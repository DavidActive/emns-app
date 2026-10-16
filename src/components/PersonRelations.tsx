import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { normalizePhone } from '../lib/rosterCore.mjs';

interface Group { id: string; name: string }
interface Contact { id: string; channel: 'sms' | 'voice' | 'email' | 'desktop'; value: string; priority: number; opted_out: boolean }

const CHANNEL_LABEL: Record<string, string> = { sms: 'Text (SMS)', voice: 'Voice call', email: 'Email', desktop: 'Desktop alert' };
const input = { padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };

export default function PersonRelations({ personId, canEdit }: { personId: string; canEdit: boolean }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [channel, setChannel] = useState<Contact['channel']>('voice');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [g, m, c] = await Promise.all([
      supabase.from('groups').select('id, name').order('name'),
      supabase.from('group_members').select('group_id').eq('person_id', personId),
      supabase.from('person_contacts').select('id, channel, value, priority, opted_out').eq('person_id', personId).order('priority'),
    ]);
    setGroups((g.data as Group[]) ?? []);
    setMine(new Set((m.data ?? []).map((r: { group_id: string }) => r.group_id)));
    setContacts((c.data as Contact[]) ?? []);
  }, [personId]);
  useEffect(() => { load(); }, [load]);

  const toggle = async (gid: string, on: boolean) => {
    setError(null);
    const q = on
      ? supabase.from('group_members').insert({ group_id: gid, person_id: personId, source: 'manual' })
      : supabase.from('group_members').delete().eq('group_id', gid).eq('person_id', personId);
    const { error: err } = await q;
    if (err) setError(err.message); else load();
  };

  const addContact = async () => {
    setError(null);
    let v = value.trim();
    if (channel === 'sms' || channel === 'voice') {
      const n = normalizePhone(v);
      if (!n) { setError('Enter a valid phone number, for example +15555550123.'); return; }
      v = n;
    } else if (channel === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      setError('Enter a valid email address.'); return;
    }
    if (!v) return;
    const { error: err } = await supabase.from('person_contacts').insert({
      person_id: personId, channel, value: v, priority: contacts.filter((c) => c.channel === channel).length + 1,
    });
    if (err) setError(err.code === '23505' ? 'That contact is already on file.' : err.message);
    else { setValue(''); load(); }
  };

  const removeContact = async (id: string) => {
    const { error: err } = await supabase.from('person_contacts').delete().eq('id', id);
    if (err) setError(err.message); else load();
  };

  return (
    <>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}
      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Groups</h2>
        {groups.length === 0 && <p style={{ color: 'var(--brand-gray-600)' }}>No groups yet. Create one on the Groups page.</p>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 20px' }}>
          {groups.map((g) => (
            <label key={g.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
              <input type="checkbox" checked={mine.has(g.id)} disabled={!canEdit} onChange={(e) => toggle(g.id, e.target.checked)} />
              {g.name}
            </label>
          ))}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>Additional contact methods</h2>
        <p style={{ fontSize: 13, color: 'var(--brand-gray-600)', marginTop: 0 }}>
          The primary mobile number above is used for text messages. Add other ways to reach this person (office phone, personal email, desktop alert).
          Lower priority numbers are tried first when a notification falls back to another channel.
        </p>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {contacts.map((c) => (
              <tr key={c.id} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
                <td style={{ padding: 8, fontWeight: 600 }}>{CHANNEL_LABEL[c.channel]}</td>
                <td style={{ padding: 8 }}>{c.value}</td>
                <td style={{ padding: 8, fontSize: 13 }}>Priority {c.priority}{c.opted_out ? ' · opted out' : ''}</td>
                {canEdit && <td style={{ padding: 8, textAlign: 'right' }}><button onClick={() => removeContact(c.id)} style={{ background: 'none', border: 'none', color: 'var(--tier-3)', cursor: 'pointer' }}>Remove</button></td>}
              </tr>
            ))}
            {contacts.length === 0 && <tr><td style={{ padding: 8, color: 'var(--brand-gray-600)' }}>None added.</td></tr>}
          </tbody>
        </table>
        {canEdit && (
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <select style={input} value={channel} onChange={(e) => setChannel(e.target.value as Contact['channel'])}>
              {Object.entries(CHANNEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <input style={{ ...input, flex: 1 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder={channel === 'email' ? 'name@example.com' : channel === 'desktop' ? 'Workstation or user name' : '+15555550123'} onKeyDown={(e) => e.key === 'Enter' && addContact()} />
            <button className="btn-primary" onClick={addContact} disabled={!value.trim()}>Add</button>
          </div>
        )}
      </div>
    </>
  );
}
