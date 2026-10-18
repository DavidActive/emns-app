// Reads the urgency of a plain-text message. Same method as Protect and VetProtect (organization-editable keyword rules,
// tier 1 = routine / safe, tier 2 = needs a look, tier 3 = critical), hardened for emergency use:
//   * whole words only, so "unsafe" is not "safe" and "send it" is not "end it"
//   * a negated reassurance ("not safe", "I'm not ok", "never felt safe") is critical, never routine
//   * the highest tier found wins; the tier is only ever raised, never lowered, by the caller
// Rules come from the organization's priority_rules rows. An organization with no rows gets DEFAULT_TIER_RULES.
// A person always reaches a human: this never decides that a message needs no review except for an exact SAFE-type reply.
const norm = (t) => String(t || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const NEGATORS = new Set(['not', 'no', 'never', 'cant', 'cannot', 'dont', 'isnt', 'arent', 'wasnt', 'werent', 'aint', 'hardly', 'barely']);

const DEFAULT_TIER_RULES = [
  // critical
  ...['suicide', 'kill myself', 'end it', 'help me now', 'help me', 'need help', 'send help', 'sos', 'emergency', 'unsafe', 'in danger', 'trapped', 'injured',
    'shooter', 'active shooter', 'gun', 'gunshots', 'shots fired', 'fire', 'explosion', 'bomb', 'bleeding', 'unconscious', 'cant breathe', 'heart attack',
    'overdose', 'hostage', 'attack', 'assault', 'dying', 'hurt badly', 'life threatening'].map((keyword) => ({ keyword, tier: 3 })),
  // routine
  ...['safe', 'ok', 'okay', 'fine', 'all clear', 'all good', 'im ok', 'im safe', 'im fine', 'im good', 'checking in', 'accounted for'].map((keyword) => ({ keyword, tier: 1 })),
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Index (in tokens) where the keyword phrase starts in the normalized text, or -1. Whole words only.
function findPhrase(tokens, kwTokens) {
  for (let i = 0; i + kwTokens.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < kwTokens.length; j++) if (tokens[i + j] !== kwTokens[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

// Returns the best matching rule { keyword, tier, negated } or null. Highest tier wins.
function matchKeywordTier(text, rules) {
  const tokens = norm(text).split(' ').filter(Boolean);
  if (!tokens.length) return null;
  let best = null;
  for (const rule of rules || []) {
    const kw = norm(rule.keyword).split(' ').filter(Boolean);
    if (!kw.length) continue;
    const at = findPhrase(tokens, kw);
    if (at < 0) continue;
    let tier = Number(rule.tier);
    let negated = false;
    // A reassurance word with a negator in the two words before it ("not safe", "im not really ok") is a distress signal.
    if (tier === 1 && kw[0] !== 'checking') {
      const before = tokens.slice(Math.max(0, at - 2), at);
      if (before.some((w) => NEGATORS.has(w))) { tier = 3; negated = true; }
    }
    if (!best || tier > best.tier) best = { keyword: rule.keyword, tier, negated };
  }
  return best;
}
module.exports = { matchKeywordTier, DEFAULT_TIER_RULES, norm };
