import { chromium, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { channelViewSchema, type ChannelView } from '@ripple/contracts';
import { judgeSchema } from '../apps/web/src/sandbox/api.ts';

// Actual installed application + PostgreSQL, no intercepted requests or fixture responses.
const started = performance.now();
const browser = await chromium.launch({
  ...(process.env.JUDGE_BROWSER_CHANNEL ? { channel: process.env.JUDGE_BROWSER_CHANNEL } : {}),
});
const context = await browser.newContext({
  baseURL: process.env.JUDGE_BASE_URL ?? 'http://127.0.0.1:3000',
});
const page = await context.newPage();
try {
  await page.goto('/');
  await page.getByRole('link', { name: 'Try sandbox' }).click();
  await page.getByRole('button', { name: 'Start my sandbox' }).click();
  await expect(page.getByRole('button', { name: 'Next scheduled step' })).toBeEnabled();
  await expect(page).toHaveURL(/#.*capability=/);
  const judge = judgeSchema.parse(
    Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.slice(1))),
  );
  async function state(channelId = judge.channelId): Promise<ChannelView> {
    const response = await page.request.get(
      `/api/worlds/${judge.worldId}/snapshot?channelId=${channelId}`,
      { headers: { authorization: `Bearer ${judge.capability}` } },
    );
    if (!response.ok()) throw new Error(`Snapshot ${response.status()}`);
    return channelViewSchema.parse(((await response.json()) as { payload: unknown }).payload);
  }
  async function click(name: string) {
    const button = page.getByRole('button', { name, exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect(
      page.getByRole('button', { name: 'Next scheduled step', exact: true }),
    ).toBeEnabled();
  }
  await click('Synthetic vote 1');
  await click('Next scheduled step');
  await click('Add local chat');
  await click('Change habitat');
  await click('Next scheduled step');
  if (!(await state()).round?.analysis) throw new Error('Missing actual round/ancestor analysis');
  await click('Simulate raid to other channel');
  await click('Neighbor channel');
  await click('Next scheduled step');
  await click('Next scheduled step');
  if (!(await state(judge.neighborId)).propagation?.visitor)
    throw new Error('No actual visitor arrived');
  await click('Home channel');
  await click('Next scheduled step');
  await click('Start break studio');
  await expect(page.getByText('Synthetic sandbox studio', { exact: true })).toBeVisible();
  const width = page.getByRole('slider', { name: 'Shell width', exact: true });
  await width.focus();
  await width.press('End');
  await click('Review and submit');
  await click('Submit proposal');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await click('Next scheduled step');
  await expect(page.getByRole('heading', { name: 'Choose the community shell' })).toBeVisible();
  await click('Synthetic vote 1');
  await click('Next scheduled step');
  await click('Approve design');
  for (let step = 0; step < 6 && (await state()).studio?.session?.phase !== 'COMPLETED'; step++)
    await click('Next scheduled step');
  const hatched = await state();
  if (
    hatched.studio?.session?.phase !== 'COMPLETED' ||
    hatched.organism?.appearance.kind !== 'studio'
  )
    throw new Error('Actual studio did not hatch');
  await click('Replay and verify');
  await expect(page.getByRole('status').filter({ hasText: 'Replay verified' })).toBeVisible();
  await expect(page.getByRole('link', { name: /inspect replay/ })).toHaveCount(2);
  const map = await page.context().newPage();
  const lineageLink = await page
    .getByRole('link', { name: 'Lineage and passports', exact: true })
    .getAttribute('href');
  if (!lineageLink) throw new Error('Missing lineage inspection link');
  await map.goto(new URL(lineageLink, page.url()).toString());
  await expect(map.getByRole('heading', { name: /lineage/i }).first()).toBeVisible();
  await map.close();
  await click('Reset sandbox');
  await expect(page).not.toHaveURL(new RegExp(`worldId=${judge.worldId}`));
  const elapsedMs = Math.round(performance.now() - started);
  if (elapsedMs >= 180_000) throw new Error(`Installed browser journey took ${elapsedMs}ms`);
  const report = {
    synthetic: true,
    mockedRequests: 0,
    elapsedMs,
    browser: browser.version(),
    journey:
      'landing-mutation-habitat-raid-studio-pointer-confirm-vote-approve-hatch-replay-lineage-reset',
    liveAcceptance: false,
  };
  if (process.env.JUDGE_EVIDENCE_PATH)
    await writeFile(process.env.JUDGE_EVIDENCE_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await browser.close();
}
