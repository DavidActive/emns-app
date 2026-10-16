// P8: pure helpers for the after-action report (CSV + duration text). No DOM, no network.
// The numbers come from the database function event_after_action; this file only formats them.

const BUCKET_LABELS = { lt_1m: 'Under 1 minute', m1_2: '1 to 2 minutes', m2_5: '2 to 5 minutes', m5_10: '5 to 10 minutes', gt_10m: 'Over 10 minutes' };
const DELIVERY_EXTRA = { no_receipt: 'Sent, no delivery receipt', failed: 'Failed or undelivered', pending: 'Still sending' };
const STATUS_LABELS = { sos: 'SOS', safe: 'Safe', replied: 'Replied (text)', unaccounted: 'Unaccounted for', pending: 'Still sending', not_contacted: 'Not texted' };

export function formatDuration(seconds) {
  if (seconds === null || seconds === undefined || seconds === '' || Number.isNaN(Number(seconds))) return '';
  const s = Math.round(Number(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`;
}

// Quote every cell; neutralise spreadsheet formulas (=, +, -, @, tab, CR) so a person's name or
// reply text cannot run as a formula when the file is opened in Excel.
export function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function row(cells) { return cells.map(csvCell).join(','); }

export function bucketLabel(key) { return BUCKET_LABELS[key] ?? DELIVERY_EXTRA[key] ?? key; }
export function statusLabel(key) { return STATUS_LABELS[key] ?? key; }

export function buildCsv(report, tz) {
  const e = report.event; const c = report.counts; const t = report.timeline;
  const when = (v) => (v ? new Date(v).toLocaleString('en-US', tz ? { timeZone: tz, timeZoneName: 'short' } : undefined) : '');
  const out = [];
  out.push(row(['After-action report']));
  out.push(row(['Event type', e.kind])); out.push(row(['Sent by', e.sent_by ?? ''])); out.push(row(['Groups', (e.groups ?? []).join('; ')]));
  out.push(row(['Message', e.body])); out.push(row(['Report generated', when(report.generated_at)]));
  out.push('');
  out.push(row(['Summary', 'People']));
  for (const [k, label] of [['targeted', 'Texted'], ['responded', 'Accounted for'], ['safe', 'Safe'], ['replied', 'Replied (text)'], ['sos', 'SOS'], ['unaccounted', 'Unaccounted for'], ['undeliverable', 'Unaccounted and text not delivered'], ['pending', 'Still sending'], ['not_contacted', 'Not texted (no consent / opted out)'], ['delivered', 'Texts delivered']]) out.push(row([label, c[k]]));
  out.push('');
  out.push(row(['Timeline', 'Time', 'Seconds after send confirmed']));
  const base = t.event_created_at ? new Date(t.event_created_at).getTime() : null;
  for (const [k, label] of [['event_created_at', 'Send confirmed'], ['first_sent_at', 'First text sent'], ['last_sent_at', 'Last text sent'], ['first_delivered_at', 'First text delivered'], ['last_delivered_at', 'Last text delivered'], ['first_reply_at', 'First reply'], ['first_sos_at', 'First SOS reply'], ['last_reply_at', 'Last reply']]) {
    const v = t[k]; out.push(row([label, when(v), v && base !== null ? Math.max(0, Math.round((new Date(v).getTime() - base) / 1000)) : '']));
  }
  out.push('');
  out.push(row(['Delivery time (carrier receipt)', 'Texts']));
  for (const k of ['lt_1m', 'm1_2', 'm2_5', 'm5_10', 'gt_10m', 'no_receipt', 'failed', 'pending']) out.push(row([bucketLabel(k), report.delivery.buckets[k]]));
  for (const k of ['p50', 'p90', 'max']) out.push(row([`Delivery ${k} (seconds)`, report.delivery.seconds[k] ?? '']));
  out.push('');
  out.push(row(['Time to first reply', 'People']));
  for (const k of ['lt_1m', 'm1_2', 'm2_5', 'm5_10', 'gt_10m']) out.push(row([bucketLabel(k), report.acknowledgement.buckets[k]]));
  for (const k of ['p50', 'p90', 'max']) out.push(row([`Reply ${k} (seconds)`, report.acknowledgement.seconds[k] ?? '']));
  out.push('');
  out.push(row(['Channel', 'Delivery status', 'Count']));
  for (const ch of report.channels) out.push(row([ch.channel, ch.status, ch.count]));
  out.push('');
  const un = report.people.filter((p) => p.status === 'unaccounted');
  out.push(row([`Unaccounted for (${un.length})`, 'Phone', 'Text delivery']));
  for (const p of un) out.push(row([p.full_name, p.mobile_phone, p.delivery_status + (p.error_code ? ` (${p.error_code})` : '')]));
  out.push('');
  out.push(row(['Name', 'Phone', 'Status', 'Text delivery', 'Error code', 'Sent at', 'Delivered at', 'Seconds to deliver', 'First reply at', 'Seconds to first reply', 'Last reply text']));
  for (const p of report.people) out.push(row([p.full_name, p.mobile_phone, statusLabel(p.status), p.delivery_status, p.error_code ?? '', when(p.sent_at), when(p.delivered_at), p.seconds_to_deliver ?? '', when(p.first_reply_at), p.seconds_to_first_reply ?? '', p.last_text ?? '']));
  return out.join('\r\n') + '\r\n';
}
