import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { callFunction } from '../lib/api';
import { canDrill, canSendAlert } from '../lib/permissions';
import { formatMessage } from '../lib/messageFormat.mjs';

type Kind = 'alert' | 'drill' | 'test';
interface Scenario { id: string; name: string; kind: Kind; bodies: { sms?: string }; default_group_ids: string[]; requires_ack: boolean }
interface Group { id: string; name: string }
interface Audience { total: number; will_receive: number; opted_out: number; no_consent: number }

export default function ComposePage() {
  const { staff } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const alertOk = canSendAlert(staff);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [org, setOrg] = useState<{ name: string; settings: { drill_tag?: string; test_tag?: string } | null } | null>(null);
  const [scenarioId, setScenarioId] = useState(params.get('scenario') ?? '');
  const [kind, setKind] = useState<Kind>('drill');
  const [body, setBody] = useState('');
  const [ack, setAck] = useState(true);
  const [selected, setSelected] = useState<string[]>([]);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmAlert, setConfirmAlert] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState(() => crypto.randomUUID());

  useEffect(() => {
    (async () => {
      const [{ data: s }, { data: g }] = await Promise.all([
        supabase.from('notification_scenarios').select('id, name, kind, bodies, default_group_ids, requires_ack').order('name'),
        supabase.from('groups').select('id, name').order('name'),
      ]);
      setScenarios((s ?? []) as Scenario[]);
      setGroups((g ?? []) as Group[]);
      if (staff?.organization_id) {
        const { data: o } = await supabase.from('organizations').select('name, settings').eq('id', staff.organization_id).maybeSingle();
        setOrg(o as typeof org);
      }
    })();
  }, [staff?.organization_id]);

  // Choosing a scenario fills in the form; everything stays editable.
  useEffect(() => {
    const s = scenarios.find((x) => x.id === scenarioId);
    if (!s) return;
    setKind(s.kind === 'alert' && !alertOk ? 'drill' : s.kind);
    setBody(s.bodies?.sms ?? '');
    setAck(s.requires_ack);
    setSelected(s.default_group_ids ?? []);
  }, [scenarioId, scenarios, alertOk]);

  useEffect(() => {
    if (selected.length === 0) { setAudience(null); return; }
    supabase.rpc('preview_event_audience', { p_group_ids: selected }).then(({ data }) => setAudience((data ?? null) as Audience | null));
  }, [selected]);

  const preview = useMemo(() => {
    try {
      return formatMessage({ kind, orgName: org?.name ?? '', body, requiresAck: ack, drillTag: org?.settings?.drill_tag, testTag: org?.settings?.test_tag });
    } catch { return ''; }
  }, [kind, body, ack, org]);

  if (!canDrill(staff)) return <div><h1>Send</h1><p>Your role can view notifications but not send them.</p></div>;

  const ready = selected.length > 0 && (kind !== 'alert' || body.trim().length > 0) && (audience?.will_receive ?? 0) > 0;
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await callFunction('send-event', { kind, body, group_ids: selected, requires_ack: ack, scenario_id: scenarioId || undefined, idempotency_key: key });
      navigate('/events');
    } catch (e) { setError((e as Error).message); setKey(crypto.randomUUID()); setConfirming(false); }
    setBusy(false);
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <h1>Send a notification</h1>
      <div className="card" style={{ display: 'grid', gap: 14 }}>
        <label>Start from a scenario (optional)<br />
          <select value={scenarioId} onChange={(e) => setScenarioId(e.target.value)} style={{ padding: 8, width: '100%' }}>
            <option value="">— none —</option>
            {scenarios.filter((s) => s.kind !== 'alert' || alertOk).map((s) => <option key={s.id} value={s.id}>{s.name} ({s.kind})</option>)}
          </select>
        </label>
        <fieldset style={{ border: 'none', padding: 0 }}>
          <legend>Type</legend>
          {(['drill', 'test', 'alert'] as Kind[]).map((k) => (
            <label key={k} style={{ marginRight: 18, opacity: k === 'alert' && !alertOk ? 0.5 : 1 }}>
              <input type="radio" name="kind" checked={kind === k} disabled={k === 'alert' && !alertOk} onChange={() => setKind(k)} /> {k === 'alert' ? 'Real alert' : k[0].toUpperCase() + k.slice(1)}
            </label>
          ))}
          {!alertOk && <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Your role can run drills and tests. Real alerts need a sender or admin.</div>}
        </fieldset>
        <label>Message{kind !== 'alert' ? ' (optional for drills and tests)' : ''}<br />
          <textarea rows={4} maxLength={600} value={body} onChange={(e) => setBody(e.target.value)} style={{ width: '100%', padding: 8 }} />
        </label>
        <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Ask people to reply SAFE</label>
        <fieldset style={{ border: '1px solid var(--brand-gray-300)', borderRadius: 6 }}>
          <legend>Send to</legend>
          {groups.length === 0 && <span>No groups yet. Create groups first.</span>}
          {groups.map((g) => (
            <label key={g.id} style={{ display: 'block' }}>
              <input type="checkbox" checked={selected.includes(g.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, g.id] : selected.filter((x) => x !== g.id))} /> {g.name}
            </label>
          ))}
        </fieldset>
        {audience && (
          <div style={{ background: 'var(--brand-teal-light)', padding: 10, borderRadius: 6 }}>
            <strong>{audience.will_receive}</strong> of {audience.total} people will receive this.
            {audience.no_consent > 0 && <div>{audience.no_consent} skipped: have not agreed to texts yet.</div>}
            {audience.opted_out > 0 && <div>{audience.opted_out} skipped: replied STOP.</div>}
          </div>
        )}
        <div>
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>What recipients will get</div>
          <div style={{ border: '1px dashed var(--brand-gray-300)', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{preview || '—'}</div>
          <div style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>{preview.length} characters</div>
        </div>
        {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
        <button className="btn-primary" disabled={!ready} onClick={() => { setConfirmAlert(false); setConfirming(true); }} style={{ opacity: ready ? 1 : 0.5 }}>Review and send</button>
      </div>

      {confirming && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div className="card" style={{ maxWidth: 520, width: '100%' }}>
            <h2 style={{ marginTop: 0 }}>{kind === 'alert' ? 'Send a REAL alert?' : `Send this ${kind}?`}</h2>
            <p>This will text <strong>{audience?.will_receive ?? 0}</strong> people right away. It cannot be recalled.</p>
            <div style={{ border: '1px dashed var(--brand-gray-300)', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' }}>{preview}</div>
            {kind === 'alert' && (
              <label style={{ display: 'block', margin: '12px 0' }}>
                <input type="checkbox" checked={confirmAlert} onChange={(e) => setConfirmAlert(e.target.checked)} /> This is a real emergency and I want to alert these people now.
              </label>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn-primary" disabled={busy || (kind === 'alert' && !confirmAlert)} onClick={send}>{busy ? 'Sending…' : 'Send now'}</button>
              <button onClick={() => setConfirming(false)} disabled={busy}>Go back</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
