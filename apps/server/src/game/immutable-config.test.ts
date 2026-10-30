import { expect, it } from 'vitest';
import { candidateRuleset, rulesetCanonicalJson, rulesetHash } from '@ripple/engine';
import { storedRules } from './immutable-config.ts';
it('never lets a cached valid rules hash authorize corrupt bytes from another database or world', () => {
  const canonical = rulesetCanonicalJson(candidateRuleset),
    hash = rulesetHash(candidateRuleset);
  expect(storedRules(hash, canonical).version).toBe(candidateRuleset.version);
  const altered = JSON.stringify({ ...candidateRuleset, version: 'corrupt-cache-collision' });
  expect(() => storedRules(hash, altered)).toThrow('hash mismatch');
  expect(() => storedRules('0'.repeat(64), canonical)).toThrow('hash mismatch');
});
