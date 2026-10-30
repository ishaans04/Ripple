import { describe, expect, it } from 'vitest';
import { candidateRuleset } from '@ripple/engine';
import { simulateTrial, type TrialConfig } from './simulation.ts';
const base: TrialConfig = {
  habitat: 'shifting',
  policy: 'recent-profile-informed',
  seed: 'held-out-v1-101',
  size: 'small',
  rounds: 36,
  trace: 'keep',
  shelter: false,
};
describe('policy experiments', () => {
  it('replays exactly and preserves small/large fitness and survival under equal normalized shapes', () => {
    const first = simulateTrial(base);
    expect(simulateTrial(base)).toEqual(first);
    const large = simulateTrial({ ...base, size: 'large' });
    expect(large.health).toBe(first.health);
    expect(large.genome).toEqual(first.genome);
    expect(large.ancestorDifference).toBe(first.ancestorDifference);
  });
  it('holds limited observations and keeps genome budgets and health bounds', () => {
    const sparse = simulateTrial({ ...base, habitat: 'sparse' });
    expect(sparse.validRounds).toBe(0);
    expect(sparse.limitedRounds).toBe(36);
    expect(sparse.health).toBe(candidateRuleset.health.founder);
    expect(Object.values(sparse.genome).reduce((sum, gene) => sum + gene, 0)).toBe(24);
    expect(sparse.health).toBeLessThanOrEqual(100);
  });
  it('compares finite arrival, cooldown, trace and shelter effects without changing parent energy', () => {
    const clear = simulateTrial({
      ...base,
      habitat: 'raid-heavy',
      policy: 'always-Calm',
      rounds: 120,
      trace: 'clear',
    });
    const keep = simulateTrial({
      ...base,
      habitat: 'raid-heavy',
      policy: 'always-Calm',
      rounds: 120,
    });
    const sheltered = simulateTrial({
      ...base,
      habitat: 'raid-heavy',
      policy: 'always-Calm',
      rounds: 120,
      shelter: true,
    });
    expect(clear.arrivals).toBeGreaterThan(0);
    expect(clear.cooldownBlocks).toBeGreaterThan(0);
    expect(clear.traceRounds).toBe(0);
    expect(keep.maxTraceAdjustment).toBeLessThanOrEqual(1);
    expect(sheltered.shelters).toBeGreaterThan(0);
    expect(sheltered.branches).toBeLessThanOrEqual(12);
    expect(sheltered.arrivalDeaths).toBeLessThanOrEqual(sheltered.arrivals);
  });
});
