import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { isLiveEvent, kindColor, kindLabel, rollCallSummary, type RollCallSummary } from '../lib/eventLabels.mjs';

interface Ev {
  id: string; kind: string; status: string; created_at: string; created_by_name: string | null; body?: string;
  queued: number; sending: number; sent: number; delivered: number; undelivered: number; failed: number; skipped: number;
}

// Roll-call numbers are fetched for the most recent events only, so the page stays quick on a long history.
const SUMMARY_LIMIT = 15;

const chip = (bg: string, color = 'white') => ({
  display: 'inline-block', background: bg, color, borderRadius: 999, padding: '2px 9px', fontSize: 12, fontWeight: 700, marginRight: 6, whiteSpace: 'nowrap' as const,
});

export default function EventsPage() {
  const navigate = useNavigate();
  const [events, setEvents] = useState<Ev[]>([]);
  const [summaries, setSummaries] = useState<Record<string, RollCallSummary | null>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('list_recent_events', { p_limit: 50 });
    if (err) { setError(err.message); return; }
    const list = (data ?? []) as Ev[];
    setEvents(list);
    const pairs = await Promise.all(list.slice(0, SUMMARY_LIMIT).map(async (e) => {
      const { data: rc } = await supabase.rpc('event_roll_call', { p_event: e.id });
      return [e.id, rollCallSummary((rc as { counts?: unknown } | null)?.counts)] as const;
    }));
    setSummaries(Object.fromEntries(pairs));
  }, []);
  useEffect(() => { load(); }, [load]);

  const sending = events.some((e) => e.queued > 0 || e.sending > 0);
  const recent = events.some((e) => isLiveEvent({ createdAt: e.created_at, status: e.status, pending: e.queued + e.sending }));
  useEffect(() => {
    if (!sending && !recent) return;
    const t = setInterval(load, sending ? 5000 : 15000);
    return () => clearInterval(t);
  }, [sending, recent, load]);

  const stop = (ev: { stopPropagation: () => void }) => ev.stopPropagation();

  return (
    <div style={{ maxWidth: 1200 }}>
      <h1>Drills &amp; Emergencies</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Every emergency alert, drill and test that has been sent. Open one to see who is safe, who needs help and who is unaccounted for, with a map.
        This page refreshes itself while messages are going out or a roll-call is recent.
      </p>
      {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ textAlign: 'left' }}>
            {['Type', 'When', 'Status', 'Roll-call', 'Waiting', 'Sent', 'Delivered', 'Not delivered', 'Skipped', 'By'].map((h) => <th key={h} style={{ padding: 6 }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={10} style={{ padding: 10 }}>Nothing has been sent yet.</td></tr>}
            {events.map((e) => {
              const s = summaries[e.id];
              return (
                <tr
                  key={e.id}
                  onClick={() => navigate(`/events/${e.id}`)}
                  style={{ borderTop: '1px solid var(--brand-gray-300)', cursor: 'pointer', background: s && s.sos > 0 ? '#fdecea' : undefined }}
                >
                  <td style={{ padding: 6 }}><span style={chip(kindColor(e.kind))}>{kindLabel(e.kind)}</span></td>
                  <td style={{ padding: 6 }}>{new Date(e.created_at).toLocaleString()}</td>
                  <td style={{ padding: 6 }}>{e.status}</td>
                  <td style={{ padding: 6, minWidth: 330 }} onClick={stop}>
                    <div style={{ marginBottom: 6 }}>
                      {s ? (
                        <>
                          <span style={chip('var(--tier-1)')}>{s.safe} safe</span>
                          {s.sos > 0 && <span style={chip('var(--tier-3)')}>{s.sos} SOS</span>}
                          {s.replied > 0 && <span style={chip('var(--brand-navy)')}>{s.replied} replied</span>}
                          <span style={chip(s.unaccounted > 0 ? 'var(--accent-orange)' : 'var(--brand-gray-300)', s.unaccounted > 0 ? 'white' : 'var(--brand-gray-600)')}>{s.unaccounted} unaccounted</span>
                        </>
                      ) : <span style={{ color: 'var(--brand-gray-600)' }}>—</span>}
                    </div>
                    <Link to={`/events/${e.id}`} className="btn-primary" style={{ display: 'inline-block', textDecoration: 'none', padding: '6px 12px', fontSize: 13 }}>
                      View roll-call &amp; map
                    </Link>
                    {' '}<Link to={`/events/${e.id}/report`} style={{ fontSize: 13 }}>Report</Link>
                  </td>
                  <td style={{ padding: 6 }}>{e.queued + e.sending}</td>
                  <td style={{ padding: 6 }}>{e.sent}</td>
                  <td style={{ padding: 6 }}>{e.delivered}</td>
                  <td style={{ padding: 6 }}>{e.undelivered + e.failed}</td>
                  <td style={{ padding: 6 }}>{e.skipped}</td>
                  <td style={{ padding: 6 }}>{e.created_by_name ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
