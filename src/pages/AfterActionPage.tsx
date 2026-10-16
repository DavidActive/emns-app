import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { bucketLabel, buildCsv, formatDuration, statusLabel } from '../lib/afterActionReport.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function AfterActionPage() {
  const { id } = useParams();
  const [r, setR] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase.rpc('event_after_action', { p_event: id }).then(({ data, error: err }) => {
      if (err) setError(err.message); else if (!data) setError('Event not found.'); else setR(data);
    });
  }, [id]);

  if (error) return <div><p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p><Link to="/events">← Sent events</Link></div>;
  if (!r) return <p>Loading…</p>;

  const c = r.counts; const t = r.timeline;
  const fmt = (v: string | null) => (v ? new Date(v).toLocaleTimeString() : '—');
  const base = new Date(t.event_created_at).getTime();
  const off = (v: string | null) => (v ? `+${formatDuration(Math.max(0, (new Date(v).getTime() - base) / 1000))}` : '');
  const unaccounted = r.people.filter((p: any) => p.status === 'unaccounted');

  function download() {
    const blob = new Blob(['﻿' + buildCsv(r)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `after-action-${r.event.kind}-${r.event.created_at.slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  const th = { padding: 6, textAlign: 'left' as const };
  const dist = (title: string, buckets: Record<string, number>, keys: string[], secs: any) => (
    <div className="card" style={{ flex: 1, minWidth: 300 }}>
      <h3 style={{ marginTop: 0 }}>{title}</h3>
      <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
        <tbody>{keys.map((k) => <tr key={k}><td style={{ padding: 4 }}>{bucketLabel(k)}</td><td style={{ padding: 4, textAlign: 'right', fontWeight: 700 }}>{buckets[k]}</td></tr>)}</tbody>
      </table>
      <p style={{ fontSize: 13, color: 'var(--brand-gray-600)', marginBottom: 0 }}>Median {formatDuration(secs.p50) || '—'} · 90th percentile {formatDuration(secs.p90) || '—'} · slowest {formatDuration(secs.max) || '—'}</p>
    </div>
  );

  return (
    <div style={{ maxWidth: 1000 }}>
      <div className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <Link to={`/events/${id}`}>← Roll-call</Link>
        <span style={{ flex: 1 }} />
        <button onClick={download}>Download CSV</button>
        <button onClick={() => window.print()}>Print / Save as PDF</button>
      </div>
      <h1 style={{ marginBottom: 4 }}>After-action report <span style={{ textTransform: 'uppercase', fontSize: 16, color: 'var(--brand-gray-600)' }}>{r.event.kind}</span></h1>
      <p style={{ color: 'var(--brand-gray-600)', marginTop: 0 }}>
        Sent {new Date(r.event.created_at).toLocaleString()} by {r.event.sent_by ?? 'unknown'} to {(r.event.groups ?? []).join(', ') || 'no groups'} · report generated {new Date(r.generated_at).toLocaleString()}
      </p>
      <div style={{ border: '1px dashed var(--brand-gray-300)', padding: 10, borderRadius: 6, marginBottom: 14, whiteSpace: 'pre-wrap' }}>{r.event.body}</div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Result</h3>
        <p style={{ fontSize: 18, margin: '0 0 6px' }}><strong>{c.responded}</strong> of <strong>{c.targeted}</strong> accounted for · <strong>{c.unaccounted}</strong> unaccounted for · <strong style={{ color: c.sos ? 'var(--tier-3)' : undefined }}>{c.sos}</strong> SOS</p>
        <p style={{ margin: 0, fontSize: 14 }}>Safe {c.safe} · Replied (text) {c.replied} · Texts delivered {c.delivered}{c.undeliverable > 0 ? ` · ${c.undeliverable} unaccounted people did not receive the text` : ''}{c.pending > 0 ? ` · ${c.pending} still sending` : ''}{c.not_contacted > 0 ? ` · ${c.not_contacted} not texted (no consent / opted out)` : ''}</p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Timeline</h3>
        <table style={{ fontSize: 14, borderCollapse: 'collapse' }}><tbody>
          {([['Send confirmed', t.event_created_at], ['First text sent', t.first_sent_at], ['Last text sent', t.last_sent_at], ['First text delivered', t.first_delivered_at], ['Last text delivered', t.last_delivered_at], ['First reply', t.first_reply_at], ['First SOS reply', t.first_sos_at], ['Last reply', t.last_reply_at]] as [string, string | null][]).map(([l, v]) => (
            <tr key={l}><td style={{ padding: '3px 16px 3px 0' }}>{l}</td><td style={{ padding: '3px 16px 3px 0' }}>{fmt(v)}</td><td style={{ color: 'var(--brand-gray-600)' }}>{l === 'Send confirmed' ? '' : off(v)}</td></tr>
          ))}
        </tbody></table>
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {dist('Text delivery time (carrier receipt)', r.delivery.buckets, ['lt_1m', 'm1_2', 'm2_5', 'm5_10', 'gt_10m', 'no_receipt', 'failed', 'pending'], r.delivery.seconds)}
        {dist('Time to first reply', r.acknowledgement.buckets, ['lt_1m', 'm1_2', 'm2_5', 'm5_10', 'gt_10m'], r.acknowledgement.seconds)}
      </div>
      <p style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>Times are measured from when the send was confirmed. Delivery uses the carrier's delivery receipt; some carriers do not return one, so those texts are counted separately. Reply time is each person's first reply.</p>

      <div className="card" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Unaccounted for ({unaccounted.length})</h3>
        {unaccounted.length === 0 ? <p style={{ margin: 0 }}>Everyone texted is accounted for.</p> : (
          <table style={{ width: '100%', fontSize: 14, borderCollapse: 'collapse' }}>
            <thead><tr>{['Name', 'Phone', 'Text delivery'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{unaccounted.map((p: any) => <tr key={p.person_id} style={{ borderTop: '1px solid var(--brand-gray-300)' }}><td style={{ padding: 6, fontWeight: 600 }}>{p.full_name}</td><td style={{ padding: 6 }}>{p.mobile_phone}</td><td style={{ padding: 6 }}>{p.delivery_status}{p.error_code ? ` (${p.error_code})` : ''}</td></tr>)}</tbody>
          </table>
        )}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        <h3 style={{ marginTop: 0 }}>Everyone ({r.people.length})</h3>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead><tr>{['Name', 'Status', 'Delivered in', 'First reply in', 'Last reply'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>{r.people.map((p: any) => (
            <tr key={p.person_id} style={{ borderTop: '1px solid var(--brand-gray-300)' }}>
              <td style={{ padding: 4 }}>{p.full_name}</td><td style={{ padding: 4 }}>{statusLabel(p.status)}</td>
              <td style={{ padding: 4 }}>{formatDuration(p.seconds_to_deliver) || '—'}</td><td style={{ padding: 4 }}>{formatDuration(p.seconds_to_first_reply) || '—'}</td>
              <td style={{ padding: 4 }}>{p.last_text ?? '—'}</td>
            </tr>))}</tbody>
        </table>
      </div>
    </div>
  );
}
