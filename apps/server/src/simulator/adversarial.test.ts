import { expect, it } from 'vitest';
import { auditPolicies } from './adversarial.ts';
it('measures duplicate caps, finite shelter, host loops and nonrenewable migration allowances', () => {
  expect(auditPolicies()).toMatchObject({
    concentratedAccount: { contributions: 12, confidence: 'limited' },
    duplicateVotes: { accepted: 1, ignored: 999 },
    repeatedHostLoops: { retainedBranches: 12, capBlocks: 39, cooldownBlocks: 9 },
    shelter: { totalHealthAfter: 90, nextContest: 'resident' },
    migratedLifetime: { remainingRounds: 0 },
  });
});
