'use strict';
// Small JSON state file for the agent: server address, device token, alerts not yet answered, reports not yet delivered.
// The token is encrypted by the caller-supplied functions (Electron safeStorage = Windows DPAPI, bound to the signed-in user).
// Writes go to a temp file and are renamed into place, so a power cut never leaves half a file.
const nodeFs = require('fs');
const path = require('path');

const EMPTY = () => ({ serverUrl: null, token: null, deviceName: null, person: null, alerts: {}, pending: [] });

function createStore({ file, fs = nodeFs, encrypt = (s) => s, decrypt = (s) => s }) {
  let state = null;

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = { ...EMPTY(), ...raw };
      s.token = raw.token ? (() => { try { return decrypt(raw.token); } catch { return null; } })() : null; // cannot decrypt = not paired
      if (typeof s.alerts !== 'object' || !s.alerts) s.alerts = {};
      if (!Array.isArray(s.pending)) s.pending = [];
      return s;
    } catch { return EMPTY(); }
  }
  function save() {
    const out = { ...state, token: state.token ? encrypt(state.token) : null };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return {
    read() { if (!state) state = load(); return state; },
    update(fn) { if (!state) state = load(); fn(state); save(); return state; },
  };
}

module.exports = { createStore };
