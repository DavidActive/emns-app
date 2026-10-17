import { useEffect, useState } from 'react';
import { useAuth } from '../lib/AuthContext';
import { callFunction } from '../lib/api';

interface Me { full_name: string | null; mobile_phone: string; email: string | null; consent_status: string; voice_consent_status?: string }
interface Device { id: string; device_name: string; platform: string; enrolled_at: string; last_seen_at: string | null }
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
  const [devices, setDevices] = useState<Device[]>([]);
  const [code, setCode] = useState<{ value: string; minutes: number } | null>(null);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);

  const apply = (r: Res) => { setMe(r.person); setMobile(r.person.mobile_phone); setEmail(r.person.email ?? ''); };
  useEffect(() => {
    callFunction<Res>('my-contact', { action: 'get' }).then((r) => { setOrg(r.organization); apply(r); }).catch((e) => setError((e as Error).message));
  }, []);

  const loadDevices = () => callFunction<{ devices: Device[] }>('agent-pair', { action: 'list' }).then((r) => setDevices(r.devices)).catch(() => setDevices([]));
  useEffect(() => { loadDevices(); }, []);
  const makeCode = async () => {
    setAgentMsg(null);
    try { const r = await callFunction<{ code: string; expires_in_seconds: number }>('agent-pair', { action: 'create_code' }); setCode({ value: r.code, minutes: Math.round(r.expires_in_seconds / 60) }); }
    catch (err) { setAgentMsg((err as Error).message); }
  };
  const removeDevice = async (id: string) => {
    setAgentMsg(null);
    try { await callFunction('agent-pair', { action: 'revoke', device_id: id }); await loadDevices(); setAgentMsg('That computer will no longer receive alerts.'); }
    catch (err) { setAgentMsg((err as Error).message); }
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null); setMsg(null);
    try {
      const r = await callFunction<Res>('my-contact', { action: 'update', mobile_phone: mobile, email });
      apply(r);
      setMsg(!r.changed || r.changed.length === 0 ? 'Nothing changed.'
        : r.consent_reset ? 'Saved. Because your mobile number changed, you will need to agree to text alerts (and voice calls, if you had agreed) again. Your organization will send you a new sign-up link.'
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
              Voice calls: {me.voice_consent_status === 'consented' ? 'you have agreed' : me.voice_consent_status === 'withdrawn' ? 'you have opted out' : 'not agreed yet'}.
              If you change your mobile number you will need to agree to text alerts and voice calls again for the new number.
            </p>
            {msg && <p role="status" style={{ color: 'var(--tier-1)' }}>{msg}</p>}
            <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </form>
        )}
        {me && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--brand-gray-300)' }}>
            <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>Desktop alerts</h2>
            <p style={{ fontSize: 13, color: 'var(--brand-gray-600)', marginTop: 0 }}>
              Install the Active SOS eMNS desktop app on your work computer (your IT team can deploy it), open it, and enter a pairing code from here. Alerts then appear on that computer even if no browser is open.
            </p>
            {code && (
              <div role="status" style={{ textAlign: 'center', margin: '8px 0 12px' }}>
                <div style={{ fontSize: 28, letterSpacing: 3, fontWeight: 700, fontFamily: 'monospace' }}>{code.value}</div>
                <div style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>Enter this in the desktop app within {code.minutes} minutes. It works once.</div>
                <div style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>Server address: <strong>{window.location.origin}</strong></div>
              </div>
            )}
            <button type="button" onClick={makeCode} style={{ width: '100%' }}>{code ? 'Get a new code' : 'Get a pairing code'}</button>
            {devices.length > 0 && (
              <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0' }}>
                {devices.map((d) => (
                  <li key={d.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 14 }}>
                    <span><strong>{d.device_name}</strong><br /><span style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>{d.last_seen_at ? `Last seen ${new Date(d.last_seen_at).toLocaleString()}` : 'Not seen yet'}</span></span>
                    <button type="button" onClick={() => removeDevice(d.id)}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            {agentMsg && <p role="status" style={{ fontSize: 13 }}>{agentMsg}</p>}
          </div>
        )}
        <button onClick={signOut} style={{ width: '100%', marginTop: 10 }}>Sign out</button>
      </div>
    </div>
  );
}
