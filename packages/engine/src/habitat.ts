import { EngineError } from './errors.ts';
import { clamp, floorDiv, roundHalfUp } from './integer.ts';
import { PROFILE_SCALE, type Ruleset } from './ruleset.ts';

/**
 * One accepted ordinary local chat message, reduced to what the habitat
 * needs. Ripple commands, the bot, mirrored Shared Chat copies, and duplicate
 * receipts are excluded before this point; message text is never retained.
 */
export interface ActivityObservation {
  /** Scoped pseudonymous account key. */
  readonly actorKey: string;
  /** Active milliseconds since the observation window opened. */
  readonly offsetMs: number;
}

export type Confidence = 'confident' | 'limited';

/** The temporal shape of one complete observation window. */
export interface ActivityProfile {
  /** Distinct accounts heard in each bucket. */
  readonly bucketCounts: readonly number[];
  /** m: accepted account/bucket contributions. */
  readonly contributions: number;
  /** q: contributions in the busiest burstTopBuckets buckets. */
  readonly topBucketContributions: number;
  readonly distinctAccounts: number;
  /** Concentration of activity in [0, PROFILE_SCALE]. */
  readonly burst: number;
  /** PROFILE_SCALE - burst. */
  readonly steadiness: number;
  /** True when nobody spoke: burst and steadiness are a neutral display value, not a measurement. */
  readonly neutral: boolean;
  /** Limited below the configured number of distinct contributing accounts. */
  readonly confidence: Confidence;
}

const NEUTRAL_BURST = floorDiv(PROFILE_SCALE, 2);

/**
 * Burst and steadiness for a complete observation window. Each account counts
 * at most once per bucket. With B buckets, the top k of them holding q of m
 * contributions, burst is clamp(round_half_up(1000 * (B*q - k*m) / ((B-k)*m)), 0, 1000):
 * 0 when activity is spread evenly, 1000 when it all falls in k buckets. For
 * B = 12 and k = 3 this is the PRD's (4q - m) / 3m. Scaling every bucket by
 * the same factor leaves it unchanged, so raw channel volume does not matter.
 */
export function buildActivityProfile(
  observations: readonly ActivityObservation[],
  rules: Ruleset,
): ActivityProfile {
  const { bucketMs, bucketCount, burstTopBuckets, confidenceMinAccounts } = rules.habitat;
  const windowMs = bucketMs * bucketCount;
  const heard = Array.from({ length: bucketCount }, () => new Set<string>());
  const accounts = new Set<string>();
  for (const { actorKey, offsetMs } of observations) {
    if (actorKey.length === 0) {
      throw new EngineError('INVALID_ARGUMENT', 'an observation needs an account key');
    }
    if (!Number.isSafeInteger(offsetMs) || offsetMs < 0 || offsetMs >= windowMs) {
      throw new EngineError(
        'INVALID_ARGUMENT',
        `observation offsets must be integers in [0, ${windowMs})`,
      );
    }
    heard[floorDiv(offsetMs, bucketMs)]?.add(actorKey);
    accounts.add(actorKey);
  }
  const bucketCounts = heard.map((bucket) => bucket.size);
  const contributions = bucketCounts.reduce((sum, n) => sum + n, 0);
  const topBucketContributions = [...bucketCounts]
    .sort((a, b) => b - a)
    .slice(0, burstTopBuckets)
    .reduce((sum, n) => sum + n, 0);
  const neutral = contributions === 0;
  const burst = neutral
    ? NEUTRAL_BURST
    : clamp(
        roundHalfUp(
          PROFILE_SCALE * (bucketCount * topBucketContributions - burstTopBuckets * contributions),
          (bucketCount - burstTopBuckets) * contributions,
        ),
        0,
        PROFILE_SCALE,
      );
  return {
    bucketCounts,
    contributions,
    topBucketContributions,
    distinctAccounts: accounts.size,
    burst,
    steadiness: PROFILE_SCALE - burst,
    neutral,
    confidence: accounts.size >= confidenceMinAccounts ? 'confident' : 'limited',
  };
}

export type ShockKind = 'arrival' | 'category_change';

/** An explicit, persisted shock: an arrival or a stream category change, never an inferred event. */
export interface ShockMarker {
  readonly kind: ShockKind;
  readonly amount: number;
}

export function arrivalShock(rules: Ruleset): ShockMarker {
  return { kind: 'arrival', amount: rules.shock.arrival };
}

export function categoryChangeShock(rules: Ruleset): ShockMarker {
  return { kind: 'category_change', amount: rules.shock.categoryChange };
}
