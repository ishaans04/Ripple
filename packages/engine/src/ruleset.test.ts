import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  assertCompatibleRuleset,
  candidateRuleset,
  parseRuleset,
  rulesetCanonicalJson,
  rulesetHash,
  type Ruleset,
} from './ruleset.ts';

// The published candidate-1 ruleset, field by field from the PRD (sections 6-10).
// A published ruleset is immutable: any value change requires a new version.
const candidateCanonicalJson =
  '{"ballot":{"mutationCandidates":3},' +
  '"baseline":{"minRounds":3,"windowRounds":10},' +
  '"dormant":{"minRunnerUpPercent":20,"minRunnerUpVotes":2,"minTotalVotes":5,"triggerBurstChange":300},' +
  '"engineVersion":1,' +
  '"genome":{"budget":24,"founder":{"calm":6,"drift":6,"grit":6,"pulse":6},"max":15,"min":0,"mutationStep":2},' +
  '"habitat":{"bucketCount":12,"bucketMs":10000,"burstTopBuckets":3,"confidenceMinAccounts":3},' +
  '"health":{"founder":70,"max":100},' +
  '"migration":{"minChildHealth":10,"retentionBasePermille":350,"retentionPerDriftPermille":20},' +
  '"scoring":{"deltaMax":6,"deltaMin":-8,"fitWeight":6,"gritProtectionMax":8,"rawShockCap":8,"upkeep":3},' +
  '"shock":{"arrival":4,"categoryChange":2},' +
  '"traces":{"adjustmentMax":1,"adjustmentMin":-1,"chargedAdjustment":1,"chargedBurstThreshold":650,' +
  '"qualifyingRounds":2,"recoveryAdjustment":1,"recoveryHealthThreshold":30,' +
  '"shelterArrivalShockReduction":2,"shelterUpkeep":1},' +
  '"version":"candidate-1"}';

/** The candidate as raw stored JSON, open to arbitrary edits. */
type Draft = Record<string, unknown>;

function editedCandidate(edit: (draft: Draft) => void): unknown {
  const draft = JSON.parse(rulesetCanonicalJson(candidateRuleset)) as Draft;
  edit(draft);
  return draft;
}

function section(draft: Draft, key: keyof Ruleset): Draft {
  return draft[key] as Draft;
}

describe('candidateRuleset', () => {
  it('serializes to the published canonical JSON', () => {
    expect(rulesetCanonicalJson(candidateRuleset)).toBe(candidateCanonicalJson);
  });

  it('is identified by the SHA-256 of its canonical JSON', () => {
    expect(rulesetHash(candidateRuleset)).toBe(
      createHash('sha256').update(candidateCanonicalJson, 'utf8').digest('hex'),
    );
  });

  it('is deeply frozen', () => {
    expect(Object.isFrozen(candidateRuleset)).toBe(true);
    expect(Object.isFrozen(candidateRuleset.genome)).toBe(true);
    expect(Object.isFrozen(candidateRuleset.genome.founder)).toBe(true);
    expect(Object.isFrozen(candidateRuleset.traces)).toBe(true);
  });

  it('targets the current engine', () => {
    expect(candidateRuleset.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('parseRuleset', () => {
  it('round-trips the stored canonical JSON', () => {
    const parsed = parseRuleset(JSON.parse(candidateCanonicalJson));
    expect(rulesetCanonicalJson(parsed)).toBe(candidateCanonicalJson);
    expect(Object.isFrozen(parsed.scoring)).toBe(true);
  });

  it('changes the hash when any value changes', () => {
    const changed = parseRuleset(
      editedCandidate((draft) => {
        section(draft, 'scoring').upkeep = 4;
      }),
    );
    expect(rulesetHash(changed)).not.toBe(rulesetHash(candidateRuleset));
  });

  it.each<[string, (draft: Draft) => void]>([
    ['an unknown field', (d) => (d.extra = 1)],
    ['a missing section', (d) => delete d.traces],
    ['an unknown nested field', (d) => (section(d, 'scoring').bonus = 1)],
    ['a fractional value', (d) => (section(d, 'scoring').upkeep = 2.5)],
    ['an empty version', (d) => (d.version = '')],
    [
      'an illegal founder genome',
      (d) => (section(d, 'genome').founder = { pulse: 9, calm: 6, grit: 6, drift: 6 }),
    ],
    ['an unreachable budget', (d) => (section(d, 'genome').budget = 61)],
    ['a mutation step wider than the gene range', (d) => (section(d, 'genome').mutationStep = 16)],
    ['inverted gene bounds', (d) => Object.assign(section(d, 'genome'), { min: 10, max: 5 })],
    ['founder health above the maximum', (d) => (section(d, 'health').founder = 101)],
    ['as many top buckets as buckets', (d) => (section(d, 'habitat').burstTopBuckets = 12)],
    [
      'a baseline needing more rounds than its window',
      (d) => (section(d, 'baseline').minRounds = 11),
    ],
    ['a delta range excluding zero', (d) => (section(d, 'scoring').deltaMin = 1)],
    ['a trace cap excluding zero', (d) => (section(d, 'traces').adjustmentMax = -1)],
    [
      'a charged threshold beyond the profile scale',
      (d) => (section(d, 'traces').chargedBurstThreshold = 1001),
    ],
    [
      'a recovery threshold above maximum health',
      (d) => (section(d, 'traces').recoveryHealthThreshold = 101),
    ],
    [
      'a runner-up share above 100 percent',
      (d) => (section(d, 'dormant').minRunnerUpPercent = 101),
    ],
    [
      'a dormant trigger beyond the profile scale',
      (d) => (section(d, 'dormant').triggerBurstChange = 1001),
    ],
    [
      'a minimum child health above maximum health',
      (d) => (section(d, 'migration').minChildHealth = 101),
    ],
  ])('rejects %s', (_label, edit) => {
    expect(() => parseRuleset(editedCandidate(edit))).toThrow(
      expect.objectContaining({ code: 'INVALID_RULESET' }),
    );
  });
});

describe('assertCompatibleRuleset', () => {
  it('accepts a ruleset for this engine version', () => {
    expect(() => {
      assertCompatibleRuleset(candidateRuleset);
    }).not.toThrow();
  });

  it('refuses a ruleset written for another engine version', () => {
    const future = parseRuleset(
      editedCandidate((draft) => (draft.engineVersion = ENGINE_VERSION + 1)),
    );
    expect(() => {
      assertCompatibleRuleset(future);
    }).toThrow(expect.objectContaining({ code: 'INCOMPATIBLE_RULESET' }));
  });
});
