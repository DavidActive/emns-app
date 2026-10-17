'use strict';
// Active SOS eMNS desktop agent: tray app. Pairs with the server, polls for alerts, and shows an always-on-top alert window.
// This file is the thin Electron shell. The logic lives in src/core (tested without Electron).
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, net, safeStorage, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('./core/agent.cjs');
const { createStore } = require('./core/store.cjs');
const { normalizeServerUrl } = require('./core/protocol.cjs');

const VERSION = app.getVersion();

// IT settings, in order of priority: %ProgramData%\ActiveSOS\eMNS\config.json, then config.json next to the app, then EMNS_SERVER_URL.
//   { "serverUrl": "https://emns.example.org", "takeover": "window" | "fullscreen", "allowQuit": false, "sound": true }
function readConfig() {
  const candidates = [
    path.join(process.env.ProgramData || 'C:\\ProgramData', 'ActiveSOS', 'eMNS', 'config.json'),
    path.join(process.resourcesPath || __dirname, 'config.json'),
  ];
  for (const f of candidates) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { /* not there */ } }
  return {};
}
const config = readConfig();
const takeover = config.takeover === 'fullscreen' ? 'fullscreen' : 'window';

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let tray = null, alertWin = null, enrollWin = null, agent = null;
const queue = []; // alerts on screen, oldest first

// ---------- tray icon drawn in code (no image files to ship) ----------
function icon(rgb) {
  const size = 32, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), o = (y * size + x) * 4;
    const inside = d <= 14;
    buf[o] = inside ? rgb[2] : 0; buf[o + 1] = inside ? rgb[1] : 0; buf[o + 2] = inside ? rgb[0] : 0; buf[o + 3] = inside ? 255 : 0; // BGRA
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}
const ICONS = { online: [30, 140, 70], offline: [220, 150, 20], unpaired: [120, 120, 120], revoked: [120, 120, 120] };
const STATUS_TEXT = { online: 'Connected', offline: 'Cannot reach the server (retrying)', unpaired: 'Not paired yet', revoked: 'Not paired yet' };

function refreshTray() {
  if (!tray) return;
  const st = agent.state;
  tray.setImage(icon(ICONS[st] || ICONS.unpaired));
  tray.setToolTip(`Active SOS eMNS: ${STATUS_TEXT[st] || st}`);
  const items = [
    { label: `Active SOS eMNS ${VERSION}`, enabled: false },
    { label: STATUS_TEXT[st] || st, enabled: false },
    agent.person ? { label: `${agent.person.name} (${agent.person.organization || ''})`, enabled: false } : { label: 'Pair this computer…', click: showEnroll },
    { type: 'separator' },
    { label: 'Show a test alert on this screen', click: () => showAlerts([{ delivery_id: `local-${Date.now()}`, kind: 'test', body: 'This is a local test of the desktop alert on this computer. No one else received it.', requires_ack: true, organization: 'Local test', local: true }]) },
  ];
  if (agent.paired) items.push({ label: 'Pair again…', click: showEnroll });
  if (config.allowQuit === true) items.push({ type: 'separator' }, { label: 'Quit', click: () => { app.exit(0); } });
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- windows ----------
const webPrefs = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false };

function showEnroll() {
  if (enrollWin && !enrollWin.isDestroyed()) { enrollWin.show(); enrollWin.focus(); return; }
  enrollWin = new BrowserWindow({ width: 460, height: 470, resizable: false, minimizable: false, maximizable: false, title: 'Pair this computer', autoHideMenuBar: true, webPreferences: webPrefs });
  enrollWin.setMenu(null);
  enrollWin.loadFile(path.join(__dirname, 'ui', 'enroll.html'), { query: { server: normalizeServerUrl(config.serverUrl || process.env.EMNS_SERVER_URL || '') || agent.serverUrl || '', locked: config.serverUrl ? '1' : '' } });
}

function ensureAlertWindow() {
  if (alertWin && !alertWin.isDestroyed()) return alertWin;
  const d = screen.getPrimaryDisplay();
  const full = takeover === 'fullscreen';
  alertWin = new BrowserWindow({
    width: full ? d.bounds.width : 720, height: full ? d.bounds.height : 560, x: full ? d.bounds.x : undefined, y: full ? d.bounds.y : undefined,
    frame: !full, fullscreen: full, alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false, closable: true, skipTaskbar: false,
    title: 'Active SOS eMNS alert', autoHideMenuBar: true, show: false, backgroundColor: '#ffffff', webPreferences: webPrefs,
  });
  alertWin.setMenu(null);
  alertWin.setAlwaysOnTop(true, 'screen-saver');
  alertWin.on('close', (e) => { if (queue.some((a) => a.requires_ack)) e.preventDefault(); }); // cannot be closed while an answer is owed
  alertWin.on('closed', () => { alertWin = null; });
  alertWin.loadFile(path.join(__dirname, 'ui', 'alert.html'));
  return alertWin;
}

function pushToAlertWindow() {
  const w = ensureAlertWindow();
  const send = () => w.webContents.send('alerts', { alerts: queue, sound: config.sound !== false });
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send); else send();
}

function showAlerts(list) {
  for (const a of list) if (!queue.some((q) => q.delivery_id === a.delivery_id)) queue.push(a);
  if (queue.length === 0) return;
  pushToAlertWindow();
  const w = ensureAlertWindow();
  const reveal = () => { w.show(); w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); w.focus(); w.flashFrame(true); };
  if (w.webContents.isLoading()) w.webContents.once('did-finish-load', reveal); else reveal();
}

function closeAlert(id) {
  const i = queue.findIndex((a) => a.delivery_id === id);
  if (i >= 0) queue.splice(i, 1);
  if (queue.length === 0) { if (alertWin && !alertWin.isDestroyed()) { alertWin.flashFrame(false); alertWin.hide(); } }
  else pushToAlertWindow();
}

// ---------- start ----------
app.whenReady().then(() => {
  const file = path.join(app.getPath('userData'), 'agent-state.json');
  const store = createStore({
    file,
    encrypt: (s) => (safeStorage.isEncryptionAvailable() ? `dpapi:${safeStorage.encryptString(s).toString('base64')}` : `plain:${s}`),
    decrypt: (s) => (s.startsWith('dpapi:') ? safeStorage.decryptString(Buffer.from(s.slice(6), 'base64')) : s.replace(/^plain:/, '')),
  });
  agent = new Agent({ store, fetchImpl: (url, opts) => net.fetch(url, opts), version: VERSION, platform: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux', log: (...a) => console.error(...a) });

  tray = new Tray(icon(ICONS.unpaired));
  agent.on('state', refreshTray);
  agent.on('paired', () => { refreshTray(); if (enrollWin && !enrollWin.isDestroyed()) enrollWin.close(); });
  agent.on('revoked', () => { queue.length = 0; if (alertWin && !alertWin.isDestroyed()) alertWin.hide(); refreshTray(); showEnroll(); });
  agent.on('alert', (a) => showAlerts([a]));
  agent.on('closed', closeAlert);

  ipcMain.handle('enroll', async (_e, { serverUrl, code, deviceName }) => {
    try { await agent.enroll({ serverUrl: config.serverUrl || serverUrl, code, deviceName: deviceName || os.hostname() }); return { ok: true }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('alert-shown', (_e, id) => { if (!String(id).startsWith('local-')) return agent.shown(id); });
  // After an answer the screen stays up for a moment so the person can read whether it was sent, then the alert closes.
  ipcMain.handle('alert-ack', async (_e, { id, response }) => {
    const r = String(id).startsWith('local-') ? { sent: true } : await agent.ack(id, response);
    setTimeout(() => closeAlert(id), r.sent ? 2500 : 8000);
    return r;
  });
  ipcMain.handle('alert-dismiss', async (_e, id) => { if (!String(id).startsWith('local-')) await agent.dismiss(id); closeAlert(id); return { ok: true }; });

  app.setLoginItemSettings({ openAtLogin: true });
  refreshTray();
  agent.resume();
  agent.start();
  if (!agent.paired) showEnroll();
});

app.on('second-instance', () => { if (agent && !agent.paired) showEnroll(); });
app.on('window-all-closed', () => { /* stay in the tray */ });
