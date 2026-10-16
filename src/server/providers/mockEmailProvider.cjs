// In-memory email provider for dev/test. Records every send; can force failures for chosen addresses.
const { ProviderError } = require('./types.cjs');

/**
 * @param {{failAddresses?: Record<string,string>, failRate?: number, failCode?: string, latencyMs?: number}} [opts]
 *   failAddresses maps a destination address to the error code it should always fail with (e.g. {'bad@example.com':'invalid_email'}).
 */
function createMockEmailProvider(opts = {}) {
  const { failAddresses = {}, failRate = 0, failCode = '503', latencyMs = 0 } = opts;
  const sent = [];
  const failed = [];
  let n = 0;
  let k = 0; // deterministic "random": every Nth send fails when failRate is set
  return {
    name: 'mock',
    sent, failed,
    async send(req) {
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      if (failAddresses[req.to] !== undefined) { failed.push(req); throw new ProviderError(`mock: forced failure for ${req.to}`, failAddresses[req.to]); }
      k++;
      if (failRate > 0 && k % Math.round(1 / failRate) === 0) { failed.push(req); throw new ProviderError('mock: simulated failure', failCode); }
      const sid = `MOCKMAIL${String(++n).padStart(8, '0')}`;
      sent.push({ ...req, sid });
      return { sid, status: 'queued' };
    },
  };
}
module.exports = { createMockEmailProvider };
