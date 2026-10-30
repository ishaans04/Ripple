import { fork, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';
import { cpus, totalmem, platform } from 'node:os';
import pg from 'pg';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { runMigrations, acceptInput, transaction } from '@ripple/database';
import { createTemporaryDatabase } from '@ripple/database/testing';
import { defaultStudioSettings, founderShell, type StudioChallenge } from '@ripple/contracts';
import { sha256Hex, canonicalJson } from '@ripple/engine';
import { ensureInstallation, enrollChannel } from '../twitch/installation.ts';
import { storeGrant } from '../twitch/grants.ts';
import { exchangeReadCapability } from '../game/read-access.ts';
import { syntheticSeedCommand } from '../game/sandbox.ts';
import type { TwitchConfig } from '../twitch/security.ts';

const { values } = parseArgs({
  options: {
    seconds: { type: 'string', default: '60' },
    output: { type: 'string' },
    channels: { type: 'string', default: '100' },
    strict: { type: 'boolean', default: false },
  },
});
const seconds = z.coerce.number().int().min(5).max(300).parse(values.seconds),
  channelCount = z.coerce.number().int().min(10).max(100).parse(values.channels);
const percentile = (samples: number[], p: number) =>
  [...samples].sort((a, b) => a - b)[
    Math.min(samples.length - 1, Math.floor(samples.length * p))
  ] ?? null;
const distribution = (samples: number[]) => ({
  samples: samples.length,
  p50: percentile(samples, 0.5),
  p95: percentile(samples, 0.95),
  p99: percentile(samples, 0.99),
  max: samples.length ? Math.max(...samples) : null,
});
const temporary = await createTemporaryDatabase();
const pool = new pg.Pool({ connectionString: temporary.connectionString, max: 12 });
const sockets: WebSocket[] = [];
const child = fork(
  fileURLToPath(
    new URL(
      import.meta.url.endsWith('.ts') ? '../release/load-server.ts' : '../release/load-server.js',
      import.meta.url,
    ),
  ),
  [],
  {
    execArgv: import.meta.url.endsWith('.ts') ? ['--conditions=ripple-source'] : [],
    env: { ...process.env, DATABASE_URL: temporary.connectionString },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  },
);
let childError = '';
child.stdout?.on('data', (data: Buffer) => {
  childError = (childError + data.toString()).slice(-12000);
});
child.stderr?.on('data', (data: Buffer) => {
  childError += data.toString().slice(0, 1000);
});
try {
  await runMigrations(pool);
  const config: TwitchConfig = {
    origin: 'https://ripple-load.invalid',
    clientId: randomUUID(),
    clientSecret: 'fixture-only',
    webhookSecret: randomBytes(32).toString('hex'),
    encryptionKey: randomBytes(32).toString('base64'),
    actorKey: randomBytes(32).toString('base64'),
    sessionSecret: randomBytes(32).toString('base64'),
    operatorSecret: randomBytes(32).toString('base64'),
  };
  const worldId = await ensureInstallation(pool, config);
  await transaction(pool, (c) =>
    storeGrant(
      c,
      config,
      worldId,
      null,
      'bot',
      { access_token: 'synthetic-fixture', refresh_token: 'synthetic-fixture', expires_in: 3600 },
      {
        client_id: config.clientId,
        user_id: '999999',
        scopes: ['user:bot', 'user:read:chat', 'user:write:chat'],
        expires_in: 3600,
      },
    ),
  );
  const channels: { id: string; twitch: string; capability: string }[] = [];
  for (let i = 0; i < channelCount; i++) {
    const twitch = String(10000 + i),
      id = await transaction(pool, (c) => enrollChannel(c, worldId, twitch, `Synthetic load ${i}`)),
      capability = randomBytes(32).toString('base64url');
    await pool.query(
      'insert into overlay_capabilities(hash,world_id,channel_id) values($1,$2,$3)',
      [sha256Hex(capability), worldId, id],
    );
    await pool.query(
      "insert into twitch_subscriptions(world_id,channel_id,type,version,provider_id,condition,status) values($1,$2,'channel.chat.message','1',$3,$4,'enabled')",
      [
        worldId,
        id,
        `load-sub-${i}`,
        JSON.stringify({ broadcaster_user_id: twitch, user_id: '999999' }),
      ],
    );
    channels.push({ id, twitch, capability });
  }
  const address = await new Promise<string>((done, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Server start timeout ${childError}`));
    }, 30000);
    child.once('exit', (code) => {
      reject(new Error(`Server exited ${code}: ${childError}`));
    });
    child.once('message', (message: { ready?: boolean; address: string }) => {
      clearTimeout(timer);
      if (message.ready) done(message.address);
      else reject(new Error('No server address'));
    });
    child.send({ config });
  });
  const send = async (id: string, command: unknown) => {
    await acceptInput(pool, {
      worldId,
      channelId: id,
      provider: 'load-fixture',
      messageId: randomUUID(),
      command,
      requiredMode: 'live',
    });
  };
  const drain = async (timeout = 120000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (
        (
          await pool.query<{ n: number }>(
            'select count(*)::int n from channels where world_id=$1 and intake_sequence<>processed_sequence',
            [worldId],
          )
        ).rows[0]?.n === 0
      )
        return;
      await wait(50);
    }
    throw new Error('Accepted-input backlog failed to drain');
  };
  for (const channel of channels) {
    await send(channel.id, { type: 'integration', online: true, healthy: true });
    await send(channel.id, syntheticSeedCommand());
  }
  await drain();
  let frames = 0,
    reconnectSnapshots = 0;
  const received = new Map<WebSocket, number>();
  const socketChannels = new Map<WebSocket, string>();
  const frameTimes = new Map<string, { version: number; at: number }[]>();
  async function connect(index: number, reconnect = false) {
    const channel = channels[index % channels.length];
    if (!channel) throw new Error('Missing channel');
    const { ticket } = await exchangeReadCapability(
      pool,
      { worldId, channelId: channel.id },
      channel.capability,
    );
    await new Promise<void>((done, reject) => {
      const socket = new WebSocket(`${address.replace('http', 'ws')}/api/live?ticket=${ticket}`);
      sockets.push(socket);
      socketChannels.set(socket, channel.id);
      const timer = setTimeout(() => {
        reject(new Error('Snapshot did not arrive'));
      }, 30000);
      socket.on('error', reject);
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as { type: string; stateVersion: number };
        frames++;
        if (message.type !== 'heartbeat') {
          received.set(socket, message.stateVersion);
          const timeline = frameTimes.get(channel.id) ?? [];
          timeline.push({ version: message.stateVersion, at: Date.now() });
          frameTimes.set(channel.id, timeline);
        }
        if (message.type === 'snapshot') {
          if (reconnect) reconnectSnapshots++;
          clearTimeout(timer);
          done();
        }
      });
    });
  }
  for (let i = 0; i < channelCount * 3; i += 10)
    await Promise.all(
      Array.from({ length: Math.min(10, channelCount * 3 - i) }, (_, j) => connect(i + j)),
    );
  const studioCount = Math.min(20, channelCount),
    studioIds: string[] = [];
  for (const channel of channels.slice(0, studioCount)) {
    const id = randomUUID();
    studioIds.push(id);
    await send(channel.id, {
      type: 'studioSettings',
      settings: { ...defaultStudioSettings, enabled: true, creationMs: 300000, maxProposals: 64 },
    });
    await send(channel.id, { type: 'studioStart', trigger: 'manual', sessionId: id });
  }
  await drain();
  let proposals = 0;
  for (const [index, channel] of channels.slice(0, studioCount).entries()) {
    const studio = (
      await pool.query<{ id: string; challenge: StudioChallenge }>(
        'select id,challenge from studio_sessions where world_id=$1 and id=$2',
        [worldId, studioIds[index]],
      )
    ).rows[0];
    if (!studio) throw new Error('Studio did not open');
    for (let artist = 0; artist < (index === 0 ? 50 : 5); artist++) {
      await send(channel.id, {
        type: 'studioProposal',
        sessionId: studio.id,
        proposalId: randomUUID(),
        artistKey: sha256Hex(`synthetic-artist-${index}-${artist}`),
        credit: 'Synthetic load artist',
        creditOptIn: false,
        blueprint: {
          schemaVersion: 1,
          worldId,
          studioSessionId: studio.id,
          baseOrganismId: studio.challenge.baseOrganismId,
          baseOrganismVersion: studio.challenge.baseOrganismVersion,
          mutationTemplateId: studio.challenge.mutationTemplateIds[0],
          rendererVersion: 'shell-v1',
          part: founderShell,
        },
      });
      proposals++;
    }
  }
  await drain();
  const callback: number[] = [],
    committed: number[] = [],
    published: number[] = [],
    errors: Record<string, number> = {};
  const outstanding = new Map<string, number>();
  const publicStarts: { channelId: string; version: number; at: number }[] = [];
  const versions = new Map(
    (
      await pool.query<{ id: string; state_version: number }>(
        'select id,state_version from channels where world_id=$1',
        [worldId],
      )
    ).rows.map((row) => [row.id, row.state_version]),
  );
  const cursors = new Map(
    (
      await pool.query<{ id: string; processed_sequence: number }>(
        'select id,processed_sequence from channels where world_id=$1',
        [worldId],
      )
    ).rows.map((row) => [row.id, row.processed_sequence]),
  );
  const sampleCommits = async () => {
    const rows = await pool.query<{
      channel_id: string;
      sequence: number;
      operation_id: string;
      update: string | null;
    }>(
      "select e.channel_id,e.sequence,e.operation_id,e.result->>'updateType' as update from game_events e join jsonb_to_recordset($2::jsonb) c(id uuid,seq int) on e.channel_id=c.id and e.sequence>c.seq where e.world_id=$1 order by e.channel_id,e.sequence",
      [worldId, JSON.stringify([...cursors].map(([id, seq]) => ({ id, seq })))],
    );
    for (const row of rows.rows) {
      cursors.set(row.channel_id, Math.max(row.sequence, cursors.get(row.channel_id) ?? 0));
      if (row.update !== null)
        versions.set(row.channel_id, (versions.get(row.channel_id) ?? 0) + 1);
      const at = outstanding.get(row.operation_id);
      if (at !== undefined) {
        const latency = Date.now() - at;
        committed.push(latency);
        if (row.update !== null) {
          published.push(latency);
          publicStarts.push({
            channelId: row.channel_id,
            version: versions.get(row.channel_id) ?? 0,
            at,
          });
        }
        outstanding.delete(row.operation_id);
      }
    }
  };
  let sampling = false;
  let samplePending: Promise<void> = Promise.resolve();
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = true;
    samplePending = sampleCommits()
      .catch((error: unknown) => {
        errors[String(error)] = (errors[String(error)] ?? 0) + 1;
      })
      .finally(() => {
        sampling = false;
      });
  }, 50);
  let notifications = 0,
    acked = 0;
  const workloadStart = performance.now();
  async function notification(index: number, vote = false) {
    const channel = channels[index % channelCount];
    if (!channel) throw new Error('Missing channel');
    const messageId = randomUUID(),
      id = randomUUID(),
      timestamp = new Date().toISOString();
    const body = JSON.stringify({
      subscription: {
        id: `load-sub-${index % channelCount}`,
        type: 'channel.chat.message',
        version: '1',
        status: 'enabled',
        condition: { broadcaster_user_id: channel.twitch, user_id: '999999' },
        transport: { method: 'webhook', callback: `${config.origin}/webhooks/twitch` },
      },
      event: {
        broadcaster_user_id: channel.twitch,
        chatter_user_id: String(200000 + notifications),
        message_id: messageId,
        message: { text: vote ? '!ripple 1' : 'synthetic ordinary local chat' },
        message_type: 'text',
        source_broadcaster_user_id: null,
        source_message_id: null,
      },
    });
    notifications++;
    const started = performance.now();
    outstanding.set(`twitch-chat:${channel.id}:${messageId}`, Date.now());
    const response = await fetch(`${address}/webhooks/twitch`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'twitch-eventsub-message-id': id,
        'twitch-eventsub-message-timestamp': timestamp,
        'twitch-eventsub-message-type': 'notification',
        'twitch-eventsub-subscription-type': 'channel.chat.message',
        'twitch-eventsub-subscription-version': '1',
        'twitch-eventsub-message-signature': `sha256=${createHmac('sha256', config.webhookSecret)
          .update(id + timestamp + body)
          .digest('hex')}`,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    callback.push(performance.now() - started);
    if (response.status === 204) acked++;
    else {
      errors[`HTTP_${response.status}`] = (errors[`HTTP_${response.status}`] ?? 0) + 1;
      outstanding.delete(`twitch-chat:${channel.id}:${messageId}`);
    }
  }
  const pending: Promise<unknown>[] = [];
  for (let tick = 0; tick < seconds * 2; tick++) {
    const due = workloadStart + tick * 500;
    await wait(Math.max(0, due - performance.now()));
    for (let index = 0; index < channelCount; index++)
      pending.push(
        notification(index, tick % 10 === 0 && index >= studioCount).catch((error: unknown) => {
          errors[String(error)] = (errors[String(error)] ?? 0) + 1;
        }),
      );
    if (tick === 4 || tick === 5)
      for (let repeat = 0; repeat < 9; repeat++)
        for (let index = 0; index < Math.min(10, channelCount); index++)
          pending.push(
            notification(index).catch((error: unknown) => {
              errors[String(error)] = (errors[String(error)] ?? 0) + 1;
            }),
          );
    if (tick === Math.floor(seconds))
      pending.push(
        (async () => {
          for (const socket of sockets.slice(0, 30)) socket.terminate();
          await Promise.all(Array.from({ length: 30 }, (_, index) => connect(index, true)));
        })(),
      );
  }
  await Promise.all(pending);
  await drain();
  clearInterval(timer);
  await samplePending;
  await sampleCommits();
  const finalVersions = new Map(
    (
      await pool.query<{ id: string; state_version: number }>(
        'select id,state_version from channels where world_id=$1',
        [worldId],
      )
    ).rows.map((row) => [row.id, row.state_version]),
  );
  const converged = () =>
    sockets.filter(
      (socket) =>
        socket.readyState === WebSocket.OPEN &&
        (received.get(socket) ?? -1) >=
          (finalVersions.get(socketChannels.get(socket) ?? '') ?? Infinity),
    ).length;
  const convergenceEnd = Date.now() + 10000;
  while (converged() < channelCount * 3 && Date.now() < convergenceEnd) await wait(50);
  const publicFrames = publicStarts.flatMap((start) => {
    const frame = (frameTimes.get(start.channelId) ?? []).find(
      (frame) => frame.version >= start.version && frame.at >= start.at,
    );
    return frame ? [frame.at - start.at] : [];
  });
  const elapsedMs = performance.now() - workloadStart;
  const duplicates =
    (
      await pool.query<{ n: number }>(
        "select count(*)::int n from (select organism_id,target_slot from pending_adaptations where world_id=$1 and status='committed' group by 1,2 having count(*)>1) x",
        [worldId],
      )
    ).rows[0]?.n ?? 0;
  const database = (
    await pool.query(
      'select pg_database_size(current_database())::float as bytes,blks_read,blks_hit,tup_inserted,tup_updated from pg_stat_database where datname=current_database()',
    )
  ).rows[0] as Record<string, unknown>;
  const rowSizes = (
    await pool.query(
      `select 'normalized_input' as record,avg(pg_column_size(command))::float avg_bytes,percentile_cont(.95) within group(order by pg_column_size(command)) p95_bytes from inbox where world_id=$1
    union all select 'accepted_event',avg(pg_column_size(e))::float,percentile_cont(.95) within group(order by pg_column_size(e)) from game_events e where world_id=$1
    union all select 'public_projection',avg(pg_column_size(payload))::float,percentile_cont(.95) within group(order by pg_column_size(payload)) from public_updates where world_id=$1`,
      [worldId],
    )
  ).rows as unknown[];
  const stats = await new Promise<unknown>((done) => {
    child.once('message', done);
    child.send({ action: 'stats' });
  });
  const report = {
    schemaVersion: 1,
    synthetic: true,
    revision:
      process.env.RELEASE_REVISION ??
      execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    environment: {
      node: process.version,
      platform: platform(),
      cpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    workload: {
      channels: channelCount,
      sockets: channelCount * 3,
      studios: studioCount,
      artistsInLargestStudio: 50,
      proposals,
      seconds,
      ordinaryNotificationsPerChannelPerSecond: 2,
      burstMultiplier: 10,
      notifications,
      acked,
      elapsedMs,
      requestsPerSecond: notifications / seconds,
    },
    callbackMs: distribution(callback),
    acceptedToObservedCommitMs: distribution(committed),
    publicMutationCommitMs: distribution(published),
    publicFrameMs: distribution(publicFrames),
    convergedSockets: converged(),
    remainingAcknowledged: outstanding.size,
    reconnectSnapshots,
    frames,
    duplicateCommitments: duplicates,
    errors,
    serverErrors: childError,
    openSockets: sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length,
    database,
    rowSizes,
    server: stats,
    configurationHash: sha256Hex(canonicalJson({ seconds, channelCount, studioCount, proposals })),
    limits: [
      'Synthetic signed notifications over real localhost HTTP and PostgreSQL; no Twitch network or TLS time.',
      'Client generator runs separately from the app; both share the declared host.',
      'Commit samples include polling delay. Ordinary activity creates no public frame; public latency samples use vote/transition records only.',
      'Proposal submissions use the production ordered adapter directly during setup; public network proposal auth is covered by route tests.',
      'No hosted capacity or low-end physical-device claim is established.',
    ],
  };
  if (values.output)
    await writeFile(
      resolve(process.env.INIT_CWD ?? process.cwd(), values.output),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  else process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (
    values.strict &&
    (acked !== notifications ||
      outstanding.size ||
      duplicates ||
      Object.keys(errors).length ||
      childError.length ||
      converged() < channelCount * 3 ||
      (percentile(callback, 0.95) ?? Infinity) >= 500 ||
      (percentile(committed, 0.95) ?? Infinity) >= 1000 ||
      reconnectSnapshots < 30)
  )
    throw new Error('Declared release load targets failed; inspect the measured report');
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : 'Load run failed'}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  child.kill();
  await new Promise<void>((done) => {
    if (child.exitCode !== null) done();
    else
      child.once('exit', () => {
        done();
      });
  });
  await pool.end();
  await temporary.drop();
}
