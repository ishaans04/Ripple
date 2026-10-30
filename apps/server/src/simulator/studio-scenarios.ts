import { founderShell, type AppearanceBlueprint, type StudioChallenge } from '@ripple/contracts';
import {
  candidateRuleset,
  canonicalJson,
  sha256Hex,
  createStudioChallenge,
  initialMutationSlots,
  studioEligibility,
  approveStudioAdaptation,
  commitStudioAdaptation,
  completeSlotObservation,
  consumeMutationSlot,
  shortlistStudioProposals,
  resolveStudioSelection,
  studioDormantFinalist,
  evaluateDormantBlueprint,
  committedStudioAppearance,
  inheritCommittedDesign,
  scoreRound,
  StudioRuleError,
  type MutationSlots,
  type StudioOrganism,
} from '@ripple/engine';

export interface ScenarioCheck {
  scenario: string;
  passed: true;
  observations: Record<string, unknown>;
}
const worldId = '11111111-1111-4111-8111-111111111111';
const organismId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function rejects(action: () => unknown, code: string) {
  try {
    action();
  } catch (error) {
    check(error instanceof StudioRuleError && error.code === code, `Expected ${code}`);
    return;
  }
  throw new Error(`Expected rejection ${code}`);
}
function challengeFor(current: StudioOrganism, slots: MutationSlots): StudioChallenge {
  return createStudioChallenge(
    {
      worldId,
      studioSessionId: sessionId,
      baseOrganismId: current.id,
      baseOrganismVersion: current.version,
      genome: current.genome,
      baseAppearanceHash: current.appearanceHash,
      targetMutationSlot: slots.next,
    },
    candidateRuleset,
  );
}
function blueprint(challenge: StudioChallenge, index: number, width: number): AppearanceBlueprint {
  return {
    schemaVersion: 1,
    worldId,
    studioSessionId: sessionId,
    baseOrganismId: organismId,
    baseOrganismVersion: challenge.baseOrganismVersion,
    mutationTemplateId: challenge.mutationTemplateIds[index] ?? 'cosmetic-only',
    rendererVersion: 'shell-v1',
    part: { ...founderShell, parameters: { ...founderShell.parameters, width } },
  };
}
/** Six required studio experiments use production pure rules, with no database shortcuts. */
export function runStudioScenarios(seed = 'studio-scenarios-v1'): ScenarioCheck[] {
  const rules = candidateRuleset;
  const checks: ScenarioCheck[] = [];
  const current: StudioOrganism = {
    id: organismId,
    version: 0,
    genome: rules.genome.founder,
    status: 'ALIVE',
    appearanceHash: null,
    appearance: null,
  };
  const slots = initialMutationSlots;
  const challenge = challengeFor(current, slots);
  const proposals = [0, 1].map((index) => ({
    id: `proposal-${index}`,
    artistKey: `artist-${index}`,
    blueprint: blueprint(challenge, index, 400 + index * 200),
  }));
  const shortlist = shortlistStudioProposals(proposals, challenge, seed, rules);
  check(shortlist.finalists.length === 2, 'Two distinct legal finalists required');
  const selection = resolveStudioSelection(
    shortlist.finalists,
    Array.from({ length: 10 }, (_, i) => ({ actorKey: `v${i}`, choice: i < 6 ? 1 : 2 })),
  );
  check(selection.outcome.kind === 'design', 'Design should win 6 to 4');
  const winner = selection.outcome.finalist;
  const dormant = studioDormantFinalist(
    shortlist.finalists,
    selection.tally,
    winner.blueprint,
    rules,
  );
  check(
    dormant !== null && dormant.hash !== winner.hash,
    'Different-direction losing design must be captured',
  );
  check(
    evaluateDormantBlueprint(dormant.blueprint, current.genome, 3, rules).eligible,
    'Dormant art must revalidate',
  );
  check(
    !evaluateDormantBlueprint(dormant.blueprint, current.genome, 0, rules).eligible,
    'Expired dormant art cannot be used',
  );
  checks.push({
    scenario: 'studio selection with dormant capture',
    passed: true,
    observations: { counts: selection.tally.counts, winner: winner.hash, dormant: dormant.hash },
  });

  const approved = approveStudioAdaptation(
    'adaptation-1',
    winner.blueprint,
    challenge,
    current,
    slots,
    rules,
  );
  rejects(
    () =>
      approveStudioAdaptation(
        'adaptation-conflict',
        winner.blueprint,
        challenge,
        current,
        approved.slots,
        rules,
      ),
    'PENDING_ADAPTATION_EXISTS',
  );
  check(
    canonicalJson(current.genome) === canonicalJson(rules.genome.founder) &&
      current.appearanceHash === null,
    'Approval must not commit art or genes',
  );
  checks.push({
    scenario: 'pending-adaptation conflicts',
    passed: true,
    observations: { reserved: approved.slots.reservation, unappliedGenome: current.genome },
  });

  const committed = commitStudioAdaptation(
    approved.pending,
    current,
    approved.slots,
    slots.next,
    rules,
  );
  let eligibilityChecks = 0;
  for (let toggle = 0; toggle < 50; toggle++)
    for (const availability of ['ACTIVE', 'REST'] as const) {
      check(
        !studioEligibility({
          enabled: true,
          online: true,
          healthy: true,
          status: 'ALIVE',
          availability,
          slots: committed.slots,
        }).eligible,
        'Break toggles cannot skip observation',
      );
      eligibilityChecks++;
    }
  rejects(() => consumeMutationSlot(committed.slots, 'extra', 2), 'SLOT_UNAVAILABLE');
  const observed = completeSlotObservation(committed.slots, 1, true);
  check(
    studioEligibility({
      enabled: true,
      online: true,
      healthy: true,
      status: 'ALIVE',
      availability: 'REST',
      slots: observed,
    }).eligible,
    'Valid observation unlocks the next slot',
  );
  checks.push({
    scenario: 'repeated break toggles',
    passed: true,
    observations: {
      eligibilityChecks,
      commitments: committed.slots.commitments.length,
      nextSlot: observed.next,
    },
  });

  const appearance = committedStudioAppearance(winner.blueprint, null, 'Synthetic host', {
    optedIn: true,
    credit: 'Synthetic artist',
  });
  const child = inheritCommittedDesign({ genome: committed.organism.genome, appearance });
  check(
    child.appearance.kind === 'studio' && child.appearance.hash === winner.hash,
    'Child must carry committed appearance',
  );
  check(
    canonicalJson(child.genome) === canonicalJson(committed.organism.genome),
    'Child must inherit the committed genome',
  );
  checks.push({
    scenario: 'appearance inheritance',
    passed: true,
    observations: { appearanceHash: winner.hash, inheritedGenome: child.genome },
  });

  const restored = JSON.parse(
    JSON.stringify({ organism: committed.organism, slots: committed.slots }),
  ) as { organism: StudioOrganism; slots: MutationSlots };
  const duplicate = commitStudioAdaptation(
    approved.pending,
    restored.organism,
    restored.slots,
    1,
    rules,
  );
  check(
    duplicate.outcome === 'already_committed' && duplicate.slots.commitments.length === 1,
    'Restored duplicate must not consume another slot',
  );
  check(
    canonicalJson(duplicate.organism) === canonicalJson(restored.organism),
    'Restored duplicate must not change organism state',
  );
  checks.push({
    scenario: 'checkpoint restart with duplicate commitment',
    passed: true,
    observations: { outcome: duplicate.outcome, commitments: duplicate.slots.commitments.length },
  });

  const cosmeticCurrent: StudioOrganism = {
    ...current,
    genome: { pulse: 3, calm: 3, grit: 15, drift: 3 },
  };
  const cosmeticChallenge = challengeFor(cosmeticCurrent, slots);
  const cosmetic = blueprint(cosmeticChallenge, 0, 800);
  check(
    cosmetic.mutationTemplateId === 'cosmetic-only',
    'Boundary genome must only offer cosmetics',
  );
  const pendingCosmetic = approveStudioAdaptation(
    'cosmetic',
    cosmetic,
    cosmeticChallenge,
    cosmeticCurrent,
    slots,
    rules,
  );
  const hatchedCosmetic = commitStudioAdaptation(
    pendingCosmetic.pending,
    cosmeticCurrent,
    pendingCosmetic.slots,
    1,
    rules,
  );
  let comparisons = 0;
  for (let burst = 0; burst <= 1000; burst += 100)
    for (const trace of [null, 'shelter', 'charged', 'recovery'] as const) {
      const input = {
        genome: cosmeticCurrent.genome,
        healthBefore: 70,
        profile: { burst, steadiness: 1000 - burst },
        shocks: [{ kind: 'arrival' as const, amount: 4 }],
        trace,
      };
      check(
        canonicalJson(scoreRound(input, rules)) ===
          canonicalJson(scoreRound({ ...input, genome: hatchedCosmetic.organism.genome }, rules)),
        'Cosmetics must have zero fitness benefit',
      );
      comparisons++;
    }
  checks.push({
    scenario: 'zero gameplay benefit from cosmetic designs',
    passed: true,
    observations: {
      comparisons,
      hash: hatchedCosmetic.organism.appearanceHash,
      genome: hatchedCosmetic.organism.genome,
    },
  });
  return checks;
}
export function studioScenariosHash(checks: readonly ScenarioCheck[]) {
  return sha256Hex(canonicalJson(checks));
}
