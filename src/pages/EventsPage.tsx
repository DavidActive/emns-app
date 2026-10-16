import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

interface Ev {
  id: string; kind: string; status: string; created_at: string; created_by_name: string | null; body?: string;
  queued: number; sending: number; sent: number; delivered: number; undelivered: number; failed: number; skipped: number;
}

export default function EventsPage() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error: err } = await supabase.rpc('list_recent_events', { p_limit: 50 });
    if (err) setError(err.message); else setEvents((data ?? []) as Ev[]);
  }, []);
  useEffect(() => { load(); }, [load]);
  const active = events.some((e) => e.queued > 0 || e.sending > 0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [active, load]);

  return (
    <div style={{ maxWidth: 1000 }}>
      <h1>Sent Events</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>Every alert, drill and test, with delivery results. This page refreshes itself while messages are still going out.</p>
      {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ textAlign: 'left' }}>
            {['When', 'Type', 'By', 'Status', 'Waiting', 'Sent', 'Delivered', 'Not delivered', 'Skipped', 'Roll-call'].map((h) => <th key={h} style={{ padding: 6 }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {events.length === 0 && <tr><td colSpan={10} style={{ padding: 10 }}>Nothing has been sent yet.</td></tr>}
            {events.map((e) => (
              <tr key={e.id} style={{ borderTop: '1px solid var(--brand-gray-300)' }}>
                <td style={{ padding: 6 }}>{new Date(e.created_at).toLocaleString()}</td>
                <td style={{ padding: 6, fontWeight: 700, textTransform: 'uppercase' }}>{e.kind}</td>
                <td style={{ padding: 6 }}>{e.created_by_name ?? '—'}</td>
                <td style={{ padding: 6 }}>{e.status}</td>
                <td style={{ padding: 6 }}>{e.queued + e.sending}</td>
                <td style={{ padding: 6 }}>{e.sent}</td>
                <td style={{ padding: 6 }}>{e.delivered}</td>
                <td style={{ padding: 6 }}>{e.undelivered + e.failed}</td>
                <td style={{ padding: 6 }}>{e.skipped}</td>
                <td style={{ padding: 6 }}><Link to={`/events/${e.id}`}>Open</Link> · <Link to={`/events/${e.id}/report`}>Report</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
