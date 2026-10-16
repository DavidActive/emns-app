// In-memory voice provider for dev/test. Records every call; can force failures for chosen numbers.
// It places no real calls and produces no status callbacks (tests simulate those through the database functions).
const { ProviderError } = require('./types.cjs');

function createMockVoiceProvider(opts = {}) {
  const { failNumbers = {}, failRate = 0, failCode = '503', latencyMs = 0 } = opts;
  const sent = [];
  const failed = [];
  let n = 0;
  let k = 0;
  return {
    name: 'mock',
    sent, failed,
    async send(req) {
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (failNumbers[req.to] !== undefined) { failed.push(req); throw new ProviderError(`mock: forced failure for ${req.to}`, failNumbers[req.to]); }
      k++;
      if (failRate > 0 && k % Math.round(1 / failRate) === 0) { failed.push(req); throw new ProviderError('mock: simulated failure', failCode); }
      const sid = `MOCKCALL${String(++n).padStart(8, '0')}`;
      sent.push({ ...req, sid });
      return { sid, status: 'queued' };
    },
  };
}
module.exports = { createMockVoiceProvider };
