import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

type Info =
  | { status: 'loading' }
  | { status: 'invalid' | 'used' | 'expired' }
  | { status: 'valid'; org_name: string; first_name: string | null; phone_last4: string | null; already_consented: boolean; opted_out: boolean;
      consent_text: string; text_version: string; links: { privacy: string; terms: string; consent: string } };

const wrap: React.CSSProperties = { maxWidth: 560, margin: '40px auto', padding: '0 16px' };

export default function EnrollPage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<Info>({ status: 'loading' });
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | { org_name: string; opted_out: boolean; confirmation: string }>(null);

  useEffect(() => {
    fetch(`/.netlify/functions/enroll?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((j) => setInfo(j))
      .catch(() => setError('Could not load this page. Please check your connection and try again.'));
  }, [token]);

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const res = await fetch('/.netlify/functions/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      const j = await res.json();
      if (j.ok) setDone(j);
      else if (j.reason) setInfo({ status: j.reason });
      else setError(j.error || 'Something went wrong. Please try again.');
    } catch { setError('Something went wrong. Please try again.'); }
    setBusy(false);
  };

  const v = info.status === 'valid' ? info : null;
  let content: JSX.Element;
  if (error && info.status === 'loading') content = <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>;
  else if (info.status === 'loading') content = <p>Loading…</p>;
  else if (done) {
    content = (
      <>
        <h1>You're enrolled</h1>
        <p>You will receive emergency alerts, drill and test notices, and safety check-in texts from <strong>{done.org_name}</strong>.</p>
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
  else if (v && v.already_consented && !v.opted_out) {
    content = <><h1>You're already enrolled</h1><p>You are already set up to receive alerts from <strong>{v.org_name}</strong>. Nothing more to do.</p></>;
  } else if (v) {
    content = (
      <>
        <h1>Text alert enrollment</h1>
        <p>
          {v.first_name ? `Hi ${v.first_name}. ` : ''}<strong>{v.org_name}</strong> uses Active SOS eMNS to send emergency alerts to your mobile phone
          {v.phone_last4 ? <> ending in <strong>{v.phone_last4}</strong></> : null}.
        </p>
        {v.opted_out && (
          <p style={{ background: '#fff4e5', padding: 10, borderRadius: 6 }}>
            You previously replied STOP. After you enroll here, also reply <strong>START</strong> to the number that texts you to turn texts back on.
          </p>
        )}
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: '18px 0', lineHeight: 1.45 }}>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ marginTop: 4, width: 20, height: 20 }} />
          <span>{v.consent_text}</span>
        </label>
        <p style={{ fontSize: 14 }}>
          <a href={v.links.privacy} target="_blank" rel="noreferrer">Privacy Policy</a> · <a href={v.links.terms} target="_blank" rel="noreferrer">SMS Terms</a> · <a href={v.links.consent} target="_blank" rel="noreferrer">About this consent</a>
        </p>
        {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
        <button className="btn-primary" disabled={!agreed || busy} onClick={submit} style={{ opacity: agreed && !busy ? 1 : 0.5 }}>
          {busy ? 'Saving…' : 'Yes, text me alerts'}
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
