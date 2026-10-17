// AuthProvider: turns a bearer token into a verified identity. Everything that identifies a caller goes through here,
// so the identity system can change (Supabase Auth for the pilot, the customer's OIDC provider later) without touching the functions.
//   verify(token) -> { ok: true, identity: { provider, key, email } } | { ok: false, reason }
//   identity.key is the stable lookup value stored on the person: Supabase user id, or "<issuer>|<sub>" for OIDC.
// Selection: EMNS_AUTH_PROVIDER = supabase (default) | oidc.  OIDC needs EMNS_OIDC_ISSUER, EMNS_OIDC_AUDIENCE and EMNS_OIDC_JWKS_URI.
const crypto = require('crypto');

function createSupabaseAuthProvider(db) {
  return {
    name: 'supabase',
    async verify(token) {
      if (!token) return { ok: false, reason: 'missing token' };
      const { data, error } = await db.auth.getUser(token);
      if (error || !data || !data.user) return { ok: false, reason: 'invalid or expired session' };
      return { ok: true, identity: { provider: 'supabase', key: data.user.id, email: data.user.email || null } };
    },
    // Creates an account and emails the person an invitation. Returns { ok, userId } or { ok: false, reason }.
    async inviteUser(email) {
      const { data, error } = await db.auth.admin.inviteUserByEmail(email);
      if (error || !data || !data.user) return { ok: false, reason: (error && error.message) || 'could not invite' };
      return { ok: true, userId: data.user.id };
    },
  };
}

const b64urlJson = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
const SKEW_SECONDS = 60;

// Verifies RS256 ID/access tokens from any standards-compliant OIDC provider. `getJwks` returns { keys: [...] }.
function createOidcAuthProvider({ issuer, audience, getJwks, now = () => Date.now() / 1000 }) {
  if (!issuer || !audience || typeof getJwks !== 'function') throw new Error('OIDC needs issuer, audience and a JWKS source.');
  return {
    name: 'oidc',
    async inviteUser() { return { ok: false, reason: 'Accounts are created in your identity provider. Link an existing identity instead.' }; },
    async verify(token) {
      if (!token) return { ok: false, reason: 'missing token' };
      const parts = token.split('.');
      if (parts.length !== 3) return { ok: false, reason: 'malformed token' };
      let header, claims;
      try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return { ok: false, reason: 'malformed token' }; }
      if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported algorithm' }; // never accept "none" or HMAC
      let jwks;
      try { jwks = await getJwks(); } catch { return { ok: false, reason: 'keys unavailable' }; }
      const jwk = (jwks.keys || []).find((k) => k.kid === header.kid && (!k.use || k.use === 'sig') && k.kty === 'RSA');
      if (!jwk) return { ok: false, reason: 'unknown signing key' };
      let valid = false;
      try {
        valid = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
      } catch { valid = false; }
      if (!valid) return { ok: false, reason: 'bad signature' };
      const t = now();
      if (claims.iss !== issuer) return { ok: false, reason: 'wrong issuer' };
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(audience)) return { ok: false, reason: 'wrong audience' };
      if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < t) return { ok: false, reason: 'expired' };
      if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > t) return { ok: false, reason: 'not yet valid' };
      if (!claims.sub || typeof claims.sub !== 'string') return { ok: false, reason: 'no subject' };
      return { ok: true, identity: { provider: 'oidc', key: `${issuer}|${claims.sub}`, email: claims.email || null } };
    },
  };
}

let jwksCache = { uri: null, at: 0, value: null };
function fetchJwksCached(uri, fetchImpl = fetch) {
  return async () => {
    if (jwksCache.uri === uri && Date.now() - jwksCache.at < 10 * 60 * 1000) return jwksCache.value;
    const res = await fetchImpl(uri);
    if (!res.ok) throw new Error(`JWKS fetch failed (${res.status})`);
    jwksCache = { uri, at: Date.now(), value: await res.json() };
    return jwksCache.value;
  };
}

let override = null;
function setAuthProviderForTests(p) { override = p; }

function getAuthProvider(db, env = process.env) {
  if (override) return override;
  const choice = (env.EMNS_AUTH_PROVIDER || 'supabase').toLowerCase();
  if (choice === 'supabase') return createSupabaseAuthProvider(db);
  if (choice === 'oidc') {
    return createOidcAuthProvider({ issuer: env.EMNS_OIDC_ISSUER, audience: env.EMNS_OIDC_AUDIENCE, getJwks: fetchJwksCached(env.EMNS_OIDC_JWKS_URI) });
  }
  throw new Error(`Unknown EMNS_AUTH_PROVIDER "${choice}".`);
}

// Staff (operators) always sign in with the built-in account system; EMNS_AUTH_PROVIDER selects how EMPLOYEES sign in (my-contact).
function getStaffAuthProvider(db) { return createSupabaseAuthProvider(db); }

module.exports = { createSupabaseAuthProvider, createOidcAuthProvider, getAuthProvider, getStaffAuthProvider, setAuthProviderForTests };
