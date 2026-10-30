import { z } from 'zod';
import {
  blueprintSchema,
  hashSchema,
  shellPartSchema,
  mutationTemplateSchema,
  studioChallengeSchema,
  studioGenomeSchema,
} from './studio.ts';

/** OBS scene names are matched exactly; they are configuration, never rendered as markup. */
const sceneName = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) =>
      Array.from(value).every((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code >= 32 && code !== 127;
      }),
    'Control characters are not allowed',
  );

/** Broadcaster-owned studio configuration (addendum 5.1, 13, 22). Versioned with the channel. */
export const studioSettingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    breakScenes: z.array(sceneName).max(8).readonly(),
    activeScenes: z.array(sceneName).max(8).readonly(),
    approval: z.enum(['review', 'auto']),
    creationMs: z.int().min(10_000).max(1_800_000),
    votingMs: z.int().min(10_000).max(180_000),
    reviewMs: z.int().min(60_000).max(3_600_000),
    returnDuringVoting: z.enum(['finish', 'cancel']),
    cosmeticPolicy: z.enum(['offer', 'defer']),
    maxProposals: z.int().min(1).max(200),
    replaceCooldownMs: z.int().min(5_000).max(600_000),
  })
  .refine(
    (settings) => !settings.breakScenes.some((scene) => settings.activeScenes.includes(scene)),
    'A scene cannot be both a break and an active scene',
  )
  .readonly();
export type StudioSettings = z.infer<typeof studioSettingsSchema>;
export const defaultStudioSettings: StudioSettings = Object.freeze({
  enabled: false,
  breakScenes: [],
  activeScenes: [],
  approval: 'review',
  creationMs: 300_000,
  votingMs: 45_000,
  reviewMs: 900_000,
  returnDuringVoting: 'finish',
  cosmeticPolicy: 'offer',
  maxProposals: 50,
  replaceCooldownMs: 30_000,
});

export const availabilityStates = ['ACTIVE', 'REST', 'UNKNOWN'] as const;
export const availabilitySchema = z.enum(availabilityStates);
export type Availability = z.infer<typeof availabilitySchema>;

/** A scoped OBS bridge may report only these signals for its own channel (addendum 7.4). */
export const bridgeReportSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('scene'), scene: sceneName }),
  z.strictObject({ kind: z.literal('heartbeat'), scene: sceneName.nullable() }),
  z.strictObject({ kind: z.literal('hidden') }),
]);
export type BridgeReport = z.infer<typeof bridgeReportSchema>;

export const studioPhaseSchema = z.enum([
  'OPENING',
  'CREATING',
  'VOTING',
  'REVIEW',
  'PENDING_HATCH',
  'COMPLETED',
  'CANCELLED',
  'EXPIRED',
]);
export type StudioPhaseView = z.infer<typeof studioPhaseSchema>;

/** Artist credit is opt-in; the creating channel is always the default attribution. */
export const proposalSubmissionSchema = z.strictObject({
  proposalId: z.uuid(),
  blueprint: blueprintSchema,
  creditOptIn: z.boolean(),
});
export type ProposalSubmission = z.infer<typeof proposalSubmissionSchema>;

export const studioReviewSchema = z.strictObject({
  sessionVersion: z.int().nonnegative(),
  decision: z.enum(['approve', 'keep']),
});

const finalistView = z.object({
  index: z.int().min(1).max(2),
  hash: hashSchema,
  template: mutationTemplateSchema,
  blueprint: blueprintSchema,
  credit: z.string(),
});
export type StudioFinalistView = z.infer<typeof finalistView>;

/** Safe public studio state: finalists and committed results only, never drafts or landmarks. */
export const studioViewSchema = z.object({
  enabled: z.boolean(),
  availability: z.object({
    state: availabilitySchema,
    source: z.enum(['manual', 'bridge', 'stream', 'integration']).nullable(),
    bridgeStale: z.boolean(),
  }),
  session: z
    .object({
      id: z.uuid(),
      phase: studioPhaseSchema,
      version: z.int().nonnegative(),
      trigger: z.enum(['manual', 'bridge']),
      cosmeticOnly: z.boolean(),
      challenge: z.object({
        templates: z.array(mutationTemplateSchema).min(1).max(3),
        genome: studioGenomeSchema,
        targetMutationSlot: z.int().min(1),
      }),
      creationCloseAtMs: z.number().nullable(),
      votingCloseAtMs: z.number().nullable(),
      reviewExpiresAtMs: z.number().nullable(),
      accepted: z.int().nonnegative(),
      maxProposals: z.int().positive(),
      finalists: z.array(finalistView).max(2),
      counts: z.array(z.int().nonnegative()).max(3),
      selection: z
        .object({
          kind: z.enum(['keep_current', 'design']),
          reason: z.string().nullable(),
          finalistIndex: z.int().min(1).max(2).nullable(),
        })
        .nullable(),
      pending: z
        .object({
          hash: hashSchema,
          template: mutationTemplateSchema,
          blueprint: blueprintSchema,
          credit: z.string(),
          message: z.literal('Community design selected. Hatches after the current round.'),
        })
        .nullable(),
      outcome: z.object({ reason: z.string() }).nullable(),
    })
    .nullable(),
});
export type StudioView = z.infer<typeof studioViewSchema>;

/** The studio page's read model, including the capturing challenge needed to build a blueprint. */
export const studioStateSchema = z.object({
  worldId: z.uuid(),
  channelId: z.uuid(),
  label: z.string(),
  studio: studioViewSchema,
  challenge: studioChallengeSchema.nullable(),
  // The creature being redesigned, as currently committed; pending designs never appear here.
  organism: z
    .object({
      name: z.string(),
      genome: studioGenomeSchema,
      appearance: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('founder'), part: shellPartSchema }),
        z.object({ kind: z.literal('studio'), blueprint: z.object({ part: shellPartSchema }) }),
      ]),
    })
    .nullable(),
  serverTimeMs: z.number(),
});
export type StudioState = z.infer<typeof studioStateSchema>;

export const artistProposalViewSchema = z.object({
  id: z.uuid(),
  status: z.enum(['active', 'replaced', 'withdrawn', 'removed']),
  revision: z.int().positive(),
  hash: hashSchema,
  creditOptIn: z.boolean(),
  submittedAtMs: z.number(),
});
export const artistStatusSchema = z.object({
  signedIn: z.boolean(),
  available: z.boolean(),
  login: z.string().nullable(),
  csrfToken: z.string().nullable(),
  proposals: z.array(artistProposalViewSchema).max(20),
  lastResult: z.object({ operationId: z.uuid(), code: z.string(), detail: z.unknown() }).nullable(),
});
export type ArtistStatus = z.infer<typeof artistStatusSchema>;
