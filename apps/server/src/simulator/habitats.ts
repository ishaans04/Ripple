import { generatorFromSeedMaterial, type ActivityObservation } from '@ripple/engine';

export const habitats = [
  'steady',
  'bursty',
  'sparse',
  'shifting',
  'raid-heavy',
  'hostile-input',
] as const;
export type Habitat = (typeof habitats)[number];
/** Disjoint, named seed sets. Evaluation seeds are never selected from a tuning result. */
export const tuningSeeds = Array.from({ length: 8 }, (_, i) => `tune-v1-${i}`);
export const heldOutSeeds = Array.from({ length: 12 }, (_, i) => `held-out-v1-${i + 100}`);

export function observationsFor(
  habitat: Habitat,
  seed: string,
  round: number,
  size: 'small' | 'large',
): ActivityObservation[] {
  const rng = generatorFromSeedMaterial({ purpose: 'habitat-v1', habitat, seed, round });
  const bursty =
    habitat === 'bursty' || (habitat === 'shifting' && Math.floor(round / 4) % 2 === 1);
  const accounts = habitat === 'sparse' ? 2 : size === 'small' ? 3 : 30;
  const buckets = bursty ? [0, 1, 2] : Array.from({ length: 12 }, (_, i) => i);
  const observations: ActivityObservation[] = [];
  const jitter = rng.nextInt(500);
  for (const bucket of buckets)
    for (let account = 0; account < accounts; account++)
      observations.push({ actorKey: `local-${account}`, offsetMs: bucket * 10_000 + jitter });
  // Duplicate receipts/account spam never create extra account/bucket contributions.
  if (habitat === 'hostile-input')
    for (let i = 0; i < 100; i++) observations.push({ actorKey: 'local-0', offsetMs: jitter });
  return observations;
}
