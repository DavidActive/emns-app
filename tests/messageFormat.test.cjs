const test = require('node:test');
const assert = require('node:assert');
const { formatMessage, cleanTag } = require('../src/server/broadcast/messageFormat.cjs');

test('alert text carries the brand, the organization, the ack line and opt-out wording', () => {
  assert.equal(
    formatMessage({ kind: 'alert', orgName: 'Acme Hospital', body: 'Shelter in place at Building A', requiresAck: true }),
    'Active SOS eMNS: ALERT from Acme Hospital: Shelter in place at Building A. Reply SAFE when secure. Reply STOP to opt out.');
  assert.equal(
    formatMessage({ kind: 'alert', orgName: 'Acme', body: 'Evacuate now!', requiresAck: false }),
    'Active SOS eMNS: ALERT from Acme: Evacuate now! Reply STOP to opt out.');
});

test('drills and tests are always tagged, with a configurable tag', () => {
  const d = formatMessage({ kind: 'drill', orgName: 'Acme', body: '', requiresAck: true });
  assert.equal(d, 'Active SOS eMNS: [DRILL] This is a drill from Acme. No action is needed. Reply SAFE to confirm you received this. Reply STOP to opt out.');
  const custom = formatMessage({ kind: 'drill', orgName: 'Acme', body: 'Fire drill at 10', drillTag: 'exercise 7!', requiresAck: false });
  assert.equal(custom, 'Active SOS eMNS: [EXERCISE 7] This is a drill from Acme. Fire drill at 10. Reply STOP to opt out.');
  const t = formatMessage({ kind: 'test', orgName: 'Acme', body: '', requiresAck: true });
  assert.ok(t.startsWith('Active SOS eMNS: [TEST]'));
  assert.ok(t.endsWith('Reply STOP to opt out.'));
});

test('a drill cannot lose its tag: junk or empty tag settings fall back to DRILL', () => {
  for (const bad of ['', '   ', '!!!', null, undefined]) {
    assert.ok(formatMessage({ kind: 'drill', orgName: 'A', body: 'x', drillTag: bad }).includes('[DRILL]'), String(bad));
  }
  assert.equal(cleanTag('a'.repeat(40), 'DRILL').length, 16);
});

test('unknown kinds are rejected', () => {
  assert.throws(() => formatMessage({ kind: 'bogus', orgName: 'A', body: 'x' }));
});

test('browser copy produces exactly the same text as the server copy', async () => {
  const web = await import('../src/lib/messageFormat.mjs');
  const bodies = ['', 'Shelter in place', 'Evacuate now!', 'Go to the east lot.  ', 'What?'];
  const orgs = ['Acme Hospital', '', '  Valor Tech  '];
  const tags = [undefined, 'exercise', '!!!', 'Drill 2'];
  let n = 0;
  for (const kind of ['alert', 'drill', 'test']) for (const body of bodies) for (const orgName of orgs) for (const drillTag of tags) for (const requiresAck of [true, false]) {
    if (kind === 'alert' && !body.trim()) continue;
    const args = { kind, orgName, body, requiresAck, drillTag, testTag: drillTag };
    assert.equal(web.formatMessage(args), formatMessage(args));
    n++;
  }
  assert.ok(n > 100);
});
