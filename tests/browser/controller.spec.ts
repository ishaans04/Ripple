import { test, expect } from '@playwright/test';
const channel = '11111111-1111-4111-8111-111111111111',
  world = '22222222-2222-4222-8222-222222222222';
const status = {
  worldId: world,
  channelId: channel,
  csrfToken: 'csrf-test',
  authorized: true,
  botAuthorized: false,
  callbackReady: false,
  subscriptionsReady: false,
  subscriptions: [],
  settings: {
    input_error: 'BOT_AUTHORIZATION_REQUIRED',
    visitor_policy: 'ask',
    last_seed_at: null,
    seed_cooldown_ms: 180000,
  },
  snapshot: {
    version: 0,
    payload: {
      channelId: channel,
      label: 'Synthetic browser fixture',
      mode: 'sandbox',
      online: false,
      healthy: false,
      paused: false,
      organism: null,
      round: null,
    },
  },
  readClients: 0,
};
test('controller explains disabled live mode without offering a broken authorization link', async ({
  page,
}) => {
  await page.goto('/controller');
  await expect(page.getByRole('heading', { name: 'Channel controller' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Live Twitch is disabled');
  await expect(page.getByRole('link', { name: 'Connect broadcaster with Twitch' })).toHaveCount(0);
});
test('controller distinguishes sign-in from ready subscriptions and recovers from a stale owner command', async ({
  page,
}) => {
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) => route.fulfill({ json: status }));
  await page.route(`**/api/channels/${channel}/seed`, (route) =>
    route.fulfill({ status: 409, json: { error: { code: 'STALE_VERSION' } } }),
  );
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({ status: 404, json: { error: { code: 'NOT_FOUND' } } }),
  );
  await page.goto('/controller');
  await expect(page.getByText('Operator bot: operator authorization needed')).toBeVisible();
  await expect(page.getByText('Signed callback: waiting for Twitch verification')).toBeVisible();
  await expect(page.getByText('Read-only preview: not connected')).toBeVisible();
  await page.getByLabel('Approved strain name').fill('<Shell & Tide>');
  await page.getByRole('button', { name: 'Seed strain', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('The channel changed');
  await expect(page.getByRole('button', { name: 'Seed strain', exact: true })).toBeEnabled();
});
test('controller retains an uncertain command id and retries it unchanged before reporting commitment', async ({
  page,
}) => {
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) => route.fulfill({ json: status }));
  const keys: string[] = [];
  let committed = false;
  await page.route(`**/api/channels/${channel}/seed`, async (route) => {
    keys.push(route.request().headers()['idempotency-key'] ?? 'missing-key');
    if (keys.length === 1) await route.abort();
    else {
      committed = true;
      await route.fulfill({ status: 202, json: { operationId: keys[0], sequence: 1 } });
    }
  });
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({ json: { result: committed ? { code: 'APPLIED' } : null } }),
  );
  await page.goto('/controller');
  await page.getByLabel('Approved strain name').fill('Tide');
  await page.getByRole('button', { name: 'Seed strain', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Connection lost');
  await page.getByRole('button', { name: 'Retry pending command' }).click();
  await expect(page.getByRole('status')).toHaveText('Change committed.');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
});
test('read-only preview explains an invalid link without showing fabricated state', async ({
  page,
}) => {
  await page.goto('/preview');
  await expect(page.getByRole('status')).toContainText('link or renderer state is unsupported');
  await expect(page.getByRole('button')).toHaveCount(0);
});

const lineage = '33333333-3333-4333-8333-333333333333',
  transfer = '44444444-4444-4444-8444-444444444444',
  source = '55555555-5555-4555-8555-555555555555',
  child = '66666666-6666-4666-8666-666666666666';
const propagation = {
  preparation: 'shield',
  preparationRequested: false,
  resident: null,
  visitor: null,
  admissions: [
    {
      id: transfer,
      version: 3,
      outcome: 'PENDING_APPROVAL',
      childId: child,
      lineageId: lineage,
      sourceChannelId: source,
      sourceLabel: 'Tide channel',
      destinationChannelId: channel,
      destinationLabel: 'Receiver',
      expiresAt: '2026-10-29T00:00:00Z',
      createdAt: '2026-10-28T00:00:00Z',
    },
  ],
  outgoing: [],
  limits: {
    livingLineageCap: 12,
    harborCap: 3,
    generationCap: 16,
    forkCooldownMs: 1800000,
    admissionTtlMs: 86400000,
  },
  lastContest: null,
};
test('visitor approval submits current transfer and channel versions and waits for the committed result', async ({
  page,
}) => {
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) =>
    route.fulfill({
      json: {
        ...status,
        snapshot: { version: 12, payload: { ...status.snapshot.payload, propagation } },
      },
    }),
  );
  await page.route('**/api/controller/blocks?*', (route) =>
    route.fulfill({ json: { kind: 'source', items: [], next: null } }),
  );
  const bodies: unknown[] = [];
  let committed = false;
  await page.route(`**/api/channels/${channel}/control`, async (route) => {
    bodies.push(route.request().postDataJSON() as unknown);
    await route.fulfill({ status: 202, json: { operationId: 'queued', sequence: 8 } });
  });
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({ json: { result: committed ? { code: 'APPLIED' } : null } }),
  );
  await page.goto('/controller');
  await expect(page.getByRole('region', { name: 'Raids and lineage' })).toContainText(
    'Standing travel choice: shield',
  );
  await expect(page.getByRole('button', { name: 'Queue preparation ballot' })).toBeDisabled();
  await page.getByRole('button', { name: 'Approve visitor from Tide channel' }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for its committed result');
  await expect(
    page.getByRole('button', { name: 'Decline visitor from Tide channel' }),
  ).toBeDisabled();
  expect(bodies).toEqual([
    {
      action: 'admission',
      expectedVersion: 12,
      transferId: transfer,
      transferVersion: 3,
      decision: 'accept',
    },
  ]);
  committed = true;
  await expect(page.getByRole('status')).toHaveText('Change committed.');
});
test('lineage moderation is separate from visitor refusal and paginates source blocks', async ({
  page,
}) => {
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) =>
    route.fulfill({
      json: {
        ...status,
        snapshot: { version: 12, payload: { ...status.snapshot.payload, propagation } },
      },
    }),
  );
  await page.route('**/api/controller/blocks?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    return route.fulfill({
      json: {
        kind: query.get('kind'),
        items: query.has('after')
          ? [{ id: source, label: 'Second page source' }]
          : [{ id: channel, label: 'First page source' }],
        next: query.has('after') ? null : channel,
      },
    });
  });
  const bodies: unknown[] = [];
  await page.route(`**/api/channels/${channel}/control`, async (route) => {
    bodies.push(route.request().postDataJSON() as unknown);
    await route.fulfill({ status: 202, json: { sequence: 9 } });
  });
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({ json: { result: { code: 'APPLIED' } } }),
  );
  await page.goto('/controller');
  await page.getByRole('button', { name: 'Block this lineage' }).click();
  await expect(page.getByRole('status')).toHaveText('Change committed.');
  expect(bodies[0]).toEqual({
    action: 'blockLineage',
    expectedVersion: 12,
    lineageId: lineage,
    blocked: true,
  });
  await page.getByRole('button', { name: 'Next blocks' }).click();
  await page.getByRole('button', { name: 'Unblock Second page source' }).click();
  await expect(page.getByRole('status')).toHaveText('Change committed.');
  expect(bodies[1]).toEqual({
    action: 'blockSource',
    sourceChannelId: source,
    expectedVersion: 12,
    blocked: false,
  });
  await expect(page.getByRole('button', { name: 'First page' })).toBeVisible();
});

for (const lateResponse of ['accepted', 'disconnected'] as const)
  test(`a late ${lateResponse} response cannot overwrite an already committed visitor decision`, async ({
    page,
  }) => {
    await page.route('**/api/connection', (route) =>
      route.fulfill({ json: { liveEnabled: true } }),
    );
    await page.route('**/api/controller/status', (route) =>
      route.fulfill({
        json: {
          ...status,
          snapshot: { version: 12, payload: { ...status.snapshot.payload, propagation } },
        },
      }),
    );
    await page.route('**/api/controller/blocks?*', (route) =>
      route.fulfill({ json: { kind: 'source', items: [], next: null } }),
    );
    let release: (() => void) | undefined;
    const accepted = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/api/channels/${channel}/control`, async (route) => {
      await accepted;
      if (lateResponse === 'accepted') await route.fulfill({ status: 202, json: { sequence: 8 } });
      else await route.abort('failed');
    });
    await page.route('**/api/controller/commands/*', (route) =>
      route.fulfill({ json: { result: { code: 'APPLIED' } } }),
    );
    await page.goto('/controller');
    const approve = page.getByRole('button', { name: 'Approve visitor from Tide channel' });
    await approve.click();
    try {
      await expect(page.getByRole('status')).toHaveText('Change committed.');
      await expect(approve).toBeDisabled();
    } finally {
      release?.();
    }
    await expect(approve).toBeEnabled();
    await expect(page.getByRole('status')).toHaveText('Change committed.');
  });
