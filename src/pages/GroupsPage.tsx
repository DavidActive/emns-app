import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';

interface GroupRow { id: string; name: string; description: string | null; members: number }

export default function GroupsPage() {
  const { staff } = useAuth();
  const navigate = useNavigate();
  const canEdit = canEditRoster(staff);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: g } = await supabase.from('groups').select('id, name, description').order('name');
    const { data: m } = await supabase.from('group_members').select('group_id');
    const counts = new Map<string, number>();
    (m ?? []).forEach((r: { group_id: string }) => counts.set(r.group_id, (counts.get(r.group_id) ?? 0) + 1));
    setGroups((g ?? []).map((x: { id: string; name: string; description: string | null }) => ({ ...x, members: counts.get(x.id) ?? 0 })));
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setError(null);
    const n = name.trim();
    if (!n || !staff?.organization_id) return;
    const { data, error: err } = await supabase.from('groups').insert({ name: n, organization_id: staff.organization_id }).select('id').single();
    if (err || !data) { setError(err?.code === '23505' ? 'A group with that name already exists.' : err?.message ?? 'Could not create group.'); return; }
    setName('');
    navigate(`/groups/${data.id}`);
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <h1>Groups</h1>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Groups are the audiences for notifications (a building, a unit, a shift). A person can belong to many groups,
        and a notification sent to several groups reaches each person only once.
      </p>
      {canEdit && (
        <div className="card" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group name" maxLength={80}
            onKeyDown={(e) => e.key === 'Enter' && create()}
            style={{ flex: 1, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 }} />
          <button className="btn-primary" onClick={create} disabled={!name.trim()}>Create group</button>
        </div>
      )}
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead><tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
          <th style={{ padding: 10 }}>Group</th><th style={{ padding: 10 }}>Description</th><th style={{ padding: 10 }}>Members</th>
        </tr></thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.id} onClick={() => navigate(`/groups/${g.id}`)} style={{ borderBottom: '1px solid var(--brand-gray-300)', cursor: 'pointer' }}>
              <td style={{ padding: 10, fontWeight: 600, color: 'var(--brand-teal)' }}>{g.name}</td>
              <td style={{ padding: 10 }}>{g.description ?? '—'}</td>
              <td style={{ padding: 10 }}>{g.members}</td>
            </tr>
          ))}
          {groups.length === 0 && <tr><td colSpan={3} style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>No groups yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
