import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

interface RosterRow {
  id: string;
  full_name: string;
  branch_of_service: string | null;
  tier1: number;
  tier2: number;
  tier3: number;
  latestSummary: AiSummary | null;
}

interface AiSummary {
  summary: string;
  risk_flag: 'low' | 'elevated' | 'high';
  time_window: '1m' | '3m' | 'all';
  generated_at: string;
}

interface AttentionItem {
  full_name: string;
  risk_flag: 'low' | 'elevated' | 'high';
  reason: string;
}

interface PopulationReport {
  overall_summary: string;
  attention_list: AttentionItem[];
  generated_at: string;
  lookback_days: number;
  roster_size: number;
}

const RISK_COLORS: Record<string, string> = { low: 'var(--tier-1)', elevated: 'var(--tier-2)', high: 'var(--tier-3)' };

export default function ReportsPage() {
  const { staff } = useAuth();
  const [roster, setRoster] = useState<RosterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState<string | null>(null);
  const [populationReport, setPopulationReport] = useState<PopulationReport | null>(null);
  const [generatingPopulation, setGeneratingPopulation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoster = async () => {
    setLoading(true);
    const [{ data: people }, { data: alerts }, { data: summaries }] = await Promise.all([
      supabase.from('enrolled_people').select('id, full_name, branch_of_service').eq('enrolled', true).order('full_name'),
      supabase.from('alerts').select('enrolled_person_id, tier'),
      supabase
        .from('activity_ai_summaries')
        .select('enrolled_person_id, summary, risk_flag, time_window, generated_at')
        .order('generated_at', { ascending: false }),
    ]);

    const rows: RosterRow[] = (people ?? []).map((p) => {
      const personAlerts = (alerts ?? []).filter((a) => a.enrolled_person_id === p.id);
      const latestSummary = (summaries ?? []).find((s) => s.enrolled_person_id === p.id) ?? null;
      return {
        id: p.id,
        full_name: p.full_name,
        branch_of_service: p.branch_of_service,
        tier1: personAlerts.filter((a) => a.tier === 1).length,
        tier2: personAlerts.filter((a) => a.tier === 2).length,
        tier3: personAlerts.filter((a) => a.tier === 3).length,
        latestSummary: latestSummary as AiSummary | null,
      };
    });
    setRoster(rows);
    setLoading(false);
  };

  useEffect(() => {
    loadRoster();
  }, []);

  const generatePersonSummary = async (personId: string) => {
    setError(null);
    setGeneratingId(personId);
    try {
      const res = await fetch('/.netlify/functions/generate-activity-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enrolled_person_id: personId, window: '3m' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate report.');
      await loadRoster();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report.');
    } finally {
      setGeneratingId(null);
    }
  };

  const generatePopulationReport = async () => {
    if (!staff?.organization_id) return;
    setError(null);
    setGeneratingPopulation(true);
    try {
      const res = await fetch('/.netlify/functions/generate-population-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organization_id: staff.organization_id, lookback_days: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to generate triage summary.');
      setPopulationReport(data as PopulationReport);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate triage summary.');
    } finally {
      setGeneratingPopulation(false);
    }
  };

  if (loading) return <p>Loading reports…</p>;

  return (
    <div>
      <h1>Reports</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Roster-wide AI triage plus per-person activity summaries, in one place.
      </p>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}

      <div className="card" style={{ marginTop: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h2 style={{ margin: 0 }}>Who needs attention</h2>
            <p style={{ color: 'var(--brand-gray-600)', fontSize: 13, margin: '4px 0 0' }}>
              AI-generated triage across the whole roster, last 30 days. Regenerated on demand — not a stored record.
            </p>
          </div>
          <button className="btn-primary" onClick={generatePopulationReport} disabled={generatingPopulation}>
            {generatingPopulation ? 'Analyzing…' : populationReport ? 'Refresh' : 'Analyze roster'}
          </button>
        </div>

        {populationReport && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 12, color: 'var(--brand-gray-600)' }}>
              {populationReport.roster_size} enrolled · generated {new Date(populationReport.generated_at).toLocaleString()}
            </p>
            <p>{populationReport.overall_summary}</p>
            {populationReport.attention_list.length === 0 ? (
              <p style={{ color: 'var(--brand-gray-600)' }}>No one flagged for attention this period.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                {populationReport.attention_list.map((item, i) => (
                  <div key={i} style={{ border: '1px solid var(--brand-gray-300)', borderRadius: 8, padding: 12 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontWeight: 700 }}>{item.full_name}</span>
                      <span style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', color: RISK_COLORS[item.risk_flag] }}>
                        {item.risk_flag} risk
                      </span>
                    </div>
                    <p style={{ margin: '4px 0 0', fontSize: 14 }}>{item.reason}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 30 }}>Per-person summaries</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 8 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
            <th style={{ padding: 10 }}>Name</th>
            <th style={{ padding: 10 }}>Branch</th>
            <th style={{ padding: 10 }}>T1 / T2 / T3</th>
            <th style={{ padding: 10 }}>Latest AI summary</th>
            <th style={{ padding: 10 }}></th>
          </tr>
        </thead>
        <tbody>
          {roster.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
              <td style={{ padding: 10, fontWeight: 600 }}>{p.full_name}</td>
              <td style={{ padding: 10 }}>{p.branch_of_service ?? '—'}</td>
              <td style={{ padding: 10 }}>
                <span className="tier-badge tier-1" style={{ marginRight: 4 }}>{p.tier1}</span>
                <span className="tier-badge tier-2" style={{ marginRight: 4 }}>{p.tier2}</span>
                <span className="tier-badge tier-3">{p.tier3}</span>
              </td>
              <td style={{ padding: 10, maxWidth: 360 }}>
                {p.latestSummary ? (
                  <>
                    <span style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', color: RISK_COLORS[p.latestSummary.risk_flag] }}>
                      {p.latestSummary.risk_flag}
                    </span>
                    <span style={{ marginLeft: 8, fontSize: 13 }}>{p.latestSummary.summary}</span>
                  </>
                ) : (
                  <span style={{ color: 'var(--brand-gray-600)', fontSize: 13 }}>Not generated yet</span>
                )}
              </td>
              <td style={{ padding: 10 }}>
                <button
                  className="btn-primary"
                  disabled={generatingId === p.id}
                  onClick={() => generatePersonSummary(p.id)}
                  style={{ fontSize: 12, padding: '6px 10px' }}
                >
                  {generatingId === p.id ? 'Generating…' : p.latestSummary ? 'Refresh' : 'Generate'}
                </button>
              </td>
            </tr>
          ))}
          {roster.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>
                No one enrolled yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
