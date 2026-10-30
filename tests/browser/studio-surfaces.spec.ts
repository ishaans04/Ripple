import { expectAccessible } from './axe.ts';
import { test, expect, type Page } from '@playwright/test';
import {
  channelViewSchema,
  defaultStudioSettings,
  founderShell,
  type ChannelView,
  type StudioView,
} from '@ripple/contracts';
import { candidateRuleset } from '@ripple/engine';

const world = '22222222-2222-4222-8222-222222222222',
  channel = '11111111-1111-4111-8111-111111111111',
  session = '33333333-3333-4333-8333-333333333333',
  capability = 'c'.repeat(43),
  hash = 'b'.repeat(64);
const design = {
  schemaVersion: 1 as const,
  worldId: world,
  studioSessionId: session,
  baseOrganismId: channel,
  baseOrganismVersion: 0,
  mutationTemplateId: 'grit-plus2-pulse-minus2' as const,
  rendererVersion: 'shell-v1' as const,
  part: { ...founderShell, parameters: { width: 760, height: 520, curvature: 500 } },
};
const finalists = [
  { index: 1, hash, template: design.mutationTemplateId, blueprint: design, credit: 'shell_maker' },
];

function studio(
  phase: NonNullable<StudioView['session']>['phase'],
  extra: Partial<NonNullable<StudioView['session']>> = {},
): StudioView {
  return {
    enabled: true,
    availability: { state: 'REST', source: 'bridge', bridgeStale: false },
    session: {
      id: session,
      phase,
      version: 4,
      trigger: 'bridge',
      cosmeticOnly: false,
      challenge: {
        templates: ['grit-plus2-pulse-minus2', 'grit-plus2-calm-minus2'],
        genome: candidateRuleset.genome.founder,
        targetMutationSlot: 2,
      },
      creationCloseAtMs: Date.now() + 120_000,
      votingCloseAtMs: Date.now() + 30_000,
      reviewExpiresAtMs: Date.now() + 600_000,
      accepted: 3,
      maxProposals: 50,
      finalists: [],
      counts: [],
      selection: null,
      pending: null,
      outcome: null,
      ...extra,
    },
  };
}
function view(studioView: StudioView, round: Partial<NonNullable<ChannelView['round']>> = {}) {
  return channelViewSchema.parse({
    channelId: channel,
    label: 'Studio fixture channel',
    mode: 'sandbox',
    online: true,
    healthy: true,
    paused: false,
    studio: studioView,
    organism: {
      id: channel,
      name: 'Tidepool',
      health: 60,
      status: 'ALIVE',
      genome: candidateRuleset.genome.founder,
      appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
    },
    round: {
      id: world,
      number: 3,
      kind: 'MUTATION',
      phase: 'VOTING',
      clock: { paused: true, remainingMs: 20_000, deadlineAtMs: null },
      candidates: [{ effect: 'Reinforce shell', tradeOff: 'Less burst affinity' }],
      counts: [0],
      voteCloseAtMs: null,
      explanation: null,
      ...round,
    },
  });
}
const pending = {
  hash,
  template: design.mutationTemplateId,
  blueprint: design,
  credit: 'shell_maker',
  message: 'Community design selected. Hatches after the current round.' as const,
};

async function overlay(page: Page, initial: ChannelView) {
  let current = initial,
    sequence = 0,
    connections = 0,
    push: (() => void) | undefined,
    drop: (() => void) | undefined;
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' } }),
  );
  await page.routeWebSocket('**/api/live?*', (socket) => {
    connections++;
    push = () => {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          eventId: channel,
          worldId: world,
          topic: `channel:${channel}`,
          stateVersion: ++sequence,
          type: 'snapshot',
          serverTime: new Date().toISOString(),
          payload: current,
        }),
      );
    };
    drop = () => {
      void socket.close({ code: 1012, reason: 'Fixture restart' });
    };
    push();
  });
  await page.goto(`/overlay#worldId=${world}&channelId=${channel}&capability=${capability}`);
  return {
    set(next: ChannelView) {
      current = next;
      push?.();
    },
    drop: () => drop?.(),
    connections: () => connections,
  };
}

test('overlay shows the studio invitation, vote, incubation and hatch, and recovers each after reconnect', async ({
  page,
}) => {
  const stage = page.getByRole('main', { name: 'Ripple broadcast overlay', exact: true });
  const feed = await overlay(page, view(studio('CREATING')));
  await expect(stage).toContainText('Cocoon Studio is open');
  await expect(stage).toContainText(`/studio?s=${session}`);
  await expect(stage).toContainText('Grit +2 · Pulse −2; Grit +2 · Calm −2');
  await expect(stage).not.toContainText('Vote in chat: !ripple 1');
  feed.set(view(studio('VOTING', { finalists, counts: [5, 2] })));
  const ballot = stage.getByRole('list', { name: 'Studio finalists' });
  await expect(ballot).toContainText('1. Grit +2 · Pulse −2');
  await expect(ballot).toContainText('5 votes');
  await expect(ballot).toContainText('2. Keep current');
  await expect(stage).toContainText('Vote in chat: !ripple 1 or !ripple 2');
  await expectAccessible(page);
  // Reconnecting during voting restores the authoritative studio ballot from the snapshot.
  feed.drop();
  await expect.poll(() => feed.connections()).toBe(2);
  await expect(ballot).toContainText('5 votes');
  feed.set(
    view(studio('PENDING_HATCH', { finalists, pending }), {
      clock: { paused: false, remainingMs: 20_000, deadlineAtMs: null },
      phase: 'OBSERVING',
    }),
  );
  await expect(stage).toContainText('Community design selected. Hatches after the current round.');
  await expect(stage).toContainText('Health, protection and genes are unchanged until then.');
  await expect(stage.getByRole('heading', { name: 'Observing habitat' })).toBeVisible();
  feed.set(
    view(studio('PENDING_HATCH', { finalists, pending }), {
      candidates: [],
      counts: [],
      clock: { paused: false, remainingMs: 20_000, deadlineAtMs: null },
      voteCloseAtMs: Date.now() + 20_000,
      studioHatch: { adaptationId: world, sessionId: session, hash },
    }),
  );
  await expect(stage.getByRole('heading', { name: 'Community design hatching' })).toBeVisible();
  await expect(stage).toContainText('No ballot this round.');
  feed.drop();
  await expect.poll(() => feed.connections()).toBe(3);
  await expect(stage.getByRole('heading', { name: 'Community design hatching' })).toBeVisible();
  await expect(page.getByRole('button')).toHaveCount(0);
});

const status = (payload: ChannelView) => ({
  worldId: world,
  channelId: channel,
  csrfToken: 'csrf-test',
  authorized: true,
  botAuthorized: true,
  callbackReady: true,
  subscriptionsReady: true,
  subscriptions: [],
  settings: {
    input_error: null,
    visitor_policy: 'ask',
    last_seed_at: null,
    seed_cooldown_ms: 180000,
  },
  snapshot: { version: 7, payload },
  readClients: 1,
});

async function controller(page: Page, payload: ChannelView) {
  const posts: { url: string; body: unknown; key: string | undefined }[] = [];
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) => route.fulfill({ json: status(payload) }));
  await page.route('**/api/controller/studio', (route) =>
    route.fulfill({
      json: {
        settings: { ...defaultStudioSettings, enabled: true, breakScenes: ['BRB'] },
        bridge: { issued: true, lastSeenAt: null, scene: 'BRB', stale: true },
        proposals: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            artistKey: 'd'.repeat(64),
            credit: 'shell_maker',
            creditOptIn: true,
            hash,
            revision: 2,
            blueprint: design,
          },
        ],
        blocks: [],
      },
    }),
  );
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({ json: { sequence: 12, result: { code: 'APPLIED' } } }),
  );
  await page.route(
    (url) => url.pathname.startsWith('/api/studios/') || url.pathname.includes('/studio/'),
    async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      posts.push({
        url: new URL(request.url()).pathname,
        body: request.postDataJSON(),
        key: request.headers()['idempotency-key'],
      });
      await route.fulfill({ status: 202, json: { operationId: 'x', sequence: 12 } });
    },
  );
  await page.goto('/controller');
  return posts;
}

test('controller reviews the winning design with its trade-off, credit and session version', async ({
  page,
}) => {
  const posts = await controller(
    page,
    view(
      studio('REVIEW', {
        finalists,
        selection: { kind: 'design', reason: null, finalistIndex: 1 },
      }),
    ),
  );
  const card = page.getByRole('region', { name: 'Cocoon Studio controls' });
  await expect(card.getByRole('heading', { name: 'Review the community design' })).toBeVisible();
  await expect(card).toContainText('Trade-off: Grit +2 · Pulse −2 · credit: shell_maker');
  await expect(card).toContainText('OBS bridge signal is stale');
  await expectAccessible(page);
  await card.getByRole('button', { name: 'Approve design' }).click();
  await expect(page.getByRole('status').first()).toContainText('Change committed.');
  expect(posts).toEqual([
    {
      url: `/api/studios/${session}/review`,
      body: { expectedVersion: 7, sessionVersion: 4, decision: 'approve' },
      key: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown as string,
    },
  ]);
});

test('controller moderates proposals, ends the break and saves validated studio settings', async ({
  page,
}) => {
  const posts = await controller(page, view(studio('CREATING')));
  const card = page.getByRole('region', { name: 'Cocoon Studio controls' });
  const proposals = card.getByRole('region', { name: 'Studio proposals' });
  await expect(proposals).toContainText('shell_maker · Grit +2 · Pulse −2 · revision 2');
  await proposals.getByRole('button', { name: 'Remove' }).click();
  await expect.poll(() => posts.length).toBe(1);
  await proposals.getByRole('button', { name: 'Block artist' }).click();
  await expect.poll(() => posts.length).toBe(2);
  await card.getByRole('button', { name: 'End break' }).click();
  await expect.poll(() => posts.length).toBe(3);
  await card.getByText('Studio settings', { exact: true }).click();
  await card.getByLabel('Creation minutes').fill('0');
  await expect(card.getByRole('alert')).toContainText('outside the supported limits');
  await expect(card.getByRole('button', { name: 'Save studio settings' })).toBeDisabled();
  await card.getByLabel('Creation minutes').fill('3');
  await card.getByRole('button', { name: 'Save studio settings' }).click();
  await expect.poll(() => posts.length).toBe(4);
  expect(posts.map((post) => post.url)).toEqual([
    `/api/studios/${session}/proposals/55555555-5555-4555-8555-555555555555/remove`,
    `/api/channels/${channel}/studio/blocks`,
    `/api/channels/${channel}/studio/stop`,
    `/api/channels/${channel}/studio/settings`,
  ]);
  expect(posts[1]?.body).toEqual({ expectedVersion: 7, artistKey: 'd'.repeat(64), blocked: true });
  expect((posts[3]?.body as { settings: { creationMs: number } }).settings.creationMs).toBe(
    180_000,
  );
});

test('the OBS bridge reconciles, debounces scene changes and reports hiding as stale', async ({
  page,
}) => {
  const reports: unknown[] = [];
  await page.route(`**/api/channels/${channel}/availability`, async (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${capability}`);
    reports.push(route.request().postDataJSON());
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.addInitScript(() => {
    (window as unknown as { obsstudio: unknown }).obsstudio = {
      getCurrentScene: (callback: (scene: { name: string }) => void) => {
        callback({ name: 'Gameplay' });
      },
    };
  });
  await page.goto(`/bridge#worldId=${world}&channelId=${channel}&capability=${capability}`);
  await expect(page.getByRole('status')).toContainText(
    'Reporting configured break and active scenes',
  );
  const fire = (type: string, detail: unknown) =>
    page.evaluate(
      ([name, value]) => {
        window.dispatchEvent(new CustomEvent(name as string, { detail: value }));
      },
      [type, detail] as const,
    );
  await fire('obsSceneChanged', { name: 'BRB' });
  await fire('obsSceneChanged', { name: 'Gameplay' });
  await fire('obsSceneChanged', { name: 'BRB' });
  await expect.poll(() => reports.length, { timeout: 5000 }).toBe(2);
  await fire('obsSourceVisibleChanged', { visible: false });
  await expect.poll(() => reports.length).toBe(3);
  expect(reports).toEqual([
    { kind: 'scene', scene: 'Gameplay' },
    { kind: 'scene', scene: 'BRB' },
    { kind: 'hidden' },
  ]);
  // Outside OBS the page explains itself and reports nothing.
  const plain = await page.context().newPage();
  await plain.goto(`/bridge#worldId=${world}&channelId=${channel}&capability=${capability}`);
  await expect(plain.getByRole('status')).toContainText('Add this page as an OBS browser source');
  await plain.close();
  expect(reports).toHaveLength(3);
});
