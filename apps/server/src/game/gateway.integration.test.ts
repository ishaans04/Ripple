import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { publicUpdateSchema, type PublicUpdate } from '@ripple/contracts';
import { runMigrations } from '@ripple/database';
import { createTemporaryDatabase, type TemporaryDatabase } from '@ripple/database/testing';
import { buildApp } from '../app.ts';
import {
  acceptSyntheticCommand,
  createSyntheticWorld,
  syntheticSeedCommand,
  type SyntheticWorld,
} from './sandbox.ts';
import { consumeReadTicket, exchangeReadCapability } from './read-access.ts';
import { processNextInput } from './worker.ts';

describe('scoped snapshot-first gateway', () => {
  let temporary: TemporaryDatabase, pool: pg.Pool, app: FastifyInstance;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    temporary = await createTemporaryDatabase();
    pool = new pg.Pool({ connectionString: temporary.connectionString });
    await runMigrations(pool);
    app = await buildApp({ pool, config: { logLevel: 'silent', webRoot: undefined } });
    await app.ready();
  });
  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    await app.close();
    await pool.end();
    await temporary.drop();
  });
  async function command(world: SyntheticWorld, value: unknown): Promise<void> {
    await acceptSyntheticCommand(pool, world, world.ownerCapability, randomUUID(), value);
    while ((await processNextInput(pool, world.worldId, world.channelId)) !== null) {
      /* Drain the actual ordered worker. */
    }
  }
  async function world(): Promise<SyntheticWorld> {
    const scope = await createSyntheticWorld(pool);
    await command(scope, syntheticSeedCommand());
    return scope;
  }
  async function connect(
    scope: SyntheticWorld,
    target = app,
  ): Promise<{ socket: WebSocket; messages: PublicUpdate[] }> {
    const ticket = await exchangeReadCapability(pool, scope, scope.readCapability),
      messages: PublicUpdate[] = [];
    const socket = await target.injectWS(
      `/api/live?ticket=${ticket.ticket}`,
      {},
      {
        onInit: (ws) => {
          ws.on('message', (data) => {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
            messages.push(publicUpdateSchema.parse(JSON.parse(buffer.toString('utf8'))));
          });
        },
      },
    );
    sockets.push(socket);
    await expect.poll(() => messages.length).toBeGreaterThan(0);
    return { socket, messages };
  }
  it('requires an appropriate read capability and never shares another world', async () => {
    const one = await world(),
      two = await world();
    const url = `/api/worlds/${one.worldId}/snapshot?channelId=${one.channelId}`;
    expect((await app.inject({ url })).statusCode).toBe(401);
    expect(
      (await app.inject({ url, headers: { authorization: `Bearer ${two.readCapability}` } }))
        .statusCode,
    ).toBe(401);
    const response = await app.inject({
      url,
      headers: { authorization: `Bearer ${one.readCapability}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(publicUpdateSchema.parse(response.json()).type).toBe('snapshot');
    expect(response.body).not.toContain('actorKey');
    expect(response.body).not.toContain('fixed-seed');
    expect(response.body).not.toContain(one.ownerCapability);
  });
  it('consumes a persisted connection ticket once and rejects expiry or revocation', async () => {
    const scope = await world(),
      ticket = await exchangeReadCapability(pool, scope, scope.readCapability);
    const results = await Promise.allSettled([
      consumeReadTicket(pool, ticket.ticket),
      consumeReadTicket(pool, ticket.ticket),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const expired = await exchangeReadCapability(pool, scope, scope.readCapability);
    await pool.query(
      `update gateway_tickets set expires_at=now()-interval '1 second' where world_id=$1`,
      [scope.worldId],
    );
    await expect(consumeReadTicket(pool, expired.ticket)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    const revoked = await exchangeReadCapability(pool, scope, scope.readCapability);
    await pool.query('update overlay_capabilities set revoked_at=now() where world_id=$1', [
      scope.worldId,
    ]);
    await expect(consumeReadTicket(pool, revoked.ticket)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
  it('sends a snapshot first, catches commits during connection, and reconnects at current state', async () => {
    const scope = await world();
    const connecting = connect(scope);
    await command(scope, { type: 'vote', actorKey: 'private-actor', choice: 2 });
    const { socket, messages } = await connecting;
    expect(messages[0]?.type).toBe('snapshot');
    await expect
      .poll(() => (messages.at(-1)?.payload as { round: { counts: number[] } }).round.counts)
      .toEqual([0, 1, 0]);
    const last = messages.at(-1)!;
    expect(JSON.stringify(messages)).not.toContain('private-actor');
    socket.close();
    const reconnected = await connect(scope);
    expect(reconnected.messages[0]?.stateVersion).toBe(last.stateVersion);
    expect(reconnected.messages[0]?.payload).toEqual(last.payload);
    reconnected.socket.close();
  });
  it('recovers durable updates independently in a second gateway and denies socket writes', async () => {
    const scope = await world(),
      second = await buildApp({ pool, config: { logLevel: 'silent', webRoot: undefined } });
    await second.ready();
    try {
      const { socket, messages } = await connect(scope, second);
      await command(scope, { type: 'vote', actorKey: 'remote-gateway', choice: 1 });
      await expect
        .poll(() => (messages.at(-1)?.payload as { round: { counts: number[] } }).round.counts)
        .toEqual([1, 0, 0]);
      const closed = new Promise<number>((resolve) => {
        socket.once('close', (code) => {
          resolve(code);
        });
      });
      socket.send(JSON.stringify({ type: 'vote', choice: 3 }));
      expect(await closed).toBe(1008);
      expect(
        (await pool.query('select * from votes where world_id=$1', [scope.worldId])).rowCount,
      ).toBe(1);
    } finally {
      await second.close();
    }
  });
  it('closes a slow consumer with a recoverable reason instead of growing its buffer', async () => {
    const scope = await world();
    const { socket } = await connect(scope);
    const serverSocket = [...app.websocketServer.clients].at(-1)!;
    Object.defineProperty(serverSocket, 'bufferedAmount', {
      configurable: true,
      get: () => 300_000,
    });
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => {
        resolve(code);
      });
    });
    await command(scope, { type: 'vote', actorKey: 'slow-buffer', choice: 1 });
    expect(await closed).toBe(1013);
    const fresh = await connect(scope);
    expect((fresh.messages[0]?.payload as { round: { counts: number[] } }).round.counts).toEqual([
      1, 0, 0,
    ]);
    fresh.socket.close();
  });
  it('rechecks authority for an already connected browser after capability revocation', async () => {
    const scope = await world();
    const { socket } = await connect(scope);
    const closed = new Promise<number>((resolve) => {
      socket.once('close', (code) => {
        resolve(code);
      });
    });
    await pool.query('update overlay_capabilities set revoked_at=now() where world_id=$1', [
      scope.worldId,
    ]);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16_000);
    try {
      expect(await closed).toBe(1008);
    } finally {
      clock.mockRestore();
    }
  });
});
