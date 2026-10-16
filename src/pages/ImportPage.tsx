import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';
import { buildImportRows, CSV_TEMPLATE, ImportRow } from '../lib/rosterCore.mjs';

interface ResultRow { row: number; action: 'add' | 'update' | 'unchanged' | 'conflict' | 'invalid'; message: string; employee_id: string | null; full_name: string | null; mobile_phone: string | null }
interface Result { dry_run: boolean; counts: Record<string, number>; rows: ResultRow[] }

const ACTION_COLOR: Record<string, string> = { add: '#1a7f37', update: '#0b5cad', unchanged: '#6b7280', conflict: '#b45309', invalid: '#b42318' };

export default function ImportPage() {
  const { staff } = useAuth();
  const navigate = useNavigate();
  const [filename, setFilename] = useState('');
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [preview, setPreview] = useState<Result | null>(null);
  const [applied, setApplied] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('all');

  const result = applied ?? preview;
  const shown = useMemo(() => (result?.rows ?? []).filter((r) => filter === 'all' || r.action === filter), [result, filter]);

  if (!canEditRoster(staff)) return <p>Your role does not allow importing people.</p>;

  const reset = () => { setRows([]); setPreview(null); setApplied(null); setNotes([]); setError(null); setFilter('all'); };

  const onFile = async (file: File | undefined) => {
    reset();
    if (!file) return;
    setFilename(file.name);
    const parsed = buildImportRows(await file.text());
    if (parsed.errors.length) { setError(parsed.errors.join(' ')); return; }
    if (parsed.missingRequired.length) { setError(`The file is missing required column(s): ${parsed.missingRequired.join(', ')}.`); return; }
    if (parsed.rows.length > 5000) { setError('Imports are limited to 5000 rows per file. Split the file and import in parts.'); return; }
    setNotes(parsed.unmapped.length ? [`Ignored columns: ${parsed.unmapped.join(', ')}`] : []);
    setRows(parsed.rows);
    setBusy(true);
    const { data, error: rpcError } = await supabase.rpc('apply_roster_import', { p_rows: parsed.rows, p_filename: file.name, p_dry_run: true });
    setBusy(false);
    if (rpcError) { setError(rpcError.message); return; }
    setPreview(data as Result);
  };

  const apply = async () => {
    setBusy(true); setError(null);
    const { data, error: rpcError } = await supabase.rpc('apply_roster_import', { p_rows: rows, p_filename: filename, p_dry_run: false });
    setBusy(false);
    if (rpcError) { setError(rpcError.message); return; }
    setApplied(data as Result);
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'emns_roster_template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const c = result?.counts;
  const willChange = preview && (preview.counts.added + preview.counts.updated > 0);

  return (
    <div style={{ maxWidth: 980 }}>
      <button onClick={() => navigate('/people')} style={{ background: 'none', border: 'none', color: 'var(--brand-teal)', fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 12 }}>← Back to roster</button>
      <h1>Import people</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Upload a CSV roster. Nothing is saved until you review the preview and confirm. Imports only add and update:
        blank cells never erase existing data, people missing from the file are never removed, and opt-out status is never changed.
        People are matched on employee ID first, then mobile phone. Two different existing people matching one row is flagged as a conflict and skipped.
      </p>
      <div className="card" style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} disabled={busy} />
        <button onClick={downloadTemplate} style={{ background: 'none', border: '1px solid var(--brand-gray-300)', borderRadius: 6, padding: '6px 10px', cursor: 'pointer' }}>Download CSV template</button>
        <span style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>Columns: employee_id, full_name (or first_name + last_name), mobile_phone, email, groups (separate with ;)</span>
      </div>
      {busy && <p>Working…</p>}
      <p style={{ background: 'var(--brand-teal-light)', padding: 10, borderRadius: 6, fontSize: 14 }}>
        Importing a roster does not give anyone consent to be texted. New people are marked <strong>not yet agreed</strong> and receive nothing until they enroll themselves. After importing, use <strong>Download invite links</strong> on the People page.
      </p>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}
      {notes.map((n) => <p key={n} style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>{n}</p>)}

      {result && c && (
        <>
          <div className="card" style={{ marginTop: 16 }}>
            <h2 style={{ marginTop: 0 }}>{applied ? 'Import complete' : 'Preview (nothing saved yet)'}</h2>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {(['all', 'add', 'update', 'unchanged', 'conflict', 'invalid'] as const).map((k) => (
                <button key={k} onClick={() => setFilter(k)} style={{ padding: '6px 12px', borderRadius: 16, cursor: 'pointer', border: '1px solid var(--brand-gray-300)', background: filter === k ? 'var(--brand-navy)' : 'white', color: filter === k ? 'white' : 'inherit', fontWeight: 600 }}>
                  {k === 'all' ? `All ${c.total}` : `${k === 'add' ? 'New' : k[0].toUpperCase() + k.slice(1)} ${c[k === 'add' ? 'added' : k === 'update' ? 'updated' : k === 'conflict' ? 'conflicts' : k]}`}
                </button>
              ))}
            </div>
            {!applied && (
              <div style={{ marginTop: 14, display: 'flex', gap: 12, alignItems: 'center' }}>
                <button className="btn-primary" disabled={busy || !willChange} onClick={apply}>
                  Apply import ({preview!.counts.added} new, {preview!.counts.updated} updated)
                </button>
                <button onClick={reset} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand-teal)', fontWeight: 600 }}>Cancel</button>
                {!willChange && <span style={{ fontSize: 13 }}>Nothing to apply.</span>}
                {(c.conflicts > 0 || c.invalid > 0) && <span style={{ fontSize: 13, color: '#b45309' }}>{c.conflicts + c.invalid} row(s) will be skipped.</span>}
              </div>
            )}
            {applied && (
              <div style={{ marginTop: 14 }}>
                <button className="btn-primary" onClick={() => navigate('/people')}>View roster</button>{' '}
                <button onClick={reset} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--brand-teal)', fontWeight: 600 }}>Import another file</button>
              </div>
            )}
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12, fontSize: 14 }}>
            <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
              <th style={{ padding: 8 }}>Row</th><th style={{ padding: 8 }}>Result</th><th style={{ padding: 8 }}>Name</th><th style={{ padding: 8 }}>Employee ID</th><th style={{ padding: 8 }}>Phone</th><th style={{ padding: 8 }}>Details</th>
            </tr></thead>
            <tbody>
              {shown.slice(0, 500).map((r) => (
                <tr key={r.row} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
                  <td style={{ padding: 8 }}>{r.row + 1}</td>
                  <td style={{ padding: 8, fontWeight: 700, color: ACTION_COLOR[r.action] }}>{r.action}</td>
                  <td style={{ padding: 8 }}>{r.full_name ?? '—'}</td>
                  <td style={{ padding: 8 }}>{r.employee_id ?? '—'}</td>
                  <td style={{ padding: 8 }}>{r.mobile_phone ?? '—'}</td>
                  <td style={{ padding: 8 }}>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 500 && <p style={{ fontSize: 13 }}>Showing the first 500 of {shown.length} rows. Use the filters above to narrow down.</p>}
        </>
      )}
    </div>
  );
}
