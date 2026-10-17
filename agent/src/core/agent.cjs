'use strict';
// The agent's brain, with no screen and no Electron in it (so it can be tested on any machine).
//   pairing   enroll() turns the 8-letter code into a device token
//   polling   asks the server for alerts over one long-lived HTTPS request, again and again
//   alerts    every alert is written to disk BEFORE it is shown, so a crash or restart cannot lose one
//   answers   "shown", "I'm safe", "I need help" are queued on disk and retried until the server has them
//   revoked   when the server says this computer was removed, the token is forgotten and the app asks to be paired again
const { EventEmitter } = require('events');
const { createClient, normalizeServerUrl, AgentHttpError, RevokedError } = require('./protocol.cjs');

const MAX_ALERT_AGE_MS = 6 * 3600 * 1000;
const KINDS = ['alert', 'drill', 'test'];
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Agent extends EventEmitter {
  constructor({ store, fetchImpl, version = '0.0.0', platform = 'windows', now = Date.now, sleep = defaultSleep, random = Math.random, minPollMs = 1000, log = () => {} }) {
    super();
    Object.assign(this, { store, fetchImpl, version, platform, now, sleep, random, minPollMs, log });
    this.running = false;
    this.state = 'unpaired';
    this._flushing = null;
  }

  get paired() { return !!this.store.read().token; }
  get serverUrl() { return this.store.read().serverUrl; }
  get person() { return this.store.read().person; }
  get activeAlerts() { return Object.values(this.store.read().alerts); }

  _client(serverUrl = this.serverUrl) { return createClient({ serverUrl, fetchImpl: this.fetchImpl }); }
  _setState(s) { if (this.state !== s) { this.state = s; this.emit('state', s); } }

  async enroll({ serverUrl, code, deviceName }) {
    const origin = normalizeServerUrl(serverUrl);
    if (!origin) throw new AgentHttpError(0, 'The server address must start with https://', 'bad_server');
    const res = await this._client(origin).enroll({ code, deviceName, platform: this.platform, version: this.version });
    this.store.update((s) => { Object.assign(s, { serverUrl: origin, token: res.device_token, deviceName, person: { name: res.person_name, organization: res.organization }, alerts: {}, pending: [] }); });
    this._setState('online');
    this.emit('paired', this.person);
    return this.person;
  }

  // Show again anything that was handed over but not answered before the last shutdown.
  resume() {
    const cutoff = this.now() - MAX_ALERT_AGE_MS;
    this.store.update((s) => { for (const [id, a] of Object.entries(s.alerts)) if ((a.received_at || 0) < cutoff) delete s.alerts[id]; });
    for (const a of this.activeAlerts) this.emit('alert', a);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loop = this._run().catch((e) => { this.log('agent loop stopped', e); this.running = false; });
  }
  async stop() { this.running = false; if (this._loop) await this._loop; }

  async _run() {
    let failures = 0;
    while (this.running) {
      const st = this.store.read();
      if (!st.token) { this._setState('unpaired'); await this.sleep(2000); continue; }
      const began = this.now();
      try {
        const r = await this._client().poll(st.token, { version: this.version });
        failures = 0;
        this._setState('online');
        for (const a of r.alerts || []) this._accept(a);
        for (const id of r.dismiss || []) this._close(id, 'answered elsewhere');
        await this._flush();
        // A server that answers instantly with nothing must not be hammered.
        if (!(r.alerts && r.alerts.length) && this.now() - began < this.minPollMs) await this.sleep(this.minPollMs);
      } catch (e) {
        if (e instanceof RevokedError) { this._forget(); continue; }
        failures++;
        this._setState('offline');
        const wait = Math.min(30000, 2000 * 2 ** Math.min(failures - 1, 4)) * (0.8 + this.random() * 0.4);
        this.log('poll failed', e && e.message);
        await this.sleep(wait);
      }
    }
  }

  _forget() {
    this.store.update((s) => { s.token = null; s.alerts = {}; s.pending = []; s.person = null; });
    this._setState('unpaired');
    this.emit('revoked');
  }

  _accept(a) {
    if (!a || typeof a.delivery_id !== 'string' || !KINDS.includes(a.kind) || typeof a.body !== 'string') return;
    if (this.store.read().alerts[a.delivery_id]) return;
    const alert = {
      delivery_id: a.delivery_id, event_id: a.event_id, kind: a.kind, body: a.body.slice(0, 2000), requires_ack: a.requires_ack !== false,
      organization: typeof a.organization === 'string' ? a.organization.slice(0, 200) : '', created_at: a.created_at, received_at: this.now(), shown_reported: false,
    };
    this.store.update((s) => { s.alerts[alert.delivery_id] = alert; }); // on disk first, then on screen
    this.emit('alert', alert);
  }

  // The server says this alert is over (answered on another computer, or the event was cancelled): close it on screen.
  _close(id) {
    if (!this.store.read().alerts[id]) return;
    this.store.update((s) => { delete s.alerts[id]; });
    this.emit('closed', id);
  }

  _queue(job) { this.store.update((s) => { s.pending.push(job); }); }

  // Send queued reports in order. Stops at the first network problem (they stay queued); drops reports the server rejects for good.
  // Callers wait for a drain already in progress and then run their own, so a report queued at the last moment is never left behind.
  async _flush() {
    while (this._flushing) await this._flushing;
    this._flushing = this._drain().finally(() => { this._flushing = null; });
    return this._flushing;
  }

  async _drain() {
    for (;;) {
      const st = this.store.read();
      if (!st.token || st.pending.length === 0) return;
      const job = st.pending[0];
      try {
        await this._client().report(st.token, job);
      } catch (e) {
        if (e instanceof RevokedError) { this._forget(); return; }
        const permanent = e instanceof AgentHttpError && e.status >= 400 && e.status < 500 && e.status !== 429;
        if (!permanent) return; // network or server trouble: try again on the next poll
        // the server will never accept this one: drop it
      }
      this.store.update((s) => { s.pending.shift(); });
    }
  }

  // The alert is on the screen.
  async shown(id) {
    const a = this.store.read().alerts[id];
    if (!a || a.shown_reported) return;
    this.store.update((s) => { s.alerts[id].shown_reported = true; s.pending.push({ deliveryId: id, action: 'shown' }); });
    await this._flush();
  }

  // "I'm safe" / "I need help". Returns { sent } so the screen can say honestly whether the server has it yet.
  async ack(id, response) {
    if (!['SAFE', 'SOS'].includes(response)) throw new Error('response must be SAFE or SOS');
    const a = this.store.read().alerts[id];
    if (!a) return { sent: true };
    this.store.update((s) => { delete s.alerts[id]; s.pending.push({ deliveryId: id, action: 'ack', response }); });
    await this._flush();
    return { sent: !this.store.read().pending.some((j) => j.deliveryId === id && j.action === 'ack') };
  }

  // Close an alert that needs no answer.
  async dismiss(id) {
    const a = this.store.read().alerts[id];
    if (!a) return;
    this.store.update((s) => { delete s.alerts[id]; s.pending.push({ deliveryId: id, action: 'dismiss' }); });
    await this._flush();
  }
}

module.exports = { Agent, MAX_ALERT_AGE_MS };
