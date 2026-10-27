import { describe, expect, it } from 'vitest';
import { describeServiceStatus, fetchServiceStatus } from './serviceStatus.ts';

function respondWith(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

describe('fetchServiceStatus', () => {
  it('reports available when the service is ready', async () => {
    const fetchImpl = respondWith(200, {
      status: 'ready',
      checks: { database: 'ok', migrations: 'current' },
    });
    expect(await fetchServiceStatus(fetchImpl)).toEqual({ kind: 'available' });
  });

  it('distinguishes a database outage from a pending update', async () => {
    const outage = respondWith(503, {
      status: 'not_ready',
      checks: { database: 'unavailable', migrations: 'unknown' },
    });
    const updating = respondWith(503, {
      status: 'not_ready',
      checks: { database: 'ok', migrations: 'pending' },
    });
    expect(await fetchServiceStatus(outage)).toEqual({ kind: 'unavailable', reason: 'database' });
    expect(await fetchServiceStatus(updating)).toEqual({ kind: 'unavailable', reason: 'updating' });
  });

  it('treats network failures and unexpected bodies as unreachable', async () => {
    const offline: typeof fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const proxyPage: typeof fetch = () =>
      Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }));
    expect(await fetchServiceStatus(offline)).toEqual({
      kind: 'unavailable',
      reason: 'unreachable',
    });
    expect(await fetchServiceStatus(proxyPage)).toEqual({
      kind: 'unavailable',
      reason: 'unreachable',
    });
  });

  it('propagates cancellation instead of reporting an outage', async () => {
    const controller = new AbortController();
    const aborting: typeof fetch = () => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    };
    await expect(fetchServiceStatus(aborting, controller.signal)).rejects.toThrow('aborted');
  });
});

describe('describeServiceStatus', () => {
  it('gives every state a distinct text message', () => {
    const messages = [
      describeServiceStatus({ kind: 'checking' }),
      describeServiceStatus({ kind: 'available' }),
      describeServiceStatus({ kind: 'unavailable', reason: 'unreachable' }),
      describeServiceStatus({ kind: 'unavailable', reason: 'database' }),
      describeServiceStatus({ kind: 'unavailable', reason: 'updating' }),
    ];
    expect(new Set(messages).size).toBe(messages.length);
  });
});
