import type { BaselineComparison } from './baseline.ts';
import type { RoundResolution } from './resolution.ts';
import { PROFILE_SCALE, type Ruleset } from './ruleset.ts';
import type { ScoreBreakdown, TraceApplication } from './scoring.ts';

/*
 * Outcome explanations are deterministic templates fed only by engine score
 * components; no text is generated at runtime. "Energy" is the viewer-facing
 * word for health.
 */

export type ExplanationComponent = 'habitat' | 'shock' | 'grit' | 'trace' | 'limit';

/** One signed contribution to the round's energy change, in viewer language. */
export interface ExplanationLine {
  readonly component: ExplanationComponent;
  readonly amount: number;
  readonly text: string;
}

/** One step of the exact calculation, with its numbers filled in. */
export interface CalculationStep {
  readonly label: string;
  readonly value: number;
  readonly formula: string;
}

export interface OutcomeExplanation {
  readonly headline: string;
  /** At most two leading effects. */
  readonly causes: readonly ExplanationLine[];
  /** Every contribution; the amounts sum exactly to the energy change. */
  readonly contributions: readonly ExplanationLine[];
  /** The complete calculation, for details views. */
  readonly calculation: readonly CalculationStep[];
  readonly notes: readonly string[];
}

/** Sign-explicit integer, so a score never relies on color alone: +3, -4, +0. */
export function formatSigned(value: number): string {
  return value < 0 ? String(value) : `+${value}`;
}

/** Ties between equally large effects favor the more informative one. */
const causePriority: readonly ExplanationComponent[] = [
  'shock',
  'grit',
  'trace',
  'habitat',
  'limit',
];

function habitatText(score: ScoreBreakdown): string {
  const against = `fit ${score.fit} against upkeep ${score.upkeep}`;
  if (score.fit === 0) {
    return `The chat rhythm gave it no fit against upkeep ${score.upkeep}`;
  }
  if (score.pulseTerm > score.calmTerm) {
    return `Bursty chat fed its Pulse: ${against}`;
  }
  if (score.calmTerm > score.pulseTerm) {
    return `Steady chat fed its Calm: ${against}`;
  }
  return `Chat fed its Pulse and Calm equally: ${against}`;
}

function shockText(score: ScoreBreakdown): string {
  const arrival = score.arrivalShock > 0;
  const category = score.categoryShock > 0;
  if (arrival && category) {
    return `Arrival and category-change shocks hit for ${score.rawShock}`;
  }
  return arrival
    ? `Arrival shock hit for ${score.rawShock}`
    : `A category change shook the habitat for ${score.rawShock}`;
}

const traceNames = {
  charged: 'Charged habitat',
  recovery: 'Recovery zone',
  shelter: 'Shelter trace',
} as const;

function traceText(trace: TraceApplication): string {
  const size = Math.abs(trace.amount);
  if (trace.amount === 0) {
    return `${traceNames[trace.template]} had no effect this round`;
  }
  switch (trace.template) {
    case 'charged':
      return trace.amount > 0
        ? `Charged habitat added ${size} in a bursty round`
        : `Charged habitat cost ${size} in a steadier round`;
    case 'recovery':
      return trace.amount > 0
        ? `Recovery zone restored ${size} at low energy`
        : `Recovery zone cost ${size} above low energy`;
    case 'shelter':
      return `Shelter trace upkeep cost ${size}`;
  }
}

function contributionsOf(score: ScoreBreakdown, rules: Ruleset): ExplanationLine[] {
  const lines: ExplanationLine[] = [
    { component: 'habitat', amount: score.fit - score.upkeep, text: habitatText(score) },
  ];
  if (score.rawShock > 0) {
    lines.push({ component: 'shock', amount: -score.rawShock, text: shockText(score) });
  }
  const blocked = score.rawShock - score.shock;
  if (blocked > 0) {
    lines.push({
      component: 'grit',
      amount: blocked,
      text: `Grit blocked ${blocked} of the shock`,
    });
  }
  if (score.trace !== null) {
    lines.push({ component: 'trace', amount: score.trace.amount, text: traceText(score.trace) });
  }
  const limited = score.delta - score.rawDelta;
  if (limited !== 0) {
    lines.push({
      component: 'limit',
      amount: limited,
      text:
        limited > 0
          ? `The round loss was limited to ${-rules.scoring.deltaMin}`
          : `The round gain was limited to ${rules.scoring.deltaMax}`,
    });
  }
  return lines;
}

function leadingCauses(lines: readonly ExplanationLine[]): ExplanationLine[] {
  const effects = lines
    .filter((line) => line.amount !== 0)
    .sort(
      (a, b) =>
        Math.abs(b.amount) - Math.abs(a.amount) ||
        causePriority.indexOf(a.component) - causePriority.indexOf(b.component),
    )
    .slice(0, 2);
  // When nothing moved energy, the habitat line still says why.
  return effects.length > 0 ? effects : lines.filter((line) => line.component === 'habitat');
}

function traceFormula(trace: TraceApplication, score: ScoreBreakdown, rules: Ruleset): string {
  const { traces } = rules;
  const amount = formatSigned(trace.amount);
  switch (trace.template) {
    case 'charged':
      return score.burst >= traces.chargedBurstThreshold
        ? `Charged habitat: burst ${score.burst} >= ${traces.chargedBurstThreshold}, ${amount}`
        : `Charged habitat: burst ${score.burst} < ${traces.chargedBurstThreshold}, ${amount}`;
    case 'recovery':
      return score.healthBefore < traces.recoveryHealthThreshold
        ? `Recovery zone: start energy ${score.healthBefore} < ${traces.recoveryHealthThreshold}, ${amount}`
        : `Recovery zone: start energy ${score.healthBefore} >= ${traces.recoveryHealthThreshold}, ${amount}`;
    case 'shelter':
      return `Shelter: upkeep ${amount}`;
  }
}

function calculationOf(score: ScoreBreakdown, rules: Ruleset): CalculationStep[] {
  const { scoring, health } = rules;
  const geneMax = rules.genome.max;
  const { genome, trace } = score;
  const arrivalBefore = score.arrivalShock + score.shelterReduction;
  const arrivalTerm =
    score.shelterReduction > 0
      ? `arrival ${arrivalBefore} - Shelter ${score.shelterReduction}`
      : `arrival ${arrivalBefore}`;
  const traceTerm =
    trace !== null && trace.effect !== 'health'
      ? ` ${trace.amount < 0 ? '-' : '+'} trace ${Math.abs(trace.amount)}`
      : '';
  const steps: CalculationStep[] = [
    {
      label: 'Habitat fit',
      value: score.fit,
      formula:
        `round(${scoring.fitWeight} * (Pulse ${genome.pulse} * burst ${score.burst} + ` +
        `Calm ${genome.calm} * steadiness ${score.steadiness}) / ${geneMax * PROFILE_SCALE}) = ${score.fit}`,
    },
    { label: 'Upkeep', value: score.upkeep, formula: `upkeep = ${score.upkeep}` },
    {
      label: 'Raw shock',
      value: score.rawShock,
      formula: `min(${scoring.rawShockCap}, ${arrivalTerm} + category ${score.categoryShock}) = ${score.rawShock}`,
    },
    {
      label: 'Grit protection',
      value: score.gritProtection,
      formula: `floor(${scoring.gritProtectionMax} * Grit ${genome.grit} / ${geneMax}) = ${score.gritProtection}`,
    },
    {
      label: 'Shock',
      value: score.shock,
      formula: `max(0, ${score.rawShock} - ${score.gritProtection}) = ${score.shock}`,
    },
  ];
  if (trace !== null) {
    steps.push({ label: 'Trace', value: trace.amount, formula: traceFormula(trace, score, rules) });
  }
  steps.push(
    {
      label: 'Round fitness',
      value: score.fitness,
      formula: `fit ${score.fit} - upkeep ${score.upkeep} - shock ${score.shock}${traceTerm} = ${score.fitness}`,
    },
    {
      label: 'Energy change',
      value: score.delta,
      formula: `clamp(${score.rawDelta}, ${scoring.deltaMin}, ${scoring.deltaMax}) = ${score.delta}`,
    },
    {
      label: 'Energy',
      value: score.healthAfter,
      formula: `clamp(${score.healthBefore} ${score.delta < 0 ? '-' : '+'} ${Math.abs(score.delta)}, 0, ${health.max}) = ${score.healthAfter}`,
    },
  );
  return steps;
}

function comparisonNote(comparison: BaselineComparison, rules: Ruleset): string {
  switch (comparison.band) {
    case 'learning':
      return `Learning habitat: comparisons begin after ${rules.baseline.minRounds} valid rounds.`;
    case 'quieter':
      return 'Chat was quieter than usual.';
    case 'typical':
      return 'Chat was about as busy as usual.';
    case 'busier':
      return 'Chat was busier than usual.';
  }
}

function appliedHeadline(score: ScoreBreakdown): string {
  if (score.extinct) {
    return 'Energy fell to 0: this branch becomes a fossil';
  }
  const change = score.healthAfter - score.healthBefore;
  if (change > 0) {
    return `Gained ${change} energy (${score.healthBefore} to ${score.healthAfter})`;
  }
  if (change < 0) {
    return `Lost ${-change} energy (${score.healthBefore} to ${score.healthAfter})`;
  }
  return `Energy held at ${score.healthAfter}`;
}

/** Explain a resolved round from its exact score components. */
export function explainResolution(resolution: RoundResolution, rules: Ruleset): OutcomeExplanation {
  if (resolution.outcome === 'interrupted') {
    return {
      headline: `Observation interrupted: energy stays at ${resolution.healthBefore}`,
      causes: [],
      contributions: [],
      calculation: [],
      notes: ['This round does not count toward traces, contests, or the habitat baseline.'],
    };
  }
  const score = resolution.outcome === 'applied' ? resolution.score : resolution.estimate;
  const contributions = contributionsOf(score, rules);
  const notes: string[] = [];
  let headline: string;
  if (resolution.outcome === 'limited') {
    headline = `Too little chat to judge this round: energy stays at ${resolution.healthBefore}`;
    if (resolution.profile.neutral) {
      notes.push('Nobody chatted during the observation.');
    }
    notes.push(
      `Estimate only: fewer than ${rules.habitat.confidenceMinAccounts} accounts chatted, ` +
        `so energy is held. The estimate was ${formatSigned(score.delta)}.`,
    );
  } else {
    headline = appliedHeadline(score);
    if (score.healthBefore + score.delta > rules.health.max) {
      notes.push(`Energy is capped at ${rules.health.max}.`);
    }
  }
  notes.push(comparisonNote(resolution.comparison, rules));
  return {
    headline,
    causes: leadingCauses(contributions),
    contributions,
    calculation: calculationOf(score, rules),
    notes,
  };
}
