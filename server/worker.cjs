// Scheduler for the container profile: does what Netlify's once-a-minute schedule does.
// Every EMNS_SWEEP_SECONDS (default 15) it runs the sweeper, which releases timed fallbacks and wakes the send worker when work is due.
//   node server/worker.cjs
const sweeper = require('../netlify/functions/send-sweeper.js');

async function tick(log = console) {
  try { const r = await sweeper.handler({}); if (r && r.statusCode >= 500) log.error('sweeper error', r.body); return r; }
  catch (e) { log.error('sweeper failed', e && e.message); return null; }
}
module.exports = { tick };
if (require.main === module) {
  const every = Math.max(5, Number(process.env.EMNS_SWEEP_SECONDS) || 15) * 1000;
  console.log(`eMNS scheduler running every ${every / 1000}s`);
  tick();
  setInterval(tick, every);
}
