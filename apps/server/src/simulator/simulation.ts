import {
  candidateRuleset,
  canonicalJson,
  sha256Hex,
  rulesetHash,
  generateMutationCandidates,
  buildActivityProfile,
  resolveObservation,
  runAncestorTrial,
  selectDormantCapture,
  evaluateDormantOffer,
  tallyVotes,
  newValidRoundLifetime,
  consumeValidRound,
  childArrivalHealth,
  forkBlock,
  prepareArrival,
  welcomeArrival,
  resolveVisitorContest,
  scoreRound,
  traceTemplateFor,
  qualifiesForTrace,
  type Genome,
  type HabitatProfile,
  type DormantCapture,
  type ValidRoundLifetime,
  type TraceTemplate,
  type Ruleset,
} from '@ripple/engine';
import { habitats, observationsFor, heldOutSeeds, tuningSeeds, type Habitat } from './habitats.ts';
import { chooseCard, policies, type Policy } from './policies.ts';

export interface TrialConfig {
  habitat: Habitat;
  policy: Policy;
  seed: string;
  size: 'small' | 'large';
  rounds: number;
  trace: 'keep' | 'clear';
  shelter: boolean;
}
export interface TrialResult {
  config: TrialConfig;
  roundsSurvived: number;
  validRounds: number;
  limitedRounds: number;
  health: number;
  genome: Genome;
  arrivals: number;
  arrivalDeaths: number;
  branches: number;
  capBlocks: number;
  cooldownBlocks: number;
  shelters: number;
  dormantCaptures: number;
  dormantOffers: number;
  dormantActivations: number;
  ancestorDifference: number;
  traceRounds: number;
  traceFitnessTotal: number;
  maxTraceAdjustment: number;
  bursts: number[];
  historyHash: string;
}
/** Pure bounded experiment; clocks, files, networking and databases stay in the CLI adapters. */
export function simulateTrial(config: TrialConfig, rules: Ruleset = candidateRuleset): TrialResult {
  let genome: Genome = { ...rules.genome.founder },
    health = rules.health.founder;
  let recent: HabitatProfile | null = null;
  let dormant: { capture: DormantCapture; lifetime: ValidRoundLifetime } | null = null;
  let activeTrace: { template: TraceTemplate; lifetime: ValidRoundLifetime } | null = null;
  const result: TrialResult = {
    config,
    roundsSurvived: 0,
    validRounds: 0,
    limitedRounds: 0,
    health,
    genome,
    arrivals: 0,
    arrivalDeaths: 0,
    branches: 1,
    capBlocks: 0,
    cooldownBlocks: 0,
    shelters: 0,
    dormantCaptures: 0,
    dormantOffers: 0,
    dormantActivations: 0,
    ancestorDifference: 0,
    traceRounds: 0,
    traceFitnessTotal: 0,
    maxTraceAdjustment: 0,
    bursts: [],
    historyHash: '',
  };
  const history: unknown[] = [];
  const lastPairs = new Map<number, number>();
  const traceQualifiedHosts = new Set<number>();
  for (let round = 0; round < config.rounds && health > 0; round++) {
    const id = `round-${round}`;
    const offer =
      dormant && dormant.lifetime.remainingRounds > 0
        ? evaluateDormantOffer({ capture: dormant.capture, genome, recentProfile: recent }, rules)
        : null;
    const cards = generateMutationCandidates(
      {
        seed: config.seed,
        roundId: id,
        genome,
        ...(offer?.eligible ? { dormantMove: offer.move } : {}),
      },
      rules,
    );
    if (offer?.eligible) result.dormantOffers++;
    const chosen = chooseCard(config.policy, cards, recent, config.seed, round, rules);
    const chosenIndex = cards.indexOf(chosen);
    const votes = Array.from({ length: 10 }, (_, i) => ({
      actorKey: `v${i}`,
      choice: (i < 6 ? chosenIndex : (chosenIndex + 1) % cards.length) + 1,
    }));
    const capture = selectDormantCapture(
      {
        candidates: cards,
        tally: tallyVotes(votes, cards.length),
        captureBurst: recent?.burst ?? null,
      },
      rules,
    );
    if (offer?.eligible) {
      if (chosen.source === 'dormant') result.dormantActivations++;
      dormant = null;
    }
    if (capture) {
      result.dormantCaptures++;
      dormant = { capture, lifetime: newValidRoundLifetime(id, 3) };
    }
    genome = chosen.genome;
    const observations = observationsFor(config.habitat, config.seed, round, config.size);
    const profile = buildActivityProfile(observations, rules);
    const arrival = config.habitat === 'raid-heavy' && round % 2 === 0;
    const shocks = arrival ? [{ kind: 'arrival' as const, amount: 4 }] : [];
    const trace =
      activeTrace && activeTrace.lifetime.remainingRounds > 0 ? activeTrace.template : null;
    const resolved = resolveObservation(
      {
        genome,
        healthBefore: health,
        observation: { status: 'complete', observations },
        shocks,
        trace,
        baseline: {
          status: 'learning',
          roundIds: [],
          intensity: null,
          intensitySpread: null,
          burst: null,
        },
      },
      rules,
    );
    if (resolved.outcome === 'applied') {
      result.validRounds++;
      result.bursts.push(profile.burst);
      recent = profile;
      const input = { genome, healthBefore: health, profile, shocks, trace };
      result.ancestorDifference += runAncestorTrial(
        input,
        rules.genome.founder,
        rules,
      ).fitnessDifference;
      if (trace) {
        result.traceRounds++;
        const without = scoreRound({ ...input, trace: null }, rules);
        const difference = resolved.score.fitness - without.fitness;
        result.traceFitnessTotal += difference;
        result.maxTraceAdjustment = Math.max(
          result.maxTraceAdjustment,
          Math.abs(resolved.score.trace?.amount ?? 0),
        );
      }
      health = resolved.healthAfter;
      if (dormant) dormant.lifetime = consumeValidRound(dormant.lifetime, id, true);
      if (activeTrace) activeTrace.lifetime = consumeValidRound(activeTrace.lifetime, id, true);
    } else result.limitedRounds++;
    if (arrival && health > 0) {
      const destination = round % 4;
      const atMs = round * 180_000;
      const block = forkBlock({
        sourceEligible: true,
        sameChannel: false,
        livingBranches: result.branches,
        parentGeneration: 0,
        lastPairForkAtMs: lastPairs.get(destination) ?? null,
        atMs,
      });
      if (block === 'LINEAGE_CAP') result.capBlocks++;
      else if (block === 'FORK_COOLDOWN') result.cooldownBlocks++;
      else if (block === null) {
        lastPairs.set(destination, atMs);
        result.arrivals++;
        const preparation = prepareArrival(health, genome, 'reserve', rules);
        const welcome = welcomeArrival(
          preparation.health,
          config.shelter ? 'shelter' : 'conserve',
          preparation.shockReduction,
          rules,
        );
        const child = scoreRound(
          {
            genome,
            healthBefore: welcome.health,
            profile,
            shocks: [{ kind: 'arrival', amount: 4 }],
            trace,
          },
          rules,
        );
        const contest = resolveVisitorContest({
          confidence: profile.confidence,
          residentHealth: 70,
          visitorHealth: child.healthAfter,
          residentFitness: scoreRound(
            { genome: rules.genome.founder, healthBefore: 70, profile, shocks: [], trace },
            rules,
          ).fitness,
          visitorFitness: child.fitness,
          shelterPending: welcome.shelterPending,
        });
        if (contest.outcome === 'sheltered') result.shelters++;
        if (child.extinct || contest.outcome === 'resident') result.arrivalDeaths++;
        else result.branches++;
        // A successful child is evaluated for the required surviving rounds before emitting.
        let childHealth = contest.visitorHealth;
        for (let visit = 1; visit < rules.traces.qualifyingRounds && childHealth > 0; visit++)
          childHealth = scoreRound(
            { genome, healthBefore: childHealth, profile, shocks: [], trace },
            rules,
          ).healthAfter;
        if (
          childHealth > 0 &&
          !child.extinct &&
          contest.outcome !== 'resident' &&
          qualifiesForTrace(
            {
              raidOrigin: true,
              validSurvivingRounds: rules.traces.qualifyingRounds,
              qualifiedThisResidency: false,
              lineageQualifiedAtHostThisSeason: traceQualifiedHosts.has(destination),
            },
            rules,
          )
        ) {
          traceQualifiedHosts.add(destination);
          if (config.trace === 'keep')
            activeTrace = {
              template: traceTemplateFor(genome, rules),
              lifetime: newValidRoundLifetime(id, 3),
            };
        }
        history.push({ arrivalHealth: childArrivalHealth(health, genome, rules), child, contest });
      }
    }
    result.roundsSurvived = round + 1;
    history.push({ id, chosen: chosen.id, profile, resolved, dormant });
  }
  result.health = health;
  result.genome = genome;
  result.historyHash = sha256Hex(canonicalJson(history));
  return result;
}

export function simulateMatrix(
  split: 'tuning' | 'held-out',
  rounds = 36,
  rules: Ruleset = candidateRuleset,
) {
  const seeds = split === 'tuning' ? tuningSeeds : heldOutSeeds;
  const trials: TrialResult[] = [];
  for (const seed of seeds)
    for (const habitat of habitats)
      for (const policy of policies)
        for (const size of ['small', 'large'] as const)
          for (const trace of ['keep', 'clear'] as const)
            for (const shelter of [false, true])
              trials.push(
                simulateTrial({ seed, habitat, policy, size, rounds, trace, shelter }, rules),
              );
  return {
    schemaVersion: 1,
    split,
    rulesHash: rulesetHash(rules),
    seedsHash: sha256Hex(canonicalJson(seeds)),
    trials,
  };
}
