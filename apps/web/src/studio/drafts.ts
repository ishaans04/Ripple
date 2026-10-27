import {
  blueprintSchema,
  MAX_BLUEPRINT_BYTES,
  type AppearanceBlueprint,
  type StudioChallenge,
} from '@ripple/contracts';

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const draftKey = (challenge: StudioChallenge) =>
  `ripple:studio-draft:v1:${challenge.worldId}:${challenge.studioSessionId}`;
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export function loadDraft(
  storage: DraftStorage,
  challenge: StudioChallenge,
  now: number,
): AppearanceBlueprint | null {
  try {
    const text = storage.getItem(draftKey(challenge));
    if (text === null || text.length > MAX_BLUEPRINT_BYTES * 2) return null;
    const record: unknown = JSON.parse(text);
    if (
      typeof record !== 'object' ||
      record === null ||
      !('updatedAt' in record) ||
      !('blueprint' in record) ||
      typeof record.updatedAt !== 'number' ||
      !Number.isSafeInteger(record.updatedAt) ||
      record.updatedAt > now ||
      now - record.updatedAt > MAX_DRAFT_AGE_MS
    )
      return null;
    const parsed = blueprintSchema.safeParse(record.blueprint);
    if (!parsed.success) return null;
    const draft = parsed.data;
    return draft.worldId === challenge.worldId &&
      draft.studioSessionId === challenge.studioSessionId &&
      draft.baseOrganismId === challenge.baseOrganismId &&
      draft.baseOrganismVersion === challenge.baseOrganismVersion &&
      challenge.mutationTemplateIds.includes(draft.mutationTemplateId)
      ? draft
      : null;
  } catch {
    return null;
  }
}
export function saveDraft(
  storage: DraftStorage,
  blueprint: AppearanceBlueprint,
  challenge: StudioChallenge,
  now: number,
): boolean {
  try {
    const parsed = blueprintSchema.parse(blueprint);
    storage.setItem(draftKey(challenge), JSON.stringify({ updatedAt: now, blueprint: parsed }));
    return true;
  } catch {
    return false;
  }
}
