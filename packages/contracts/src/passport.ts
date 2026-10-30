import { z } from 'zod';
import { appearanceViewSchema } from './live.ts';
import { studioGenomeSchema } from './studio.ts';
import {
  appearanceMappingVersionSchema,
  appearanceMarksSchema,
  markHostSchema,
} from './appearance.ts';

const host = markHostSchema;
const time = z.iso.datetime({ offset: true });
const status = z.enum(['ALIVE', 'HARBOR', 'FOSSIL', 'ARCHIVED']);
const gene = z.enum(['pulse', 'calm', 'grit', 'drift']);
export const PASSPORT_ADAPTATION_PAGE = 50;
export const PASSPORT_RECORD_LIMIT = 20;

export const passportAdaptationSchema = z.object({
  roundId: z.uuid(),
  number: z.int().positive(),
  host,
  openedAt: time,
  genomeBefore: studioGenomeSchema,
  selection: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('selected'),
      effect: z.string(),
      tradeOff: z.string(),
      source: z.enum(['generated', 'dormant']),
      genomeAfter: studioGenomeSchema,
    }),
    // The explicit no-vote (or Hold-majority) outcome: the genome stayed the same.
    z.object({ status: z.literal('hold') }),
    // Closed before selections or participants were recorded; nothing is inferred.
    z.object({ status: z.literal('unrecorded') }),
    // An approved Cocoon Studio design took this slot instead of ordinary cards.
    z.object({
      status: z.literal('studio'),
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      committed: z.boolean(),
      genomeAfter: studioGenomeSchema.nullable(),
    }),
  ]),
});
export type PassportAdaptation = z.infer<typeof passportAdaptationSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** A committed community design and where it came from (addendum 14.2). */
export const passportDesignSchema = z.object({
  hash,
  template: z.string(),
  rendererVersion: z.string(),
  studioSessionId: z.uuid(),
  creatingChannel: host,
  parentHash: hash.nullable(),
  // Individual artist credit appears only when the artist opted in; channel credit is the default.
  channelCredit: z.string(),
  artistCredit: z.string().nullable(),
  // The organism whose hatch committed it; an inherited design names an ancestor.
  committedBy: z.uuid().nullable(),
  committedAt: time.nullable(),
});
export type PassportDesign = z.infer<typeof passportDesignSchema>;

export const passportSchema = z.object({
  schemaVersion: z.literal(1),
  worldId: z.uuid(),
  mode: z.enum(['live', 'sandbox', 'replay']),
  organism: z.object({
    id: z.uuid(),
    name: z.string(),
    lineageId: z.uuid(),
    generation: z.int().min(0).max(16),
    status,
    health: z.int().min(0).max(100),
    genome: studioGenomeSchema,
    foundingGenome: studioGenomeSchema,
    appearance: appearanceViewSchema,
    appearanceMapping: appearanceMappingVersionSchema,
    marks: appearanceMarksSchema,
    createdAt: time,
  }),
  origin: host,
  parent: z.object({ id: z.uuid(), name: z.string(), status }).nullable(),
  founder: z.object({ id: z.uuid(), name: z.string(), status }),
  // Every host the ancestry chain was admitted to, in first-admission order.
  hosts: z.array(host).max(17),
  residencies: z
    .array(
      host.extend({
        role: z.enum(['resident', 'visitor', 'harbor']),
        startedAt: time,
        endedAt: time.nullable(),
      }),
    )
    .max(16),
  birth: z
    .object({
      transferId: z.uuid(),
      source: host,
      destination: host.nullable(),
      outcome: z.string(),
      historical: z.boolean(),
      createdAt: time,
    })
    .nullable(),
  // Older clients may omit it; every fresh passport carries the design provenance.
  design: z
    .object({
      current: passportDesignSchema.nullable(),
      history: z.array(passportDesignSchema).max(PASSPORT_RECORD_LIMIT),
    })
    .optional(),
  adaptations: z.object({
    total: z.int().nonnegative(),
    items: z.array(passportAdaptationSchema).max(PASSPORT_ADAPTATION_PAGE),
    next: z.string().nullable(),
  }),
  dormant: z.object({
    total: z.int().nonnegative(),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          sourceRoundId: z.uuid(),
          origin: host,
          template: z.object({ from: gene, to: gene, amount: z.int().positive() }),
          supporters: z.int().nonnegative(),
          totalVotes: z.int().nonnegative(),
          status: z.enum(['active', 'consumed', 'expired', 'replaced']),
          offered: z.boolean(),
          inherited: z.boolean(),
          remainingRounds: z.int().min(0).max(3),
          outcome: z
            .enum(['selected', 'rejected', 'replaced', 'fossil', 'valid-round-expiry'])
            .nullable(),
        }),
      )
      .max(PASSPORT_RECORD_LIMIT),
  }),
  traces: z.object({
    total: z.int().nonnegative(),
    items: z
      .array(
        z.object({
          id: z.uuid(),
          template: z.enum(['charged', 'shelter', 'recovery']),
          status: z.enum(['pending', 'active', 'cleared', 'expired', 'replaced', 'rejected']),
          remainingRounds: z.int().min(0).max(3),
          qualifyingRoundId: z.uuid(),
          host,
        }),
      )
      .max(PASSPORT_RECORD_LIMIT),
  }),
  ancestorTrials: z.object({
    total: z.int().nonnegative(),
    items: z
      .array(
        z.object({
          roundId: z.uuid(),
          number: z.int().positive(),
          host,
          ancestorId: z.uuid(),
          identicalGenome: z.boolean(),
          fitnessDifference: z.int(),
          deltaDifference: z.int(),
        }),
      )
      .max(PASSPORT_RECORD_LIMIT),
  }),
});
export type Passport = z.infer<typeof passportSchema>;
export const passportCursorSchema = z.coerce.number().int().positive().max(2_147_483_647);
