// Tokens and pairing codes for the desktop agent. Only SHA-256 hashes are ever stored in the database.
const crypto = require('crypto');

// No 0/O, 1/I/L so a code read off a screen cannot be mistyped.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function newPairingCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// People type codes with spaces, dashes, lower case. Anything else cannot be a code.
function normalizeCode(input) {
  const s = String(input == null ? '' : input).toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!ALPHABET.includes(ch)) return null;
  return s;
}
const hashCode = (input) => { const n = normalizeCode(input); return n ? sha256(`emns-pairing:${n}`) : null; };

function newDeviceToken() { return `emns_dev_${crypto.randomBytes(32).toString('base64url')}`; }
const TOKEN_RE = /^emns_dev_[A-Za-z0-9_-]{43}$/;
const hashToken = (token) => (TOKEN_RE.test(String(token || '')) ? sha256(`emns-device:${token}`) : null);

function bearer(event) {
  const h = (event && event.headers) || {};
  return String(h.authorization || h.Authorization || '').replace(/^Bearer\s+/i, '');
}

module.exports = { newPairingCode, normalizeCode, hashCode, newDeviceToken, hashToken, bearer, ALPHABET, TOKEN_RE };
