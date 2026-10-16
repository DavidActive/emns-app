// Broadcast worker core. Pure orchestration: claims batches from the database queue, sends through the
// MessageProvider, and records each result. Safe to run in many copies at once (the database uses
// FOR UPDATE SKIP LOCKED) and safe to kill at any moment (unfinished claims expire and are retried).
//
// Delivery guarantee: every delivery ends in exactly one final state in the database. If a worker dies
// AFTER the carrier accepted a message but BEFORE the result was recorded, that one message is sent again
// when its claim expires. That is a deliberate choice for emergency notifications: a rare duplicate is
// better than a missed alert. At most one batch's worth of in-flight messages can be affected per crash.

// Provider error codes that will never succeed on retry (bad number, opted out, not a mobile, etc.).
const PERMANENT_CODES = new Set(['21211', '21214', '21217', '21408', '21610', '21612', '21614', '21617', '30003', '30005', '30006', '30007']);
const OPT_OUT_CODE = '21610';

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(err) {
  const code = err && err.code !== undefined && err.code !== null ? String(err.code) : '';
  if (PERMANENT_CODES.has(code)) return { outcome: 'failed', code, optOut: code === OPT_OUT_CODE };
  return { outcome: 'retry', code, optOut: false };
}

/**
 * @param {object} o
 * @param {object} o.db           supabase-js style client (uses db.rpc and db.from('people').update)
 * @param {object} o.provider     MessageProvider
 * @param {string} o.workerId     unique per invocation
 * @param {number} [o.batchSize=50]
 * @param {number} [o.concurrency=10]       parallel sends inside a batch
 * @param {number} [o.ratePerSec=0]         max sends started per second (0 = unlimited)
 * @param {number} [o.leaseSeconds=120]
 * @param {number} [o.maxRuntimeMs=0]       stop claiming new batches after this long (0 = no limit)
 * @param {string} [o.messagingServiceSid]
 * @param {string} [o.statusCallback]
 * @param {() => number} [o.now]
 * @param {(ms:number)=>Promise<void>} [o.sleep]
 * @param {() => boolean} [o.shouldCrash]   test hook: simulates the process dying (claims left unrecorded)
 */
async function runWorker(o) {
  const {
    db, provider, workerId, batchSize = 50, concurrency = 10, ratePerSec = 0, leaseSeconds = 120,
    maxRuntimeMs = 0, messagingServiceSid, statusCallback, now = Date.now, sleep = defaultSleep, shouldCrash = () => false,
  } = o;
  const stats = { claimed: 0, sent: 0, failed: 0, retried: 0, optedOut: 0, batches: 0, timedOut: false, crashed: false };
  const started = now();
  let nextSlot = started; // rate limiter: earliest time the next send may start
  const spacing = ratePerSec > 0 ? 1000 / ratePerSec : 0;

  async function takeSlot() {
    if (!spacing) return;
    const t = now();
    const slot = Math.max(nextSlot, t);
    nextSlot = slot + spacing;
    if (slot > t) await sleep(slot - t);
  }

  async function sendOne(row) {
    if (shouldCrash()) { stats.crashed = true; return; }
    await takeSlot();
    if (shouldCrash()) { stats.crashed = true; return; }
    let result;
    try {
      const res = await provider.send({ channel: 'sms', to: row.to_number, body: row.body, messagingServiceSid, statusCallback });
      result = { p_outcome: 'sent', p_sid: res.sid };
    } catch (err) {
      const c = classify(err);
      result = { p_outcome: c.outcome, p_error_code: c.code || null, p_error_message: String(err && err.message || err).slice(0, 500) };
      if (c.optOut) {
        stats.optedOut++;
        await db.from('people').update({ sms_opted_out: true, sms_opted_out_at: new Date(now()).toISOString(), consent_status: 'withdrawn' }).eq('id', row.person_id);
      }
    }
    if (shouldCrash()) { stats.crashed = true; return; } // died after the carrier call, before recording
    const { data, error } = await db.rpc('record_delivery_result', { p_delivery: row.delivery_id, p_worker: workerId, ...result });
    if (error) throw new Error(`record_delivery_result failed: ${error.message}`);
    if (data === false) return; // another worker owns this row now; theirs is the record
    if (result.p_outcome === 'sent') stats.sent++; else if (result.p_outcome === 'failed') stats.failed++; else stats.retried++;
  }

  for (;;) {
    if (stats.crashed) break;
    if (maxRuntimeMs && now() - started >= maxRuntimeMs) { stats.timedOut = true; break; }
    const { data: rows, error } = await db.rpc('claim_deliveries', { p_worker: workerId, p_limit: batchSize, p_lease_seconds: leaseSeconds });
    if (error) throw new Error(`claim_deliveries failed: ${error.message}`);
    if (!rows || rows.length === 0) break;
    stats.batches++;
    stats.claimed += rows.length;
    let i = 0;
    const lanes = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
      while (i < rows.length && !stats.crashed) { const row = rows[i++]; await sendOne(row); }
    });
    await Promise.all(lanes);
  }
  return stats;
}

module.exports = { runWorker, classify, PERMANENT_CODES };
