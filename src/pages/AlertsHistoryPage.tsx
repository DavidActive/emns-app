import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

interface AlertRow {
  id: string;
  tier: 1 | 2 | 3;
  status: string;
  alert_type: string;
  message_body: string | null;
  gps_url: string | null;
  created_at: string;
  enrolled_person_id: string | null;
  // See TriageInbox.tsx for why this is typed loosely and normalized below.
  enrolled_people: unknown;
}

function getPerson(row: AlertRow): { full_name: string | null; phone_number: string | null } | null {
  const raw = row.enrolled_people;
  if (!raw) return null;
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw as { full_name: string | null; phone_number: string | null });
}

function monthKey(iso: string) {
  return iso.slice(0, 7); // YYYY-MM
}

function monthLabel(key: string) {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

const TIER_LABELS: Record<'all' | 1 | 2 | 3, string> = {
  all: 'All Tiers',
  1: 'Tier 1 — Routine',
  2: 'Tier 2 — Elevated',
  3: 'Tier 3 — Crisis',
};

function parseTierParam(value: string | null): 'all' | 1 | 2 | 3 {
  if (value === '1' || value === '2' || value === '3') return Number(value) as 1 | 2 | 3;
  return 'all';
}

function parseStatusParam(value: string | null): 'all' | 'open' | 'acknowledged' | 'resolved' {
  if (value === 'open' || value === 'acknowledged' || value === 'resolved') return value;
  return 'all';
}

export default function AlertsHistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [alerts, setAlerts] = useState<AlertRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Dashboard "needs attention" cards link here with ?tier= and ?status= — honor them on load,
  // then keep the URL in sync as the user changes filters so the link stays shareable/bookmarkable.
  const [tierFilter, setTierFilter] = useState<'all' | 1 | 2 | 3>(() => parseTierParam(searchParams.get('tier')));
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'acknowledged' | 'resolved'>(() =>
    parseStatusParam(searchParams.get('status'))
  );
  const [monthFilter, setMonthFilter] = useState<'all' | string>('all');

  useEffect(() => {
    const next: Record<string, string> = {};
    if (tierFilter !== 'all') next.tier = String(tierFilter);
    if (statusFilter !== 'all') next.status = statusFilter;
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tierFilter, statusFilter]);

  const load = () => {
    setLoading(true);
    return supabase
      .from('alerts')
      .select(
        'id, tier, status, alert_type, message_body, gps_url, created_at, enrolled_person_id, enrolled_people ( full_name, phone_number )'
      )
      .order('created_at', { ascending: false })
      .then(({ data }) => {
        setAlerts((data as AlertRow[]) ?? []);
        setLoading(false);
      });
  };

  useEffect(() => {
    load();
  }, []);

  const remove = async (id: string) => {
    if (!window.confirm('Permanently remove this alert and its message history? This cannot be undone.')) return;
    // alert_messages and escalation_log rows cascade-delete automatically (FK ON DELETE CASCADE).
    await supabase.from('alerts').delete().eq('id', id);
    load();
  };

  const months = useMemo(() => {
    const keys = new Set(alerts.map((a) => monthKey(a.created_at)));
    return Array.from(keys).sort().reverse();
  }, [alerts]);

  const tierCounts = useMemo(() => {
    const counts: Record<1 | 2 | 3, number> = { 1: 0, 2: 0, 3: 0 };
    for (const a of alerts) {
      if (monthFilter === 'all' || monthKey(a.created_at) === monthFilter) counts[a.tier]++;
    }
    return counts;
  }, [alerts, monthFilter]);

  const filtered = useMemo(() => {
    return alerts.filter((a) => {
      if (tierFilter !== 'all' && a.tier !== tierFilter) return false;
      if (statusFilter !== 'all' && a.status !== statusFilter) return false;
      if (monthFilter !== 'all' && monthKey(a.created_at) !== monthFilter) return false;
      return true;
    });
  }, [alerts, tierFilter, statusFilter, monthFilter]);

  if (loading) return <p>Loading alert history…</p>;

  return (
    <div>
      <h1>Alert History</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Every alert ever received (open, acknowledged, or resolved) — filter by tier and by month to see
        trends over time. For AI-generated summaries and roster-wide triage, see the Reports page instead.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 20, flexWrap: 'wrap' }}>
        {(['all', 1, 2, 3] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTierFilter(t)}
            style={{
              padding: '8px 16px',
              borderRadius: 999,
              border: tierFilter === t ? '2px solid var(--brand-navy)' : '1px solid var(--brand-gray-300)',
              background: tierFilter === t ? 'var(--brand-teal-light)' : 'white',
              fontWeight: 700,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {TIER_LABELS[t]}
            {t !== 'all' && <span style={{ marginLeft: 6, opacity: 0.7 }}>({tierCounts[t]})</span>}
          </button>
        ))}

        <select
          value={monthFilter}
          onChange={(e) => setMonthFilter(e.target.value)}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--brand-gray-300)', fontWeight: 600, fontSize: 13 }}
        >
          <option value="all">All Months</option>
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>

        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'open' | 'acknowledged' | 'resolved')}
          style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--brand-gray-300)', fontWeight: 600, fontSize: 13 }}
        >
          <option value="all">All Statuses</option>
          <option value="open">Open</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="resolved">Resolved</option>
        </select>
      </div>

      <p style={{ marginTop: 12, fontSize: 13, color: 'var(--brand-gray-600)' }}>
        Showing {filtered.length} of {alerts.length} total alerts
        {monthFilter !== 'all' ? ` in ${monthLabel(monthFilter)}` : ''}
        {statusFilter !== 'all' ? ` (status: ${statusFilter})` : ''}.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 16 }}>
        {filtered.map((a) => {
          const person = getPerson(a);
          const name = person?.full_name && person.full_name !== 'Unknown' ? person.full_name : null;
          const phone = person?.phone_number ?? null;
          const primaryLabel = name ?? phone ?? 'Unknown sender';
          return (
            <div key={a.id} className="card" style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <span className={`tier-badge tier-${a.tier}`}>Tier {a.tier}</span>
                  <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--brand-gray-600)' }}>
                    {a.alert_type} · {new Date(a.created_at).toLocaleString()}
                  </span>
                </div>
                <span style={{ fontSize: 12, textTransform: 'uppercase', fontWeight: 700, color: 'var(--brand-gray-600)' }}>
                  {a.status}
                </span>
              </div>
              <div style={{ marginTop: 8 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>{primaryLabel}</span>
                {name && phone && <span style={{ marginLeft: 8, color: 'var(--brand-gray-600)', fontSize: 13 }}>{phone}</span>}
              </div>
              <p style={{ marginTop: 6, marginBottom: a.gps_url ? 4 : 0 }}>{a.message_body}</p>
              {a.gps_url && (
                <a href={a.gps_url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--brand-teal)', fontSize: 13, fontWeight: 600 }}>
                  📍 View location
                </a>
              )}
              <div style={{ display: 'flex', marginTop: 10 }}>
                <button
                  onClick={() => remove(a.id)}
                  title="Permanently delete this alert"
                  style={{ background: 'transparent', border: '1px solid var(--tier-3)', color: 'var(--tier-3)', borderRadius: 6, padding: '8px 14px', fontWeight: 600, cursor: 'pointer', marginLeft: 'auto', fontSize: 13 }}
                >
                  🗑 Remove
                </button>
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && <p style={{ color: 'var(--brand-gray-600)' }}>No alerts match this filter.</p>}
      </div>
    </div>
  );
}
