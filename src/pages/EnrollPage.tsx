import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

type Info =
  | { status: 'loading' }
  | { status: 'invalid' | 'used' | 'expired' }
  | { status: 'valid'; org_name: string; first_name: string | null; phone_last4: string | null; already_consented: boolean; opted_out: boolean;
      consent_text: string; text_version: string; links: { privacy: string; terms: string; consent: string };
      voice_consented: boolean; voice_opted_out: boolean; voice_consent_text: string; voice_text_version: string };

const wrap: React.CSSProperties = { maxWidth: 560, margin: '40px auto', padding: '0 16px' };

export default function EnrollPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<Info>({ status: 'loading' });
  const [agreed, setAgreed] = useState(false);
  const [agreedVoice, setAgreedVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { org_name: string; opted_out: boolean; confirmation: string; voice: boolean }>(null);

  useEffect(() => {
    fetch(`/.netlify/functions/enroll?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((j) => setInfo(j))
      .catch(() => setError('Could not load this page. Please check your connection and try again.'));
  }, [token]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      // Each box is its own choice. Text consent is never required for calls and calls are never required for texts.
      const body = JSON.stringify({ token, text: showText && agreed, voice: showVoice && agreedVoice });
      const res = await fetch('/.netlify/functions/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      const j = await res.json();
      if (j.ok) setDone(j);
      else if (j.reason) setInfo({ status: j.reason });
      else setError(j.error || 'Something went wrong. Please try again.');
    } catch { setError('Something went wrong. Please try again.'); }
    setBusy(false);
  };

  const v = info.status === 'valid' ? info : null;
  const showText = !!v && !(v.already_consented && !v.opted_out);
  const showVoice = !!v && !v.voice_consented;
  const canSave = (showText && agreed) || (showVoice && agreedVoice);
  let content: JSX.Element;
  if (error && info.status === 'loading') content = <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>;
  else if (info.status === 'loading') content = <p>Loading…</p>;
  else if (done) {
    content = (
      <>
        <h1>Your choices are saved</h1>
        {done.confirmation !== 'not_needed' || !done.voice ? (
          <p>You will receive emergency alerts, drill and test notices, and safety check-in texts from <strong>{done.org_name}</strong>.</p>
        ) : null}
        {done.voice && <p>You also agreed to automated voice calls from <strong>{done.org_name}</strong>. Press 9 on any call to stop calls.</p>}
        {done.opted_out ? (
          <p>You previously replied STOP to this number. To start receiving texts, reply <strong>START</strong> to the number that texted you.</p>
        ) : done.confirmation === 'sent' ? (
          <p>We just sent you a confirmation text. Reply <strong>STOP</strong> at any time to opt out and <strong>HELP</strong> for help.</p>
        ) : (
          <p>Reply <strong>STOP</strong> to any message to opt out and <strong>HELP</strong> for help.</p>
        )}
      </>
    );
  } else if (info.status === 'invalid') content = <><h1>Link not recognized</h1><p>This enrollment link is not valid. Please ask your organization for a new one.</p></>;
  else if (info.status === 'used') content = <><h1>Link already used</h1><p>This link has already been used. If you are enrolled you do not need to do anything else. Otherwise ask your organization for a new link.</p></>;
  else if (info.status === 'expired') content = <><h1>Link expired</h1><p>This link has expired. Please ask your organization for a new one.</p></>;
  else if (v && !showText && !showVoice) {
    content = <><h1>You're already enrolled</h1><p>You are already set up to receive alerts from <strong>{v.org_name}</strong>. Nothing more to do.</p></>;
  } else if (v) {
    content = (
      <>
        <h1>{showText && showVoice ? 'Alert enrollment' : showVoice ? 'Voice call enrollment' : 'Text alert enrollment'}</h1>
        <p>
          {v.first_name ? `Hi ${v.first_name}. ` : ''}<strong>{v.org_name}</strong> uses Active SOS eMNS to send emergency alerts to your mobile phone
          {v.phone_last4 ? <> ending in <strong>{v.phone_last4}</strong></> : null}.
        </p>
        {v.opted_out && (
          <p style={{ background: '#fff4e5', padding: 10, borderRadius: 6 }}>
            You previously replied STOP. After you enroll here, also reply <strong>START</strong> to the number that texts you to turn texts back on.
          </p>
        )}
        {showText && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '18px 0', lineHeight: 1.45 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 4, width: 20, height: 20 }} />
            <span>{v.consent_text}</span>
          </label>
        )}
        {showVoice && (
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '18px 0', lineHeight: 1.45 }}>
            <input type="checkbox" checked={agreedVoice} onChange={(e) => setAgreedVoice(e.target.checked)} style={{ marginTop: 4, width: 20, height: 20 }} />
            <span>{v.voice_consent_text}</span>
          </label>
        )}
        <p style={{ fontSize: 14 }}>
          <a href={v.links.privacy} target="_blank" rel="noreferrer">Privacy Policy</a> · <a href={v.links.terms} target="_blank" rel="noreferrer">SMS Terms</a> · <a href={v.links.consent} target="_blank" rel="noreferrer">About this consent</a>
        </p>
        {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
        <button className="btn-primary" disabled={!canSave || busy} onClick={submit} style={{ opacity: canSave && !busy ? 1 : 0.5 }}>
          {busy ? 'Saving…' : showVoice ? 'Save my choices' : 'Yes, text me alerts'}
        </button>
      </>
    );
  } else content = <p>Loading…</p>;

  return (
    <div style={wrap}>
      <div className="card">
        <div style={{ fontWeight: 800, color: 'var(--brand-navy)', marginBottom: 8 }}>Active SOS eMNS</div>
        {content}
      </div>
    </div>
  );
}
