const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createOidcAuthProvider, createSupabaseAuthProvider, getAuthProvider } = require('../src/server/auth/authProvider.cjs');

// A mock identity provider: one RSA key, tokens signed the way a real OIDC provider signs them.
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
const ISS = 'https://idp.test', AUD = 'emns';
const NOW = 1_800_000_000;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(claims, { key = privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' } } = {}) {
  const head = b64(header), body = b64(claims);
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const good = { iss: ISS, aud: AUD, sub: 'abc', email: 'a@x.test', exp: NOW + 600 };
const provider = createOidcAuthProvider({ issuer: ISS, audience: AUD, getJwks: async () => ({ keys: [jwk] }), now: () => NOW });

test('OIDC adapter accepts a valid token and keys the identity by issuer and subject', async () => {
  const r = await provider.verify(sign(good));
  assert.equal(r.ok, true);
  assert.deepEqual(r.identity, { provider: 'oidc', key: 'https://idp.test|abc', email: 'a@x.test' });
  assert.equal((await provider.verify(sign({ ...good, aud: ['other', AUD] }))).ok, true, 'audience list');
});

test('OIDC adapter rejects forged, expired, mis-addressed and downgraded tokens', async () => {
  const bad = async (t) => (await provider.verify(t)).ok;
  assert.equal(await bad(sign(good, { key: other.privateKey })), false, 'signed by a different key');
  assert.equal(await bad(sign({ ...good, exp: NOW - 120 })), false, 'expired');
  assert.equal(await bad(sign({ ...good, iss: 'https://evil.test' })), false, 'wrong issuer');
  assert.equal(await bad(sign({ ...good, aud: 'someone-else' })), false, 'wrong audience');
  assert.equal(await bad(sign({ ...good, nbf: NOW + 3600 })), false, 'not yet valid');
  assert.equal(await bad(sign({ ...good, sub: undefined })), false, 'no subject');
  assert.equal(await bad(sign(good, { header: { alg: 'RS256', kid: 'nope' } })), false, 'unknown key id');
  assert.equal(await bad(`${b64({ alg: 'none', kid: 'k1' })}.${b64(good)}.`), false, 'alg none');
  assert.equal(await bad(sign(good, { header: { alg: 'HS256', kid: 'k1' } })), false, 'HMAC downgrade');
  const tampered = sign(good).split('.'); tampered[1] = b64({ ...good, sub: 'admin' });
  assert.equal(await bad(tampered.join('.')), false, 'payload changed after signing');
  assert.equal(await bad('garbage'), false);
  assert.equal(await bad(''), false);
});

test('Supabase adapter and the factory', async () => {
  const db = { auth: { getUser: async (t) => (t === 'good' ? { data: { user: { id: 'u1', email: 'e@x.test' } }, error: null } : { data: { user: null }, error: { message: 'bad' } }) } };
  const sp = createSupabaseAuthProvider(db);
  assert.deepEqual((await sp.verify('good')).identity, { provider: 'supabase', key: 'u1', email: 'e@x.test' });
  assert.equal((await sp.verify('bad')).ok, false);
  assert.equal(getAuthProvider(db, {}).name, 'supabase');
  assert.equal(getAuthProvider(db, { EMNS_AUTH_PROVIDER: 'oidc', EMNS_OIDC_ISSUER: ISS, EMNS_OIDC_AUDIENCE: AUD, EMNS_OIDC_JWKS_URI: 'https://idp.test/jwks' }).name, 'oidc');
  assert.throws(() => getAuthProvider(db, { EMNS_AUTH_PROVIDER: 'nope' }));
});
