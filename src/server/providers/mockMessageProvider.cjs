// In-memory MessageProvider for dev/test/load tests. Records every send; can simulate latency and failures.
const { ProviderError } = require('./types.cjs');

function seededRandom(seed) { // mulberry32, deterministic
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param {{failRate?:number, failCode?:number, latencyMs?:number, failNumbers?:Record<string,number>, seed?:number}} [opts]
 *   failNumbers maps a destination number to the error code it should always fail with (e.g. {'+15551230000':21610}).
 */
function createMockMessageProvider(opts = {}) {
  const { failRate = 0, failCode = 30008, latencyMs = 0, failNumbers = {}, seed = 1 } = opts;
  const rand = seededRandom(seed);
  const sent = [];
  const failed = [];
  let n = 0;
  return {
    name: 'mock',
    sent, failed,
    async send(req) {
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (failNumbers[req.to] !== undefined) { failed.push(req); throw new ProviderError(`mock: forced failure for ${req.to}`, failNumbers[req.to]); }
      if (failRate > 0 && rand() < failRate) { failed.push(req); throw new ProviderError('mock: simulated failure', failCode); }
      const sid = `MOCK${String(++n).padStart(8, '0')}`;
      sent.push({ ...req, sid });
      return { sid, status: 'queued' };
    },
  };
}
module.exports = { createMockMessageProvider };
