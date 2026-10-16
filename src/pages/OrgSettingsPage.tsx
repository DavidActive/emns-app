import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import TemplatesManager from '../components/TemplatesManager';

interface Org {
  id: string;
  name: string;
  slug: string;
  twilio_number: string | null;
  settings: { drill_tag?: string; test_tag?: string } | null;
}

interface TierRule {
  id: string;
  keyword: string;
  tier: 1 | 2 | 3;
  notes: string | null;
}

const TIER_LABELS: Record<number, string> = { 3: 'Tier 3 · Critical', 1: 'Tier 1 · Safe check-in' };

export default function OrgSettingsPage() {
  const { staff } = useAuth();
  const [org, setOrg] = useState<Org | null>(null);
  const [rules, setRules] = useState<TierRule[]>([]);
  const [newKeyword, setNewKeyword] = useState('');
  const [newTier, setNewTier] = useState<1 | 3>(3);
  const [saving, setSaving] = useState(false);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [drillTag, setDrillTag] = useState('DRILL');
  const [testTag, setTestTag] = useState('TEST');
  const [tagMsg, setTagMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!staff?.organization_id) return;
    supabase
      .from('organizations')
      .select('id, name, slug, twilio_number, settings')
      .eq('id', staff.organization_id)
      .maybeSingle()
      .then(({ data }) => {
        const o = data as Org | null;
        setOrg(o);
        setDrillTag(o?.settings?.drill_tag ?? 'DRILL');
        setTestTag(o?.settings?.test_tag ?? 'TEST');
      });
    loadRules(staff.organization_id);
  }, [staff]);

  const loadRules = async (orgId: string) => {
    const { data } = await supabase
      .from('priority_rules')
      .select('id, keyword, tier, notes')
      .eq('organization_id', orgId)
      .order('tier', { ascending: false })
      .order('keyword');
    setRules((data as TierRule[]) ?? []);
  };

  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org || !newKeyword.trim()) return;
    setSaving(true);
    setRuleError(null);
    const { error } = await supabase.from('priority_rules').insert({
      organization_id: org.id,
      keyword: newKeyword.trim().toLowerCase(),
      tier: newTier,
    });
    setSaving(false);
    if (error) {
      setRuleError(error.code === '23505' ? 'That keyword is already defined for this tier.' : error.message);
      return;
    }
    setNewKeyword('');
    loadRules(org.id);
  };

  const removeRule = async (id: string) => {
    if (!org) return;
    await supabase.from('priority_rules').delete().eq('id', id);
    loadRules(org.id);
  };

  const cleanTag = (t: string, fb: string) => t.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().slice(0, 16) || fb;
  const saveTags = async () => {
    if (!org) return;
    const settings = { ...(org.settings ?? {}), drill_tag: cleanTag(drillTag, 'DRILL'), test_tag: cleanTag(testTag, 'TEST') };
    const { error } = await supabase.from('organizations').update({ settings }).eq('id', org.id);
    if (error) { setTagMsg(error.message); return; }
    setOrg({ ...org, settings }); setDrillTag(settings.drill_tag); setTestTag(settings.test_tag);
    setTagMsg('Saved.');
  };

  if (!org) return <p>No organization assigned to your account yet.</p>;

  return (
    <div>
      <h1>Org Settings</h1>
      <div className="card" style={{ maxWidth: 480 }}>
        <p><strong>Name:</strong> {org.name}</p>
        <p><strong>Slug:</strong> {org.slug}</p>
        <p><strong>Twilio number (outbound):</strong> {org.twilio_number ?? 'Not yet registered for outbound sends'}</p>
      </div>

      {staff?.role === 'admin' || staff?.is_platform_admin ? (
        <>
          <h2 style={{ marginTop: 30 }}>Drill and test labels</h2>
          <div className="card" style={{ maxWidth: 480 }}>
            <p style={{ color: 'var(--brand-gray-600)', marginTop: 0 }}>Every drill and test text starts with one of these labels in [brackets] so nobody mistakes it for a real emergency. Letters, numbers and spaces only, up to 16 characters.</p>
            <label>Drill label <input value={drillTag} maxLength={16} onChange={(e) => setDrillTag(e.target.value)} style={{ padding: 6 }} /></label><br /><br />
            <label>Test label <input value={testTag} maxLength={16} onChange={(e) => setTestTag(e.target.value)} style={{ padding: 6 }} /></label><br /><br />
            <button className="btn-primary" onClick={saveTags}>Save labels</button> {tagMsg && <span role="status">{tagMsg}</span>}
          </div>
        </>
      ) : null}

      <h2 style={{ marginTop: 30 }}>Priority Keywords</h2>
      <p style={{ color: 'var(--brand-gray-600)', maxWidth: 620 }}>
        Words or phrases below apply to <em>both</em> plain text messages and the reason field of Active SOS App
        alerts — so a word like "evacuate" gets the same tier no matter which way someone sends it. A match only
        ever raises the tier; it can't downgrade an SOS button press.
      </p>
      <form onSubmit={addRule} style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <input
          type="text"
          placeholder="keyword or phrase"
          value={newKeyword}
          onChange={(e) => setNewKeyword(e.target.value)}
          required
          style={{ padding: 8, borderRadius: 6, border: '1px solid var(--brand-gray-300)', minWidth: 220 }}
        />
        <select
          value={newTier}
          onChange={(e) => setNewTier(Number(e.target.value) as 1 | 3)}
          style={{ padding: 8, borderRadius: 6, border: '1px solid var(--brand-gray-300)' }}
        >
          <option value={3}>Tier 3 · Critical</option>
          <option value={1}>Tier 1 · Safe check-in</option>
        </select>
        <button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Adding…' : 'Add keyword'}</button>
      </form>
      {ruleError && <p style={{ color: 'var(--tier-3)', fontSize: 13 }}>{ruleError}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480 }}>
        {rules.length === 0 && <p style={{ color: 'var(--brand-gray-600)' }}>No custom keywords yet — using system defaults.</p>}
        {rules.map((r) => (
          <div
            key={r.id}
            className="card"
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 14px' }}
          >
            <div>
              <span className={`tier-badge tier-${r.tier}`} style={{ marginRight: 10 }}>{TIER_LABELS[r.tier]}</span>
              <span style={{ fontWeight: 600 }}>{r.keyword}</span>
            </div>
            <button
              onClick={() => removeRule(r.id)}
              title="Remove keyword"
              style={{ background: 'transparent', border: 'none', color: 'var(--brand-gray-600)', cursor: 'pointer', fontSize: 16 }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <TemplatesManager organizationId={org.id} />
    </div>
  );
}
