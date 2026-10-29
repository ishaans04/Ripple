import type { RoundTimings } from '@ripple/contracts';
import { freezeBaseline, type BaselineRound } from './baseline.ts';
import { generatorFromSeedMaterial, shuffle } from './random.ts';
import { openRoundClock } from './round-clock.ts';
import type { RoundCheckpoint } from './round.ts';
import type { Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import type { SpecialOption } from './arrival.ts';

export type ScheduledBallot = 'MUTATION' | 'WELCOME' | 'TRACE' | 'PREPARATION';
interface BallotScheduleInput {
  pendingWelcome: boolean;
  pendingTrace: boolean;
  preparationRequested: boolean;
  nonMutationRounds: number;
}
export function nextBallot(
  input: BallotScheduleInput & { pendingTrace: false },
): Exclude<ScheduledBallot, 'TRACE'>;
export function nextBallot(input: BallotScheduleInput): ScheduledBallot;
export function nextBallot(input: BallotScheduleInput): ScheduledBallot {
  if (input.pendingWelcome) return 'WELCOME';
  if (input.nonMutationRounds >= 2) return 'MUTATION';
  if (input.pendingTrace) return 'TRACE';
  return input.preparationRequested ? 'PREPARATION' : 'MUTATION';
}
export function openSpecialRound(
  input: {
    kind: 'WELCOME' | 'PREPARATION' | 'TRACE';
    seed: string;
    roundId: string;
    genome: Genome;
    history: readonly BaselineRound[];
    atMs: number;
    timings: RoundTimings;
    options: readonly SpecialOption[];
    visitorId?: string;
    traceOffer?: NonNullable<RoundCheckpoint['specialBallot']>['traceOffer'];
  },
  rules: Ruleset,
): RoundCheckpoint {
  if (input.options.length < 2 || input.options.length > 3)
    throw new Error('Special ballots need two or three choices');
  const options =
    input.kind === 'TRACE'
      ? [...input.options]
      : shuffle(input.options, generatorFromSeedMaterial([input.seed, input.roundId, input.kind]));
  return {
    schemaVersion: 1,
    clock: openRoundClock(input.atMs, input.timings),
    candidates: [],
    baseline: freezeBaseline(input.history, rules),
    genomeBefore: { ...input.genome },
    counts: options.map(() => 0),
    shocks: [],
    specialBallot: {
      kind: input.kind,
      options,
      ...(input.visitorId === undefined ? {} : { visitorId: input.visitorId }),
      ...(input.traceOffer === undefined ? {} : { traceOffer: input.traceOffer }),
    },
  };
}
