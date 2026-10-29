import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical.ts';

/** Independent immutable policy so existing ruleset hashes and accepted histories stay valid. */
export const mechanicsPolicySchema = z
  .strictObject({
    version: z.literal('mechanics-policy-1'),
    dormantRounds: z.int().min(1).max(3),
    traceRounds: z.int().min(1).max(3),
    pendingTraceRounds: z.int().min(1).max(3),
  })
  .readonly();
export type MechanicsPolicy = z.infer<typeof mechanicsPolicySchema>;
export const candidateMechanicsPolicy: MechanicsPolicy = mechanicsPolicySchema.parse({
  version: 'mechanics-policy-1',
  dormantRounds: 3,
  traceRounds: 3,
  pendingTraceRounds: 3,
});
export function mechanicsPolicyHash(policy: MechanicsPolicy): string {
  return sha256Hex(canonicalJson(mechanicsPolicySchema.parse(policy)));
}

export interface ValidRoundLifetime {
  readonly birthRoundId: string;
  readonly remainingRounds: number;
  /** Bounded by the initial allowance; old deliveries cannot consume the allowance twice. */
  readonly countedRoundIds: readonly string[];
}
const lifetimeSchema = z
  .strictObject({
    birthRoundId: z.string().min(1).max(128),
    remainingRounds: z.int().min(0).max(3),
    countedRoundIds: z.array(z.string().min(1).max(128)).max(3),
  })
  .refine(
    (value) =>
      value.remainingRounds + value.countedRoundIds.length <= 3 &&
      new Set(value.countedRoundIds).size === value.countedRoundIds.length &&
      !value.countedRoundIds.includes(value.birthRoundId),
    'Invalid valid-round allowance',
  );
function frozen(value: ValidRoundLifetime): ValidRoundLifetime {
  return Object.freeze({ ...value, countedRoundIds: Object.freeze([...value.countedRoundIds]) });
}
export function newValidRoundLifetime(birthRoundId: string, rounds: number): ValidRoundLifetime {
  z.int().min(1).max(3).parse(rounds);
  return frozen(
    lifetimeSchema.parse({ birthRoundId, remainingRounds: rounds, countedRoundIds: [] }),
  );
}
/** Invalid/limited intervals, capture itself and repeated accepted closes consume nothing. */
export function consumeValidRound(
  lifetime: ValidRoundLifetime,
  roundId: string,
  valid: boolean,
): ValidRoundLifetime {
  lifetimeSchema.parse(lifetime);
  z.string().min(1).max(128).parse(roundId);
  if (
    !valid ||
    lifetime.remainingRounds === 0 ||
    roundId === lifetime.birthRoundId ||
    lifetime.countedRoundIds.includes(roundId)
  )
    return lifetime;
  return frozen({
    ...lifetime,
    remainingRounds: lifetime.remainingRounds - 1,
    countedRoundIds: [...lifetime.countedRoundIds, roundId],
  });
}
/** Migration snapshots the remaining allowance and deduplication history; it never renews either. */
export function inheritValidRoundLifetime(lifetime: ValidRoundLifetime): ValidRoundLifetime {
  return frozen(lifetimeSchema.parse(lifetime));
}
