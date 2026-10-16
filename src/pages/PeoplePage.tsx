import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';

interface PersonRow {
  id: string;
  full_name: string;
  employee_id: string | null;
  mobile_phone: string;
  email: string | null;
  is_active: boolean;
  sms_opted_out: boolean;
}
interface GroupOpt { id: string; name: string }

const control = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };

export default function PeoplePage() {
  const navigate = useNavigate();
  const { staff } = useAuth();
  const canEdit = canEditRoster(staff);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [groups, setGroups] = useState<GroupOpt[]>([]);
  const [membership, setMembership] = useState<Map<string, string[]>>(new Map());
  const [query, setQuery] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState<'active' | 'inactive' | 'all'>('active');

  useEffect(() => {
    supabase
      .from('people')
      .select('id, full_name, employee_id, mobile_phone, email, is_active, sms_opted_out')
      .order('full_name')
      .limit(10000)
      .then(({ data }) => setPeople((data as PersonRow[]) ?? []));
    supabase.from('groups').select('id, name').order('name').then(({ data }) => setGroups((data as GroupOpt[]) ?? []));
    supabase.from('group_members').select('group_id, person_id').limit(100000).then(({ data }) => {
      const m = new Map<string, string[]>();
      (data ?? []).forEach((r: { group_id: string; person_id: string }) => m.set(r.person_id, [...(m.get(r.person_id) ?? []), r.group_id]));
      setMembership(m);
    });
  }, []);

  const groupName = useMemo(() => new Map(groups.map((g) => [g.id, g.name])), [groups]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => {
      if (status === 'active' && !p.is_active) return false;
      if (status === 'inactive' && p.is_active) return false;
      if (groupId && !(membership.get(p.id) ?? []).includes(groupId)) return false;
      if (!q) return true;
      return p.full_name.toLowerCase().includes(q) || (p.employee_id ?? '').toLowerCase().includes(q) ||
        p.mobile_phone.includes(q) || (p.email ?? '').toLowerCase().includes(q);
    });
  }, [people, query, groupId, status, membership]);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>People</h1>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={() => navigate('/people/import')} style={{ ...control, background: 'white', cursor: 'pointer', fontWeight: 600 }}>Import CSV</button>
            <button className="btn-primary" onClick={() => navigate('/people/new')}>+ Add person</button>
          </div>
        )}
      </div>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Everyone who can receive notifications from your organization. Click a row to view or edit.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
        <input style={{ ...control, minWidth: 280 }} placeholder="Search name, employee ID, phone or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select style={control} value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">All groups</option>
          {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <select style={control} value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive' | 'all')}>
          <option value="active">Active</option><option value="inactive">Inactive</option><option value="all">All statuses</option>
        </select>
        <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--brand-gray-600)' }}>{rows.length} of {people.length}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
            <th style={{ padding: 10 }}>Name</th>
            <th style={{ padding: 10 }}>Employee ID</th>
            <th style={{ padding: 10 }}>Mobile phone</th>
            <th style={{ padding: 10 }}>Groups</th>
            <th style={{ padding: 10 }}>Texts</th>
            <th style={{ padding: 10 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 1000).map((p) => (
            <tr key={p.id} onClick={() => navigate(`/people/${p.id}`)} style={{ borderBottom: '1px solid var(--brand-gray-300)', cursor: 'pointer' }}>
              <td style={{ padding: 10, fontWeight: 600, color: 'var(--brand-teal)' }}>{p.full_name}</td>
              <td style={{ padding: 10 }}>{p.employee_id ?? '—'}</td>
              <td style={{ padding: 10 }}>{p.mobile_phone}</td>
              <td style={{ padding: 10, fontSize: 13 }}>{(membership.get(p.id) ?? []).map((g) => groupName.get(g)).filter(Boolean).join(', ') || '—'}</td>
              <td style={{ padding: 10 }}>{p.sms_opted_out ? 'Opted out' : 'OK'}</td>
              <td style={{ padding: 10 }}>{p.is_active ? 'Active' : 'Inactive'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>
                {people.length === 0 ? 'No people yet. Add one, or import a CSV roster.' : 'No one matches these filters.'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > 1000 && <p style={{ fontSize: 13 }}>Showing the first 1000 matches. Narrow the search to see more.</p>}
    </div>
  );
}
