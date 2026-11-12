const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/lib/eventLabels.mjs');

test('the database word "alert" is shown as Emergency; drill and test keep their names', async () => {
  const { kindLabel } = await load();
  assert.equal(kindLabel('alert'), 'Emergency');
  assert.equal(kindLabel('drill'), 'Drill');
  assert.equal(kindLabel('test'), 'Test');
  assert.equal(kindLabel('exercise'), 'Exercise');
  assert.equal(kindLabel(undefined), 'Event');
  assert.equal(kindLabel(''), 'Event');
});

test('every kind has a colour; an emergency is the red one', async () => {
  const { kindColor } = await load();
  assert.match(kindColor('alert'), /tier-3/);
  assert.ok(kindColor('drill') && kindColor('test') && kindColor('whatever'));
});

test('an event is live while sending or within three hours, then not', async () => {
  const { isLiveEvent } = await load();
  const now = Date.parse('2026-11-11T20:00:00Z');
  assert.equal(isLiveEvent({ createdAt: '2026-11-11T19:00:00Z', status: 'complete' }, now), true);
  assert.equal(isLiveEvent({ createdAt: '2026-11-11T16:59:00Z', status: 'complete' }, now), false);
  assert.equal(isLiveEvent({ createdAt: '2026-11-10T10:00:00Z', status: 'sending' }, now), true);
  assert.equal(isLiveEvent({ createdAt: '2026-11-10T10:00:00Z', status: 'complete', pending: 3 }, now), true);
  assert.equal(isLiveEvent({ createdAt: 'not a date', status: 'complete' }, now), false);
});

test('roll-call summary keeps the counts a row needs and returns null for nothing', async () => {
  const { rollCallSummary } = await load();
  assert.deepEqual(rollCallSummary({ targeted: 50, safe: 35, sos: 9, replied: 2, responded: 46, unaccounted: 4, extra: 1 }),
    { targeted: 50, safe: 35, sos: 9, replied: 2, responded: 46, unaccounted: 4 });
  assert.equal(rollCallSummary(null), null);
  assert.equal(rollCallSummary('x'), null);
  assert.deepEqual(rollCallSummary({ safe: 'abc' }).safe, 0);
});

test('the latest event per scenario wins, and events with no scenario are ignored', async () => {
  const { latestEventPerScenario } = await load();
  const out = latestEventPerScenario([
    { id: 'a', scenario_id: 's1', created_at: '2026-11-01T10:00:00Z' },
    { id: 'b', scenario_id: 's1', created_at: '2026-11-05T10:00:00Z' },
    { id: 'c', scenario_id: 's2', created_at: '2026-11-02T10:00:00Z' },
    { id: 'd', scenario_id: null, created_at: '2026-11-09T10:00:00Z' },
  ]);
  assert.equal(out.s1.id, 'b');
  assert.equal(out.s2.id, 'c');
  assert.equal(Object.keys(out).length, 2);
  assert.deepEqual(latestEventPerScenario(null), {});
});
