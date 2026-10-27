import { assertLegalGenome, type Genome } from './genome.ts';
import { clamp, floorDiv } from './integer.ts';
import type { Ruleset } from './ruleset.ts';
import { assertLivingHealth } from './scoring.ts';

/**
 * Health a raid child starts with in its destination:
 * max(10, floor(parent health * (350 + 20 * Drift) / 1000)), capped at 100,
 * with the constants from the ruleset. The genome is the parent's committed
 * genome, which the child inherits as a snapshot; the parent keeps its own
 * health.
 */
export function childArrivalHealth(parentHealth: number, genome: Genome, rules: Ruleset): number {
  assertLivingHealth(parentHealth, rules);
  assertLegalGenome(genome, rules.genome);
  const { minChildHealth, retentionBasePermille, retentionPerDriftPermille } = rules.migration;
  const retained = floorDiv(
    parentHealth * (retentionBasePermille + retentionPerDriftPermille * genome.drift),
    1000,
  );
  return clamp(retained, minChildHealth, rules.health.max);
}
