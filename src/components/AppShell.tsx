import { useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { canDrill } from '../lib/permissions';

const navItemStyle = ({ isActive }: { isActive: boolean }) => ({
  display: 'block',
  padding: '10px 16px',
  borderRadius: 6,
  color: isActive ? 'var(--brand-teal)' : 'white',
  background: isActive ? 'rgba(255,255,255,0.08)' : 'transparent',
  textDecoration: 'none',
  fontWeight: 600,
  fontSize: 14,
});

export default function AppShell() {
  const { staff, signOut } = useAuth();
  const [twilioNumber, setTwilioNumber] = useState<string | null>(null);

  useEffect(() => {
    if (!staff?.organization_id) return;
    supabase
      .from('organizations')
      .select('twilio_number')
      .eq('id', staff.organization_id)
      .maybeSingle()
      .then(({ data }) => setTwilioNumber(data?.twilio_number ?? null));
  }, [staff]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside className="no-print" style={{ width: 320, background: 'var(--brand-navy)', padding: 20, color: 'white' }}>
        <div style={{ textAlign: 'center', margin: '0 0 20px' }}>
          <img src="/logo.svg" alt="" width={96} height={96} style={{ display: 'block', margin: '0 auto 8px' }} />
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1 }}>eMNS</div>
          <div style={{ fontSize: 13, color: 'var(--brand-teal-light)', marginTop: 4 }}>Emergency Mass Notification</div>
        </div>
        {twilioNumber && (
          <div
            style={{
              textAlign: 'center',
              marginBottom: 20,
              padding: '8px 12px',
              background: 'rgba(255,255,255,0.08)',
              borderRadius: 6,
              fontSize: 13,
            }}
          >
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--brand-teal-light)', marginBottom: 2 }}>
              Text this number
            </div>
            <div style={{ fontWeight: 700 }}>{twilioNumber}</div>
          </div>
        )}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NavLink to="/" end style={navItemStyle}>Dashboard</NavLink>
          <NavLink to="/inbox" style={navItemStyle}>Inbox</NavLink>
          <NavLink to="/history" style={navItemStyle}>Inbox History</NavLink>
          {canDrill(staff) && <NavLink to="/send" style={navItemStyle}>Send</NavLink>}
          <NavLink to="/scenarios" style={navItemStyle}>Scenarios</NavLink>
          <NavLink to="/events" style={navItemStyle}>Sent Events</NavLink>
          <NavLink to="/people" style={navItemStyle}>People</NavLink>
          <NavLink to="/groups" style={navItemStyle}>Groups</NavLink>
          <NavLink to="/settings" style={navItemStyle}>Org Settings</NavLink>
          {staff?.is_platform_admin && (
            <NavLink to="/admin/users" style={navItemStyle}>Platform Admin</NavLink>
          )}
        </nav>
        <button
          onClick={signOut}
          style={{ marginTop: 30, background: 'transparent', color: 'white', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 6, padding: '8px 12px', cursor: 'pointer', width: '100%' }}
        >
          Sign out
        </button>
      </aside>
      <main style={{ flex: 1, padding: 30 }}>
        <Outlet />
      </main>
    </div>
  );
}
