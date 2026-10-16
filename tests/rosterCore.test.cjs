const test = require('node:test');
const assert = require('node:assert');

let core;
test.before(async () => { core = await import('../src/lib/rosterCore.mjs'); });

test('normalizePhone handles common US formats and rejects junk', () => {
  assert.equal(core.normalizePhone('(555) 555-0102'), '+15555550102');
  assert.equal(core.normalizePhone('555.555.0102'), '+15555550102');
  assert.equal(core.normalizePhone('1-555-555-0102'), '+15555550102');
  assert.equal(core.normalizePhone('+44 20 7946 0958'), '+442079460958');
  assert.equal(core.normalizePhone('555-0102 ext 12'), null);
  assert.equal(core.normalizePhone('555'), null);
  assert.equal(core.normalizePhone(''), null);
  assert.equal(core.normalizePhone(null), null);
});

test('parseCsv handles quotes, embedded commas, CRLF, BOM and blank lines', () => {
  const t = '﻿name,notes\r\n"Doe, Jane","said ""hi"""\r\n\r\nBob,plain\r\n';
  assert.deepEqual(core.parseCsv(t), [['name', 'notes'], ['Doe, Jane', 'said "hi"'], ['Bob', 'plain']]);
});

test('mapHeaders recognizes aliases and reports unmapped columns', () => {
  const { columns, unmapped } = core.mapHeaders(['Employee ID', 'Name', 'Cell Phone', 'E-mail', 'Team', 'Favorite Color']);
  assert.deepEqual(columns, { employee_id: 0, full_name: 1, mobile_phone: 2, email: 3, groups: 4 });
  assert.deepEqual(unmapped, ['Favorite Color']);
});

test('buildImportRows combines first/last name, normalizes phones, splits groups', () => {
  const csv = 'First Name,Last Name,Mobile,Groups\nJane,Doe,(555) 555-0101,Alpha|Bravo\nBad,Phone,12,\n';
  const r = core.buildImportRows(csv);
  assert.equal(r.rows.length, 2);
  assert.deepEqual(r.rows[0], { employee_id: '', full_name: 'Jane Doe', mobile_phone: '+15555550101', email: '', groups: 'Alpha;Bravo' });
  assert.equal(r.rows[1].mobile_phone, '12'); // kept raw so the server flags it invalid
});

test('buildImportRows reports missing required columns', () => {
  const r = core.buildImportRows('employee_id,email\nE1,a@b.co\n');
  assert.equal(r.rows.length, 0);
  assert.equal(r.missingRequired.length, 2);
});

test('template parses cleanly', () => {
  const r = core.buildImportRows(core.CSV_TEMPLATE);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].mobile_phone, '+15555550102');
  assert.equal(r.rows[0].groups, 'Building A;Night Shift');
});
