import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { callFunction } from '../lib/api';

interface Me { full_name: string | null; mobile_phone: string; email: string | null; consent_status: string }
interface Res { organization: string | null; person: Me; changed?: string[]; consent_reset?: boolean }

// Employee self-service: your own mobile number and email, nothing else.
export default function MyContactPage() {
  const { signOut } = useAuth();
  const [org, setOrg] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apply = (r: Res) => { setMe(r.person); setMobile(r.person.mobile_phone); setEmail(r.person.email ?? ''); };
  useEffect(() => {
    callFunction<Res>('my-contact', { action: 'get' }).then((r) => { setOrg(r.organization); apply(r); }).catch((e) => setError((e as Error).message));
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setMsg(null);
    try {
      const r = await callFunction<Res>('my-contact', { action: 'update', mobile_phone: mobile, email });
      apply(r);
      setMsg(!r.changed || r.changed.length === 0 ? 'Nothing changed.'
        : r.consent_reset ? 'Saved. Because your mobile number changed, you will need to agree to text alerts again. Your organization will send you a new sign-up link.'
        : 'Saved.');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const input = { width: '100%', padding: 10, marginBottom: 12, borderRadius: 6, border: '1px solid var(--brand-gray-300)' } as const;
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--brand-navy)', padding: 16 }}>
      <div className="card" style={{ width: 400, maxWidth: '100%' }}>
        <img src="/logo.svg" alt="" width={56} height={56} style={{ display: 'block', margin: '0 auto 6px' }} />
        <h1 style={{ fontSize: 20, textAlign: 'center', margin: '0 0 4px' }}>My contact details</h1>
        {org && <div style={{ textAlign: 'center', fontSize: 13, color: 'var(--brand-gray-600)', marginBottom: 12 }}>{org}</div>}
        {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
        {me && (
          <form onSubmit={save}>
            <div style={{ marginBottom: 12 }}><strong>{me.full_name ?? 'Employee'}</strong></div>
            <label>Mobile number<input value={mobile} onChange={(e) => setMobile(e.target.value)} inputMode="tel" autoComplete="tel" style={input} /></label>
            <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="email" style={input} /></label>
            <p style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>
              Text alerts: {me.consent_status === 'consented' ? 'you have agreed' : me.consent_status === 'withdrawn' ? 'you have opted out' : 'not agreed yet'}.
              If you change your mobile number you will need to agree to text alerts again for the new number.
            </p>
            {msg && <p role="status" style={{ color: 'var(--tier-1)' }}>{msg}</p>}
            <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </form>
        )}
        <button onClick={signOut} style={{ width: '100%', marginTop: 10 }}>Sign out</button>
      </div>
    </div>
  );
}
