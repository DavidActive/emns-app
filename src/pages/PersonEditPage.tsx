import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';
import { canEditRoster } from '../lib/permissions';
import { normalizePhone } from '../lib/rosterCore.mjs';
import PersonRelations from '../components/PersonRelations';
import { callFunction } from '../lib/api';

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
  const canEdit = canEditRoster(staff);

  const [form, setForm] = useState<PersonForm>(BLANK);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<{ status: string; at: string | null; method: string | null; optedOut: boolean } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);

  useEffect(() => {
    if (isNew) return;
    supabase
      .from('people')
      .select(
        'full_name, employee_id, mobile_phone, email, notes, is_active, consent_status, consented_at, consent_method, sms_opted_out'
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
        setConsent({ status: data.consent_status, at: data.consented_at, method: data.consent_method, optedOut: !!data.sms_opted_out });
        setLoading(false);
      });
  }, [id, isNew]);

  const emailLink = async () => {
    setLinkMsg(null); setLink(null);
    try {
      const r = await callFunction<{ emailed: number; invites: { link: string }[] }>('create-invites', { person_ids: [id], send_email: true });
      if (r.emailed) setLinkMsg(`Link emailed to ${form.email}. It works once and will not be shown here.`);
      else if (r.invites[0]) { setLink(r.invites[0].link); setLinkMsg('Could not email this person (no usable email address or send failed). Copy the link instead.'); }
      else setLinkMsg('This person has already agreed to texts.');
    } catch (e) { setLinkMsg((e as Error).message); }
  };

  const makeLink = async () => {
    setLinkMsg(null); setLink(null);
    try {
      const r = await callFunction<{ invites: { link: string }[] }>('create-invites', { person_ids: [id] });
      if (r.invites[0]) setLink(r.invites[0].link); else setLinkMsg('This person has already agreed to texts.');
    } catch (e) { setLinkMsg((e as Error).message); }
  };

  const set = <K extends keyof PersonForm>(key: K, value: PersonForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    setError(null);
    if (!form.full_name.trim() || !form.mobile_phone.trim()) {
      setError('Name and phone number are required.');
      return;
    }
    const phone = normalizePhone(form.mobile_phone);
    if (!phone) {
      setError('Enter a valid mobile number, for example +15555550123 or (555) 555-0123.');
      return;
    }
    setSaving(true);
    const payload = {
      full_name: form.full_name.trim(),
      mobile_phone: phone,
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
        setError(insertError?.code === '23505' ? 'Another person already has that phone number or employee ID.' : insertError?.message ?? 'Failed to create record.');
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
        setError(updateError.code === '23505' ? 'Another person already has that phone number or employee ID.' : updateError.message);
        setSaving(false);
        return;
      }
      setForm((f) => ({ ...f, mobile_phone: phone }));
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

        {!isNew && consent && (
          <div style={{ background: 'var(--brand-gray-100)', padding: 12, borderRadius: 6 }}>
            <strong>Text consent: </strong>
            {consent.status === 'consented' && !consent.optedOut ? `Agreed${consent.at ? ' on ' + new Date(consent.at).toLocaleDateString() : ''}${consent.method ? ' (' + consent.method.replace(/_/g, ' ') + ')' : ''}`
              : consent.status === 'withdrawn' || consent.optedOut ? 'Opted out (replied STOP). They can reply START to turn texts back on.' : 'Not yet agreed. They will not receive texts until they do.'}
            {canEdit && consent.status !== 'consented' && (
              <div style={{ marginTop: 8 }}>
                {form.email.trim() && <button onClick={emailLink} style={{ marginRight: 8 }}>Email enrollment link</button>}
                <button onClick={makeLink}>Create enrollment link</button>
                {linkMsg && <span style={{ marginLeft: 8 }}>{linkMsg}</span>}
                {link && (
                  <div style={{ marginTop: 8 }}>
                    <input readOnly value={link} onFocus={(e) => e.target.select()} style={{ width: '100%', padding: 6 }} />
                    <small>One-time link, valid 30 days. Send it only to this person, by email or in person, not by text (they have not agreed to texts yet). It will not be shown again.</small>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--brand-gray-300)', paddingTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />
            Active (uncheck to mark inactive)
          </label>
          <button className="btn-primary" onClick={save} disabled={saving || !canEdit}>
            {saving ? 'Saving…' : isNew ? 'Create' : 'Save changes'}
          </button>
        </div>
      </div>
      {!isNew && id && <PersonRelations personId={id} canEdit={canEdit} />}
    </div>
  );
}
