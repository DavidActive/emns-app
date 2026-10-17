'use strict';
// How the desktop agent talks to the eMNS server. Plain HTTPS POSTs, one outbound address, nothing else.
// The agent passes in its own fetch (Electron's net.fetch uses the Windows proxy settings and certificate store); tests pass a fake.

class AgentHttpError extends Error {
  constructor(status, message, code) { super(message); this.name = 'AgentHttpError'; this.status = status; this.code = code; }
}
// The server no longer knows this computer (removed by the employee or an administrator): forget the token and pair again.
class RevokedError extends AgentHttpError {
  constructor() { super(401, 'This computer was removed. Pair it again from the My contact details page.', 'revoked'); this.name = 'RevokedError'; }
}

// Only the server's origin is kept. HTTPS is required, except for localhost while testing.
function normalizeServerUrl(input) {
  let u;
  try { u = new URL(String(input == null ? '' : input).trim()); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

function createClient({ serverUrl, fetchImpl = globalThis.fetch, timeoutMs = 30000 }) {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin) throw new Error('The server address must be an https:// address.');
  const base = `${origin}/.netlify/functions`;

  async function call(name, body, token, timeout = timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      let res;
      try {
        res = await fetchImpl(`${base}/${name}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body || {}),
          signal: ctl.signal,
        });
      } catch { throw new AgentHttpError(0, 'Cannot reach the server.', 'network'); }
      let json = {};
      try { json = await res.json(); } catch { /* an error page, not JSON */ }
      if (res.status === 401 && token) throw new RevokedError();
      if (!res.ok) throw new AgentHttpError(res.status, (json && json.error) || `Request failed (${res.status})`, json && json.error);
      return json;
    } finally { clearTimeout(timer); }
  }

  return {
    origin,
    enroll: ({ code, deviceName, platform, version }) => call('agent-enroll', { code, device_name: deviceName, platform, version }, null, 20000),
    poll: (token, { version } = {}) => call('agent-poll', { version }, token, timeoutMs),
    report: (token, { deliveryId, action, response }) => call('agent-report', { delivery_id: deliveryId, action, response }, token, 15000),
  };
}

module.exports = { createClient, normalizeServerUrl, AgentHttpError, RevokedError };
