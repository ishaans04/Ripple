import { randomUUID } from 'node:crypto';
import type { PublicUpdate } from '@ripple/contracts';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import type pg from 'pg';
import { z } from 'zod';
import { ApiError } from '../errors.ts';
import { resolvePublicCredits } from '../privacy/credits.ts';
import { authorizeReadHash, consumeReadTicket } from './read-access.ts';
import { snapshotEnvelope } from './snapshot.ts';
import type { WorldScope } from './sandbox.ts';

interface Client extends WorldScope {
  socket: WebSocket;
  authorityHash: string;
  version: number;
  ready: boolean;
  alive: boolean;
  lastAggregateAt: number;
  pendingAggregate: PublicUpdate | null;
  lastAuthorizedAt: number;
}
const MAX_FRAME_BYTES = 128 * 1024;
const MAX_BUFFER_BYTES = 256 * 1024;
const MAX_CLIENTS = 1000;
const TICK_MS = 100;
const AGGREGATE_MS = 500;

export class PublicGateway {
  readonly #pool: pg.Pool;
  readonly #logger: Pick<FastifyBaseLogger, 'error'>;
  readonly #clients = new Set<Client>();
  readonly #pollTimer: ReturnType<typeof setInterval>;
  readonly #heartbeatTimer: ReturnType<typeof setInterval>;
  #polling: Promise<void> | null = null;
  #closed = false;
  connected(worldId: string, channelId: string): number {
    return [...this.#clients].filter(
      (client) =>
        client.worldId === worldId &&
        client.channelId === channelId &&
        client.ready &&
        client.alive,
    ).length;
  }
  constructor(pool: pg.Pool, logger: Pick<FastifyBaseLogger, 'error'>) {
    this.#pool = pool;
    this.#logger = logger;
    this.#pollTimer = setInterval(() => {
      this.wake();
    }, TICK_MS);
    this.#heartbeatTimer = setInterval(() => {
      for (const client of this.#clients) {
        if (!client.alive) {
          client.socket.terminate();
          continue;
        }
        client.alive = false;
        if (client.ready)
          this.#send(client, {
            protocolVersion: 1,
            eventId: randomUUID(),
            worldId: client.worldId,
            topic: `channel:${client.channelId}`,
            stateVersion: client.version,
            type: 'heartbeat',
            serverTime: new Date().toISOString(),
            payload: null,
          });
        client.socket.ping();
      }
    }, 15_000);
    this.#pollTimer.unref();
    this.#heartbeatTimer.unref();
  }
  #send(client: Client, update: PublicUpdate): boolean {
    if (client.socket.readyState !== 1) return false;
    const frame = JSON.stringify(update);
    if (
      Buffer.byteLength(frame) > MAX_FRAME_BYTES ||
      client.socket.bufferedAmount > MAX_BUFFER_BYTES
    ) {
      client.socket.close(1013, 'State buffer exceeded; reconnect for a snapshot');
      return false;
    }
    client.socket.send(frame, (error: Error | null | undefined) => {
      if (error !== undefined && error !== null) client.socket.terminate();
    });
    client.version = update.stateVersion;
    return true;
  }
  connect(socket: WebSocket, scope: WorldScope & { authorityHash: string }): void {
    // Install every handler before the first asynchronous read.
    socket.on('error', () => {
      socket.terminate();
    });
    socket.on('message', () => {
      socket.close(1008, 'This connection is read-only');
    });
    if (this.#closed || this.#clients.size >= MAX_CLIENTS) {
      socket.close(1013, 'Gateway busy; reconnect later');
      return;
    }
    const client: Client = {
      ...scope,
      socket,
      version: -1,
      ready: false,
      alive: true,
      lastAggregateAt: 0,
      pendingAggregate: null,
      lastAuthorizedAt: Date.now(),
    };
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.#clients.delete(client);
    });
    // Register first. The durable outbox buffers every commit during snapshot I/O.
    this.#clients.add(client);
    void snapshotEnvelope(this.#pool, scope.worldId, scope.channelId)
      .then((snapshot) => {
        if (snapshot === null) {
          socket.close(1008, 'World unavailable');
          return;
        }
        if (this.#send(client, snapshot)) client.ready = true;
        this.wake();
      })
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, 'gateway snapshot failed');
        socket.close(1013, 'State unavailable; reconnect');
      });
  }
  wake(): void {
    if (this.#closed || this.#polling !== null) return;
    this.#polling = this.#poll()
      .catch((error: unknown) => {
        this.#logger.error({ err: error }, 'gateway catch-up failed');
        for (const client of this.#clients)
          client.socket.close(1013, 'State unavailable; reconnect');
      })
      .finally(() => {
        this.#polling = null;
      });
  }
  async #poll(): Promise<void> {
    const topics = new Map<string, Client[]>();
    for (const client of this.#clients) {
      if (!client.ready || client.socket.readyState !== 1) continue;
      if (Date.now() - client.lastAuthorizedAt >= 15_000) {
        try {
          await authorizeReadHash(this.#pool, client, client.authorityHash);
          client.lastAuthorizedAt = Date.now();
        } catch {
          client.socket.close(1008, 'Read access expired or revoked');
          continue;
        }
      }
      const key = `${client.worldId}:${client.channelId}`;
      const group = topics.get(key) ?? [];
      group.push(client);
      topics.set(key, group);
    }
    const scopes = [...topics.values()].flatMap((clients) => {
      const first = clients[0];
      return first === undefined
        ? []
        : [
            {
              world_id: first.worldId,
              channel_id: first.channelId,
              after: Math.min(...clients.map((c) => c.version)),
            },
          ];
    });
    if (scopes.length === 0) return;
    const allUpdates = await this.#pool.query<{
      world_id: string;
      channel_id: string;
      state_version: number;
      version: number | null;
      event_id: string;
      type: string;
      payload: unknown;
      created_at: Date;
    }>(
      `select s.world_id,s.channel_id,c.state_version,u.*
      from jsonb_to_recordset($1::jsonb) s(world_id uuid,channel_id uuid,after int)
      join channels c on c.world_id=s.world_id and c.id=s.channel_id
      left join lateral(select version,event_id,type,payload,created_at from public_updates
        where world_id=s.world_id and channel_id=s.channel_id and version>s.after order by version limit 101) u on true`,
      [JSON.stringify(scopes)],
    );
    const grouped = new Map<string, typeof allUpdates.rows>();
    for (const row of allUpdates.rows) {
      const key = `${row.world_id}:${row.channel_id}`,
        rows = grouped.get(key) ?? [];
      rows.push(row);
      grouped.set(key, rows);
    }
    for (const [key, clients] of topics) {
      const first = clients[0];
      if (first === undefined) continue;
      const after = Math.min(...clients.map((c) => c.version));
      const group = grouped.get(key) ?? [];
      const updates = {
        rows: group
          .filter((row): row is typeof row & { version: number } => row.version !== null)
          .sort((a, b) => a.version - b.version),
      };
      // A large gap needs current state, not a queue of old animations.
      if (
        updates.rows.length > 100 ||
        (group[0] && group[0].state_version > after && updates.rows.length === 0)
      ) {
        const snapshot = await snapshotEnvelope(this.#pool, first.worldId, first.channelId);
        for (const client of clients) {
          client.pendingAggregate = null;
          if (snapshot !== null) this.#send(client, snapshot);
          else client.socket.close(1008, 'World unavailable');
        }
        continue;
      }
      const resolvedPayloads = await resolvePublicCredits(
        this.#pool,
        updates.rows.map((row) => row.payload),
      );
      updates.rows.forEach((row, index) => {
        row.payload = resolvedPayloads[index];
      });
      for (const client of clients) {
        for (const row of updates.rows) {
          if (row.version <= client.version) continue;
          const update: PublicUpdate = {
            protocolVersion: 1,
            eventId: row.event_id,
            worldId: client.worldId,
            topic: `channel:${client.channelId}`,
            stateVersion: row.version,
            type: row.type,
            serverTime: row.created_at.toISOString(),
            payload: row.payload,
          };
          if (row.type === 'vote.aggregate') {
            client.pendingAggregate = update;
            continue;
          }
          client.pendingAggregate = null;
          // Every payload is a complete projection. A conflated gap rebases explicitly.
          if (update.stateVersion !== client.version + 1) update.type = 'snapshot';
          this.#send(client, update);
        }
        if (
          client.pendingAggregate !== null &&
          Date.now() - client.lastAggregateAt >= AGGREGATE_MS
        ) {
          const update = client.pendingAggregate;
          if (update.stateVersion !== client.version + 1) update.type = 'snapshot';
          this.#send(client, update);
          client.pendingAggregate = null;
          client.lastAggregateAt = Date.now();
        }
      }
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#pollTimer);
    clearInterval(this.#heartbeatTimer);
    for (const client of this.#clients) client.socket.terminate();
    this.#clients.clear();
    await this.#polling;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    publicGateway: PublicGateway;
  }
}

export async function registerGateway(app: FastifyInstance, pool: pg.Pool): Promise<PublicGateway> {
  await app.register(websocket, { options: { maxPayload: 1024, perMessageDeflate: false } });
  const gateway = new PublicGateway(pool, app.log);
  app.decorate('publicGateway', gateway);
  const scopes = new WeakMap<object, WorldScope & { authorityHash: string }>();
  app.get(
    '/api/live',
    {
      websocket: true,
      preValidation: async (request) => {
        const parsed = z.strictObject({ ticket: z.string().length(43) }).safeParse(request.query);
        if (!parsed.success)
          throw new ApiError('UNAUTHORIZED', 401, 'A connection ticket is required.');
        scopes.set(request, await consumeReadTicket(pool, parsed.data.ticket));
      },
    },
    (socket, request) => {
      const scope = scopes.get(request);
      scopes.delete(request);
      if (scope === undefined) {
        socket.close(1008, 'Missing read scope');
        return;
      }
      gateway.connect(socket, scope);
    },
  );
  app.addHook('preClose', () => gateway.close());
  return gateway;
}
