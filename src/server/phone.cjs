// Server-side phone normalization (same rules as src/lib/rosterCore.mjs): returns E.164 or null.
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim();
  if (!s) return null;
  s = s.replace(/(ext\.?|x)\s*\d+$/i, '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  let out;
  if (s.startsWith('+')) out = '+' + digits;
  else if (digits.length === 10) out = '+1' + digits;
  else if (digits.length === 11 && digits.startsWith('1')) out = '+' + digits;
  else return null;
  return /^\+[1-9][0-9]{7,14}$/.test(out) ? out : null;
}
module.exports = { normalizePhone };
