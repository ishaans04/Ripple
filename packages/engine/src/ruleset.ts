import { z } from 'zod';
import { canonicalJson, sha256Hex } from './canonical.ts';
import { EngineError } from './errors.ts';
import { GENES, isLegalGenome } from './genome.ts';

/** Version of the rule implementations in this package. */
export const ENGINE_VERSION = 1;

/** Burst and steadiness are integers in [0, PROFILE_SCALE] that sum to PROFILE_SCALE. */
export const PROFILE_SCALE = 1000;

const count = z.int().min(0);
const positive = z.int().min(1);

const rulesetSchema = z
  .strictObject({
    version: z.string().min(1).max(64),
    engineVersion: positive,
    genome: z
      .strictObject({
        min: count,
        max: positive,
        budget: count,
        mutationStep: positive,
        founder: z
          .strictObject({ pulse: z.int(), calm: z.int(), grit: z.int(), drift: z.int() })
          .readonly(),
      })
      .readonly(),
    ballot: z.strictObject({ mutationCandidates: positive }).readonly(),
    health: z.strictObject({ max: positive, founder: positive }).readonly(),
    habitat: z
      .strictObject({
        bucketMs: positive,
        bucketCount: positive,
        burstTopBuckets: positive,
        confidenceMinAccounts: positive,
      })
      .readonly(),
    baseline: z.strictObject({ windowRounds: positive, minRounds: positive }).readonly(),
    scoring: z
      .strictObject({
        fitWeight: count,
        upkeep: count,
        rawShockCap: count,
        gritProtectionMax: count,
        deltaMin: z.int(),
        deltaMax: z.int(),
      })
      .readonly(),
    shock: z.strictObject({ arrival: count, categoryChange: count }).readonly(),
    traces: z
      .strictObject({
        qualifyingRounds: positive,
        adjustmentMin: z.int(),
        adjustmentMax: z.int(),
        shelterArrivalShockReduction: count,
        shelterUpkeep: count,
        chargedBurstThreshold: count,
        chargedAdjustment: count,
        recoveryHealthThreshold: count,
        recoveryAdjustment: count,
      })
      .readonly(),
    dormant: z
      .strictObject({
        minTotalVotes: positive,
        minRunnerUpVotes: positive,
        minRunnerUpPercent: count,
        triggerBurstChange: count,
      })
      .readonly(),
    migration: z
      .strictObject({
        minChildHealth: positive,
        retentionBasePermille: count,
        retentionPerDriftPermille: count,
      })
      .readonly(),
  })
  .readonly();

/**
 * An immutable, versioned set of balance parameters. Rules are identified by
 * the SHA-256 of their canonical JSON; historical rounds keep the ruleset they
 * were played under.
 */
export type Ruleset = z.output<typeof rulesetSchema>;

function semanticProblems(rules: Ruleset): string[] {
  const problems: string[] = [];
  const { genome, health, habitat, baseline, scoring, traces, dormant, migration } = rules;
  if (genome.min > genome.max) {
    problems.push('genome.min exceeds genome.max');
  }
  if (genome.budget < GENES.length * genome.min || genome.budget > GENES.length * genome.max) {
    problems.push('genome.budget is unreachable within the gene bounds');
  }
  if (genome.mutationStep > genome.max - genome.min) {
    problems.push('genome.mutationStep exceeds the gene range');
  }
  if (!isLegalGenome(genome.founder, genome)) {
    problems.push('genome.founder is not a legal genome');
  }
  if (health.founder > health.max) {
    problems.push('health.founder exceeds health.max');
  }
  if (habitat.burstTopBuckets >= habitat.bucketCount) {
    problems.push('habitat.burstTopBuckets must be fewer than habitat.bucketCount');
  }
  if (baseline.minRounds > baseline.windowRounds) {
    problems.push('baseline.minRounds exceeds baseline.windowRounds');
  }
  if (scoring.deltaMin > 0 || scoring.deltaMax < 0) {
    problems.push('scoring delta range must contain zero');
  }
  if (traces.adjustmentMin > 0 || traces.adjustmentMax < 0) {
    problems.push('traces adjustment range must contain zero');
  }
  if (traces.chargedBurstThreshold > PROFILE_SCALE) {
    problems.push('traces.chargedBurstThreshold exceeds the profile scale');
  }
  if (traces.recoveryHealthThreshold > health.max) {
    problems.push('traces.recoveryHealthThreshold exceeds health.max');
  }
  if (dormant.minRunnerUpPercent > 100) {
    problems.push('dormant.minRunnerUpPercent exceeds 100');
  }
  if (dormant.triggerBurstChange > PROFILE_SCALE) {
    problems.push('dormant.triggerBurstChange exceeds the profile scale');
  }
  if (migration.minChildHealth > health.max) {
    problems.push('migration.minChildHealth exceeds health.max');
  }
  return problems;
}

/** Validate an untrusted ruleset (for example, stored canonical JSON) and freeze it. */
export function parseRuleset(value: unknown): Ruleset {
  const result = rulesetSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new EngineError('INVALID_RULESET', `invalid ruleset: ${issues.join('; ')}`);
  }
  const problems = semanticProblems(result.data);
  if (problems.length > 0) {
    throw new EngineError('INVALID_RULESET', `invalid ruleset: ${problems.join('; ')}`);
  }
  return result.data;
}

export function rulesetCanonicalJson(rules: Ruleset): string {
  return canonicalJson(rules);
}

/** Lowercase hexadecimal SHA-256 of the ruleset's canonical JSON. */
export function rulesetHash(rules: Ruleset): string {
  return sha256Hex(rulesetCanonicalJson(rules));
}

export function assertCompatibleRuleset(rules: Ruleset): void {
  if (rules.engineVersion !== ENGINE_VERSION) {
    throw new EngineError(
      'INCOMPATIBLE_RULESET',
      `ruleset ${rules.version} targets engine ${rules.engineVersion}, not ${ENGINE_VERSION}`,
    );
  }
}

/**
 * Initial balance candidate from the PRD. These values are unvalidated
 * candidates pending simulator evidence; tuning them creates a new version.
 */
export const candidateRuleset: Ruleset = parseRuleset({
  version: 'candidate-1',
  engineVersion: ENGINE_VERSION,
  genome: {
    min: 0,
    max: 15,
    budget: 24,
    mutationStep: 2,
    founder: { pulse: 6, calm: 6, grit: 6, drift: 6 },
  },
  ballot: { mutationCandidates: 3 },
  health: { max: 100, founder: 70 },
  habitat: { bucketMs: 10_000, bucketCount: 12, burstTopBuckets: 3, confidenceMinAccounts: 3 },
  baseline: { windowRounds: 10, minRounds: 3 },
  scoring: {
    fitWeight: 6,
    upkeep: 3,
    rawShockCap: 8,
    gritProtectionMax: 8,
    deltaMin: -8,
    deltaMax: 6,
  },
  // Arrival shock 4 is the PRD worked journey's value; a category change is a
  // partial habitat shift and starts at half of it.
  shock: { arrival: 4, categoryChange: 2 },
  traces: {
    qualifyingRounds: 2,
    adjustmentMin: -1,
    adjustmentMax: 1,
    shelterArrivalShockReduction: 2,
    shelterUpkeep: 1,
    chargedBurstThreshold: 650,
    chargedAdjustment: 1,
    recoveryHealthThreshold: 30,
    recoveryAdjustment: 1,
  },
  dormant: {
    minTotalVotes: 5,
    minRunnerUpVotes: 2,
    minRunnerUpPercent: 20,
    triggerBurstChange: 300,
  },
  migration: { minChildHealth: 10, retentionBasePermille: 350, retentionPerDriftPermille: 20 },
});
