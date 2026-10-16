const test = require('node:test');
const assert = require('node:assert');

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += ch;
  }
  return rows;
}

function sample() {
  const people = [];
  const st = ['safe', 'safe', 'replied', 'sos', 'unaccounted', 'unaccounted', 'not_contacted'];
  st.forEach((s, i) => people.push({ person_id: 'p' + i, full_name: i === 4 ? '=HYPERLINK("http://x")' : `Person ${i}`, mobile_phone: '+1555000' + i, delivery_status: s === 'not_contacted' ? 'skipped' : 'delivered', error_code: null, status: s, last_text: i === 2 ? '+1 call me, "ok"\nthanks' : null, sent_at: '2026-10-16T12:00:02Z', delivered_at: '2026-10-16T12:00:09Z', first_reply_at: s === 'safe' || s === 'sos' || s === 'replied' ? '2026-10-16T12:01:00Z' : null, seconds_to_deliver: 9, seconds_to_first_reply: 60 }));
  return {
    event: { id: 'e', kind: 'drill', body: 'Active SOS eMNS: [DRILL] x', created_at: '2026-10-16T12:00:00Z', sent_by: 'A admin', groups: ['All'] },
    counts: { targeted: 6, responded: 4, safe: 2, replied: 1, sos: 1, unaccounted: 2, undeliverable: 0, pending: 0, not_contacted: 1, delivered: 6 },
    generated_at: '2026-10-16T12:30:00Z',
    timeline: { event_created_at: '2026-10-16T12:00:00Z', first_sent_at: '2026-10-16T12:00:02Z', last_sent_at: '2026-10-16T12:00:02Z', first_delivered_at: '2026-10-16T12:00:09Z', last_delivered_at: '2026-10-16T12:00:09Z', first_reply_at: '2026-10-16T12:01:00Z', last_reply_at: '2026-10-16T12:01:00Z', first_sos_at: '2026-10-16T12:01:00Z' },
    delivery: { buckets: { lt_1m: 6, m1_2: 0, m2_5: 0, m5_10: 0, gt_10m: 0, no_receipt: 0, failed: 0, pending: 0 }, seconds: { p50: 9, p90: 9, max: 9 } },
    acknowledgement: { buckets: { lt_1m: 0, m1_2: 4, m2_5: 0, m5_10: 0, gt_10m: 0 }, seconds: { p50: 60, p90: 60, max: 60 } },
    channels: [{ channel: 'sms', status: 'delivered', count: 6 }, { channel: 'sms', status: 'skipped', count: 1 }],
    people,
  };
}

test('duration formatting', async () => {
  const { formatDuration } = await import('../src/lib/afterActionReport.mjs');
  assert.strictEqual(formatDuration(0), '0s'); assert.strictEqual(formatDuration(59.6), '1m 00s');
  assert.strictEqual(formatDuration(294), '4m 54s'); assert.strictEqual(formatDuration(null), '');
});

test('CSV people tally by status equals the headline counts', async () => {
  const { buildCsv } = await import('../src/lib/afterActionReport.mjs');
  const r = sample(); const rows = parseCsv(buildCsv(r, 'UTC'));
  const start = rows.findIndex((x) => x[0] === 'Name' && x[1] === 'Phone' && x[2] === 'Status');
  const people = rows.slice(start + 1).filter((x) => x.length > 1);
  assert.strictEqual(people.length, r.people.length);
  const n = (s) => people.filter((x) => x[2] === s).length;
  assert.strictEqual(n('SOS'), r.counts.sos); assert.strictEqual(n('Safe'), r.counts.safe);
  assert.strictEqual(n('Replied (text)'), r.counts.replied); assert.strictEqual(n('Unaccounted for'), r.counts.unaccounted);
  assert.strictEqual(n('Not texted'), r.counts.not_contacted);
});

test('CSV summary, distributions and unaccounted list match the report', async () => {
  const { buildCsv } = await import('../src/lib/afterActionReport.mjs');
  const r = sample(); const rows = parseCsv(buildCsv(r, 'UTC'));
  const find = (label) => rows.find((x) => x[0] === label);
  assert.strictEqual(find('Texted')[1], '6'); assert.strictEqual(find('Accounted for')[1], '4'); assert.strictEqual(find('Unaccounted for')[1], '2');
  assert.strictEqual(find('Under 1 minute')[1], '6');
  assert.strictEqual(rows.find((x) => x[0].startsWith('Unaccounted for ('))[0], 'Unaccounted for (2)');
  assert.strictEqual(find('First reply')[2], '60'); assert.strictEqual(find('Send confirmed')[2], '0');
});

test('CSV cells cannot run as spreadsheet formulas and keep quotes, commas and newlines intact', async () => {
  const { buildCsv, csvCell } = await import('../src/lib/afterActionReport.mjs');
  assert.strictEqual(csvCell('=1+1'), `"'=1+1"`); assert.strictEqual(csvCell('+15551234567'), `"'+15551234567"`);
  assert.strictEqual(csvCell('a"b'), '"a""b"'); assert.strictEqual(csvCell(null), '""');
  const rows = parseCsv(buildCsv(sample(), 'UTC'));
  assert.ok(!rows.some((x) => x.some((c) => c.startsWith('=HYPERLINK'))));
  assert.ok(rows.some((x) => x[0] === `'=HYPERLINK("http://x")`));
  assert.ok(rows.some((x) => x[10] === `'+1 call me, "ok"\nthanks`));
});
