const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { loadFunction } = require('./helpers/loadFunction.cjs');
const { createFakeDb } = require('./helpers/fakeDb.cjs');
const { setDbForTests } = require('../src/server/providers/dataStore.cjs');
const { setEmailProviderForTests } = require('../src/server/providers/index.cjs');
const { createMockEmailProvider } = require('../src/server/providers/mockEmailProvider.cjs');

const P1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1';
const P2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2';
const P3 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3';
const op = (role) => ({ id: 'op1', organization_id: 'org1', role, is_platform_admin: false });
const req = (body, token = 'good') => ({ httpMethod: 'POST', headers: { authorization: `Bearer ${token}`, host: 'x.netlify.app' }, body: JSON.stringify(body) });
const people = [
  { id: P1, full_name: 'Sam One', email: 's@x.com', mobile_phone: '+15550000001', consent_status: 'pending', is_active: true },
  { id: P2, full_name: 'Pat Two', email: null, mobile_phone: '+15550000002', consent_status: 'withdrawn', is_active: true },
  { id: P3, full_name: 'Done Three', email: null, mobile_phone: '+15550000003', consent_status: 'consented', is_active: true },
];

function setup(operator, rpcImpl, peopleRows) {
  const db = createFakeDb({ tables: { operators: operator, people: peopleRows || people, group_members: [], organizations: { name: 'Acme Hospital' } }, user: { id: 'u1' },
    rpc: { create_enrollment_invites: rpcImpl || ((a) => ({ data: a.p_invites.map((i) => i.person_id), error: null })) } });
  setDbForTests(db);
  delete process.env.URL;
  return db;
}

test('only admins and senders can create links', async () => {
  const fn = loadFunction('create-invites');
  setup(op('viewer'));
  assert.equal((await fn.handler(req({}))).statusCode, 403);
  setup(op('operator'));
  assert.equal((await fn.handler(req({}))).statusCode, 403);
  setup(op('sender'));
  assert.equal((await fn.handler(req({}))).statusCode, 200);
  assert.equal((await fn.handler({ httpMethod: 'GET', headers: {} })).statusCode, 405);
});

test('links go to everyone not yet consented; the database only ever receives hashes', async () => {
  const fn = loadFunction('create-invites');
  const db = setup(op('admin'));
  const out = JSON.parse((await fn.handler(req({}))).body);
  assert.equal(out.created, 2);
  assert.deepEqual(out.invites.map((i) => i.person_id).sort(), [P1, P2]);
  const sent = db.calls.find((c) => c.rpc === 'create_enrollment_invites').args;
  assert.equal(sent.p_org, 'org1');
  assert.equal(sent.p_created_by, 'op1');
  for (const inv of out.invites) {
    assert.match(inv.link, /^https:\/\/x\.netlify\.app\/enroll\/[A-Za-z0-9_-]{43}$/);
    const token = inv.link.split('/enroll/')[1];
    const row = sent.p_invites.find((r) => r.person_id === inv.person_id);
    assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
    assert.equal(JSON.stringify(sent).includes(token), false, 'plaintext token never reaches the database');
  }
  assert.equal(new Set(out.invites.map((i) => i.link)).size, 2, 'every link is unique');
});

test('a person the database declines gets no link', async () => {
  const fn = loadFunction('create-invites');
  setup(op('admin'), () => ({ data: [P1], error: null }));
  const out = JSON.parse((await fn.handler(req({ person_ids: [P1, P2] }))).body);
  assert.deepEqual(out.invites.map((i) => i.person_id), [P1]);
  assert.equal(out.created, 1);
  assert.equal(out.skipped, 1);
});

test('validates input', async () => {
  const fn = loadFunction('create-invites');
  setup(op('admin'));
  assert.equal((await fn.handler(req({ person_ids: [] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ person_ids: ['nope'] }))).statusCode, 400);
  assert.equal((await fn.handler(req({ group_id: 'nope' }))).statusCode, 400);
});

test('database errors are not leaked', async () => {
  const fn = loadFunction('create-invites');
  setup(op('admin'), () => ({ data: null, error: { message: 'secret internal detail' } }));
  const r = await fn.handler(req({}));
  assert.equal(r.statusCode, 500);
  assert.equal(r.body.includes('secret internal detail'), false);
});

test('send_email emails each person their own link, never texts, and withholds emailed links', async () => {
  const fn = loadFunction('create-invites');
  const mail = createMockEmailProvider();
  setEmailProviderForTests(mail);
  setup(op('admin'), null, [
    ...people.slice(0, 2),
    { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4', full_name: 'Opt Four', email: 'o@x.com', email_opted_out: true, mobile_phone: '+15550000004', consent_status: 'pending', is_active: true },
  ]);
  const out = JSON.parse((await fn.handler(req({ send_email: true }))).body);
  assert.equal(out.emailed, 1);
  assert.equal(out.no_email, 2);
  assert.equal(out.email_failed, 0);
  assert.equal(mail.sent.length, 1);
  assert.equal(mail.sent[0].to, 's@x.com');
  assert.match(mail.sent[0].subject, /Acme Hospital/);
  const link = mail.sent[0].body.match(/https:\/\/x\.netlify\.app\/enroll\/[A-Za-z0-9_-]{43}/)[0];
  assert.ok(link);
  assert.equal(out.invites.some((i) => i.link === link), false, 'emailed link is not returned to the sender');
  assert.equal(out.invites.length, 2, 'people who could not be emailed still get a link to deliver by hand');
  setEmailProviderForTests(null);
});

test('a failed email send keeps the link for hand delivery', async () => {
  const fn = loadFunction('create-invites');
  setEmailProviderForTests(createMockEmailProvider({ failAddresses: { 's@x.com': 'invalid_email' } }));
  setup(op('admin'), null, [people[0]]);
  const out = JSON.parse((await fn.handler(req({ send_email: true }))).body);
  assert.equal(out.emailed, 0);
  assert.equal(out.email_failed, 1);
  assert.equal(out.invites.length, 1);
  setEmailProviderForTests(null);
});
