import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectionTicketSchema, publicUpdateSchema, studioGenomeSchema } from '@ripple/contracts';

const ownPath = fileURLToPath(import.meta.url),
  entry = join(dirname(ownPath), `sandbox${extname(ownPath)}`);
const stateSchema = z.looseObject({
  snapshot: z.looseObject({
    stateVersion: z.int(),
    payload: z.looseObject({
      mode: z.literal('sandbox'),
      organism: z.looseObject({ genome: studioGenomeSchema, health: z.int().min(0).max(100) }),
      round: z.looseObject({
        phase: z.string(),
        counts: z.array(z.int()),
        candidates: z.array(z.looseObject({ genome: studioGenomeSchema })),
        resolution: z.unknown(),
      }),
    }),
  }),
});
const created = z
  .object({
    worldId: z.uuid(),
    channelId: z.uuid(),
    ownerCapability: z.string(),
    readCapability: z.string(),
  })
  .parse(
    JSON.parse(
      execFileSync(process.execPath, [...process.execArgv, entry, 'create'], { encoding: 'utf8' }),
    ),
  );
const env = { ...process.env, RIPPLE_SANDBOX_CAPABILITY: created.ownerCapability };
function action(name: string, ...args: string[]) {
  return stateSchema.parse(
    JSON.parse(
      execFileSync(
        process.execPath,
        [...process.execArgv, entry, name, created.worldId, created.channelId, ...args],
        { encoding: 'utf8', env },
      ),
    ),
  );
}
const initial = action('status');
assert.equal(initial.snapshot.payload.round.phase, 'VOTING');
const choice = initial.snapshot.payload.round.candidates[0];
assert.ok(choice);
assert.deepEqual(action('vote', 'alice', '1').snapshot.payload.round.counts, [1, 0, 0]);
const observation = action('advance', '3200');
assert.equal(observation.snapshot.payload.round.phase, 'OBSERVING');
assert.deepEqual(observation.snapshot.payload.organism.genome, choice.genome);
for (const actor of ['alice', 'bob', 'carol']) action('activity', actor);
const resolved = action('advance', '12000');
assert.equal(resolved.snapshot.payload.round.phase, 'REVEAL');
z.object({
  outcome: z.literal('applied'),
  profile: z.object({
    contributions: z.literal(3),
    distinctAccounts: z.literal(3),
    confidence: z.literal('confident'),
  }),
}).parse(resolved.snapshot.payload.round.resolution);
const base = new URL(
  process.env.RIPPLE_SMOKE_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3000'}`,
);
const headers = { authorization: `Bearer ${created.readCapability}` };
const snapshotUrl = new URL(`/api/worlds/${created.worldId}/snapshot`, base);
snapshotUrl.searchParams.set('channelId', created.channelId);
const response = await fetch(snapshotUrl, { headers });
assert.equal(response.status, 200);
const snapshot = publicUpdateSchema.parse(await response.json());
assert.equal(snapshot.type, 'snapshot');
assert.deepEqual(snapshot.payload, resolved.snapshot.payload);
const exchange = await fetch(new URL('/api/overlay/exchange', base), {
  method: 'POST',
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify({ worldId: created.worldId, channelId: created.channelId }),
});
assert.equal(exchange.status, 200);
const ticket = connectionTicketSchema.parse(await exchange.json());
const socketUrl = new URL('/api/live', base);
socketUrl.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
socketUrl.searchParams.set('ticket', ticket.ticket);
await new Promise<void>((resolve, reject) => {
  const socket = new WebSocket(socketUrl);
  const timeout = setTimeout(() => {
    socket.close();
    reject(new Error('Snapshot-first WebSocket timed out.'));
  }, 5000);
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('WebSocket connection failed.'));
  });
  socket.addEventListener(
    'message',
    (event) => {
      try {
        const data: unknown = event.data;
        if (typeof data !== 'string') throw new Error('Expected a text snapshot frame.');
        const update = publicUpdateSchema.parse(JSON.parse(data));
        assert.equal(update.type, 'snapshot');
        assert.equal(update.worldId, created.worldId);
        assert.deepEqual(update.payload, snapshot.payload);
        clearTimeout(timeout);
        socket.close();
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        socket.close();
        reject(error instanceof Error ? error : new Error('Invalid gateway frame.'));
      }
    },
    { once: true },
  );
});
process.stdout.write(
  `${JSON.stringify({ synthetic: true, worldId: created.worldId, checks: ['seed', 'vote', 'habitat', 'resolution', 'scoped HTTP', 'snapshot-first WebSocket'], health: resolved.snapshot.payload.organism.health })}\n`,
);
