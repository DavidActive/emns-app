import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';

interface Row { id: number; kind: string; channel: string | null; detail: string | null; at: string; people: { full_name: string } | null }
const KIND: Record<string, string> = {
  queued: 'Queued', held: 'Held for later', sending: 'Sending', sent: 'Sent', delivered: 'Delivered', undelivered: 'Not delivered', failed: 'Failed',
  skipped: 'Skipped', fallback_released: 'Moved to next channel', acknowledged: 'Answered',
};
const CH: Record<string, string> = { sms: 'Text', email: 'Email', voice: 'Call' };

// Step-by-step log of every send, fallback and answer for one event.
export default function EventTimeline({ eventId, live }: { eventId: string; live: boolean }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let stop = false;
    const load = async () => {
      const { data, error } = await supabase.from('event_timeline').select('id, kind, channel, detail, at, people(full_name)')
        .eq('event_id', eventId).order('at', { ascending: true }).order('id', { ascending: true }).limit(2000);
      if (stop) return;
      if (error) setErr(error.message); else { setRows((data ?? []) as unknown as Row[]); setErr(null); }
    };
    load();
    const t = live ? setInterval(load, 5000) : undefined;
    return () => { stop = true; if (t) clearInterval(t); };
  }, [open, eventId, live]);
  return (
    <section style={{ marginTop: 20 }}>
      <button onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'} step-by-step timeline</button>
      {open && (
        <div style={{ marginTop: 8 }}>
          {err && <p role="alert" style={{ color: 'var(--tier-3)' }}>{err}</p>}
          {rows.length === 0 && !err && <p style={{ color: 'var(--brand-gray-600)' }}>No steps recorded for this event.</p>}
          {rows.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
              <thead><tr style={{ textAlign: 'left', borderBottom: '2px solid var(--brand-gray-300)' }}><th style={{ padding: 6 }}>Time</th><th style={{ padding: 6 }}>Person</th><th style={{ padding: 6 }}>Channel</th><th style={{ padding: 6 }}>Step</th><th style={{ padding: 6 }}>Detail</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
                    <td style={{ padding: 6, whiteSpace: 'nowrap' }}>{new Date(r.at).toLocaleTimeString()}</td>
                    <td style={{ padding: 6 }}>{r.people?.full_name ?? '—'}</td>
                    <td style={{ padding: 6 }}>{r.channel ? CH[r.channel] ?? r.channel : '—'}</td>
                    <td style={{ padding: 6 }}>{KIND[r.kind] ?? r.kind}</td>
                    <td style={{ padding: 6 }}>{r.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
