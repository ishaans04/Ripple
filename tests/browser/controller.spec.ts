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
