import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicUpdate } from '@ripple/contracts';
import { openReadTopic, type ReadSocketFactory, type ReadSocketHandlers } from './read-topic.ts';

const worldId = '10000000-0000-4000-8000-000000000001',
  channelId = '10000000-0000-4000-8000-000000000002';
const clients: ReturnType<typeof openReadTopic>[] = [];
function frame(type: string, stateVersion: number): PublicUpdate {
  return {
    protocolVersion: 1,
    eventId: randomUUID(),
    worldId,
    topic: `channel:${channelId}`,
    stateVersion,
    type,
    serverTime: new Date().toISOString(),
    payload: { phase: 'VOTING' },
  };
}
function setup(
  fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: '2026-10-27T12:00:30.000Z' }),
        ),
      ),
    ),
) {
  const connections: {
    url: string;
    handlers: ReadSocketHandlers;
    close: ReturnType<typeof vi.fn>;
  }[] = [];
  const createSocket: ReadSocketFactory = (url, handlers) => {
    const close = vi.fn();
    connections.push({ url, handlers, close });
    return { close };
  };
  const onUpdate = vi.fn(),
    onStatus = vi.fn(),
    onServerTime = vi.fn();
  const client = openReadTopic({
    baseUrl: 'https://ripple.test',
    worldId,
    channelId,
    readCapability: 'private-capability',
    fetch: fetcher,
    createSocket,
    onUpdate,
    onStatus,
    onServerTime,
  });
  clients.push(client);
  return { client, connections, onUpdate, onStatus, onServerTime, fetcher };
}
describe('browser read-topic recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('keeps the capability in the exchange header, applies versions once, and never exposes a write method', async () => {
    const test = setup();
    await vi.advanceTimersByTimeAsync(0);
    const connection = test.connections[0]!;
    expect(connection.url).toBe(`wss://ripple.test/api/live?ticket=${'a'.repeat(43)}`);
    expect(connection.url).not.toContain('private-capability');
    expect(test.fetcher.mock.calls[0]?.[1]?.headers).toEqual(
      expect.objectContaining({ authorization: 'Bearer private-capability' }),
    );
    connection.handlers.opened();
    connection.handlers.message(JSON.stringify(frame('snapshot', 4)));
    const update = frame('ballot.closed', 5);
    connection.handlers.message(JSON.stringify(update));
    connection.handlers.message(JSON.stringify(update));
    connection.handlers.message(JSON.stringify(frame('vote.aggregate', 3)));
    expect(test.onUpdate).toHaveBeenCalledTimes(2);
    expect(test.onStatus).toHaveBeenLastCalledWith('connected');
    expect(Object.keys(test.client)).toEqual(['close']);
  });
  it('reconnects on a version gap and ignores late frames from the discarded socket', async () => {
    const test = setup();
    await vi.advanceTimersByTimeAsync(0);
    const old = test.connections[0]!;
    old.handlers.message(JSON.stringify(frame('snapshot', 1)));
    old.handlers.message(JSON.stringify(frame('round.resolved', 3)));
    expect(old.close).toHaveBeenCalledOnce();
    expect(test.onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    const current = test.connections[1]!;
    current.handlers.message(JSON.stringify(frame('snapshot', 4)));
    old.handlers.message(JSON.stringify(frame('round.resolved', 5)));
    expect(test.onUpdate).toHaveBeenCalledTimes(2);
    current.handlers.message(JSON.stringify(frame('snapshot', 8)));
    expect(test.onUpdate).toHaveBeenCalledTimes(3);
  });
  it('uses bounded exponential backoff and stops after denied read authority', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('', { status: 401 }));
    const test = setup(fetcher);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(test.onStatus).toHaveBeenLastCalledWith('unauthorized');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('aborts a pending exchange on close and refuses a late connection', async () => {
    const deferred = Promise.withResolvers<Response>(),
      fetcher = vi.fn<typeof fetch>().mockReturnValue(deferred.promise),
      test = setup(fetcher);
    test.client.close();
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    deferred.resolve(
      new Response(
        JSON.stringify({ ticket: 'a'.repeat(43), expiresAt: '2026-10-27T12:00:30.000Z' }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(test.connections).toHaveLength(0);
    expect(test.onStatus).toHaveBeenLastCalledWith('closed');
  });
  it('uses heartbeat time without treating it as a game update and detects a silent connection', async () => {
    const test = setup();
    await vi.advanceTimersByTimeAsync(0);
    const connection = test.connections[0]!;
    connection.handlers.opened();
    connection.handlers.message(JSON.stringify(frame('snapshot', 1)));
    await vi.advanceTimersByTimeAsync(15_000);
    connection.handlers.message(
      JSON.stringify({
        ...frame('heartbeat', 1),
        serverTime: new Date(Date.now() + 250).toISOString(),
      }),
    );
    expect(test.onServerTime).toHaveBeenLastCalledWith(250);
    expect(test.onUpdate).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(44_999);
    expect(connection.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(connection.close).toHaveBeenCalledOnce();
  });
  it('rejects out-of-scope, oversized and pre-snapshot frames', async () => {
    for (const data of [
      JSON.stringify(frame('ballot.opened', 1)),
      JSON.stringify({ ...frame('snapshot', 1), worldId: randomUUID() }),
      'x'.repeat(129 * 1024),
    ]) {
      const test = setup();
      await vi.advanceTimersByTimeAsync(0);
      test.connections[0]!.handlers.message(data);
      expect(test.onUpdate).not.toHaveBeenCalled();
      expect(test.onStatus).toHaveBeenLastCalledWith('reconnecting');
      test.client.close();
    }
  });
  it('suspends retries offline and obtains a fresh snapshot when the browser returns', async () => {
    const surface = new EventTarget();
    Object.defineProperty(surface, 'navigator', { value: { onLine: true } });
    vi.stubGlobal('window', surface);
    const test = setup();
    await vi.advanceTimersByTimeAsync(0);
    surface.dispatchEvent(new Event('offline'));
    expect(test.onStatus).toHaveBeenLastCalledWith('offline');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(test.fetcher).toHaveBeenCalledOnce();
    surface.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(test.fetcher).toHaveBeenCalledTimes(2);
  });
});
