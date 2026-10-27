import { EngineError } from './errors.ts';
import { GENES, assertLegalGenome, type Gene, type Genome } from './genome.ts';
import type { Ruleset } from './ruleset.ts';
import type { TraceTemplate } from './scoring.ts';

const templateForGene: Readonly<Record<Gene, TraceTemplate>> = {
  pulse: 'charged',
  calm: 'recovery',
  grit: 'shelter',
  drift: 'recovery',
};

/**
 * The trace a qualifying visitor offers, chosen from its largest gene: Pulse
 * gives Charged habitat, Grit gives Shelter, and Calm or Drift gives Recovery
 * zone. Ties follow the fixed Pulse, Calm, Grit, Drift order. The template is
 * recorded at qualification so later genome changes cannot alter the offer.
 */
export function traceTemplateFor(genome: Genome, rules: Ruleset): TraceTemplate {
  assertLegalGenome(genome, rules.genome);
  let largest: Gene = GENES[0];
  for (const gene of GENES) {
    // Strictly greater: an equal gene later in canonical order never wins.
    if (genome[gene] > genome[largest]) {
      largest = gene;
    }
  }
  return templateForGene[largest];
}

export interface TraceQualificationInput {
  /** The organism reached this host by raid; a founder's idle time never emits traces. */
  readonly raidOrigin: boolean;
  /** Valid observation rounds it has survived during this residency. */
  readonly validSurvivingRounds: number;
  readonly qualifiedThisResidency: boolean;
  /** Its lineage already qualified at this host within the configured season. */
  readonly lineageQualifiedAtHostThisSeason: boolean;
}

/**
 * A raid-origin branch qualifies to offer a trace after surviving the
 * configured number of valid rounds at its destination, even if it has become
 * the resident, at most once per residency and once per lineage and host per
 * season.
 */
export function qualifiesForTrace(input: TraceQualificationInput, rules: Ruleset): boolean {
  if (!Number.isSafeInteger(input.validSurvivingRounds) || input.validSurvivingRounds < 0) {
    throw new EngineError('INVALID_ARGUMENT', 'validSurvivingRounds must be a nonnegative integer');
  }
  return (
    input.raidOrigin &&
    input.validSurvivingRounds >= rules.traces.qualifyingRounds &&
    !input.qualifiedThisResidency &&
    !input.lineageQualifiedAtHostThisSeason
  );
}
