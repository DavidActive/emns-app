// Classifies a plain inbound text as an acknowledgement: SAFE, SOS, or TEXT (anything else).
// SAFE must be the WHOLE message ("safe", "I'm OK", "all good") so "safe but injured" is never counted as safe.
// SOS is matched anywhere in the message and wins over TEXT. When unsure, the message is TEXT, which a human triages.
// HELP is deliberately not an SOS word: Twilio answers HELP at the carrier level.
const norm = (t) => String(t || '').toLowerCase().replace(/[‘’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

const SAFE_RE = /^(?:(?:im|i am|were|we are)\s+)?(?:safe|ok|okay|fine|all good|all clear)(?:\s+(?:and\s+)?(?:safe|ok|okay|well|fine|here|now|thanks|thank you|all good))*$/;
const SOS_RE = /\b(?:sos|help me|need help|send help|emergency|not safe|unsafe|in danger|trapped|injured)\b/;

function classifyReply(text) {
  const n = norm(text);
  if (!n) return { response: 'TEXT', normalized: n };
  if (SAFE_RE.test(n)) return { response: 'SAFE', normalized: n };
  if (SOS_RE.test(n)) return { response: 'SOS', normalized: n };
  return { response: 'TEXT', normalized: n };
}
module.exports = { classifyReply };
