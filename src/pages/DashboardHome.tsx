import { useEffect, useState, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

// Wraps a stat card in a Link to the filtered Alert History view. Cards for non-alert
// stats (e.g. enrolled veterans) should keep using a plain div — only pass `to` when
// there's a matching alerts filter to land on.
function StatCard({ to, children }: { to?: string; children: ReactNode }) {
  if (!to) {
    return <div className="card" style={{ flex: 1 }}>{children}</div>;
  }
  return (
    <Link
      to={to}
      className="card"
      style={{ flex: 1, display: 'block', textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}
    >
      {children}
    </Link>
  );
}

export default function DashboardHome() {
  const { staff } = useAuth();
  const [counts, setCounts] = useState({
    open: 0,
    tier3Open: 0,
    enrolled: 0,
    total: 0,
    tier1Total: 0,
    tier2Total: 0,
    tier3Total: 0,
  });

  useEffect(() => {
    (async () => {
      const [
        { count: open },
        { count: tier3Open },
        { count: enrolled },
        { count: total },
        { count: tier1Total },
        { count: tier2Total },
        { count: tier3Total },
      ] = await Promise.all([
        supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('status', 'open').eq('tier', 3),
        supabase.from('enrolled_people').select('*', { count: 'exact', head: true }).eq('enrolled', true),
        supabase.from('alerts').select('*', { count: 'exact', head: true }),
        supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('tier', 1),
        supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('tier', 2),
        supabase.from('alerts').select('*', { count: 'exact', head: true }).eq('tier', 3),
      ]);
      setCounts({
        open: open ?? 0,
        tier3Open: tier3Open ?? 0,
        enrolled: enrolled ?? 0,
        total: total ?? 0,
        tier1Total: tier1Total ?? 0,
        tier2Total: tier2Total ?? 0,
        tier3Total: tier3Total ?? 0,
      });
    })();
  }, []);

  return (
    <div>
      <h1>Welcome{staff?.full_name ? `, ${staff.full_name}` : ''}</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>VetSupport Group dashboard</p>

      <p style={{ marginTop: 24, marginBottom: 8, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--brand-gray-600)' }}>
        Needs attention now
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        <StatCard to="/alerts?status=open">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Open alerts</div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.open}</div>
        </StatCard>
        <StatCard to="/alerts?tier=3&status=open">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Active crisis (tier 3, open)</div>
          <div style={{ fontSize: 32, fontWeight: 700, color: 'var(--tier-3)' }}>{counts.tier3Open}</div>
        </StatCard>
        <StatCard to="/veterans">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Enrolled veterans/supporters</div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.enrolled}</div>
        </StatCard>
      </div>

      <p style={{ marginTop: 24, marginBottom: 8, fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--brand-gray-600)' }}>
        All-time alert population
      </p>
      <div style={{ display: 'flex', gap: 16 }}>
        <StatCard to="/alerts">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Total alerts</div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.total}</div>
        </StatCard>
        <StatCard to="/alerts?tier=1">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>
            <span className="tier-badge tier-1">Tier 1</span>
          </div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.tier1Total}</div>
        </StatCard>
        <StatCard to="/alerts?tier=2">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>
            <span className="tier-badge tier-2">Tier 2</span>
          </div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.tier2Total}</div>
        </StatCard>
        <StatCard to="/alerts?tier=3">
          <div style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>
            <span className="tier-badge tier-3">Tier 3</span>
          </div>
          <div style={{ fontSize: 32, fontWeight: 700 }}>{counts.tier3Total}</div>
        </StatCard>
      </div>
      <p style={{ marginTop: 10, fontSize: 13 }}>
        <a href="/alerts" style={{ color: 'var(--brand-teal)', fontWeight: 600 }}>View full alert history by tier and month →</a>
      </p>
    </div>
  );
}
