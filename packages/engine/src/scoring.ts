import { EngineError } from './errors.ts';
import { assertLegalGenome, type Genome } from './genome.ts';
import type { ShockMarker } from './habitat.ts';
import { clamp, floorDiv, roundHalfUp } from './integer.ts';
import { PROFILE_SCALE, type Ruleset } from './ruleset.ts';

/** A temporary habitat modifier left by a successful visitor. At most one is active per host. */
export type TraceTemplate = 'shelter' | 'charged' | 'recovery';

export interface ScoreInput {
  readonly genome: Genome;
  /** Start health of a living organism, in [1, health.max]. */
  readonly healthBefore: number;
  /** The round's observed profile; burst + steadiness = PROFILE_SCALE. */
  readonly profile: { readonly burst: number; readonly steadiness: number };
  /** Persisted eligible shock markers for this round. */
  readonly shocks: readonly ShockMarker[];
  /** The host's active trace, applied to every organism scored there. */
  readonly trace: TraceTemplate | null;
}

export interface TraceApplication {
  readonly template: TraceTemplate;
  /** fitness and upkeep adjustments are part of round fitness; a health adjustment is not. */
  readonly effect: 'fitness' | 'upkeep' | 'health';
  /** Signed adjustment after the per-round cap. */
  readonly amount: number;
}

/** Every component of a round score, exactly as the engine computed it. */
export interface ScoreBreakdown {
  readonly genome: Genome;
  readonly burst: number;
  readonly steadiness: number;
  /** Pulse * burst and Calm * steadiness, the exact terms of habitat fit. */
  readonly pulseTerm: number;
  readonly calmTerm: number;
  /** round_half_up(fitWeight * (pulseTerm + calmTerm) / (geneMax * PROFILE_SCALE)). */
  readonly fit: number;
  readonly upkeep: number;
  /** Arrival marker shock after any Shelter trace reduction. */
  readonly arrivalShock: number;
  readonly categoryShock: number;
  /** Arrival shock the Shelter trace removed. */
  readonly shelterReduction: number;
  /** Arrival plus category shock, capped. */
  readonly rawShock: number;
  /** floor(gritProtectionMax * Grit / geneMax). */
  readonly gritProtection: number;
  /** max(0, rawShock - gritProtection). */
  readonly shock: number;
  readonly trace: TraceApplication | null;
  /**
   * Comparable round fitness, before start-health effects:
   * fit - upkeep - shock + fitness/upkeep trace adjustment. Contests use this.
   */
  readonly fitness: number;
  /** fitness plus any health trace adjustment, before the delta clamp. */
  readonly rawDelta: number;
  /** clamp(rawDelta, deltaMin, deltaMax). */
  readonly delta: number;
  readonly healthBefore: number;
  /** clamp(healthBefore + delta, 0, health.max). */
  readonly healthAfter: number;
  /** Health zero ends the branch. */
  readonly extinct: boolean;
}

/** A living organism's health is an integer in [1, health.max]; zero is extinction. */
export function assertLivingHealth(health: number, rules: Ruleset): void {
  if (!Number.isSafeInteger(health) || health < 1 || health > rules.health.max) {
    throw new EngineError(
      'INVALID_ARGUMENT',
      `a living organism's health is an integer in [1, ${rules.health.max}]`,
    );
  }
}

function assertScoreInput(input: ScoreInput, rules: Ruleset): void {
  assertLegalGenome(input.genome, rules.genome);
  assertLivingHealth(input.healthBefore, rules);
  const { profile, shocks } = input;
  const { burst, steadiness } = profile;
  if (
    !Number.isSafeInteger(burst) ||
    burst < 0 ||
    burst > PROFILE_SCALE ||
    steadiness !== PROFILE_SCALE - burst
  ) {
    throw new EngineError(
      'INVALID_ARGUMENT',
      `burst must be an integer in [0, ${PROFILE_SCALE}] and steadiness its complement`,
    );
  }
  for (const marker of shocks) {
    if (!Number.isSafeInteger(marker.amount) || marker.amount < 0) {
      throw new EngineError('INVALID_ARGUMENT', 'shock amounts must be nonnegative integers');
    }
  }
}

function applyTrace(
  template: TraceTemplate,
  burst: number,
  healthBefore: number,
  rules: Ruleset,
): TraceApplication {
  const { traces } = rules;
  const capped = (amount: number) => clamp(amount, traces.adjustmentMin, traces.adjustmentMax);
  switch (template) {
    case 'shelter':
      return { template, effect: 'upkeep', amount: capped(-traces.shelterUpkeep) };
    case 'charged':
      return {
        template,
        effect: 'fitness',
        amount: capped(
          burst >= traces.chargedBurstThreshold
            ? traces.chargedAdjustment
            : -traces.chargedAdjustment,
        ),
      };
    case 'recovery':
      return {
        template,
        effect: 'health',
        amount: capped(
          healthBefore < traces.recoveryHealthThreshold
            ? traces.recoveryAdjustment
            : -traces.recoveryAdjustment,
        ),
      };
  }
}

/**
 * Score one valid observation round (PRD section 6.5):
 *
 *   fit    = round_half_up(6 * (Pulse * burst + Calm * steadiness) / 15000)
 *   shock  = max(0, raw_shock - floor(8 * Grit / 15))
 *   delta  = clamp(fit - 3 - shock + trace_adjustment, -8, 6)
 *   health = clamp(health_before + delta, 0, 100)
 *
 * with the candidate constants taken from the ruleset. Raw shock sums the
 * persisted markers (a Shelter trace first removing part of each arrival's)
 * and is capped. Only one trace applies, capped per round.
 */
export function scoreRound(input: ScoreInput, rules: Ruleset): ScoreBreakdown {
  assertScoreInput(input, rules);
  const { genome, healthBefore, profile, shocks } = input;
  const { scoring, health, traces } = rules;
  const { burst, steadiness } = profile;

  const pulseTerm = genome.pulse * burst;
  const calmTerm = genome.calm * steadiness;
  const fit = roundHalfUp(
    scoring.fitWeight * (pulseTerm + calmTerm),
    rules.genome.max * PROFILE_SCALE,
  );

  const sheltered = input.trace === 'shelter';
  let arrivalShock = 0;
  let categoryShock = 0;
  let shelterReduction = 0;
  for (const marker of shocks) {
    if (marker.kind === 'arrival') {
      const reduction = sheltered
        ? Math.min(marker.amount, traces.shelterArrivalShockReduction)
        : 0;
      shelterReduction += reduction;
      arrivalShock += marker.amount - reduction;
    } else {
      categoryShock += marker.amount;
    }
  }
  const rawShock = Math.min(scoring.rawShockCap, arrivalShock + categoryShock);
  const gritProtection = floorDiv(scoring.gritProtectionMax * genome.grit, rules.genome.max);
  const shock = Math.max(0, rawShock - gritProtection);

  const trace = input.trace === null ? null : applyTrace(input.trace, burst, healthBefore, rules);
  const fitnessAdjustment = trace !== null && trace.effect !== 'health' ? trace.amount : 0;
  const healthAdjustment = trace?.effect === 'health' ? trace.amount : 0;

  const fitness = fit - scoring.upkeep - shock + fitnessAdjustment;
  const rawDelta = fitness + healthAdjustment;
  const delta = clamp(rawDelta, scoring.deltaMin, scoring.deltaMax);
  const healthAfter = clamp(healthBefore + delta, 0, health.max);

  return {
    genome,
    burst,
    steadiness,
    pulseTerm,
    calmTerm,
    fit,
    upkeep: scoring.upkeep,
    arrivalShock,
    categoryShock,
    shelterReduction,
    rawShock,
    gritProtection,
    shock,
    trace,
    fitness,
    rawDelta,
    delta,
    healthBefore,
    healthAfter,
    extinct: healthAfter === 0,
  };
}
