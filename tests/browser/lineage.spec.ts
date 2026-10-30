import { test, expect, type Page } from '@playwright/test';
import {
  founderShell,
  lineageCatalogSchema,
  lineagePageSchema,
  passportSchema,
  type LineagePage,
  type Passport,
} from '@ripple/contracts';

const world = '22222222-2222-4222-8222-222222222222',
  channelId = '11111111-1111-4111-8111-111111111111',
  capability = 'c'.repeat(43),
  fragment = `worldId=${world}&channelId=${channelId}&capability=${capability}`,
  id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  host = (n: number, label: string) => ({ channelId: n === 0 ? channelId : id(900 + n), label }),
  home = host(0, 'Mira channel'),
  second = host(1, 'Second host'),
  third = host(2, 'Third host'),
  harbor = host(3, 'Harbor host'),
  at = '2026-10-30T10:00:00.000Z',
  genome = { pulse: 6, calm: 6, grit: 6, drift: 6 };
type Node = LineagePage['nodes'][number];
function node(
  n: number,
  parent: number | null,
  generation: number,
  name: string,
  lastHost: { channelId: string; label: string } | null,
  extra: Partial<Node> = {},
): Node {
  return {
    id: id(n),
    parentId: parent === null ? null : id(parent),
    founderId: id(1),
    generation,
    name,
    genome,
    health: 50,
    status: 'ALIVE',
    appearance: { kind: 'founder', rendererVersion: 'shell-v1', part: founderShell },
    appearanceMapping: 1,
    marks: { origin: home, ancestry: [] },
    hosts: [home],
    createdAt: at,
    lastHost:
      lastHost === null ? null : { ...lastHost, role: 'resident', startedAt: at, endedAt: null },
    birth: null,
    emittedTraces: 0,
    latestTrace: null,
    ...extra,
  };
}
const nodes = [
  node(1, null, 0, 'Founding strain', home),
  node(2, 1, 1, 'Travelling branch', second, {
    emittedTraces: 1,
    latestTrace: {
      id: id(50),
      template: 'shelter',
      status: 'expired',
      remainingRounds: 0,
      qualifyingRoundId: id(51),
      host: second,
    },
  }),
  node(3, 1, 1, 'Lost branch', third, {
    status: 'FOSSIL',
    health: 30,
    lastHost: { ...third, role: 'visitor', startedAt: at, endedAt: at },
  }),
  node(4, 2, 2, 'Waiting branch', harbor, {
    status: 'HARBOR',
    lastHost: { ...harbor, role: 'harbor', startedAt: at, endedAt: null },
  }),
];
const lineagePage = lineagePageSchema.parse({
  schemaVersion: 1,
  worldId: world,
  lineageId: id(100),
  mode: 'sandbox',
  origin: home,
  createdAt: at,
  rulesHash: 'a'.repeat(64),
  counts: { total: 4, alive: 2, harbor: 1, fossil: 1, archived: 0 },
  nodes,
  next: null,
});
const otherPage = lineagePageSchema.parse({
  ...lineagePage,
  lineageId: id(200),
  origin: second,
  counts: { total: 1, alive: 1, harbor: 0, fossil: 0, archived: 0 },
  nodes: [node(201, null, 0, 'Rival founder', second, { founderId: id(201) })],
});
const catalog = lineageCatalogSchema.parse({
  schemaVersion: 1,
  worldId: world,
  channelId,
  mode: 'sandbox',
  total: 2,
  lineages: [
    {
      lineageId: id(100),
      origin: home,
      createdAt: at,
      founder: { id: id(1), name: 'Founding strain', status: 'ALIVE' },
      counts: lineagePage.counts,
    },
    {
      lineageId: id(200),
      origin: second,
      createdAt: at,
      founder: { id: id(201), name: 'Rival founder', status: 'ALIVE' },
      counts: otherPage.counts,
    },
  ],
  next: null,
});
function passport(item: Node, older = false): Passport {
  const adaptation = (
    number: number,
    selection: Passport['adaptations']['items'][number]['selection'],
  ) => ({
    roundId: id(300 + number),
    number,
    host: home,
    openedAt: at,
    genomeBefore: genome,
    selection,
  });
  return passportSchema.parse({
    schemaVersion: 1,
    worldId: world,
    mode: 'sandbox',
    organism: {
      id: item.id,
      name: item.name,
      lineageId: id(100),
      generation: item.generation,
      status: item.status,
      health: item.health,
      genome: item.genome,
      foundingGenome: genome,
      appearance: item.appearance,
      appearanceMapping: 1,
      marks: item.id === id(2) ? { origin: home, ancestry: [second] } : item.marks,
      createdAt: at,
    },
    origin: home,
    parent:
      item.parentId === null
        ? null
        : { id: item.parentId, name: 'Founding strain', status: 'ALIVE' },
    founder: { id: id(1), name: 'Founding strain', status: 'ALIVE' },
    hosts: item.id === id(2) ? [home, second] : [home],
    residencies:
      item.lastHost === null
        ? []
        : [{ ...item.lastHost, startedAt: at, endedAt: item.lastHost.endedAt }],
    birth: null,
    adaptations: older
      ? { total: 3, items: [adaptation(1, { status: 'unrecorded' })], next: null }
      : {
          total: 3,
          items: [
            adaptation(3, { status: 'hold' }),
            adaptation(2, {
              status: 'selected',
              effect: 'Reinforce shell',
              tradeOff: 'Less burst affinity',
              source: 'dormant',
              genomeAfter: { pulse: 4, calm: 6, grit: 8, drift: 6 },
            }),
          ],
          next: '2',
        },
    dormant: {
      total: 1,
      items: [
        {
          id: id(60),
          sourceRoundId: id(301),
          origin: home,
          template: { from: 'pulse', to: 'calm', amount: 2 },
          supporters: 2,
          totalVotes: 5,
          status: 'consumed',
          offered: true,
          inherited: false,
          remainingRounds: 1,
          outcome: 'selected',
        },
      ],
    },
    traces:
      item.latestTrace === null ? { total: 0, items: [] } : { total: 1, items: [item.latestTrace] },
    ancestorTrials: {
      total: 1,
      items: [
        {
          roundId: id(302),
          number: 2,
          host: home,
          ancestorId: id(1),
          identicalGenome: false,
          fitnessDifference: -3,
          deltaDifference: 2,
        },
      ],
    },
  });
}
async function serve(page: Page, options: { revoked?: boolean } = {}) {
  const requests: string[] = [];
  await page.route('**/api/lineages**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    expect(route.request().headers().authorization).toBe(`Bearer ${capability}`);
    expect(url.searchParams.get('worldId')).toBe(world);
    if (options.revoked === true) return route.fulfill({ status: 401, json: {} });
    if (url.pathname === '/api/lineages') return route.fulfill({ json: catalog });
    return route.fulfill({ json: url.pathname.endsWith(id(200)) ? otherPage : lineagePage });
  });
  await page.route('**/api/organisms/*/passport**', (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    expect(route.request().headers().authorization).toBe(`Bearer ${capability}`);
    const organism = url.pathname.split('/')[3],
      item = [...nodes, ...otherPage.nodes].find((entry) => entry.id === organism);
    if (item === undefined) return route.fulfill({ status: 404, json: {} });
    return route.fulfill({ json: passport(item, url.searchParams.get('before') === '2') });
  });
  return requests;
}

test('lineage map shows competing lineages, fossils, trace attribution and the home passport', async ({
  page,
}, testInfo) => {
  const requests = await serve(page);
  await page.goto(`/lineage#${fragment}`);
  await expect(page.getByText('Synthetic world')).toBeVisible();
  const tree = page.getByRole('list', { name: 'Family tree' });
  await expect(tree.getByRole('button', { name: /^Founding strain Generation/ })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await expect(tree.getByRole('button', { name: /^Lost branch Generation/ })).toContainText(
    'fossil',
  );
  await expect(tree.getByRole('button', { name: /^Travelling branch Generation/ })).toContainText(
    '1 trace earned · latest Shelter at Second host (expired)',
  );
  const passportView = page.getByRole('article');
  await expect(passportView.getByRole('heading', { name: 'Founding strain' })).toBeVisible();
  await expect(passportView).toContainText('Committed mutation decisions (3)');
  await expect(passportView).toContainText('Round 3 at Mira channel: Hold');
  await expect(passportView).toContainText(
    'Reinforce shell — Less burst affinity · minority-preserved option',
  );
  await expect(passportView).toContainText('calm +2 / pulse −2 · 2 of 5 votes at Mira channel');
  await expect(passportView).toContainText('chosen by the receiving community');
  await expect(passportView).toContainText('Round 2 at Mira channel: fitness −3, energy +2');
  await page.screenshot({ path: testInfo.outputPath('lineage.png'), fullPage: true });
  await passportView.getByRole('button', { name: 'Show older decisions' }).click();
  await expect(passportView).toContainText('Round 1 at Mira channel: Selection not recorded');
  await expect(passportView.getByRole('button', { name: 'Show older decisions' })).toHaveCount(0);
  expect(requests.some((item) => item.includes('before=2'))).toBe(true);
  expect(requests.every((item) => !item.includes(capability))).toBe(true);
  await page.getByLabel('Lineage (2)').selectOption(id(200));
  await expect(tree.getByRole('button', { name: /^Rival founder Generation/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^Founding strain Generation/ })).toHaveCount(0);
});

test('lineage map collapses subtrees, filters by host and selects branches by keyboard', async ({
  page,
}) => {
  await serve(page);
  await page.goto(`/lineage#${fragment}`);
  const tree = page.getByRole('list', { name: 'Family tree' }),
    collapse = tree.getByRole('button', { name: "Collapse Founding strain's 3 descendants" });
  await collapse.click();
  await expect(
    tree.getByRole('button', { name: "Expand Founding strain's 3 descendants" }),
  ).toHaveAttribute('aria-expanded', 'false');
  await expect(tree.getByRole('button', { name: /^Lost branch Generation/ })).toHaveCount(0);
  await expect(tree).toContainText('3 descendants hidden');
  await tree.getByRole('button', { name: "Expand Founding strain's 3 descendants" }).click();
  await page.getByLabel('Host', { exact: true }).selectOption({ label: 'Harbor host' });
  await expect(tree.getByRole('button', { name: /^Waiting branch Generation/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^Travelling branch Generation/ })).toBeVisible();
  await expect(tree.getByRole('button', { name: /^Lost branch Generation/ })).toHaveCount(0);
  await page.getByLabel('Host', { exact: true }).selectOption({ label: 'All hosts' });
  const lost = tree.getByRole('button', { name: /^Lost branch Generation/ });
  await lost.focus();
  await page.keyboard.press('Enter');
  await expect(lost).toHaveAttribute('aria-current', 'true');
  const passportView = page.getByRole('article');
  await expect(passportView.getByRole('heading', { name: 'Lost branch' })).toBeVisible();
  await expect(passportView).toContainText('Fossil · history preserved');
  await expect(page.getByText('Lost branch has no descendants yet.')).toBeVisible();
  await tree.getByRole('button', { name: /^Travelling branch Generation/ }).click();
  await expect(page.getByRole('article')).toContainText(
    'Origin mark: Mira channel; ancestry marks: Second host',
  );
  await expect(page.getByRole('article')).toContainText('Shelter at Second host · expired');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Lineage map' })).toBeInViewport();
});

test('lineage page explains invalid and revoked links without showing fabricated history', async ({
  page,
}) => {
  await page.goto('/lineage');
  await expect(page.getByRole('alert')).toContainText('This lineage link is incomplete');
  await serve(page, { revoked: true });
  await page.goto(`/lineage#${fragment}`);
  await expect(page.getByRole('alert')).toContainText('This link was revoked or expired');
  await expect(page.getByRole('list', { name: 'Family tree' })).toHaveCount(0);
  await expect(page.getByRole('article')).toHaveCount(0);
});
