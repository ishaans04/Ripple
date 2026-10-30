import { canonicalJson, sha256Hex } from '@ripple/engine';
import type { TrialResult } from './simulation.ts';

function quantile(values: number[], p: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)] ?? null;
}
export function summarizeTrials(trials: readonly TrialResult[]) {
  const groups = new Map<string, TrialResult[]>();
  for (const trial of trials) {
    const { habitat, policy, size, trace, shelter } = trial.config;
    const key = `${habitat}/${policy}/${size}/${trace}/${shelter ? 'shelter' : 'conserve'}`;
    const group = groups.get(key) ?? [];
    group.push(trial);
    groups.set(key, group);
  }
  return [...groups].map(([scenario, group]) => {
    const sum = (
      key:
        | 'arrivals'
        | 'arrivalDeaths'
        | 'capBlocks'
        | 'cooldownBlocks'
        | 'validRounds'
        | 'limitedRounds'
        | 'dormantCaptures'
        | 'dormantOffers'
        | 'dormantActivations'
        | 'ancestorDifference'
        | 'traceRounds'
        | 'traceFitnessTotal'
        | 'shelters',
    ) => group.reduce((n, trial) => n + trial[key], 0);
    const arrivals = sum('arrivals');
    const finalGenes = { pulse: 0, calm: 0, grit: 0, drift: 0 };
    for (const trial of group)
      for (const gene of ['pulse', 'calm', 'grit', 'drift'] as const)
        finalGenes[gene] += trial.genome[gene];
    return {
      scenario,
      trials: group.length,
      aliveAtHorizon: group.filter((trial) => trial.health > 0).length,
      survivalRounds: {
        p10: quantile(
          group.map((trial) => trial.roundsSurvived),
          0.1,
        ),
        median: quantile(
          group.map((trial) => trial.roundsSurvived),
          0.5,
        ),
        p90: quantile(
          group.map((trial) => trial.roundsSurvived),
          0.9,
        ),
      },
      arrivals,
      arrivalDeaths: sum('arrivalDeaths'),
      arrivalMortality: arrivals ? sum('arrivalDeaths') / arrivals : null,
      validRounds: sum('validRounds'),
      limitedRounds: sum('limitedRounds'),
      finalGeneTotals: finalGenes,
      maxRetainedBranches: Math.max(...group.map((trial) => trial.branches)),
      capBlocks: sum('capBlocks'),
      cooldownBlocks: sum('cooldownBlocks'),
      shelters: sum('shelters'),
      dormantCaptures: sum('dormantCaptures'),
      dormantOffers: sum('dormantOffers'),
      dormantActivations: sum('dormantActivations'),
      ancestorFitnessDifferenceTotal: sum('ancestorDifference'),
      traceRounds: sum('traceRounds'),
      traceFitnessDifferenceTotal: sum('traceFitnessTotal'),
      maxTraceAdjustment: Math.max(...group.map((trial) => trial.maxTraceAdjustment)),
      observedBurstValues: [...new Set(group.flatMap((trial) => trial.bursts))].sort(
        (a, b) => a - b,
      ),
    };
  });
}
export function resultDigest(trials: readonly TrialResult[]) {
  return sha256Hex(canonicalJson(trials));
}
export function compareNormalizedSizes(trials: readonly TrialResult[]) {
  const keyOf = (trial: TrialResult) => {
    return canonicalJson({ ...trial.config, size: 'normalized' });
  };
  const small = new Map(
    trials.filter((trial) => trial.config.size === 'small').map((trial) => [keyOf(trial), trial]),
  );
  let compared = 0,
    divergences = 0;
  for (const large of trials.filter((trial) => trial.config.size === 'large')) {
    const pair = small.get(keyOf(large));
    if (!pair) throw new Error('Missing normalized size comparison');
    compared++;
    if (
      canonicalJson([pair.health, pair.genome, pair.arrivalDeaths, pair.dormantActivations]) !==
      canonicalJson([large.health, large.genome, large.arrivalDeaths, large.dormantActivations])
    )
      divergences++;
  }
  return { compared, divergences };
}
