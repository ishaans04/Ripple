import { z } from 'zod';

export const shellDirections = [
  'grit-plus2-pulse-minus2',
  'grit-plus2-calm-minus2',
  'grit-plus2-drift-minus2',
] as const;
export const mutationTemplateSchema = z.enum([...shellDirections, 'cosmetic-only']);
export type StudioMutationTemplate = z.infer<typeof mutationTemplateSchema>;
export const rendererVersionSchema = z.literal('shell-v1');
export const shellBounds = {
  width: { min: 300, max: 850, initial: 620 },
  height: { min: 250, max: 750, initial: 440 },
  curvature: { min: 100, max: 800, initial: 300 },
} as const;
export const markingPatterns = ['plain', 'bands', 'dots'] as const;
export const shellPalettes = ['teal-amber', 'coral-ink', 'moss-cream'] as const;
export const shellParametersSchema = z
  .strictObject({
    width: z.int().min(shellBounds.width.min).max(shellBounds.width.max),
    height: z.int().min(shellBounds.height.min).max(shellBounds.height.max),
    curvature: z.int().min(shellBounds.curvature.min).max(shellBounds.curvature.max),
  })
  .readonly();
export type ShellParameters = z.infer<typeof shellParametersSchema>;
export const shellPartSchema = z
  .strictObject({
    type: z.literal('shell'),
    templateId: z.literal('segmented-shell'),
    parameters: shellParametersSchema,
    marking: z
      .strictObject({
        patternId: z.enum(markingPatterns),
        paletteId: z.enum(shellPalettes),
      })
      .readonly(),
  })
  .readonly();
export type ShellPart = z.infer<typeof shellPartSchema>;

export const blueprintSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    worldId: z.uuid(),
    studioSessionId: z.uuid(),
    baseOrganismId: z.uuid(),
    baseOrganismVersion: z.int().min(0),
    mutationTemplateId: mutationTemplateSchema,
    rendererVersion: rendererVersionSchema,
    part: shellPartSchema,
  })
  .readonly();
export type AppearanceBlueprint = z.infer<typeof blueprintSchema>;
export const MAX_BLUEPRINT_BYTES = 8192;
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const studioGenomeSchema = z
  .strictObject({
    pulse: z.int().min(0).max(15),
    calm: z.int().min(0).max(15),
    grit: z.int().min(0).max(15),
    drift: z.int().min(0).max(15),
  })
  .refine(
    (genome) => Object.values(genome).reduce((sum, value) => sum + value, 0) === 24,
    'gene budget must be 24',
  )
  .readonly();

export const studioChallengeSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    worldId: z.uuid(),
    studioSessionId: z.uuid(),
    baseOrganismId: z.uuid(),
    baseOrganismVersion: z.int().min(0),
    genome: studioGenomeSchema,
    rulesHash: hashSchema,
    baseAppearanceHash: hashSchema.nullable(),
    rendererVersion: rendererVersionSchema,
    targetMutationSlot: z.int().min(1),
    mutationTemplateIds: z.array(mutationTemplateSchema).min(1).max(3).readonly(),
  })
  .readonly();
export type StudioChallenge = z.infer<typeof studioChallengeSchema>;

export const founderShell: ShellPart = shellPartSchema.parse({
  type: 'shell',
  templateId: 'segmented-shell',
  parameters: { width: 620, height: 440, curvature: 300 },
  marking: { patternId: 'plain', paletteId: 'teal-amber' },
});
