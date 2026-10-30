import {
  buildActivityProfile,
  candidateRuleset,
  forkBlock,
  tallyVotes,
  resolveVisitorContest,
  canonicalJson,
  consumeValidRound,
  newValidRoundLifetime,
  inheritValidRoundLifetime,
} from '@ripple/engine';

/** Executable adversarial measurements; a failing invariant stops evidence generation. */
export function auditPolicies() {
  const rules = candidateRuleset;
  const singleAccount = Array.from({ length: 1000 }, (_, i) => ({
    actorKey: 'one-account',
    offsetMs: (i % 12) * 10_000,
  }));
  const spam = buildActivityProfile(singleAccount, rules);
  if (spam.confidence !== 'limited' || spam.contributions !== 12)
    throw new Error('Concentrated-account cap failed');
  const votes = tallyVotes(
    Array.from({ length: 1000 }, (_, i) => ({ actorKey: 'one-account', choice: (i % 3) + 1 })),
    3,
  );
  if (votes.totalVotes !== 1 || votes.counts[0] !== 1) throw new Error('First valid vote failed');
  let branches = 1,
    capBlocks = 0,
    cooldownBlocks = 0;
  const pairs = new Map<number, number>();
  for (let attempt = 0; attempt < 50; attempt++) {
    const atMs = attempt * 180_000,
      host = attempt % 12;
    const block = forkBlock({
      sourceEligible: true,
      sameChannel: false,
      livingBranches: branches,
      parentGeneration: 0,
      lastPairForkAtMs: pairs.get(host) ?? null,
      atMs,
    });
    if (block === null) {
      branches++;
      pairs.set(host, atMs);
    }
    if (block === 'LINEAGE_CAP') capBlocks++;
  }
  for (let attempt = 1; attempt < 10; attempt++)
    if (
      forkBlock({
        sourceEligible: true,
        sameChannel: false,
        livingBranches: 2,
        parentGeneration: 0,
        lastPairForkAtMs: 0,
        atMs: attempt * 1000,
      }) === 'FORK_COOLDOWN'
    )
      cooldownBlocks++;
  if (branches !== 12 || capBlocks !== 39 || cooldownBlocks !== 9)
    throw new Error('Loop/cap policy failed');
  const shelter = resolveVisitorContest({
    confidence: 'confident',
    residentHealth: 70,
    visitorHealth: 20,
    residentFitness: 0,
    visitorFitness: -1,
    shelterPending: true,
  });
  const next = resolveVisitorContest({
    confidence: 'confident',
    residentHealth: shelter.residentHealth,
    visitorHealth: shelter.visitorHealth,
    residentFitness: 0,
    visitorFitness: -1,
    shelterPending: shelter.shelterPending,
  });
  if (
    (shelter.residentHealth ?? 0) + shelter.visitorHealth !== 90 ||
    shelter.shelterPending ||
    next.outcome !== 'resident'
  )
    throw new Error('Finite shelter policy failed');
  let lifetime = newValidRoundLifetime('birth', 3);
  for (const round of ['a', 'b', 'c']) {
    lifetime = consumeValidRound(lifetime, round, true);
    const migrated = inheritValidRoundLifetime(lifetime);
    if (canonicalJson(consumeValidRound(migrated, round, true)) !== canonicalJson(lifetime))
      throw new Error('Migration renewed a trace or dormant allowance');
    lifetime = migrated;
  }
  if (lifetime.remainingRounds !== 0) throw new Error('Lifetime did not expire');
  return {
    concentratedAccount: {
      messages: 1000,
      contributions: spam.contributions,
      distinctAccounts: spam.distinctAccounts,
      confidence: spam.confidence,
    },
    duplicateVotes: {
      attempts: 1000,
      accepted: votes.totalVotes,
      ignored: votes.ignoredDuplicates,
    },
    repeatedHostLoops: { attempts: 50, retainedBranches: branches, capBlocks, cooldownBlocks },
    shelter: {
      moved: shelter.moved,
      totalHealthBefore: 90,
      totalHealthAfter: (shelter.residentHealth ?? 0) + shelter.visitorHealth,
      nextContest: next.outcome,
    },
    migratedLifetime: lifetime,
  };
}
