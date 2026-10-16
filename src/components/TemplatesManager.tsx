import { FormEvent, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

interface Template {
  id: string;
  tier: 1 | 2 | 3 | null;
  name: string;
  message: string;
}

const TIER_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: 'Any tier' },
  { value: '1', label: 'Tier 1 · Safe check-in' },
  { value: '2', label: 'Tier 2 · Needs a look' },
  { value: '3', label: 'Tier 3 · Critical' },
];

// Pre-approved replies staff can drop into the conversation box. Editing is limited to org
// admins / global admins because this is the wording sent to people during incidents, and
// carriers filter emergency-adjacent text, so keep it plain.
export default function TemplatesManager({ organizationId }: { organizationId: string }) {
  const { staff } = useAuth();
  const canEdit = Boolean(staff?.is_platform_admin || staff?.role === 'admin');
  const [items, setItems] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [tier, setTier] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from('message_templates')
      .select('id, tier, name, message')
      .eq('organization_id', organizationId)
      .order('tier', { ascending: true, nullsFirst: true })
      .order('name');
    setItems((data as Template[]) ?? []);
  }, [organizationId]);

  useEffect(() => { load(); }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const { error: err } = await supabase.from('message_templates').insert({
      organization_id: organizationId,
      name: name.trim(),
      message: message.trim(),
      tier: tier ? Number(tier) : null,
    });
    setSaving(false);
    if (err) { setError(err.message); return; }
    setName(''); setMessage(''); setTier('');
    load();
  };

  const remove = async (id: string) => {
    if (!window.confirm('Delete this template?')) return;
    await supabase.from('message_templates').delete().eq('id', id);
    load();
  };

  const input = { padding: 8, borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontFamily: 'inherit', fontSize: 14 } as const;

  return (
    <div>
      <h2 style={{ marginTop: 30 }}>Reply Templates</h2>
      <p style={{ color: 'var(--brand-gray-600)', maxWidth: 620 }}>
        Approved wording staff can insert when replying from the Triage Inbox. Use <code>{'{first_name}'}</code> to
        personalize. Every Tier 3 reply should include your organization's escalation contact or 911 for immediate danger.
      </p>

      {canEdit ? (
        <form onSubmit={add} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 560, margin: '12px 0' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input style={{ ...input, flex: 1 }} placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} required />
            <select style={input} value={tier} onChange={(e) => setTier(e.target.value)}>
              {TIER_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <textarea style={input} rows={3} placeholder="Message text" value={message} onChange={(e) => setMessage(e.target.value)} required maxLength={1600} />
          <div><button type="submit" className="btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add template'}</button></div>
        </form>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--brand-gray-600)' }}>Only organization admins can add or edit templates.</p>
      )}
      {error && <p style={{ color: 'var(--tier-3)', fontSize: 13 }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 560 }}>
        {items.length === 0 && <p style={{ color: 'var(--brand-gray-600)' }}>No templates yet.</p>}
        {items.map((t) => (
          <div key={t.id} className="card" style={{ padding: '10px 14px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                {t.tier && <span className={`tier-badge tier-${t.tier}`} style={{ marginRight: 10 }}>Tier {t.tier}</span>}
                <span style={{ fontWeight: 600 }}>{t.name}</span>
              </div>
              {canEdit && (
                <button onClick={() => remove(t.id)} title="Delete template" style={{ background: 'transparent', border: 'none', color: 'var(--brand-gray-600)', cursor: 'pointer', fontSize: 16 }}>✕</button>
              )}
            </div>
            <p style={{ margin: '6px 0 0', fontSize: 13, whiteSpace: 'pre-wrap' }}>{t.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
