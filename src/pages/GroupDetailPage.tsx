import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';

interface Person { id: string; full_name: string; employee_id: string | null; mobile_phone: string; is_active: boolean }

const inputStyle = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };

export default function GroupDetailPage() {
  const { id } = useParams();
  const { staff } = useAuth();
  const navigate = useNavigate();
  const canEdit = canEditRoster(staff);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [members, setMembers] = useState<Person[]>([]);
  const [everyone, setEveryone] = useState<Person[]>([]);
  const [query, setQuery] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: g } = await supabase.from('groups').select('name, description').eq('id', id).maybeSingle();
    if (!g) { setError('Group not found.'); return; }
    setName(g.name); setDescription(g.description ?? '');
    const { data: gm } = await supabase.from('group_members').select('person_id').eq('group_id', id);
    const ids = new Set((gm ?? []).map((r: { person_id: string }) => r.person_id));
    const { data: p } = await supabase.from('people').select('id, full_name, employee_id, mobile_phone, is_active').order('full_name');
    const all = (p ?? []) as Person[];
    setEveryone(all);
    setMembers(all.filter((x) => ids.has(x.id)));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return everyone.filter((p) => !memberIds.has(p.id) &&
      (p.full_name.toLowerCase().includes(q) || (p.employee_id ?? '').toLowerCase().includes(q) || p.mobile_phone.includes(q))).slice(0, 8);
  }, [query, everyone, memberIds]);

  const save = async () => {
    setError(null); setMsg(null);
    const { error: err } = await supabase.from('groups').update({ name: name.trim(), description: description.trim() || null }).eq('id', id);
    if (err) setError(err.code === '23505' ? 'A group with that name already exists.' : err.message); else setMsg('Saved.');
  };
  const add = async (personId: string) => {
    const { error: err } = await supabase.from('group_members').insert({ group_id: id, person_id: personId, source: 'manual' });
    if (err) setError(err.message); else { setQuery(''); load(); }
  };
  const remove = async (personId: string) => {
    const { error: err } = await supabase.from('group_members').delete().eq('group_id', id).eq('person_id', personId);
    if (err) setError(err.message); else load();
  };
  const deleteGroup = async () => {
    if (!window.confirm(`Delete the group "${name}"? People are not deleted, only their membership in this group.`)) return;
    const { error: err } = await supabase.from('groups').delete().eq('id', id);
    if (err) setError(err.message); else navigate('/groups');
  };

  return (
    <div style={{ maxWidth: 800 }}>
      <button onClick={() => navigate('/groups')} style={{ background: 'none', border: 'none', color: 'var(--brand-teal)', fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 12 }}>← All groups</button>
      <h1>{name || 'Group'}</h1>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}
      {msg && <p style={{ color: '#1a7f37' }}>{msg}</p>}
      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={80} aria-label="Group name" />
        <input style={inputStyle} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canEdit} placeholder="Description (optional)" aria-label="Description" />
        {canEdit && (
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <button className="btn-primary" onClick={save} disabled={!name.trim()}>Save</button>
            <button onClick={deleteGroup} style={{ background: 'none', border: '1px solid var(--tier-3)', color: 'var(--tier-3)', borderRadius: 6, padding: '6px 12px', cursor: 'pointer' }}>Delete group</button>
          </div>
        )}
      </div>

      <h2 style={{ marginTop: 24 }}>Members ({members.length})</h2>
      {canEdit && (
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <input style={{ ...inputStyle, width: '100%' }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Add a person: search by name, employee ID or phone" />
          {matches.length > 0 && (
            <div className="card" style={{ position: 'absolute', left: 0, right: 0, zIndex: 5, padding: 4 }}>
              {matches.map((p) => (
                <div key={p.id} onClick={() => add(p.id)} style={{ padding: '8px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600 }}>{p.full_name}</span><span style={{ color: 'var(--brand-gray-600)' }}>{p.employee_id ?? ''} {p.mobile_phone}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {members.map((p) => (
            <tr key={p.id} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
              <td style={{ padding: 10, fontWeight: 600, cursor: 'pointer', color: 'var(--brand-teal)' }} onClick={() => navigate(`/people/${p.id}`)}>{p.full_name}{!p.is_active && ' (inactive)'}</td>
              <td style={{ padding: 10 }}>{p.employee_id ?? '—'}</td>
              <td style={{ padding: 10 }}>{p.mobile_phone}</td>
              {canEdit && <td style={{ padding: 10, textAlign: 'right' }}><button onClick={() => remove(p.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--tier-3)' }}>Remove</button></td>}
            </tr>
          ))}
          {members.length === 0 && <tr><td style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>No members yet.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
