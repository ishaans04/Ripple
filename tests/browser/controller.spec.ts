import { test, expect } from '@playwright/test';
import { roundAnalysisSchema } from '@ripple/contracts';
import {
  candidateRuleset as rules,
  explainResolution,
  freezeBaseline,
  generateMutationCandidates,
  replayRejectedChoices,
  resolveObservation,
  rulesetHash,
  runAncestorTrial,
} from '@ripple/engine';
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

function analysisFixture(limited = false, identical = false) {
  const roundId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cards = generateMutationCandidates(
      { seed: 'browser-analysis', roundId, genome: rules.genome.founder },
      rules,
    );
  const first = cards[0];
  if (first === undefined) throw new Error('Missing fixture card');
  const selectedId = identical ? null : first.id,
    genome = identical ? rules.genome.founder : first.genome,
    resolution = resolveObservation(
      {
        genome,
        healthBefore: 70,
        observation: {
          status: 'complete',
          observations: limited
            ? []
            : ['a', 'b', 'c'].map((actorKey) => ({ actorKey, offsetMs: 0 })),
        },
        shocks: [],
        trace: null,
        baseline: freezeBaseline([], rules),
      },
      rules,
    );
  if (resolution.outcome === 'interrupted') throw new Error('Unexpected interrupted fixture');
  const score = resolution.outcome === 'applied' ? resolution.score : resolution.estimate,
    input = {
      genome,
      healthBefore: 70,
      profile: { burst: score.burst, steadiness: score.steadiness },
      shocks: [],
      trace: null,
    },
    identity = { engineVersion: 1, rulesHash: rulesetHash(rules) };
  return roundAnalysisSchema.parse({
    schemaVersion: 1,
    roundId,
    kind: 'MUTATION',
    rulesHash: identity.rulesHash,
    status: 'resolved',
    mechanicsVersion: 1,
    modelLabel: 'Fixed-input model comparisons; downstream viewer behavior is not simulated.',
    scoringStage: 'before-shelter-settlement',
    participants: [
      {
        organismId: channel,
        role: 'resident',
        actual: {
          outcome: resolution.outcome,
          healthBefore: 70,
          healthAfter: resolution.healthAfter,
          score,
          explanation: explainResolution(resolution, rules),
        },
        ancestor: limited
          ? null
          : {
              ...identity,
              ancestorId: channel,
              inputs: {
                schemaVersion: 1,
                scoreInput: input,
                arrival: null,
                scoringStage: 'before-shelter-settlement',
              },
              result: runAncestorTrial(input, rules.genome.founder, rules),
            },
      },
    ],
    alternative: {
      ...identity,
      confidence: limited ? 'limited' : 'confident',
      inputs: {
        genomeBefore: rules.genome.founder,
        candidates: cards,
        selectedId,
        actual: input,
        actualOutcome: resolution.outcome,
        actualHealthAfter: resolution.healthAfter,
        scoringStage: 'before-shelter-settlement',
      },
      result: replayRejectedChoices(
        { genomeBefore: rules.genome.founder, candidates: cards, selectedId, actual: input },
        rules,
      ),
    },
    settlement: null,
    traceAttribution: null,
    dormantOffer: null,
    cancellation: null,
  });
}

test('saved round analysis separates actual energy, ancestral shadow and rejected-choice models', async ({
  page,
}) => {
  const analysis = analysisFixture(),
    participant = analysis.participants[0];
  if (participant === undefined || participant.ancestor === null)
    throw new Error('Missing fixture comparison');
  const actual = participant.actual;
  let current = analysis;
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) =>
    route.fulfill({
      json: {
        ...status,
        snapshot: {
          version: 5,
          payload: {
            ...status.snapshot.payload,
            round: {
              id: analysis.roundId,
              number: 1,
              kind: 'MUTATION',
              phase: 'REVEAL',
              clock: { paused: false, remainingMs: 800, deadlineAtMs: null },
              candidates: [],
              counts: [],
              voteCloseAtMs: null,
              explanation: actual.explanation,
              analysis: current,
            },
          },
        },
      },
    }),
  );
  await page.goto('/controller');
  const panel = page.getByRole('region', { name: 'Round analysis', exact: true });
  await expect(
    panel.getByRole('heading', { name: 'Actual result · resident', exact: true }),
  ).toBeVisible();
  await expect(panel).toContainText(`Recorded energy 70 → ${actual.healthAfter}.`);
  await expect(panel).toContainText('downstream viewer behavior is not simulated');
  await expect(panel.getByLabel('Founding ancestor outline')).toBeVisible();
  await expect(panel).toContainText(
    `Shadow fitness ${participant.ancestor.result.ancestor.fitness}`,
  );
  await expect(
    panel.getByRole('region', { name: 'Rejected choices', exact: true }).getByRole('listitem'),
  ).toHaveCount(2);
  await panel.getByText('Complete recorded calculation', { exact: true }).click();
  for (const row of actual.explanation.calculation)
    await expect(panel).toContainText(`${row.formula} = ${row.value}`);
  current = analysisFixture(false, true);
  await expect(panel).toContainText('Identical founding genome: genetic contributions are equal.');
  await expect(panel.getByLabel('Founding ancestor outline')).toHaveCount(0);
  current = analysisFixture(true);
  await expect(panel).toContainText('Limited data: energy held; the score below is an estimate.');
  await expect(panel).toContainText('Recorded energy 70 → 70.');
  await expect(panel).toContainText('Insufficient valid data for an ancestor trial.');
  await expect(panel).toContainText('all comparisons are estimates; actual energy was held.');
});
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

test('choice previews show uncertain recent-profile estimates and replace them with Learning when needed', async ({
  page,
}) => {
  const cards = Array.from({ length: 3 }, (_, index) => ({
    candidateId: `candidate-${index}`,
    effect: `Adaptation ${index + 1}`,
    tradeOff: `Trade-off ${index + 1}`,
    source: index === 2 ? 'dormant' : 'generated',
    estimatedFitness: index,
    estimatedEnergyChange: index + 1,
    relativeToHold: index,
  }));
  const preview = {
    status: 'estimate',
    label: 'Based on recent activity',
    uncertainty: 'Estimate only; future chat, arrivals and category changes may differ.',
    sourceRoundId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    exogenousHash: 'a'.repeat(64),
    cards,
  };
  const payload = {
    ...status.snapshot.payload,
    online: true,
    healthy: true,
    round: {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      number: 2,
      kind: 'MUTATION',
      phase: 'VOTING',
      clock: { paused: false, remainingMs: 3000, deadlineAtMs: null },
      candidates: cards,
      counts: [0, 0, 0],
      voteCloseAtMs: null,
      explanation: null,
      choicePreview: preview,
    },
  };
  let current: unknown = payload;
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) =>
    route.fulfill({ json: { ...status, snapshot: { version: 2, payload: current } } }),
  );
  await page.goto('/controller');
  await expect(page.getByText('Based on recent activity.', { exact: false })).toBeVisible();
  await expect(page.getByText('Estimated energy change +2; +1 compared with Hold.')).toBeVisible();
  await expect(page.getByText('Trade-off 2.', { exact: false })).toBeVisible();
  await expect(
    page.getByText('Minority-preserved option from an earlier ballot. This is its only offer.'),
  ).toBeVisible();
  await expect(
    page.getByText('Estimate only; future chat, arrivals and category changes may differ.', {
      exact: false,
    }),
  ).toBeVisible();
  current = {
    ...payload,
    round: {
      ...payload.round,
      choicePreview: {
        ...preview,
        status: 'learning',
        reason: 'No valid habitat profile yet',
        cards: [],
      },
    },
  };
  await expect(
    page.getByText('Learning: No valid habitat profile yet.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('Estimated energy change', { exact: false })).toHaveCount(0);
});

test('trace controls send versioned owner requests and wait for committed settings', async ({
  page,
}) => {
  let committed = false;
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status', (route) =>
    route.fulfill({
      json: {
        ...status,
        snapshot: {
          version: committed ? 8 : 7,
          payload: {
            ...status.snapshot.payload,
            mechanics: { version: 1, enableRequested: false, tracesEnabled: !committed },
          },
        },
      },
    }),
  );
  await page.route(`**/api/channels/${channel}/control`, async (route) => {
    requests.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    expect(route.request().headers()['x-csrf-token']).toBe('csrf-test');
    expect(route.request().headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    await route.fulfill({ status: 202, json: { sequence: requests.length } });
  });
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({
      json: { result: committed ? { code: requests.length > 1 ? 'NO_CHANGE' : 'APPLIED' } : null },
    }),
  );
  await page.goto('/controller');
  await page.getByRole('button', { name: 'Disable habitat traces', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Waiting for its committed result');
  await expect(
    page.getByRole('button', { name: 'Disable habitat traces', exact: true }),
  ).toBeDisabled();
  expect(requests[0]).toEqual({ action: 'setTraces', enabled: false, expectedVersion: 7 });
  committed = true;
  await expect(
    page.getByRole('button', { name: 'Enable habitat traces', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByText('Traces disabled. Cleared offers stay cleared when you enable traces again.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear habitat traces', exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ action: 'clearTrace', expectedVersion: 8 });
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

test('historical invitation preserves its label and destination-scoped request versions', async ({
  page,
}) => {
  const offer = {
    ...propagation.admissions[0],
    version: 0,
    outcome: 'NOT_ENROLLED',
    destinationChannelId: null,
    destinationLabel: null,
  };
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status?claim=*', (route) => {
    expect(new URL(route.request().url()).searchParams.get('claim')).toBe(transfer);
    return route.fulfill({
      json: {
        ...status,
        historicalOffers: [offer],
        snapshot: {
          version: 12,
          payload: {
            ...status.snapshot.payload,
            propagation: { ...propagation, admissions: [], outgoing: [offer] },
          },
        },
      },
    });
  });
  await page.route('**/api/controller/blocks?*', (route) =>
    route.fulfill({ json: { kind: 'source', items: [], next: null } }),
  );
  const requests: unknown[] = [];
  await page.route(`**/api/channels/${channel}/control`, (route) => {
    requests.push(route.request().postDataJSON() as unknown);
    return route.fulfill({ status: 202, json: { sequence: 8 } });
  });
  await page.route('**/api/controller/commands/*', (route) =>
    route.fulfill({
      json: { result: { code: 'APPLIED', detail: { historical: true, outcome: 'OFFLINE_HOLD' } } },
    }),
  );
  await page.goto(`/controller#claim=${transfer}`);
  await expect(page.getByRole('region', { name: 'Historical raid invitations' })).toContainText(
    'It is not a new live raid',
  );
  await expect(
    page.getByRole('textbox', { name: `Historical raid invitation ${transfer}` }),
  ).toHaveValue(`http://127.0.0.1:${new URL(page.url()).port}/controller#claim=${transfer}`);
  await page.getByRole('button', { name: 'Request historical adoption from Tide channel' }).click();
  await expect(page.getByRole('status')).toHaveText(
    'Historical adoption recorded. Held while offline or paused.',
  );
  expect(requests).toEqual([
    { action: 'claimRaid', expectedVersion: 12, transferId: transfer, transferVersion: 0 },
  ]);
});

test('an unavailable historical invitation explains the account and expiry boundary without an adoption action', async ({
  page,
}) => {
  await page.route('**/api/connection', (route) => route.fulfill({ json: { liveEnabled: true } }));
  await page.route('**/api/controller/status?claim=*', (route) =>
    route.fulfill({ json: { ...status, historicalOffers: [] } }),
  );
  await page.goto(`/controller#claim=${transfer}`);
  const invitations = page.getByRole('region', { name: 'Historical raid invitations' });
  await expect(invitations).toContainText(
    'No unexpired historical invitation is available for this signed-in channel',
  );
  await expect(invitations.getByRole('button')).toHaveCount(0);
});
