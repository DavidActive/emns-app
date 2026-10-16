import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';

interface Scenario { id: string; name: string; kind: 'alert' | 'drill' | 'test'; bodies: { sms?: string }; default_group_ids: string[]; requires_ack: boolean }
interface Group { id: string; name: string }
const blank = { id: '', name: '', kind: 'alert' as Scenario['kind'], sms: '', groups: [] as string[], ack: true };

export default function ScenariosPage() {
  const { staff } = useAuth();
  const canEdit = canEditRoster(staff);
  const [rows, setRows] = useState<Scenario[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [form, setForm] = useState<typeof blank | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: s }, { data: g }] = await Promise.all([
      supabase.from('notification_scenarios').select('id, name, kind, bodies, default_group_ids, requires_ack').order('name'),
      supabase.from('groups').select('id, name').order('name'),
    ]);
    setRows((s ?? []) as Scenario[]);
    setGroups((g ?? []) as Group[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!form || !staff?.organization_id) return;
    setError(null);
    const name = form.name.trim();
    if (!name) { setError('Give the scenario a name.'); return; }
    if (form.kind === 'alert' && !form.sms.trim()) { setError('An alert scenario needs message text.'); return; }
    const payload = { name, kind: form.kind, bodies: { sms: form.sms.trim() }, default_group_ids: form.groups, requires_ack: form.ack };
    const { error: err } = form.id
      ? await supabase.from('notification_scenarios').update(payload).eq('id', form.id)
      : await supabase.from('notification_scenarios').insert({ ...payload, organization_id: staff.organization_id });
    if (err) { setError(err.code === '23505' ? 'A scenario with that name already exists.' : err.message); return; }
    setForm(null); load();
  };

  const remove = async (s: Scenario) => {
    if (!window.confirm(`Delete the scenario "${s.name}"? Past events keep their record.`)) return;
    const { error: err } = await supabase.from('notification_scenarios').delete().eq('id', s.id);
    if (err) setError(err.message); else load();
  };

  const groupNames = (ids: string[]) => ids.map((i) => groups.find((g) => g.id === i)?.name).filter(Boolean).join(', ') || 'None';

  return (
    <div style={{ maxWidth: 900 }}>
      <h1>Scenarios</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Pre-written messages for situations you plan for. Pick one on the Send page and the message and groups fill in.
        The standard wording (Active SOS eMNS, your organization name, DRILL or TEST tag, opt-out line) is added automatically.
      </p>
      {error && <p role="alert" style={{ color: 'var(--tier-3)' }}>{error}</p>}
      {canEdit && !form && <button className="btn-primary" onClick={() => setForm({ ...blank })}>New scenario</button>}

      {form && (
        <div className="card" style={{ margin: '16px 0', display: 'grid', gap: 12 }}>
          <label>Name<br /><input value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} style={{ width: '100%', padding: 8 }} /></label>
          <label>Type<br />
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Scenario['kind'] })} style={{ padding: 8 }}>
              <option value="alert">Alert (real emergency)</option><option value="drill">Drill</option><option value="test">Test</option>
            </select>
          </label>
          <label>Message text<br /><textarea rows={4} maxLength={600} value={form.sms} onChange={(e) => setForm({ ...form, sms: e.target.value })} style={{ width: '100%', padding: 8 }} /></label>
          <label><input type="checkbox" checked={form.ack} onChange={(e) => setForm({ ...form, ack: e.target.checked })} /> Ask people to reply SAFE</label>
          <fieldset style={{ border: '1px solid var(--brand-gray-300)', borderRadius: 6 }}>
            <legend>Default groups</legend>
            {groups.length === 0 && <span>No groups yet.</span>}
            {groups.map((g) => (
              <label key={g.id} style={{ display: 'block' }}>
                <input type="checkbox" checked={form.groups.includes(g.id)} onChange={(e) => setForm({ ...form, groups: e.target.checked ? [...form.groups, g.id] : form.groups.filter((x) => x !== g.id) })} /> {g.name}
              </label>
            ))}
          </fieldset>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-primary" onClick={save}>Save</button>
            <button onClick={() => { setForm(null); setError(null); }}>Cancel</button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        {rows.length === 0 && <p>No scenarios yet.</p>}
        {rows.map((s) => (
          <div key={s.id} className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <strong>{s.name} <span style={{ fontWeight: 400, color: 'var(--brand-gray-600)' }}>· {s.kind}</span></strong>
              <span style={{ display: 'flex', gap: 8 }}>
                {canDrillLink(staff, s.kind) && <Link to={`/send?scenario=${s.id}`}>Use</Link>}
                {canEdit && <button onClick={() => setForm({ id: s.id, name: s.name, kind: s.kind, sms: s.bodies?.sms ?? '', groups: s.default_group_ids ?? [], ack: s.requires_ack })}>Edit</button>}
                {canEdit && <button onClick={() => remove(s)}>Delete</button>}
              </span>
            </div>
            <p style={{ margin: '8px 0' }}>{s.bodies?.sms || <em>No custom text</em>}</p>
            <small style={{ color: 'var(--brand-gray-600)' }}>Groups: {groupNames(s.default_group_ids ?? [])}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

function canDrillLink(staff: ReturnType<typeof useAuth>['staff'], kind: string) {
  if (!staff || staff.role === 'viewer' && !staff.is_platform_admin) return false;
  return kind !== 'alert' || canEditRoster(staff);
}
