import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

interface PersonForm {
  full_name: string;
  phone_number: string;
  email: string;
  branch_of_service: string;
  discharge_era: string;
  va_connected: '' | 'yes' | 'no';
  preferred_contact_time: string;
  primary_contact_name: string;
  primary_contact_phone: string;
  notes: string;
  enrolled: boolean;
}

const BLANK: PersonForm = {
  full_name: '',
  phone_number: '',
  email: '',
  branch_of_service: '',
  discharge_era: '',
  va_connected: '',
  preferred_contact_time: '',
  primary_contact_name: '',
  primary_contact_phone: '',
  notes: '',
  enrolled: true,
};

const BRANCHES = ['Army', 'Navy', 'Air Force', 'Marine Corps', 'Coast Guard', 'Space Force'];
const ERAS = ['Post-9/11', 'OEF/OIF', 'Gulf War', 'GWOT', 'Peacetime'];
const CONTACT_TIMES = ['Morning', 'Afternoon', 'Evening'];

const fieldStyle = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--brand-gray-600)', marginBottom: 4, textTransform: 'uppercase' as const };

export default function VeteranEditPage() {
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
      .from('enrolled_people')
      .select(
        'full_name, phone_number, email, branch_of_service, discharge_era, va_connected, preferred_contact_time, primary_contact_name, primary_contact_phone, notes, enrolled'
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
          phone_number: data.phone_number ?? '',
          email: data.email ?? '',
          branch_of_service: data.branch_of_service ?? '',
          discharge_era: data.discharge_era ?? '',
          va_connected: data.va_connected === null ? '' : data.va_connected ? 'yes' : 'no',
          preferred_contact_time: data.preferred_contact_time ?? '',
          primary_contact_name: data.primary_contact_name ?? '',
          primary_contact_phone: data.primary_contact_phone ?? '',
          notes: data.notes ?? '',
          enrolled: data.enrolled ?? true,
        });
        setLoading(false);
      });
  }, [id, isNew]);

  const set = <K extends keyof PersonForm>(key: K, value: PersonForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setError(null);
    if (!form.full_name.trim() || !form.phone_number.trim()) {
      setError('Name and phone number are required.');
      return;
    }
    setSaving(true);
    const payload = {
      full_name: form.full_name.trim(),
      phone_number: form.phone_number.trim(),
      email: form.email.trim() || null,
      branch_of_service: form.branch_of_service || null,
      discharge_era: form.discharge_era || null,
      va_connected: form.va_connected === '' ? null : form.va_connected === 'yes',
      preferred_contact_time: form.preferred_contact_time || null,
      primary_contact_name: form.primary_contact_name.trim() || null,
      primary_contact_phone: form.primary_contact_phone.trim() || null,
      notes: form.notes.trim() || null,
      enrolled: form.enrolled,
    };

    if (isNew) {
      if (!staff?.organization_id) {
        setError('Could not determine your organization.');
        setSaving(false);
        return;
      }
      const { data, error: insertError } = await supabase
        .from('enrolled_people')
        .insert({ ...payload, organization_id: staff.organization_id })
        .select('id')
        .single();
      if (insertError || !data) {
        setError(insertError?.message ?? 'Failed to create record.');
        setSaving(false);
        return;
      }
      await supabase.from('consent_log').insert({
        enrolled_person_id: data.id,
        event: 'opt_in',
        method: 'staff_manual_entry',
      });
      navigate(`/veterans/${data.id}`, { replace: true });
    } else {
      const { error: updateError } = await supabase.from('enrolled_people').update(payload).eq('id', id);
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
        onClick={() => navigate('/veterans')}
        style={{ background: 'none', border: 'none', color: 'var(--brand-teal)', fontWeight: 600, cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← Back to roster
      </button>
      <h1>{isNew ? 'Add Veteran / Supporter' : form.full_name}</h1>
      {error && <p style={{ color: 'var(--tier-3)' }}>{error}</p>}

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>Full name</label>
            <input style={fieldStyle} value={form.full_name} onChange={(e) => set('full_name', e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Phone number</label>
            <input style={fieldStyle} value={form.phone_number} onChange={(e) => set('phone_number', e.target.value)} placeholder="+15551234567" />
          </div>
        </div>

        <div>
          <label style={labelStyle}>Email</label>
          <input style={fieldStyle} type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>Branch of service</label>
            <select style={fieldStyle} value={form.branch_of_service} onChange={(e) => set('branch_of_service', e.target.value)}>
              <option value="">—</option>
              {BRANCHES.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Discharge era</label>
            <select style={fieldStyle} value={form.discharge_era} onChange={(e) => set('discharge_era', e.target.value)}>
              <option value="">—</option>
              {ERAS.map((e) => (
                <option key={e} value={e}>{e}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <label style={labelStyle}>VA-connected</label>
            <select style={fieldStyle} value={form.va_connected} onChange={(e) => set('va_connected', e.target.value as PersonForm['va_connected'])}>
              <option value="">Unknown</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
          <div>
            <label style={labelStyle}>Preferred contact time</label>
            <select style={fieldStyle} value={form.preferred_contact_time} onChange={(e) => set('preferred_contact_time', e.target.value)}>
              <option value="">—</option>
              {CONTACT_TIMES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--brand-gray-300)', paddingTop: 16 }}>
          <p style={{ fontWeight: 700, fontSize: 13, margin: '0 0 10px' }}>Primary contact (family, sponsor, or caseworker)</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <label style={labelStyle}>Contact name</label>
              <input style={fieldStyle} value={form.primary_contact_name} onChange={(e) => set('primary_contact_name', e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Contact phone</label>
              <input style={fieldStyle} value={form.primary_contact_phone} onChange={(e) => set('primary_contact_phone', e.target.value)} />
            </div>
          </div>
        </div>

        <div>
          <label style={labelStyle}>Notes</label>
          <textarea style={{ ...fieldStyle, minHeight: 80, fontFamily: 'inherit' }} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>

        <div style={{ borderTop: '1px solid var(--brand-gray-300)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={form.enrolled} onChange={(e) => set('enrolled', e.target.checked)} />
            Enrolled (uncheck to mark inactive)
          </label>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
