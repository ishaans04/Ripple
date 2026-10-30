import { expectAccessible } from './axe.ts';
import { test, expect } from '@playwright/test';
import {
  channelViewSchema,
  founderShell,
  mechanicsStateSchema,
  type ChannelView,
} from '@ripple/contracts';
import { candidateRuleset } from '@ripple/engine';

const world = '22222222-2222-4222-8222-222222222222',
  channelId = '11111111-1111-4111-8111-111111111111',
  capability = 'c'.repeat(43),
  fragment = `worldId=${world}&channelId=${channelId}&capability=${capability}`;
function fixture(): ChannelView {
  return channelViewSchema.parse({
    channelId,
    label: 'Mira channel',
    mode: 'sandbox',
    online: true,
    healthy: true,
    paused: false,
    organism: {
      id: channelId,
      name: '<Shell & Tide>',
      health: 42,
      status: 'ALIVE',
      genome: { pulse: 6, calm: 6, grit: 6, drift: 6 },
      appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
    },
    round: {
      id: world,
      number: 2,
      kind: 'MUTATION',
      phase: 'VOTING',
      clock: { paused: false, remainingMs: 25000, deadlineAtMs: null },
      candidates: [
        { effect: 'Reinforce shell', tradeOff: 'Less burst affinity' },
        { effect: 'Settle into steady chat', tradeOff: 'Smaller travel reserve' },
        { effect: 'Specialize for bursts', tradeOff: 'Less steadiness', source: 'dormant' },
      ],
      counts: [2, 1, 0],
      voteCloseAtMs: null,
      explanation: null,
    },
  });
}
test('transparent overlay uses scoped state, server-aligned deadlines and honest connection/clock states', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const initial = fixture(),
    serverTime = Date.now() + 60000;
  if (initial.round === null) throw new Error('Missing fixture round');
  initial.round.voteCloseAtMs = serverTime + 24000;
  let current = initial,
    sequence = 0,
    connections = 0,
    push: (() => void) | undefined,
    disconnect: (() => void) | undefined;
  await page.route('**/api/overlay/exchange', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${capability}`);
    expect(route.request().postDataJSON()).toEqual({ worldId: world, channelId });
    return route.fulfill({
      json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' },
    });
  });
  await page.routeWebSocket('**/api/live?*', (socket) => {
    connections++;
    push = () => {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          eventId: channelId,
          worldId: world,
          topic: `channel:${channelId}`,
          stateVersion: ++sequence,
          type: 'snapshot',
          serverTime: new Date(serverTime).toISOString(),
          payload: current,
        }),
      );
    };
    disconnect = () => {
      void socket.close({ code: 1012, reason: 'Fixture restart' });
    };
    if (connections === 1) push();
  });
  await page.goto(`/overlay#${fragment}`);
  const overlay = page.getByRole('main', { name: 'Ripple broadcast overlay', exact: true });
  await expect(overlay.getByRole('heading', { name: '<Shell & Tide>', exact: true })).toBeVisible();
  await expect(overlay).toContainText('Synthetic world');
  await expect(overlay).toContainText('Energy 42/100');
  await expect(overlay).toContainText('Minority-preserved; only offer');
  await expect(overlay).toContainText('Vote in chat: !ripple 1 or 2 or 3');
  await expect(overlay).toContainText(/Closes in 00:2[0-4]/);
  await expect(overlay).toContainText('3 votes received');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await page.screenshot({ path: testInfo.outputPath('overlay.png'), omitBackground: true });
  await expectAccessible(page);
  if (push === undefined || disconnect === undefined) throw new Error('Missing scoped connection');
  current = { ...initial, round: { ...initial.round, voteCloseAtMs: serverTime - 1 } };
  push();
  await expect(overlay).toContainText('Waiting for the ballot result');
  await expect(overlay.getByText('Vote in chat:', { exact: false })).toHaveCount(0);
  current = { ...initial, round: { ...initial.round, phase: 'OBSERVING' } };
  push();
  await expect(
    overlay.getByRole('heading', { name: 'Observing habitat', exact: true }),
  ).toBeVisible();
  current = { ...current, paused: true };
  push();
  await expect(overlay).toContainText('Game paused · committed adaptations stay');
  current = { ...current, online: false };
  push();
  await expect(overlay).toContainText('Stream offline · active time is frozen');
  current = { ...initial, healthy: false };
  push();
  await expect(overlay).toContainText('Observation interrupted');
  current = initial;
  push();
  await expect(overlay).toContainText('Vote in chat:');
  disconnect();
  await expect(overlay).toContainText('Reconnecting · displaying last confirmed state');
  await expect(overlay.getByText('Vote in chat:', { exact: false })).toHaveCount(0);
  await expect.poll(() => connections).toBeGreaterThan(1);
  push();
  await expect(overlay).toContainText('Vote in chat:');
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await overlay.boundingBox();
  expect(bounds?.width).toBe(390);
  await expect(
    overlay.getByRole('heading', { name: '<Shell & Tide>', exact: true }),
  ).toBeInViewport();
  await expect(overlay.getByText('No votes: Hold the current genome.')).toBeInViewport();
});
test('trace overlay discloses the offered origin, concrete benefit and cost before Keep or Clear', async ({
  page,
}) => {
  const current = fixture();
  if (current.round === null) throw new Error('Missing fixture round');
  current.round.kind = 'TRACE';
  current.round.candidates = [
    {
      effect: 'Keep this habitat trace',
      tradeOff: 'Replace any active trace for three valid observations',
    },
    { effect: 'Clear this offer', tradeOff: 'Discard the offered trace' },
  ];
  current.round.counts = [0, 0];
  current.mechanics = {
    version: 1,
    enableRequested: false,
    tracesEnabled: true,
    state: mechanicsStateSchema.parse({
      traceRules: candidateRuleset.traces,
      activeTrace: null,
      pendingCount: 1,
      pendingTraces: [
        {
          id: world,
          version: 0,
          emitterId: channelId,
          emitterName: 'Visiting strain',
          lineageId: world,
          originChannelId: channelId,
          originLabel: 'Mira channel',
          qualifyingRoundId: world,
          template: 'shelter',
          status: 'pending',
          remainingRounds: 3,
          choice: null,
          reason: 'awaiting-vote',
        },
      ],
      recentTraces: [],
      dormant: [],
    }),
  };
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' } }),
  );
  await page.routeWebSocket('**/api/live?*', (socket) => {
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        eventId: channelId,
        worldId: world,
        topic: `channel:${channelId}`,
        stateVersion: 1,
        type: 'snapshot',
        serverTime: new Date().toISOString(),
        payload: current,
      }),
    );
  });
  await page.goto(`/overlay#${fragment}`);
  await expect(page.getByRole('heading', { name: 'Habitat trace', exact: true })).toBeVisible();
  await expect(page.getByText('Offered Shelter', { exact: false })).toContainText(
    'earned by Visiting strain from Mira channel',
  );
  await expect(page.getByText('Offered Shelter', { exact: false })).toContainText(
    'Arrival raw shock reduced by 2; upkeep increases by 1.',
  );
  await expect(page.getByText('No votes: Clear. Only 1 Keep or 2 Clear is valid.')).toBeVisible();
  await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('button')).toHaveCount(0);
});
test('overlay rejects an invalid link and re-authorizes a changed fragment without owner actions', async ({
  page,
}) => {
  await page.goto('/overlay');
  await expect(page.getByRole('status')).toContainText('Overlay link or renderer unsupported');
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'UNAUTHORIZED' } } }),
  );
  await page.goto(`/overlay#${fragment}`);
  await expect(page.getByRole('status')).toContainText('Overlay link expired or revoked');
  await expect(page.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('Vote in chat:', { exact: false })).toHaveCount(0);
});
test('overlay draws persisted gene-linked parts and bounded ancestry marks with text alternatives', async ({
  page,
}) => {
  const current = fixture();
  if (current.organism === null) throw new Error('Missing fixture organism');
  current.organism = {
    ...current.organism,
    genome: { pulse: 10, calm: 2, grit: 11, drift: 1 },
    appearanceMapping: 1,
    marks: {
      origin: { channelId, label: 'Mira channel' },
      ancestry: [
        { channelId: world, label: 'Second host' },
        { channelId: '33333333-3333-4333-8333-333333333333', label: 'Latest host' },
      ],
    },
  };
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' } }),
  );
  await page.routeWebSocket('**/api/live?*', (socket) => {
    socket.send(
      JSON.stringify({
        protocolVersion: 1,
        eventId: channelId,
        worldId: world,
        topic: `channel:${channelId}`,
        stateVersion: 1,
        type: 'snapshot',
        serverTime: new Date().toISOString(),
        payload: current,
      }),
    );
  });
  await page.goto(`/overlay#${fragment}`);
  const creature = page.getByRole('img', {
    name: '<Shell & Tide>. quick movement, armored plating, stubs. Origin mark: Mira channel; ancestry marks: Second host, Latest host',
    exact: true,
  });
  await expect(creature).toBeVisible();
  await expect(creature).toHaveAttribute('data-appendages', 'stubs');
  await expect(creature.locator('[data-mark="origin"]')).toHaveCount(1);
  await expect(creature.locator('[data-mark="ancestry"]')).toHaveCount(2);
  await expectAccessible(page);
  const moving = page.locator('[data-movement="quick"]');
  await expect(moving).not.toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(moving).toHaveCSS('animation-name', 'none');
});
test('overlay shows up to three family updates outside voting and yields to an open ballot', async ({
  page,
}) => {
  const voting = fixture();
  if (voting.round === null) throw new Error('Missing fixture round');
  voting.familyDigest = {
    items: [
      {
        kind: 'fossilized',
        lineageId: world,
        sequence: 5,
        organismId: world,
        organismName: '<Lost & Found>',
        generation: 2,
        host: { channelId: world, label: 'Far host' },
        traceTemplate: null,
      },
      {
        kind: 'trace_earned',
        lineageId: world,
        sequence: 4,
        organismId: world,
        organismName: 'Settler',
        generation: 1,
        host: { channelId: world, label: 'Near host' },
        traceTemplate: 'shelter',
      },
    ],
    remaining: 2,
  };
  const observing = { ...voting, round: { ...voting.round, phase: 'OBSERVING' } };
  let push: ((payload: typeof voting) => void) | undefined;
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' } }),
  );
  await page.routeWebSocket('**/api/live?*', (socket) => {
    let version = 0;
    push = (payload) => {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          eventId: channelId,
          worldId: world,
          topic: `channel:${channelId}`,
          stateVersion: ++version,
          type: 'snapshot',
          serverTime: new Date().toISOString(),
          payload,
        }),
      );
    };
    push(observing);
  });
  await page.goto(`/overlay#${fragment}`);
  const news = page.getByRole('region', { name: 'Family news since last stream' });
  await expect(news).toContainText('<Lost & Found> (generation 2) became a fossil at Far host');
  await expect(news).toContainText('Settler (generation 1) earned a Shelter trace at Near host');
  await expect(news).toContainText('2 more family updates in the lineage map');
  await expect(news.getByRole('listitem')).toHaveCount(2);
  push?.(voting);
  await expect(page.getByText('Vote in chat:', { exact: false })).toBeVisible();
  await expect(news).toHaveCount(0);
  push?.({ ...observing, familyDigest: null });
  await expect(page.getByRole('heading', { name: 'Observing habitat' })).toBeVisible();
  await expect(news).toHaveCount(0);
});
test('overlay applies the broadcaster layout, reduced motion and family-news preferences', async ({
  page,
}) => {
  const base = fixture();
  if (base.round === null || base.organism === null) throw new Error('Missing fixture');
  const current = {
    ...base,
    organism: { ...base.organism, appearanceMapping: 1 as const },
    round: { ...base.round, phase: 'OBSERVING' },
    familyDigest: {
      items: [
        {
          kind: 'admitted' as const,
          lineageId: world,
          sequence: 2,
          organismId: world,
          organismName: 'Traveller',
          generation: 1,
          host: { channelId: world, label: 'Far host' },
          traceTemplate: null,
        },
      ],
      remaining: 0,
    },
  };
  let push: ((payload: ChannelView) => void) | undefined;
  await page.route('**/api/overlay/exchange', (route) =>
    route.fulfill({ json: { ticket: 't'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' } }),
  );
  await page.routeWebSocket('**/api/live?*', (socket) => {
    let version = 0;
    push = (payload) => {
      socket.send(
        JSON.stringify({
          protocolVersion: 1,
          eventId: channelId,
          worldId: world,
          topic: `channel:${channelId}`,
          stateVersion: ++version,
          type: 'snapshot',
          serverTime: new Date().toISOString(),
          payload,
        }),
      );
    };
    push(current);
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`/overlay#${fragment}`);
  const overlay = page.getByRole('main', { name: 'Ripple broadcast overlay', exact: true }),
    creature = page.locator('[data-movement="sway"]');
  await expect(overlay).toHaveAttribute('data-layout', 'compact');
  await expect(page.getByRole('region', { name: 'Family news since last stream' })).toBeVisible();
  await expect(creature).not.toHaveCSS('animation-name', 'none');
  const compactWidth = (await creature.boundingBox())?.width ?? 0;
  push?.({ ...current, display: { layout: 'expanded', reducedMotion: true, familyNews: false } });
  await expect(overlay).toHaveAttribute('data-layout', 'expanded');
  await expect(creature).toHaveCSS('animation-name', 'none');
  await expect(page.getByRole('region', { name: 'Family news since last stream' })).toHaveCount(0);
  await expect
    .poll(async () => (await creature.boundingBox())?.width ?? 0)
    .toBeGreaterThan(compactWidth);
});
