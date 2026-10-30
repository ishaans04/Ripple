import {
  assertCompatibleRuleset,
  mechanicsPolicyHash,
  mechanicsPolicySchema,
  parseRuleset,
  rulesetHash,
  type Ruleset,
  type MechanicsPolicy,
} from '@ripple/engine';
// Cache by both stored bytes and claimed hash: a corrupt row in any world/database must still fail.
const rules = new Map<string, Ruleset>();
const policies = new Map<string, MechanicsPolicy>();
function remember<T>(cache: Map<string, T>, key: string, value: T): T {
  const oldest = cache.keys().next().value;
  if (cache.size >= 64 && oldest !== undefined) cache.delete(oldest);
  cache.set(key, value);
  return value;
}
export function storedRules(hash: string, canonical: string): Ruleset {
  const key = `${hash}:${canonical}`,
    hit = rules.get(key);
  if (hit) return hit;
  const parsed = parseRuleset(JSON.parse(canonical));
  assertCompatibleRuleset(parsed);
  if (rulesetHash(parsed) !== hash) throw new Error('Stored ruleset hash mismatch.');
  return remember(rules, key, parsed);
}
export function storedMechanics(hash: string, canonical: string): MechanicsPolicy {
  const key = `${hash}:${canonical}`,
    hit = policies.get(key);
  if (hit) return hit;
  const parsed = mechanicsPolicySchema.parse(JSON.parse(canonical));
  if (mechanicsPolicyHash(parsed) !== hash)
    throw new Error('Stored mechanics policy hash mismatch.');
  return remember(policies, key, parsed);
}
