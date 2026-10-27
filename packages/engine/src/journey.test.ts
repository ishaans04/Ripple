import { describe, expect, it } from 'vitest';
import {
  arrivalShock,
  candidateRuleset as rules,
  childArrivalHealth,
  evaluateDormantOffer,
  explainResolution,
  generateMutationCandidates,
  qualifiesForTrace,
  resolveMutationBallot,
  resolveObservation,
  runAncestorTrial,
  selectDormantCapture,
  tallyVotes,
  traceTemplateFor,
  freezeBaseline,
  type ActivityObservation,
  type BallotVote,
  type Genome,
  type TraceTemplate,
} from './index.ts';

/*
 * PRD section 25.4, the worked deterministic journey, replayed through the
 * engine's public API. Source A's founder chooses +2 Calm/-2 Drift by eight
 * votes to two; the runner-up +2 Pulse/-2 Calm becomes dormant. A raid
 * carries a child to empty host B, whose bursty habitat later revives the
 * dormant option; the child then qualifies to offer a Charged habitat trace.
 */

/** Bucket i gets counts[i] distinct accounts. */
function habitat(counts: readonly number[], channel: string): ActivityObservation[] {
  return counts.flatMap((count, bucket) =>
    Array.from({ length: count }, (_, n) => ({
      actorKey: `${channel}-chatter-${n}`,
      offsetMs: bucket * 10_000 + 4_000,
    })),
  );
}

// m = 30, q = 12: burst round(1000 * 18 / 90) = 200, steadiness 800.
const sourceHabitat = habitat([4, 4, 4, 2, 2, 2, 2, 2, 2, 2, 2, 2], 'a');
// m = 40, q = 37: burst round(1000 * 108 / 120) = 900, steadiness 100.
const hostHabitat = habitat([13, 12, 12, 1, 1, 1, 0, 0, 0, 0, 0, 0], 'b');

function votes(channel: string, ...choices: number[]): BallotVote[] {
  return choices.map((choice, n) => ({ actorKey: `${channel}-voter-${n}`, choice }));
}

function observeAtHost(genome: Genome, healthBefore: number, trace: TraceTemplate | null) {
  return resolveObservation(
    {
      genome,
      healthBefore,
      observation: { status: 'complete', observations: hostHabitat },
      shocks: [],
      trace,
      baseline: freezeBaseline([], rules),
    },
    rules,
  );
}

function playJourney() {
  const founder = rules.genome.founder;
  const founderHealth = rules.health.founder;

  // Source mutation: a ten-vote ballot at A.
  const sourceCards = generateMutationCandidates(
    { seed: 'journey-source-a-67', roundId: 'a-round-1', genome: founder },
    rules,
  );
  const sourceBallot = resolveMutationBallot(sourceCards, votes('a', 1, 1, 1, 1, 2, 1, 1, 2, 1, 1));
  const sourceGenome =
    sourceBallot.outcome.kind === 'mutation' ? sourceBallot.outcome.candidate.genome : founder;
  const dormant = selectDormantCapture(
    { candidates: sourceCards, tally: sourceBallot.tally, captureBurst: 200 },
    rules,
  );

  // Source observation at A.
  const sourceObservation = resolveObservation(
    {
      genome: sourceGenome,
      healthBefore: founderHealth,
      observation: { status: 'complete', observations: sourceHabitat },
      shocks: [],
      trace: null,
      baseline: freezeBaseline([], rules),
    },
    rules,
  );
  const parentHealth = sourceObservation.healthAfter;

  // Real raid to enrolled, empty B: the child inherits a snapshot of the genome.
  const childGenome = sourceGenome;
  const childHealth = childArrivalHealth(parentHealth, sourceGenome, rules);

  // B welcome: Conserve leaves the arrival shock at its normal strength.
  const welcomeRound = resolveObservation(
    {
      genome: childGenome,
      healthBefore: childHealth,
      observation: { status: 'complete', observations: hostHabitat },
      shocks: [arrivalShock(rules)],
      trace: null,
      baseline: freezeBaseline([], rules),
    },
    rules,
  );

  // Next mutation at B, judged only on the known profile from the welcome round.
  const knownProfile = welcomeRound.outcome === 'applied' ? welcomeRound.profile : null;
  const dormantOffer =
    dormant === null
      ? null
      : evaluateDormantOffer(
          { capture: dormant, genome: childGenome, recentProfile: knownProfile },
          rules,
        );
  const hostCards = generateMutationCandidates(
    {
      seed: 'journey-host-b-1',
      roundId: 'b-round-2',
      genome: childGenome,
      ...(dormantOffer?.eligible === true ? { dormantMove: dormantOffer.move } : {}),
    },
    rules,
  );
  const hostBallot = resolveMutationBallot(hostCards, votes('b', 3, 3, 1, 3));
  const adaptedGenome =
    hostBallot.outcome.kind === 'mutation' ? hostBallot.outcome.candidate.genome : childGenome;

  // Next valid observation at B, and the ancestor shadow beside it.
  const nextRound = observeAtHost(adaptedGenome, welcomeRound.healthAfter, null);
  const shadow = runAncestorTrial(
    {
      genome: adaptedGenome,
      healthBefore: welcomeRound.healthAfter,
      profile: { burst: 900, steadiness: 100 },
      shocks: [],
      trace: null,
    },
    founder,
    rules,
  );

  // Trace qualification after two valid surviving rounds at B.
  const validRoundsAtB = [welcomeRound, nextRound].filter(
    (round) => round.outcome === 'applied' && !round.extinct,
  ).length;
  const qualified = qualifiesForTrace(
    {
      raidOrigin: true,
      validSurvivingRounds: validRoundsAtB,
      qualifiedThisResidency: false,
      lineageQualifiedAtHostThisSeason: false,
    },
    rules,
  );
  const template = traceTemplateFor(adaptedGenome, rules);

  // Trace ballot: 1 Keep, 2 Clear. Kept, it applies for three valid rounds.
  const traceVote = tallyVotes(votes('b-trace', 1, 1, 2, 1), 2);
  const kept = traceVote.winnerIndex === 0;
  let health = nextRound.healthAfter;
  const traceRounds = [];
  for (let round = 0; round < 3; round += 1) {
    const resolution = observeAtHost(adaptedGenome, health, kept ? template : null);
    traceRounds.push(resolution);
    health = resolution.healthAfter;
  }

  return {
    sourceCards,
    sourceBallot,
    sourceGenome,
    dormant,
    sourceObservation,
    parentHealth,
    childHealth,
    welcomeRound,
    dormantOffer,
    hostCards,
    hostBallot,
    adaptedGenome,
    nextRound,
    shadow,
    validRoundsAtB,
    qualified,
    template,
    traceVote,
    traceRounds,
  };
}

describe('PRD section 25.4 worked deterministic journey', () => {
  const journey = playJourney();

  it('Source mutation: the genome becomes [6,8,6,4], the budget stays 24, and the runner-up is dormant', () => {
    expect(journey.sourceCards.slice(0, 2).map((card) => card.id)).toEqual([
      'calm+2/drift-2',
      'pulse+2/calm-2',
    ]);
    expect(journey.sourceBallot.tally).toMatchObject({ counts: [8, 2, 0], totalVotes: 10 });
    expect(journey.sourceGenome).toEqual({ pulse: 6, calm: 8, grit: 6, drift: 4 });
    expect(Object.values(journey.sourceGenome).reduce((sum, gene) => sum + gene, 0)).toBe(24);
    expect(journey.dormant).toEqual({
      move: { from: 'calm', to: 'pulse', amount: 2 },
      supporters: 2,
      totalVotes: 10,
      captureBurst: 200,
    });
  });

  it('Source observation: fit rounds to 3, upkeep 3, no shock, so health stays 70', () => {
    expect(journey.sourceObservation.outcome).toBe('applied');
    if (journey.sourceObservation.outcome === 'applied') {
      expect(journey.sourceObservation.profile).toMatchObject({ burst: 200, steadiness: 800 });
      expect(journey.sourceObservation.score).toMatchObject({
        fit: 3,
        upkeep: 3,
        shock: 0,
        delta: 0,
      });
    }
    expect(journey.sourceObservation.healthAfter).toBe(70);
  });

  it('Real raid to enrolled empty B: the child starts at floor(70 * 430 / 1000) = 30, the parent stays at 70', () => {
    expect(journey.childHealth).toBe(30);
    expect(journey.parentHealth).toBe(70);
  });

  it('B welcome: Conserve; burst 900, raw shock 4, Grit protection 3; fit 2, delta -2, health 28', () => {
    const round = journey.welcomeRound;
    expect(round.outcome).toBe('applied');
    if (round.outcome === 'applied') {
      expect(round.profile).toMatchObject({ burst: 900, steadiness: 100 });
      expect(round.score).toMatchObject({
        rawShock: 4,
        gritProtection: 3,
        shock: 1,
        fit: 2,
        delta: -2,
      });
    }
    expect(round.healthAfter).toBe(28);
    expect(explainResolution(round, rules).causes.map((cause) => cause.text)).toEqual([
      'Arrival shock hit for 4',
      'Grit blocked 3 of the shock',
    ]);
  });

  it('Next mutation at B: the profile moved 700 units and the rebased dormant move fits better; chat selects [8,6,6,4]', () => {
    expect(journey.dormantOffer).toEqual({
      eligible: true,
      move: { from: 'calm', to: 'pulse', amount: 2 },
      rebasedGenome: { pulse: 8, calm: 6, grit: 6, drift: 4 },
      profileChange: 700,
      currentFit: 2,
      rebasedFit: 3,
    });
    expect(journey.hostCards[2]).toMatchObject({ id: 'pulse+2/calm-2', source: 'dormant' });
    expect(journey.hostBallot.outcome).toMatchObject({ kind: 'mutation', index: 2 });
    expect(journey.adaptedGenome).toEqual({ pulse: 8, calm: 6, grit: 6, drift: 4 });
  });

  it('Next valid observation: no new arrival shock; fit 3, upkeep 3; delta 0; health remains 28', () => {
    const round = journey.nextRound;
    expect(round.outcome).toBe('applied');
    if (round.outcome === 'applied') {
      expect(round.score).toMatchObject({ rawShock: 0, fit: 3, upkeep: 3, delta: 0 });
    }
    expect(round.healthAfter).toBe(28);
  });

  it('Ancestor shadow: the founding [6,6,6,6] under matched inputs scores fit 2, upkeep 3, delta -1 and changes no live health', () => {
    expect(journey.shadow.ancestor).toMatchObject({
      genome: { pulse: 6, calm: 6, grit: 6, drift: 6 },
      healthBefore: 28,
      fit: 2,
      upkeep: 3,
      delta: -1,
    });
    expect(journey.shadow.current).toMatchObject({ fit: 3, delta: 0 });
    expect(journey.nextRound.healthAfter).toBe(28);
  });

  it('Trace qualification: two valid surviving rounds at B offer Charged habitat', () => {
    expect(journey.validRoundsAtB).toBe(2);
    expect(journey.qualified).toBe(true);
    expect(journey.template).toBe('charged');
  });

  it('Trace vote and activation: Keep; burst stays 900; net trace adjustment +1 for three valid rounds', () => {
    expect(journey.traceVote.winnerIndex).toBe(0);
    expect(journey.traceRounds).toHaveLength(3);
    for (const round of journey.traceRounds) {
      expect(round.outcome).toBe('applied');
      if (round.outcome === 'applied') {
        expect(round.profile.burst).toBe(900);
        expect(round.score.trace).toEqual({ template: 'charged', effect: 'fitness', amount: 1 });
        expect(round.score.delta).toBe(1);
      }
    }
    expect(journey.traceRounds.map((round) => round.healthAfter)).toEqual([29, 30, 31]);
  });

  it('replays to the identical result from the same recorded inputs', () => {
    expect(playJourney()).toEqual(journey);
  });

  it('follows the selected alternative when chat rejects the dormant option', () => {
    const rejected = resolveMutationBallot(journey.hostCards, votes('b', 1, 1, 3));
    expect(rejected.outcome).toMatchObject({ kind: 'mutation', index: 0 });
    if (rejected.outcome.kind === 'mutation') {
      expect(rejected.outcome.candidate.source).toBe('generated');
      expect(rejected.outcome.candidate.genome).not.toEqual({
        pulse: 8,
        calm: 6,
        grit: 6,
        drift: 4,
      });
    }
  });

  it('activates no modifier when the trace is cleared, including by default with no votes', () => {
    expect(tallyVotes(votes('b-trace', 2, 2, 1), 2).winnerIndex).toBe(1);
    expect(tallyVotes([], 2).winnerIndex).toBeNull();
    const cleared = observeAtHost(journey.adaptedGenome, 28, null);
    expect(cleared.outcome === 'applied' && cleared.score.trace).toBeNull();
    expect(cleared.healthAfter).toBe(28);
  });
});
