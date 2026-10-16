import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

export default function SetPasswordPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // supabase-js parses the invite/recovery token out of the URL hash automatically
    // (detectSessionInUrl defaults to true) and fires SIGNED_IN once it's done.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if ((event === 'SIGNED_IN' || event === 'PASSWORD_RECOVERY') && session) {
        setReady(true);
      }
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    navigate('/', { replace: true });
  };

  if (!ready) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--brand-navy)' }}>
        <div className="card" style={{ width: 340, textAlign: 'center' }}>
          <p>Verifying your invite link…</p>
          <p style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>
            If this link has expired, ask an admin to send a new invite.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--brand-navy)' }}>
      <form onSubmit={handleSubmit} className="card" style={{ width: 340, textAlign: 'center' }}>
        <img src="/logo.svg" alt="" width={72} height={72} style={{ display: 'block', margin: '0 auto 6px' }} />
        <strong style={{ fontSize: 20 }}>eMNS</strong>
        <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Emergency Mass Notification</div>
        <h1 style={{ fontSize: 20, margin: '12px 0 4px' }}>Set your password</h1>
        <input
          type="password"
          placeholder="New password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ width: '100%', padding: 10, marginBottom: 10, borderRadius: 6, border: '1px solid var(--brand-gray-300)' }}
        />
        <input
          type="password"
          placeholder="Confirm password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          style={{ width: '100%', padding: 10, marginBottom: 14, borderRadius: 6, border: '1px solid var(--brand-gray-300)' }}
        />
        {error && <p style={{ color: 'var(--tier-3)', fontSize: 13 }}>{error}</p>}
        <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Saving…' : 'Set password & continue'}
        </button>
      </form>
    </div>
  );
}
