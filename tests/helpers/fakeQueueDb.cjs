// In-memory stand-in for the broadcast queue functions, mirroring the SQL semantics proven against Postgres
// in supabase/tests/broadcast_queue.sql: claim = queued rows due now plus 'sending' rows whose lease expired;
// record_delivery_result only accepts the worker that holds the claim.
function createFakeQueueDb({ count, body = 'Test', clock = { t: 0 }, optedOutEvery = 0 }) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    const skipped = optedOutEvery > 0 && i % optedOutEvery === 0;
    rows.push({ id: `d${i}`, person_id: `p${i}`, to: `+1555${String(i).padStart(7, '0')}`, status: skipped ? 'skipped' : 'queued', attempt: 0, locked_by: null, locked_at: 0, next_attempt_at: 0, sid: null, error_code: null });
  }
  const peopleUpdates = [];
  const finalWrites = new Map(); // delivery id -> number of times a final state was recorded
  const db = {
    rows, peopleUpdates, finalWrites, clock,
    async rpc(name, args) {
      if (name === 'claim_deliveries') {
        const due = rows.filter((r) => (r.status === 'queued' && r.next_attempt_at <= clock.t) || (r.status === 'sending' && r.locked_at < clock.t - args.p_lease_seconds * 1000)).slice(0, args.p_limit);
        due.forEach((r) => { r.status = 'sending'; r.locked_by = args.p_worker; r.locked_at = clock.t; r.attempt++; });
        return { data: due.map((r) => ({ delivery_id: r.id, event_id: 'e1', organization_id: 'o1', person_id: r.person_id, to_number: r.to, body, attempt: r.attempt })), error: null };
      }
      if (name === 'record_delivery_result') {
        const r = rows.find((x) => x.id === args.p_delivery);
        if (!r || r.locked_by !== args.p_worker || r.status !== 'sending') return { data: false, error: null };
        if (args.p_outcome === 'sent') { r.status = 'sent'; r.sid = args.p_sid; }
        else if (args.p_outcome === 'retry' && r.attempt < 3) { r.status = 'queued'; r.next_attempt_at = clock.t + 30000 * r.attempt; r.error_code = args.p_error_code; }
        else { r.status = 'failed'; r.error_code = args.p_error_code; }
        r.locked_by = null;
        if (r.status === 'sent' || r.status === 'failed') finalWrites.set(r.id, (finalWrites.get(r.id) || 0) + 1);
        return { data: true, error: null };
      }
      return { data: null, error: { message: `unknown rpc ${name}` } };
    },
    from(table) {
      return { update(payload) { return { eq(col, val) { peopleUpdates.push({ table, payload, col, val }); return Promise.resolve({ data: null, error: null }); } }; } };
    },
    count(status) { return rows.filter((r) => r.status === status).length; },
  };
  return db;
}
module.exports = { createFakeQueueDb };
