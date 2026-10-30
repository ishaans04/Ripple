import { test, expect } from '@playwright/test';
import {
  channelViewSchema,
  founderShell,
  defaultStudioSettings,
  type StudioState,
} from '@ripple/contracts';
import { candidateRuleset, createStudioChallenge } from '@ripple/engine';
import { expectAccessible } from './axe.ts';

const worldId = '11111111-1111-4111-8111-111111111111',
  channelId = '22222222-2222-4222-8222-222222222222',
  neighborId = '33333333-3333-4333-8333-333333333333',
  sessionId = '44444444-4444-4444-8444-444444444444';
const judge = {
  worldId,
  channelId,
  neighborId,
  capability: 'o'.repeat(43),
  readCapability: 'r'.repeat(43),
  neighborReadCapability: 'n'.repeat(43),
};
const challenge = createStudioChallenge(
  {
    worldId,
    studioSessionId: sessionId,
    baseOrganismId: channelId,
    baseOrganismVersion: 0,
    genome: candidateRuleset.genome.founder,
    baseAppearanceHash: null,
    targetMutationSlot: 1,
  },
  candidateRuleset,
);

test('judge controls preserve capability boundaries, confirm a real editor blueprint and inspect replay', async ({
  page,
}, testInfo) => {
  const actions: Record<string, unknown>[] = [];
  let creating = false;
  const view = () =>
    channelViewSchema.parse({
      channelId,
      label: 'Synthetic judge home',
      mode: 'sandbox',
      online: true,
      healthy: true,
      paused: false,
      organism: {
        id: channelId,
        name: 'Tidepool',
        health: 70,
        status: 'ALIVE',
        genome: candidateRuleset.genome.founder,
        appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
      },
      round: null,
      ...(creating
        ? {
            studio: {
              enabled: true,
              availability: { state: 'REST', source: 'manual', bridgeStale: false },
              session: {
                id: sessionId,
                phase: 'CREATING',
                version: 1,
                trigger: 'manual',
                cosmeticOnly: false,
                challenge: {
                  templates: challenge.mutationTemplateIds,
                  genome: challenge.genome,
                  targetMutationSlot: 1,
                },
                creationCloseAtMs: Date.now() + 20_000,
                votingCloseAtMs: null,
                reviewExpiresAtMs: null,
                accepted: 0,
                maxProposals: defaultStudioSettings.maxProposals,
                finalists: [],
                counts: [],
                selection: null,
                pending: null,
                outcome: null,
              },
            },
          }
        : {}),
    });
  await page.route('**/api/sandbox**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/sandbox') return route.fulfill({ status: 201, json: judge });
    expect(route.request().headers().authorization).toBe(`Bearer ${judge.capability}`);
    if (url.pathname.endsWith('/actions')) {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      actions.push(body);
      if (body.action === 'studioStart') creating = true;
      return route.fulfill({ json: { synthetic: true, results: [{ code: 'APPLIED' }] } });
    }
    if (url.pathname.endsWith('/replay'))
      return route.fulfill({
        json: {
          replayWorldId: neighborId,
          sourceComparison: [{ equal: true }],
          channels: [
            { channelId, label: 'Synthetic replay', records: 20, readCapability: 'p'.repeat(43) },
          ],
        },
      });
    creating = false;
    return route.fulfill({ status: 201, json: { ...judge, worldId: neighborId } });
  });
  await page.route('**/api/worlds/*/snapshot?*', (route) => {
    expect(route.request().headers().authorization).toBe(`Bearer ${judge.capability}`);
    return route.fulfill({ json: { payload: view() } });
  });
  await page.route('**/api/studios/*', (route) => {
    const current = view();
    const state: StudioState = {
      worldId,
      channelId,
      label: current.label,
      serverTimeMs: Date.now(),
      challenge,
      organism: {
        name: 'Tidepool',
        genome: candidateRuleset.genome.founder,
        appearance: { kind: 'founder', part: founderShell },
      },
      studio: current.studio ?? {
        enabled: false,
        availability: { state: 'ACTIVE', source: 'manual', bridgeStale: false },
        session: null,
      },
    };
    return route.fulfill({ json: state });
  });
  await page.goto('/sandbox');
  await page.getByRole('button', { name: 'Start my sandbox' }).click();
  await expect(page.getByRole('heading', { name: 'Synthetic judge home' })).toBeVisible();
  await expect(page).toHaveURL(/#.*capability=/);
  await expect(page.getByRole('link', { name: 'Inspect round details' })).toHaveAttribute(
    'href',
    new RegExp(`capability=${judge.readCapability}`),
  );
  await page.getByRole('button', { name: 'Synthetic vote 2' }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({ action: 'vote', channelId, choice: 2, crowd: true });
  await page.getByRole('button', { name: 'Start break studio' }).click();
  await expect(page.getByText('Synthetic sandbox studio', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
  const width = page.getByRole('slider', { name: 'Shell width', exact: true });
  await width.focus();
  await width.press('End');
  await page.getByRole('button', { name: 'Review and submit' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(actions.filter((action) => action.action === 'propose')).toHaveLength(0);
  await page.getByRole('button', { name: 'Submit proposal', exact: true }).click();
  await expect.poll(() => actions.filter((action) => action.action === 'propose').length).toBe(1);
  expect(actions.find((action) => action.action === 'propose')).toMatchObject({
    channelId,
    blueprint: { worldId, studioSessionId: sessionId, part: { parameters: { width: 850 } } },
  });
  await page.getByRole('button', { name: 'Replay and verify' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Replay verified' })).toBeVisible();
  await expect(page.getByRole('link', { name: /inspect replay/ })).toHaveAttribute(
    'href',
    /capability=ppp/,
  );
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('sandbox.png'), fullPage: true });
  await page.getByRole('button', { name: 'Reset sandbox', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`worldId=${neighborId}`));
});

test('creation and expired-world failures show recovery without inventing success', async ({
  page,
}) => {
  await page.route('**/api/sandbox', (route) =>
    route.fulfill({ status: 429, json: { error: { message: 'All sandbox slots are in use.' } } }),
  );
  await page.goto('/sandbox');
  await page.getByRole('button', { name: 'Start my sandbox' }).click();
  await expect(page.getByRole('status')).toHaveText('All sandbox slots are in use.');
  await expect(page.getByRole('button', { name: 'Start my sandbox' })).toBeEnabled();
  await page.route('**/api/worlds/*/snapshot?*', (route) =>
    route.fulfill({ status: 410, json: {} }),
  );
  await page.goto(`/sandbox#${new URLSearchParams(judge).toString()}`);
  await expect(page.getByRole('status')).toContainText('Reset to start again');
  await expect(page.getByRole('button', { name: 'Reset sandbox', exact: true })).toBeEnabled();
});
