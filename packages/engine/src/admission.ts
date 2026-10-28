import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical.ts';

/** Independent versioned propagation policy; every transfer records its canonical value/hash. */
export const raidPolicySchema = z
  .strictObject({
    version: z.literal('raid-policy-1'),
    livingLineageCap: z.int().min(1).max(12),
    generationCap: z.int().min(1).max(16),
    harborCap: z.int().min(1).max(3),
    forkCooldownMs: z.int().min(1800000).max(86400000),
    admissionTtlMs: z.int().min(60000).max(86400000),
    shieldCost: z.int().min(0).max(4),
    shieldShockReduction: z.int().min(0).max(2),
    acclimateCost: z.int().min(0).max(4),
    acclimateShockReduction: z.int().min(0).max(2),
    shelterMinHealth: z.int().min(2).max(100),
    shelterTransfer: z.int().min(0).max(5),
    maxNonMutationRounds: z.literal(2),
  })
  .readonly();
export type RaidPolicy = z.infer<typeof raidPolicySchema>;
export const candidateRaidPolicy: RaidPolicy = raidPolicySchema.parse({
  version: 'raid-policy-1',
  livingLineageCap: 12,
  generationCap: 16,
  harborCap: 3,
  forkCooldownMs: 1800000,
  admissionTtlMs: 86400000,
  shieldCost: 4,
  shieldShockReduction: 2,
  acclimateCost: 4,
  acclimateShockReduction: 1,
  shelterMinHealth: 50,
  shelterTransfer: 5,
  maxNonMutationRounds: 2,
});
export function raidPolicyHash(policy: RaidPolicy): string {
  return sha256Hex(canonicalJson(raidPolicySchema.parse(policy)));
}
export type ForkBlock =
  'SOURCE_INELIGIBLE' | 'SELF_RAID' | 'LINEAGE_CAP' | 'GENERATION_CAP' | 'FORK_COOLDOWN';
export function forkBlock(
  input: {
    sourceEligible: boolean;
    sameChannel: boolean;
    livingBranches: number;
    parentGeneration: number;
    lastPairForkAtMs: number | null;
    atMs: number;
  },
  policy: RaidPolicy = candidateRaidPolicy,
): ForkBlock | null {
  z.strictObject({
    sourceEligible: z.boolean(),
    sameChannel: z.boolean(),
    livingBranches: z.int().nonnegative(),
    parentGeneration: z.int().nonnegative(),
    lastPairForkAtMs: z.int().nonnegative().nullable(),
    atMs: z.int().nonnegative(),
  }).parse(input);
  if (!input.sourceEligible) return 'SOURCE_INELIGIBLE';
  if (input.sameChannel) return 'SELF_RAID';
  if (input.parentGeneration >= policy.generationCap) return 'GENERATION_CAP';
  if (input.livingBranches >= policy.livingLineageCap) return 'LINEAGE_CAP';
  if (
    input.lastPairForkAtMs !== null &&
    input.atMs - input.lastPairForkAtMs < policy.forkCooldownMs
  )
    return 'FORK_COOLDOWN';
  return null;
}
export type AdmissionOutcome =
  | 'NOT_ENROLLED'
  | 'SOURCE_BLOCKED'
  | 'POLICY_REJECTED'
  | 'RULES_INCOMPATIBLE'
  | 'GRANT_REVOKED'
  | 'INPUT_UNAVAILABLE'
  | 'OFFLINE_HOLD'
  | 'PENDING_APPROVAL'
  | 'HARBOR'
  | 'HARBOR_FULL'
  | 'ACTIVE';
export interface AdmissionInput {
  enrolled: boolean;
  sourceBlocked: boolean;
  policy: 'ask' | 'accept' | 'reject';
  approved: boolean;
  rulesCompatible: boolean;
  authorized: boolean;
  healthy: boolean;
  online: boolean;
  paused: boolean;
  visitorBusy: boolean;
  waitingAhead: number;
}
/** Waiting count excludes this arrival. No existing visitor is evicted to make room. */
export function admissionOutcome(
  input: AdmissionInput,
  policy: RaidPolicy = candidateRaidPolicy,
): AdmissionOutcome {
  if (!input.enrolled) return 'NOT_ENROLLED';
  if (input.sourceBlocked) return 'SOURCE_BLOCKED';
  if (input.policy === 'reject') return 'POLICY_REJECTED';
  if (input.waitingAhead >= policy.harborCap) return 'HARBOR_FULL';
  if (!input.rulesCompatible) return 'RULES_INCOMPATIBLE';
  if (!input.authorized) return 'GRANT_REVOKED';
  if (!input.healthy) return 'INPUT_UNAVAILABLE';
  if (!input.online || input.paused) return 'OFFLINE_HOLD';
  if (input.policy === 'ask' && !input.approved) return 'PENDING_APPROVAL';
  if (input.visitorBusy) return 'HARBOR';
  return 'ACTIVE';
}
export function admissionExpired(atMs: number, expiresAtMs: number): boolean {
  return atMs >= expiresAtMs;
}
