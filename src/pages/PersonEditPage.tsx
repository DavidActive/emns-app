import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

interface PersonForm {
  full_name: string;
  employee_id: string;
  mobile_phone: string;
  email: string;
  notes: string;
  is_active: boolean;
}

const BLANK: PersonForm = {
  full_name: '',
  employee_id: '',
  mobile_phone: '',
  email: '',
  notes: '',
  is_active: true,
};


const fieldStyle = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--brand-gray-600)', marginBottom: 4, textTransform: 'uppercase' as const };

export default function PersonEditPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const { staff } = useAuth();

  const [form, setForm] = useState<PersonForm>(BLANK);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    supabase
      .from('people')
      .select(
        'full_name, employee_id, mobile_phone, email, notes, is_active'
      )
      .eq('id', id)
      .single()
      .then(({ data, error: fetchError }) => {
        if (fetchError || !data) {
          setError('Could not load this person.');
          setLoading(false);
          return;
        }
        setForm({
          full_name: data.full_name ?? '',
          employee_id: data.employee_id ?? '',
          mobile_phone: data.mobile_phone ?? '',
          email: data.email ?? '',
          notes: data.notes ?? '',
          is_active: data.is_active ?? true,
        });
        setLoading(false);
      });
  }, [id, isNew]);

  const set = <K extends keyof PersonForm>(key: K, value: PersonForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setError(null);
    if (!form.full_name.trim() || !form.mobile_phone.trim()) {
      setError('Name and phone number are required.');
      return;
    }
    setSaving(true);
    const payload = {
      full_name: form.full_name.trim(),
      mobile_phone: form.mobile_phone.trim(),
      email: form.email.trim() || null,
      employee_id: form.employee_id.trim() || null,
      notes: form.notes.trim() || null,
      is_active: form.is_active,
    };

    if (isNew) {
      if (!staff?.organization_id) {
        setError('Could not determine your organization.');
        setSaving(false);
        return;
      }
      const { data, error: insertError } = await supabase
        .from('people')
        .insert({ ...payload, organization_id: staff.organization_id })
        .select('id')
        .single();
      if (insertError || !data) {
        setError(insertError?.message ?? 'Failed to create record.');
        setSaving(false);
        return;
      }
      await supabase.from('consent_events').insert({
        person_id: data.id,
        event: 'opt_in',
        method: 'staff_manual_entry',
      });
      navigate(`/people/${data.id}`, { replace: true });
    } else {
      const { error: updateError } = await supabase.from('people').update(payload).eq('id', id);
      if (updateError) {
        setError(updateError.message);
        setSaving(false);
        return;
      }
    }
    setSaving(false);
  };

  if (loading) return <p>Loading…</p>;

  return (
    <div style={{ maxWidth: 640 }}>
      <button
        onClick={() => navigate('/people')}
        style={{ background: 'none', border: 'none', color: 'var(--brand-teal)', fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← Back to roster
      </button>
      <h1>{isNew ? 'Add person' : form.full_name}</h1>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>Full name</label>
            <input style={fieldStyle} value={form.full_name} onChange={(e) => set('full_name', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Phone number</label>
            <input style={fieldStyle} value={form.mobile_phone} onChange={(e) => set('mobile_phone', e.target.value)} placeholder="+15551234567" />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Email</label>
          <input style={fieldStyle} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Employee ID</label>
          <input style={fieldStyle} value={form.employee_id} onChange={(e) => set('employee_id', e.target.value)} />
        </div>

        <div>
          <label style={labelStyle}>Notes</label>
          <textarea style={{ ...fieldStyle, minHeight: 80, fontFamily: 'inherit' }} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        <div style={{ borderTop: '1px solid var(--brand-gray-300)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            Active (uncheck to mark inactive)
          </label>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
