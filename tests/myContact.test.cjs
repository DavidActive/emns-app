const test = require('node:test');
const assert = require('node:assert');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');

// Identity-aware fake: rows are matched on the filters the function applies, so a function that looked up the wrong person would show up here.
function makeDb({ users = {}, people = [], operators = {} } = {}) {
  const calls = [];
  const from = (table) => {
    const st = { filters: [] };
    const rows = () => {
      const src = table === 'people' ? people : table === 'organizations' ? [{ id: 'org1', name: 'Acme Hospital' }] : [];
      return src.filter((r) => st.filters.every(([c, v]) => r[c] === v));
    };
    const b = new Proxy({}, { get(_t, k) {
      if (k === 'eq') return (c, v) => { st.filters.push([c, v]); return b; };
      if (k === 'maybeSingle') return async () => {
        if (table === 'operators') return { data: operators[st.filters.find(([c]) => c === 'user_id')?.[1]] || null, error: null };
        return { data: rows()[0] || null, error: null };
      };
      return () => b;
    } });
    return b;
  };
  const db = {
    calls, from,
    auth: { getUser: async (t) => (users[t] ? { data: { user: users[t] }, error: null } : { data: { user: null }, error: { message: 'bad' } }),
            admin: { inviteUserByEmail: async (email) => ({ data: { user: { id: 'new-user' } }, error: null }) } },
    rpc: async (name, args) => {
      calls.push({ rpc: name, args });
      if (name === 'self_update_contact') {
        const p = people.find((x) => x.id === args.p_person);
        const changed = [];
        if (args.p_mobile && args.p_mobile !== p.mobile_phone) { changed.push('mobile_phone'); p.mobile_phone = args.p_mobile; }
        if (args.p_email !== null && args.p_email !== p.email) { changed.push('email'); p.email = args.p_email; }
        const reset = changed.includes('mobile_phone') && p.consent_status === 'consented';
        if (reset) p.consent_status = 'pending';
        return { data: { changed, consent_reset: reset }, error: null };
      }
      return { data: true, error: null };
    },
  };
  return db;
}
const A = { id: 'pa', organization_id: 'org1', full_name: 'Emp A', mobile_phone: '+15553000001', email: 'a@x.test', consent_status: 'consented', is_active: true, user_id: 'ua' };
const B = { id: 'pb', organization_id: 'org1', full_name: 'Emp B', mobile_phone: '+15553000002', email: 'b@x.test', consent_status: 'consented', is_active: true, user_id: 'ub' };
const C = { id: 'pc', organization_id: 'org1', full_name: 'Emp C', mobile_phone: '+15553000003', email: 'c@x.test', consent_status: 'consented', is_active: true, idp_subject: 'https://idp.test|c' };
const req = (body, token) => ({ httpMethod: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
const users = { ta: { id: 'ua' }, tb: { id: 'ub' }, tnone: { id: 'stranger' } };

test('an employee reads only their own record, whatever the request says', async () => {
  const people = [{ ...A }, { ...B }];
  setDbForTests(makeDb({ users, people }));
  const fn = loadFunction('my-contact');
  const a = JSON.parse((await fn.handler(req({ action: 'get', person_id: 'pb', id: 'pb', user_id: 'ub' }, 'ta'))).body);
  assert.equal(a.person.full_name, 'Emp A');
  assert.equal(a.person.email, 'a@x.test');
  const b = JSON.parse((await fn.handler(req({ action: 'get' }, 'tb'))).body);
  assert.equal(b.person.full_name, 'Emp B');
  assert.doesNotMatch(JSON.stringify(a), /Emp B|b@x\.test|3000002/);
});

test('an employee can edit only their own record; the other one is unchanged; changes reach the database function with the verified actor', async () => {
  const people = [{ ...A }, { ...B }];
  const db = makeDb({ users, people });
  setDbForTests(db);
  const fn = loadFunction('my-contact');
  const r = await fn.handler(req({ action: 'update', email: 'new-a@x.test', person_id: 'pb' }, 'ta'));
  assert.equal(r.statusCode, 200);
  assert.equal(people[0].email, 'new-a@x.test');
  assert.equal(people[1].email, 'b@x.test', 'employee B untouched');
  const call = db.calls.find((c) => c.rpc === 'self_update_contact');
  assert.equal(call.args.p_person, 'pa');
  assert.equal(call.args.p_actor, 'supabase:ua');
});

test('changing the mobile number normalizes it and reports that consent was reset', async () => {
  const people = [{ ...A }, { ...B }];
  setDbForTests(makeDb({ users, people }));
  const fn = loadFunction('my-contact');
  const r = JSON.parse((await fn.handler(req({ action: 'update', mobile_phone: '(555) 300-9999' }, 'ta'))).body);
  assert.equal(r.consent_reset, true);
  assert.equal(people[0].mobile_phone, '+15553009999');
  assert.equal(people[0].consent_status, 'pending');
});

test('bad input, unknown accounts and bad tokens are refused', async () => {
  const people = [{ ...A }, { ...B }];
  const db = makeDb({ users, people });
  setDbForTests(db);
  const fn = loadFunction('my-contact');
  assert.equal((await fn.handler(req({ action: 'get' }, 'nope'))).statusCode, 401);
  assert.equal((await fn.handler(req({ action: 'get' }, 'tnone'))).statusCode, 403, 'signed in but not linked to anyone');
  assert.equal((await fn.handler(req({ action: 'update', mobile_phone: '12' }, 'ta'))).statusCode, 400);
  assert.equal((await fn.handler(req({ action: 'update', email: 'nope' }, 'ta'))).statusCode, 400);
  assert.equal((await fn.handler(req({ action: 'update' }, 'ta'))).statusCode, 400);
  assert.equal((await fn.handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
  assert.equal(db.calls.some((c) => c.rpc === 'self_update_contact'), false);
});

test('an inactive employee cannot use self-service', async () => {
  setDbForTests(makeDb({ users, people: [{ ...A, is_active: false }] }));
  const fn = loadFunction('my-contact');
  assert.equal((await fn.handler(req({ action: 'get' }, 'ta'))).statusCode, 403);
});

test('sign-in through the OIDC adapter finds the employee by issuer|subject', async () => {
  const { setAuthProviderForTests } = require('../src/server/auth/authProvider.cjs');
  const people = [{ ...A }, { ...C }];
  setDbForTests(makeDb({ users, people }));
  setAuthProviderForTests({ name: 'oidc', verify: async (t) => (t === 'idp-c' ? { ok: true, identity: { provider: 'oidc', key: 'https://idp.test|c', email: 'c@x.test' } } : { ok: false }) });
  try {
    const fn = loadFunction('my-contact');
    const r = JSON.parse((await fn.handler(req({ action: 'get' }, 'idp-c'))).body);
    assert.equal(r.person.full_name, 'Emp C');
    assert.equal((await fn.handler(req({ action: 'get' }, 'ta'))).statusCode, 401, 'a Supabase token is not valid while OIDC is active');
  } finally { setAuthProviderForTests(null); }
});

test('link-employee: admins only, own organization only', async () => {
  const people = [{ ...A, user_id: null }, { ...B, organization_id: 'org2', user_id: null }];
  const operators = { uadm: { id: 'op1', organization_id: 'org1', role: 'admin', is_platform_admin: false }, uviewer: { id: 'op2', organization_id: 'org1', role: 'operator', is_platform_admin: false } };
  const db = makeDb({ users: { tadm: { id: 'uadm' }, tviewer: { id: 'uviewer' } }, people, operators });
  setDbForTests(db);
  const fn = loadFunction('link-employee');
  const U = '11111111-1111-1111-1111-111111111111';
  assert.equal((await fn.handler(req({ person_id: U }, 'tviewer'))).statusCode, 403);
  people[0].id = U; people[1].id = '22222222-2222-2222-2222-222222222222';
  assert.equal((await fn.handler(req({ person_id: people[1].id }, 'tadm'))).statusCode, 404, 'person in another organization');
  const ok = await fn.handler(req({ person_id: U }, 'tadm'));
  assert.equal(ok.statusCode, 200);
  const call = db.calls.find((c) => c.rpc === 'link_person_identity');
  assert.equal(call.args.p_user_id, 'new-user');
  assert.equal(call.args.p_org, 'org1');
});
