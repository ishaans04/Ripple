import { expect, it } from 'vitest';
import { runStudioScenarios, studioScenariosHash } from './studio-scenarios.ts';
it('passes every required studio scenario reproducibly across selection seeds', () => {
  for (const seed of ['studio-tune-1', 'studio-held-out-101', 'studio-held-out-102']) {
    const first = runStudioScenarios(seed);
    expect(first).toHaveLength(6);
    expect(studioScenariosHash(runStudioScenarios(seed))).toBe(studioScenariosHash(first));
    expect(first.every((check) => check.passed)).toBe(true);
  }
});
