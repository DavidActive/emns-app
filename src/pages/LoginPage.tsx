import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

export default function LoginPage() {
  const { session } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'signIn' | 'reset'>('signIn');
  const [resetSent, setResetSent] = useState(false);

  if (session) return <Navigate to="/" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (signInError) setError(signInError.message);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/set-password`,
    });
    setBusy(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setResetSent(true);
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--brand-navy)',
      }}
    >
      <form
        onSubmit={mode === 'signIn' ? handleSubmit : handleReset}
        className="card"
        style={{ width: 440, textAlign: 'center' }}
      >
        <img src="/logo.svg" alt="" width={88} height={88} style={{ display: 'block', margin: '0 auto 8px' }} />
        <h1 style={{ fontSize: 24, margin: '4px 0 0' }}>eMNS</h1>
        <div style={{ fontSize: 14, color: 'var(--brand-gray-600)', margin: '2px 0 4px' }}>Emergency Mass Notification</div>
        <p style={{ color: 'var(--brand-gray-600)', fontSize: 13, marginBottom: 20 }}>
          {mode === 'signIn' ? 'Staff & peer-support sign in' : 'Reset your password'}
        </p>

        {mode === 'reset' && resetSent ? (
          <p style={{ fontSize: 13, marginBottom: 14 }}>
            If an account exists for <strong>{email}</strong>, a password reset link has been sent. Check your
            email and follow the link to set a new password.
          </p>
        ) : (
          <>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={{ width: '100%', padding: 10, marginBottom: 10, borderRadius: 6, border: '1px solid var(--brand-gray-300)' }}
            />
            {mode === 'signIn' && (
              <input
                type="password"
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                style={{ width: '100%', padding: 10, marginBottom: 14, borderRadius: 6, border: '1px solid var(--brand-gray-300)' }}
              />
            )}
            {error && <p style={{ color: 'var(--tier-3)', fontSize: 13 }}>{error}</p>}
            <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={busy}>
              {mode === 'signIn'
                ? busy
                  ? 'Signing in…'
                  : 'Sign in'
                : busy
                  ? 'Sending link…'
                  : 'Send reset link'}
            </button>
          </>
        )}

        <p style={{ marginTop: 14, fontSize: 13 }}>
          {mode === 'signIn' ? (
            <button
              type="button"
              onClick={() => {
                setMode('reset');
                setError(null);
              }}
              style={{ background: 'none', border: 'none', color: 'var(--brand-navy)', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
            >
              Forgot password?
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setMode('signIn');
                setError(null);
                setResetSent(false);
              }}
              style={{ background: 'none', border: 'none', color: 'var(--brand-navy)', textDecoration: 'underline', cursor: 'pointer', padding: 0 }}
            >
              Back to sign in
            </button>
          )}
        </p>
      </form>
    </div>
  );
}
