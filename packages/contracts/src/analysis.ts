import { z } from 'zod';
import { studioGenomeSchema } from './studio.ts';

const trace = z.enum(['charged', 'shelter', 'recovery']);
export const scoreBreakdownSchema = z.object({
  genome: studioGenomeSchema,
  burst: z.int(),
  steadiness: z.int(),
  pulseTerm: z.int(),
  calmTerm: z.int(),
  fit: z.int(),
  upkeep: z.int(),
  arrivalShock: z.int(),
  categoryShock: z.int(),
  shelterReduction: z.int(),
  rawShock: z.int(),
  gritProtection: z.int(),
  shock: z.int(),
  trace: z
    .object({ template: trace, effect: z.enum(['fitness', 'upkeep', 'health']), amount: z.int() })
    .nullable(),
  fitness: z.int(),
  rawDelta: z.int(),
  delta: z.int(),
  healthBefore: z.int().min(1).max(100),
  healthAfter: z.int().min(0).max(100),
  extinct: z.boolean(),
});
const line = z.object({
  component: z.enum(['habitat', 'shock', 'grit', 'trace', 'limit']),
  amount: z.int(),
  text: z.string(),
});
export const outcomeExplanationSchema = z.object({
  headline: z.string(),
  causes: z.array(line).max(2),
  contributions: z.array(line),
  calculation: z.array(z.object({ label: z.string(), value: z.number(), formula: z.string() })),
  notes: z.array(z.string()),
});
const scoreInput = z.object({
  genome: studioGenomeSchema,
  healthBefore: z.int(),
  profile: z.object({ burst: z.int(), steadiness: z.int() }),
  shocks: z.array(z.object({ kind: z.enum(['arrival', 'category_change']), amount: z.int() })),
  trace: trace.nullable(),
});
const metadata = {
  rulesHash: z.string().regex(/^[a-f0-9]{64}$/),
  engineVersion: z.int().positive(),
};
const ancestor = z.object({
  ancestorId: z.uuid(),
  ...metadata,
  inputs: z.object({
    schemaVersion: z.literal(1),
    scoreInput,
    arrival: z
      .object({ pending: z.boolean(), shockReduction: z.int(), shelterPending: z.boolean() })
      .nullable(),
    scoringStage: z.literal('before-shelter-settlement'),
  }),
  result: z.object({
    current: scoreBreakdownSchema,
    ancestor: scoreBreakdownSchema,
    identicalGenome: z.boolean(),
    fitnessDifference: z.int(),
    deltaDifference: z.int(),
  }),
});
const gene = z.enum(['pulse', 'calm', 'grit', 'drift']);
const alternative = z.object({
  ...metadata,
  confidence: z.enum(['confident', 'limited']),
  inputs: z.object({
    genomeBefore: studioGenomeSchema,
    candidates: z
      .array(
        z.object({
          id: z.string(),
          move: z.object({ from: gene, to: gene, amount: z.int() }),
          genome: studioGenomeSchema,
          effect: z.string(),
          tradeOff: z.string(),
          source: z.enum(['generated', 'dormant']),
        }),
      )
      .length(3),
    selectedId: z.string().nullable(),
    actual: scoreInput,
    actualOutcome: z.enum(['applied', 'limited']),
    actualHealthAfter: z.int(),
    scoringStage: z.literal('before-shelter-settlement'),
  }),
  result: z.object({
    kind: z.literal('fixed-input-comparison'),
    exogenousHash: z.string().regex(/^[a-f0-9]{64}$/),
    actual: scoreBreakdownSchema,
    rejected: z
      .array(
        z.object({
          kind: z.literal('rejected-choice'),
          candidateId: z.string(),
          score: scoreBreakdownSchema,
          fitnessDifference: z.int(),
          energyDifference: z.int(),
        }),
      )
      .max(3),
  }),
});
export const roundAnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  roundId: z.uuid(),
  kind: z.string(),
  rulesHash: metadata.rulesHash,
  status: z.enum(['resolved', 'cancelled']),
  mechanicsVersion: z.union([z.literal(0), z.literal(1)]),
  modelLabel: z.literal(
    'Fixed-input model comparisons; downstream viewer behavior is not simulated.',
  ),
  scoringStage: z.literal('before-shelter-settlement'),
  participants: z
    .array(
      z.object({
        organismId: z.uuid(),
        role: z.enum(['resident', 'visitor', 'primary']),
        actual: z.object({
          outcome: z.enum(['applied', 'limited']),
          healthBefore: z.int(),
          healthAfter: z.int(),
          score: scoreBreakdownSchema,
          explanation: outcomeExplanationSchema,
        }),
        ancestor: ancestor.nullable(),
      }),
    )
    .max(2),
  alternative: alternative.nullable(),
  settlement: z
    .object({
      outcome: z.enum(['held', 'empty', 'visitor', 'resident', 'sheltered']),
      residentHealth: z.int().nullable(),
      visitorHealth: z.int(),
      moved: z.int().nonnegative(),
      shelterPending: z.boolean(),
    })
    .nullable(),
  cancellation: z.object({ reason: z.string(), sequence: z.int() }).nullable(),
  traceAttribution: z
    .object({
      id: z.uuid(),
      emitterId: z.uuid(),
      lineageId: z.uuid(),
      originChannelId: z.uuid(),
      qualifyingRoundId: z.uuid(),
      template: trace,
    })
    .nullable(),
  dormantOffer: z
    .object({
      id: z.uuid(),
      version: z.int(),
      sourceRoundId: z.uuid(),
      originChannelId: z.uuid(),
      supporters: z.int(),
      totalVotes: z.int(),
      blueprintHash: z.string().optional(),
    })
    .nullable(),
  // The approved studio design that took this mutation slot instead of ordinary cards.
  studioHatch: z
    .object({ adaptationId: z.uuid(), sessionId: z.uuid(), hash: z.string() })
    .nullable()
    .optional(),
});
export type RoundAnalysis = z.infer<typeof roundAnalysisSchema>;
