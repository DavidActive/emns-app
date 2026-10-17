import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { callFunction } from '../lib/api';
import { canDrill, canSendAlert } from '../lib/permissions';
import { formatMessage } from '../lib/messageFormat.mjs';
import { formatEmail } from '../lib/emailFormat.mjs';
import { formatVoice } from '../lib/voiceFormat.mjs';

type Kind = 'alert' | 'drill' | 'test';
type Channel = 'sms' | 'email' | 'voice';
type Mode = 'together' | 'fallback';
interface Scenario { id: string; name: string; kind: Kind; bodies: { sms?: string }; default_group_ids: string[]; requires_ack: boolean }
interface Group { id: string; name: string }
interface Audience { total: number; will_receive: number; opted_out: number; no_consent: number }
interface EmailAudience { total: number; will_receive: number; no_email: number; opted_out: number; bounced: number }
const NAME: Record<Channel, string> = { sms: 'Text message', email: 'Email', voice: 'Phone call' };
const VERB: Record<Channel, string> = { sms: 'text', email: 'email', voice: 'call' };

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
  const [emailAudience, setEmailAudience] = useState<EmailAudience | null>(null);
  const [voiceAudience, setVoiceAudience] = useState<Audience | null>(null);
  const [order, setOrder] = useState<Channel[]>(['sms']); // the order boxes were ticked: it is the order used in "in this order" mode
  const [mode, setMode] = useState<Mode>('together');
  const [fallbackMinutes, setFallbackMinutes] = useState(0); // 0 = move on only when a channel fails
  const [subject, setSubject] = useState('');
  const [voiceAttempts, setVoiceAttempts] = useState(2);
  const [voiceMinutes, setVoiceMinutes] = useState(2);
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

  const usesSms = order.includes('sms');
  const usesEmail = order.includes('email');
  const usesVoice = order.includes('voice');
  const effectiveMode: Mode = order.length > 1 ? mode : 'together';

  useEffect(() => {
    if (selected.length === 0) { setAudience(null); return; }
    supabase.rpc('preview_event_audience', { p_group_ids: selected }).then(({ data }) => setAudience((data ?? null) as Audience | null));
  }, [selected]);
  useEffect(() => {
    if (selected.length === 0 || !usesEmail) { setEmailAudience(null); return; }
    supabase.rpc('preview_email_audience', { p_group_ids: selected }).then(({ data }) => setEmailAudience((data ?? null) as EmailAudience | null));
  }, [selected, usesEmail]);
  useEffect(() => {
    if (selected.length === 0 || !usesVoice) { setVoiceAudience(null); return; }
    supabase.rpc('preview_voice_audience', { p_group_ids: selected }).then(({ data }) => setVoiceAudience((data ?? null) as Audience | null));
  }, [selected, usesVoice]);

  const emailPreview = useMemo(() => {
    try {
      return formatEmail({ kind, orgName: org?.name ?? '', subject, body, requiresAck: ack, drillTag: org?.settings?.drill_tag, testTag: org?.settings?.test_tag });
    } catch { return null; }
  }, [kind, subject, body, ack, org]);

  const preview = useMemo(() => {
    try {
      return formatMessage({ kind, orgName: org?.name ?? '', body, requiresAck: ack, drillTag: org?.settings?.drill_tag, testTag: org?.settings?.test_tag });
    } catch { return ''; }
  }, [kind, body, ack, org]);

  const voicePreview = useMemo(() => {
    try {
      const spoken = formatVoice({ kind, orgName: org?.name ?? '', body });
      return `${spoken} ${ack ? 'Press 1 if you are safe. Press 2 if you need help. Press 9 to stop receiving calls from this system.' : 'To stop receiving calls from this system, press 9.'}`;
    } catch { return ''; }
  }, [kind, body, ack, org]);

  if (!canDrill(staff)) return <div><h1>Send</h1><p>Your role can view notifications but not send them.</p></div>;

  const toggle = (c: Channel, on: boolean) => setOrder((o) => (on ? (o.includes(c) ? o : [...o, c]) : o.filter((x) => x !== c)));
  const people: Record<Channel, number> = {
    sms: usesSms ? audience?.will_receive ?? 0 : 0,
    email: usesEmail ? emailAudience?.will_receive ?? 0 : 0,
    voice: usesVoice ? voiceAudience?.will_receive ?? 0 : 0,
  };
  const ready = selected.length > 0 && order.length > 0 && (kind !== 'alert' || body.trim().length > 0) && order.some((c) => people[c] > 0);
  const send = async () => {
    setBusy(true); setError(null);
    try {
      await callFunction('send-event', {
        kind, body, group_ids: selected, requires_ack: ack, scenario_id: scenarioId || undefined, idempotency_key: key,
        channels: order, mode: effectiveMode,
        fallback_after_seconds: effectiveMode === 'fallback' && ack ? Math.round(fallbackMinutes * 60) : undefined,
        email_subject: usesEmail ? subject : undefined,
        voice_max_attempts: usesVoice ? voiceAttempts : undefined,
        voice_retry_seconds: usesVoice ? Math.round(voiceMinutes * 60) : undefined,
      });
      navigate('/events');
    } catch (e) { setError((e as Error).message); setKey(crypto.randomUUID()); setConfirming(false); }
    setBusy(false);
  };
  const box = { border: '1px dashed var(--brand-gray-300)', padding: 10, borderRadius: 6, whiteSpace: 'pre-wrap' as const };
  const note = { fontSize: 13, color: 'var(--brand-gray-600)' };

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
          {!alertOk && <div style={note}>Your role can run drills and tests. Real alerts need a sender or admin.</div>}
        </fieldset>
        <label>Message{kind !== 'alert' ? ' (optional for drills and tests)' : ''}<br />
          <textarea rows={4} maxLength={600} value={body} onChange={(e) => setBody(e.target.value)} style={{ width: '100%', padding: 8 }} />
        </label>

        <fieldset style={{ border: '1px solid var(--brand-gray-300)', borderRadius: 6 }}>
          <legend>How to reach people</legend>
          {(['sms', 'email', 'voice'] as Channel[]).map((c) => (
            <label key={c} style={{ display: 'inline-block', marginRight: 18 }}>
              <input type="checkbox" checked={order.includes(c)} onChange={(e) => toggle(c, e.target.checked)} /> {NAME[c]}
            </label>
          ))}
          {order.length === 0 && <div style={{ color: 'var(--tier-3)' }}>Choose at least one.</div>}
          {order.length > 1 && (
            <div style={{ marginTop: 8 }}>
              <label style={{ display: 'block' }}><input type="radio" name="mode" checked={mode === 'together'} onChange={() => setMode('together')} /> All at once</label>
              <label style={{ display: 'block' }}><input type="radio" name="mode" checked={mode === 'fallback'} onChange={() => setMode('fallback')} /> In this order, moving on only if one fails: <strong>{order.map((c) => NAME[c]).join(' → ')}</strong></label>
              {mode === 'fallback' && <div style={note}>The order is the order you ticked the boxes. Untick and tick again to change it.</div>}
              {mode === 'fallback' && ack && (
                <label style={{ display: 'block', marginTop: 6 }}>Also move on if there is no answer within{' '}
                  <input type="number" min={0} max={1440} value={fallbackMinutes} onChange={(e) => setFallbackMinutes(Math.min(1440, Math.max(0, Number(e.target.value) || 0)))} style={{ width: 70 }} /> minutes
                  <span style={note}> (0 = only when a channel fails)</span>
                </label>
              )}
            </div>
          )}
        </fieldset>

        {usesEmail && (
          <label>Email subject (optional)<br />
            <input value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} style={{ width: '100%', padding: 8 }} />
          </label>
        )}
        {usesVoice && (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <label>Call attempts per person<br />
              <input type="number" min={1} max={5} value={voiceAttempts} onChange={(e) => setVoiceAttempts(Math.min(5, Math.max(1, Number(e.target.value) || 1)))} style={{ padding: 8, width: 90 }} />
            </label>
            <label>Minutes between attempts<br />
              <input type="number" min={1} max={60} value={voiceMinutes} onChange={(e) => setVoiceMinutes(Math.min(60, Math.max(1, Number(e.target.value) || 1)))} style={{ padding: 8, width: 90 }} />
            </label>
            <div style={{ ...note, alignSelf: 'end' }}>A busy line or no answer is tried again, up to this many calls. A voicemail greeting counts as reached.</div>
          </div>
        )}
        <label><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> Ask people to confirm they are safe{usesSms || usesEmail ? ' (reply SAFE' : ''}{usesVoice ? `${usesSms || usesEmail ? ', or ' : ' ('}press 1 on a call` : ''}{usesSms || usesEmail || usesVoice ? ')' : ''}</label>
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
            {usesSms && <>
              <div><strong>{audience.will_receive}</strong> of {audience.total} people can be texted.</div>
              {audience.no_consent > 0 && <div>{audience.no_consent} skipped for text: have not agreed to texts yet.</div>}
              {audience.opted_out > 0 && <div>{audience.opted_out} skipped for text: replied STOP.</div>}
            </>}
            {usesEmail && emailAudience && <>
              <div><strong>{emailAudience.will_receive}</strong> of {emailAudience.total} people can be emailed.</div>
              {emailAudience.no_email > 0 && <div>{emailAudience.no_email} skipped for email: no email address on file.</div>}
              {emailAudience.opted_out > 0 && <div>{emailAudience.opted_out} skipped for email: opted out.</div>}
              {emailAudience.bounced > 0 && <div>{emailAudience.bounced} skipped for email: address bounced earlier.</div>}
            </>}
            {usesVoice && voiceAudience && <>
              <div><strong>{voiceAudience.will_receive}</strong> of {voiceAudience.total} people can be called.</div>
              {voiceAudience.no_consent > 0 && <div>{voiceAudience.no_consent} skipped for calls: have not agreed to contact yet.</div>}
              {voiceAudience.opted_out > 0 && <div>{voiceAudience.opted_out} skipped for calls: asked to stop calls.</div>}
            </>}
            {effectiveMode === 'fallback' && <div style={{ fontSize: 13 }}>Each later channel is held and only goes to people whose earlier one fails. People with no usable first channel move on right away.</div>}
          </div>
        )}
        {usesSms && (
          <div>
            <div style={note}>Text message recipients will get</div>
            <div style={box}>{preview || '—'}</div>
            <div style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>{preview.length} characters</div>
          </div>
        )}
        {usesEmail && emailPreview && (
          <div>
            <div style={note}>Email recipients will get</div>
            <div style={box}><strong>Subject: {emailPreview.subject}</strong>{'\n\n'}{emailPreview.text}</div>
          </div>
        )}
        {usesVoice && (
          <div>
            <div style={note}>People who answer a call will hear</div>
            <div style={box}>{voicePreview || '—'}</div>
          </div>
        )}
        {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
        <button className="btn-primary" disabled={!ready} onClick={() => { setConfirmAlert(false); setConfirming(true); }} style={{ opacity: ready ? 1 : 0.5 }}>Review and send</button>
      </div>

      {confirming && (
        <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', padding: 16 }}>
          <div className="card" style={{ maxWidth: 520, width: '100%' }}>
            <h2 style={{ marginTop: 0 }}>{kind === 'alert' ? 'Send a REAL alert?' : `Send this ${kind}?`}</h2>
            <p>This will {order.filter((c) => people[c] > 0).map((c, i, a) => (
              <span key={c}>{i > 0 ? (i === a.length - 1 ? ' and ' : ', ') : ''}{VERB[c]} <strong>{people[c]}</strong> {people[c] === 1 ? 'person' : 'people'}</span>
            ))} right away{effectiveMode === 'fallback' ? ' (each later channel only where the earlier one fails)' : ''}. It cannot be recalled.</p>
            {usesSms && <div style={box}>{preview}</div>}
            {usesEmail && emailPreview && <div style={{ ...box, marginTop: 8 }}><strong>{emailPreview.subject}</strong></div>}
            {usesVoice && <div style={{ ...box, marginTop: 8 }}>{voicePreview}</div>}
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
