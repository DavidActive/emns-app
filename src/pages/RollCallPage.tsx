import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

type Status = 'sos' | 'unaccounted' | 'pending' | 'replied' | 'safe' | 'not_contacted';
interface Person { person_id: string; full_name: string; mobile_phone: string; delivery_status: string; error_code: string | null; responded_at: string | null; last_text: string | null; reply_count: number; status: Status }
interface RollCall {
  event: { id: string; kind: string; status: string; body: string; requires_ack: boolean; created_at: string };
  counts: { targeted: number; safe: number; sos: number; replied: number; responded: number; unaccounted: number; undeliverable: number; pending: number; not_contacted: number; delivered: number };
  people: Person[];
}

const LABEL: Record<Status, string> = { sos: 'NEEDS HELP (SOS)', unaccounted: 'Unaccounted for', pending: 'Still sending', replied: 'Replied (text)', safe: 'Safe', not_contacted: 'Not texted (no consent / opted out)' };
const COLOR: Record<Status, string> = { sos: 'var(--tier-3)', unaccounted: 'var(--accent-orange)', pending: 'var(--brand-gray-600)', replied: 'var(--brand-navy)', safe: 'var(--tier-1)', not_contacted: 'var(--brand-gray-600)' };

export default function RollCallPage() {
  const { id } = useParams();
  const [data, setData] = useState<RollCall | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Status>('all');
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    const { data: d, error: err } = await supabase.rpc('event_roll_call', { p_event: id });
    if (err) { setError(err.message); return; }
    if (!d) { setError('Event not found.'); return; }
    setData(d as RollCall); setUpdated(new Date()); setError(null);
  }, [id]);
  useEffect(() => { load(); }, [load]);
  const live = !!data && (data.counts.pending > 0 || data.event.status === 'sending' || Date.now() - new Date(data.event.created_at).getTime() < 3 * 3600 * 1000);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [live, load]);

  const rows = useMemo(() => (data?.people ?? []).filter((p) => filter === 'all' || p.status === filter), [data, filter]);

  if (error) return <div><p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p><Link to="/events">← Sent events</Link></div>;
  if (!data) return <p>Loading…</p>;
  const c = data.counts;
  const tile = (label: string, value: number, color: string, f?: Status) => (
    <button key={label} onClick={() => setFilter(f ?? 'all')} style={{ textAlign: 'left', background: 'white', border: `2px solid ${filter === (f ?? 'all') ? color : 'var(--brand-gray-300)'}`, borderRadius: 10, padding: '10px 14px', minWidth: 130, cursor: 'pointer' }}>
      <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>{label}</div>
    </button>
  );

  return (
    <div style={{ maxWidth: 1000 }}>
      <Link to="/events">← Sent events</Link> · <Link to={`/events/${id}/report`}>After-action report</Link>
      <h1 style={{ marginBottom: 4 }}>Roll-call <span style={{ textTransform: 'uppercase', fontSize: 16, color: 'var(--brand-gray-600)' }}>{data.event.kind}</span></h1>
      <p style={{ color: 'var(--brand-gray-600)', marginTop: 0 }}>
        Sent {new Date(data.event.created_at).toLocaleString()}{live ? ' · updating live' : ''}{updated ? ` · checked ${updated.toLocaleTimeString()}` : ''}
      </p>
      <div style={{ border: '1px dashed var(--brand-gray-300)', padding: 10, borderRadius: 6, marginBottom: 14, whiteSpace: 'pre-wrap' }}>{data.event.body}</div>
      {!data.event.requires_ack && <p style={{ background: '#fff4e5', padding: 10, borderRadius: 6 }}>This notification did not ask people to reply, so replies are not tracked against it.</p>}
      {c.sos > 0 && <p role="alert" style={{ background: 'var(--tier-3)', color: 'white', padding: 12, borderRadius: 6, fontWeight: 700 }}>{c.sos} {c.sos === 1 ? 'person has' : 'people have'} replied SOS. They are also in the Inbox as critical items.</p>}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', margin: '12px 0' }}>
        {tile('Texted', c.targeted, 'var(--brand-navy)')}
        {tile('Accounted for', c.responded, 'var(--tier-1)')}
        {tile('Safe', c.safe, 'var(--tier-1)', 'safe')}
        {tile('Replied (text)', c.replied, 'var(--brand-navy)', 'replied')}
        {tile('SOS', c.sos, 'var(--tier-3)', 'sos')}
        {tile('Unaccounted for', c.unaccounted, 'var(--accent-orange)', 'unaccounted')}
        {c.pending > 0 && tile('Still sending', c.pending, 'var(--brand-gray-600)', 'pending')}
        {c.not_contacted > 0 && tile('Not texted', c.not_contacted, 'var(--brand-gray-600)', 'not_contacted')}
      </div>
      {c.undeliverable > 0 && <p style={{ fontSize: 14 }}>{c.undeliverable} of the unaccounted people did not receive the text (failed or undelivered). Contact them another way.</p>}
      <div className="card" style={{ overflowX: 'auto' }}>
        <div style={{ marginBottom: 8, fontSize: 14 }}>Showing <strong>{filter === 'all' ? 'everyone' : LABEL[filter]}</strong> ({rows.length}) {filter !== 'all' && <button onClick={() => setFilter('all')}>Show all</button>}</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
          <thead><tr style={{ textAlign: 'left' }}>{['Name', 'Phone', 'Status', 'Text delivery', 'Last reply'].map((h) => <th key={h} style={{ padding: 6 }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} style={{ padding: 10 }}>No one in this group.</td></tr>}
            {rows.map((p) => (
              <tr key={p.person_id} style={{ borderTop: '1px solid var(--brand-gray-300)', background: p.status === 'sos' ? '#fdecea' : undefined }}>
                <td style={{ padding: 6, fontWeight: 600 }}>{p.full_name}</td>
                <td style={{ padding: 6 }}>{p.mobile_phone}</td>
                <td style={{ padding: 6, color: COLOR[p.status], fontWeight: 700 }}>{LABEL[p.status]}</td>
                <td style={{ padding: 6 }}>{p.delivery_status}{p.error_code ? ` (${p.error_code})` : ''}</td>
                <td style={{ padding: 6 }}>{p.last_text ? `"${p.last_text}" · ${p.responded_at ? new Date(p.responded_at).toLocaleTimeString() : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
