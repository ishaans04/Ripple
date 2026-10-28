import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  admissionOutcome,
  candidateRaidPolicy,
  forkBlock,
  raidPolicyHash,
  type AdmissionInput,
} from './admission.ts';
const ready: AdmissionInput = {
  enrolled: true,
  sourceBlocked: false,
  policy: 'accept',
  approved: false,
  rulesCompatible: true,
  authorized: true,
  healthy: true,
  online: true,
  paused: false,
  visitorBusy: false,
  waitingAhead: 0,
};
describe('bounded raid admission policy', () => {
  it('distinguishes active, approval, offline, busy, full, unknown, revoked and incompatible destinations', () => {
    expect(admissionOutcome(ready)).toBe('ACTIVE');
    for (const [change, outcome] of [
      [{ policy: 'ask' }, 'PENDING_APPROVAL'],
      [{ online: false }, 'OFFLINE_HOLD'],
      [{ paused: true }, 'OFFLINE_HOLD'],
      [{ visitorBusy: true }, 'HARBOR'],
      [{ waitingAhead: 3 }, 'HARBOR_FULL'],
      [{ enrolled: false }, 'NOT_ENROLLED'],
      [{ authorized: false }, 'GRANT_REVOKED'],
      [{ healthy: false }, 'INPUT_UNAVAILABLE'],
      [{ rulesCompatible: false }, 'RULES_INCOMPATIBLE'],
      [{ sourceBlocked: true }, 'SOURCE_BLOCKED'],
      [{ policy: 'reject' }, 'POLICY_REJECTED'],
    ] as const)
      expect(admissionOutcome({ ...ready, ...change })).toBe(outcome);
    expect(admissionOutcome({ ...ready, policy: 'ask', approved: true })).toBe('ACTIVE');
  });
  it('never activates an unauthorized, incompatible, offline or full destination across combined conditions', () => {
    fc.assert(
      fc.property(
        fc.record({
          authorized: fc.boolean(),
          rulesCompatible: fc.boolean(),
          online: fc.boolean(),
          healthy: fc.boolean(),
          visitorBusy: fc.boolean(),
          waitingAhead: fc.integer({ min: 0, max: 20 }),
        }),
        (state) => {
          const outcome = admissionOutcome({ ...ready, ...state });
          if (outcome === 'ACTIVE')
            expect(
              state.authorized &&
                state.rulesCompatible &&
                state.online &&
                state.healthy &&
                !state.visitorBusy &&
                state.waitingAhead < 3,
            ).toBe(true);
        },
      ),
      { numRuns: 1000 },
    );
  });
  it('counts held branches toward the twelve-branch cap and enforces depth and the exact pair cooldown', () => {
    const eligible = {
      sourceEligible: true,
      sameChannel: false,
      livingBranches: 11,
      parentGeneration: 15,
      lastPairForkAtMs: null,
      atMs: 2000000,
    };
    expect(forkBlock(eligible)).toBeNull();
    expect(forkBlock({ ...eligible, sourceEligible: false })).toBe('SOURCE_INELIGIBLE');
    expect(forkBlock({ ...eligible, sameChannel: true })).toBe('SELF_RAID');
    expect(forkBlock({ ...eligible, livingBranches: 12 })).toBe('LINEAGE_CAP');
    expect(forkBlock({ ...eligible, parentGeneration: 16 })).toBe('GENERATION_CAP');
    expect(forkBlock({ ...eligible, lastPairForkAtMs: 200001 })).toBe('FORK_COOLDOWN');
    expect(forkBlock({ ...eligible, lastPairForkAtMs: 200000 })).toBeNull();
    expect(raidPolicyHash(candidateRaidPolicy)).toHaveLength(64);
    expect(raidPolicyHash({ ...candidateRaidPolicy })).toBe(raidPolicyHash(candidateRaidPolicy));
  });
});
