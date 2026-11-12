// Plain-language labels and small helpers shared by the Drills & Emergencies list, the Scenarios page and the Dashboard.
// Kept as plain .mjs so the node test runner can exercise it without a build step.

export const KIND_LABELS = { alert: 'Emergency', drill: 'Drill', test: 'Test' };
const KIND_COLORS = { alert: 'var(--tier-3)', drill: 'var(--brand-navy)', test: 'var(--brand-gray-600)' };

// The database calls a real emergency "alert"; people running the system call it an emergency.
export function kindLabel(kind) {
  return KIND_LABELS[kind] ?? (typeof kind === 'string' && kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : 'Event');
}

export function kindColor(kind) {
  return KIND_COLORS[kind] ?? 'var(--brand-gray-600)';
}

// Same rule the roll-call page uses to decide it is "updating live": still sending, or sent within the last 3 hours.
export const LIVE_WINDOW_MS = 3 * 3600 * 1000;
export function isLiveEvent({ createdAt, status, pending = 0 }, now = Date.now()) {
  if ((pending ?? 0) > 0 || status === 'sending') return true;
  const t = new Date(createdAt).getTime();
  return Number.isFinite(t) && now - t < LIVE_WINDOW_MS;
}

// Reduce the roll-call counts object to the few numbers a list row or card shows. Missing or odd input gives null,
// so the caller can show a dash instead of a misleading zero.
export function rollCallSummary(counts) {
  if (!counts || typeof counts !== 'object') return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    targeted: n(counts.targeted),
    safe: n(counts.safe),
    sos: n(counts.sos),
    replied: n(counts.replied),
    responded: n(counts.responded),
    unaccounted: n(counts.unaccounted),
  };
}

// Given events (any order) that carry a scenario_id, return an object mapping scenario id -> its most recent event.
export function latestEventPerScenario(events) {
  const out = {};
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.scenario_id) continue;
    const cur = out[e.scenario_id];
    if (!cur || new Date(e.created_at).getTime() > new Date(cur.created_at).getTime()) out[e.scenario_id] = e;
  }
  return out;
}
