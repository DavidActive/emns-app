const test = require('node:test');
const assert = require('node:assert');
const { matchKeywordTier, DEFAULT_TIER_RULES } = require('../src/server/replies/triage.cjs');
const tier = (t, rules = DEFAULT_TIER_RULES) => (matchKeywordTier(t, rules) || { tier: 2 }).tier;

test('plain reassurance is tier 1', () => {
  for (const t of ['safe', 'SAFE', "I'm OK", 'im fine', 'All clear here', 'checking in']) assert.equal(tier(t), 1, t);
});
test('unsafe is critical, not "safe"', () => { assert.equal(tier('I feel unsafe'), 3); });
test('negated reassurance is critical', () => {
  for (const t of ['I am not safe', "I'm not ok", 'not really fine', 'never felt safe']) assert.equal(tier(t), 3, t);
});
test('whole words only: "send it" is not "end it"', () => { assert.equal(tier('please send it to the office'), 2); });
test('emergency words are critical', () => {
  for (const t of ['shooter in the east lot', 'there is a fire in building B', 'he is bleeding and unconscious', 'I cant breathe', 'shots fired', 'bomb threat']) assert.equal(tier(t), 3, t);
});
test('highest tier wins over reassurance', () => { assert.equal(tier('I am safe but my friend is injured'), 3); });
test('no match is tier 2 (a person looks at it)', () => { assert.equal(tier('On my way to the east lot'), 2); });
test('an organization with its own rules uses only those', () => {
  const rules = [{ keyword: 'relapse', tier: 3 }, { keyword: 'doing well', tier: 1 }];
  assert.equal(tier('I think I will relapse', rules), 3);
  assert.equal(tier('shooter in the lot', rules), 2);
  assert.equal(tier('doing well', rules), 1);
});
test('empty or odd input does not throw', () => { assert.equal(tier(''), 2); assert.equal(tier(null), 2); });
