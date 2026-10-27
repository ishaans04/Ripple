import { EngineError } from './errors.ts';
import type { Confidence } from './habitat.ts';
import { roundHalfUp } from './integer.ts';
import { PROFILE_SCALE, type Ruleset } from './ruleset.ts';

/** The numbers a closed, complete observation round contributes to its channel's history. */
export interface BaselineRound {
  readonly roundId: string;
  /** m: accepted account/bucket contributions. */
  readonly contributions: number;
  readonly burst: number;
  readonly confidence: Confidence;
}

/**
 * A channel's habitat history, frozen before a round opens and stored with
 * it. It gives context (is chat quieter or busier than usual?) and never
 * scales energy.
 */
export interface FrozenBaseline {
  /** Learning until enough valid rounds exist. */
  readonly status: 'learning' | 'established';
  /** The valid rounds the baseline was computed from, oldest first. */
  readonly roundIds: readonly string[];
  /** Mean contributions per round; null while learning. */
  readonly intensity: number | null;
  /** Mean absolute deviation of contributions; null while learning. */
  readonly intensitySpread: number | null;
  /** Mean burst; null while learning. */
  readonly burst: number | null;
}

function assertBaselineRound(round: BaselineRound, rules: Ruleset): void {
  const { roundId, contributions, burst, confidence } = round;
  if (roundId.length === 0) {
    throw new EngineError('INVALID_ARGUMENT', 'a baseline round needs its round ID');
  }
  if (!Number.isSafeInteger(contributions) || contributions < 0) {
    throw new EngineError('INVALID_ARGUMENT', 'contributions must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(burst) || burst < 0 || burst > PROFILE_SCALE) {
    throw new EngineError('INVALID_ARGUMENT', `burst must be an integer in [0, ${PROFILE_SCALE}]`);
  }
  if (confidence === 'confident' && contributions < rules.habitat.confidenceMinAccounts) {
    throw new EngineError('INVALID_ARGUMENT', 'a confident round has a contribution per account');
  }
}

/**
 * Freeze a baseline from a channel's complete observation rounds in close
 * order. Only valid rounds (complete and confident) count, and only the last
 * windowRounds of them; interrupted intervals never reach this history.
 */
export function freezeBaseline(history: readonly BaselineRound[], rules: Ruleset): FrozenBaseline {
  for (const round of history) {
    assertBaselineRound(round, rules);
  }
  const window = history
    .filter((round) => round.confidence === 'confident')
    .slice(-rules.baseline.windowRounds);
  const roundIds = window.map((round) => round.roundId);
  if (window.length < rules.baseline.minRounds) {
    return { status: 'learning', roundIds, intensity: null, intensitySpread: null, burst: null };
  }
  const n = window.length;
  const total = window.reduce((sum, round) => sum + round.contributions, 0);
  // Mean absolute deviation, exact: sum |n*m_i - total| / n^2.
  const deviation = window.reduce(
    (sum, round) => sum + Math.abs(n * round.contributions - total),
    0,
  );
  return {
    status: 'established',
    roundIds,
    intensity: roundHalfUp(total, n),
    intensitySpread: roundHalfUp(deviation, n * n),
    burst: roundHalfUp(
      window.reduce((sum, round) => sum + round.burst, 0),
      n,
    ),
  };
}

export type IntensityBand = 'learning' | 'quieter' | 'typical' | 'busier';

export interface BaselineComparison {
  /** Outside one spread of the baseline intensity is quieter or busier; learning while learning. */
  readonly band: IntensityBand;
  /** Contributions in permille of the baseline intensity; a neutral 1000 while learning. */
  readonly relativeIntensity: number;
  /** Burst minus the baseline burst; 0 while learning. */
  readonly burstShift: number;
}

/** Place a round's activity against its frozen baseline, for display and explanation only. */
export function compareToBaseline(
  profile: { readonly contributions: number; readonly burst: number },
  baseline: FrozenBaseline,
): BaselineComparison {
  const { intensity, intensitySpread, burst } = baseline;
  if (intensity === null || intensitySpread === null || burst === null) {
    return { band: 'learning', relativeIntensity: PROFILE_SCALE, burstShift: 0 };
  }
  const band: IntensityBand =
    profile.contributions < intensity - intensitySpread
      ? 'quieter'
      : profile.contributions > intensity + intensitySpread
        ? 'busier'
        : 'typical';
  return {
    band,
    relativeIntensity: roundHalfUp(PROFILE_SCALE * profile.contributions, intensity),
    burstShift: profile.burst - burst,
  };
}
