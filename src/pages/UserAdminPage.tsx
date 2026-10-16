import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../lib/AuthContext';

interface StaffRow {
  id: string;
  full_name: string | null;
  role: string;
  is_platform_admin: boolean;
  organization_id: string | null;
}

interface OrgOption {
  id: string;
  name: string;
}

const ROLE_LABELS: Record<string, string> = { support: 'Application Support', admin: 'Administrators', staff: 'Staff', viewer: 'Viewer' };

const fieldStyle = { width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid var(--brand-gray-300)', fontSize: 14 };
const labelStyle = { display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--brand-gray-600)', marginBottom: 4, textTransform: 'uppercase' as const };

export default function UserAdminPage() {
  const { staff } = useAuth();
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [orgs, setOrgs] = useState<OrgOption[]>([]);

  const [showForm, setShowForm] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [organizationId, setOrganizationId] = useState('');
  const [role, setRole] = useState<'operator' | 'sender' | 'admin'>('operator');
  const [canAddUsers, setCanAddUsers] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const loadStaff = () => {
    supabase
      .from('operators')
      .select('id, full_name, role, is_platform_admin, organization_id')
      .then(({ data }) => setRows((data as StaffRow[]) ?? []));
  };

  useEffect(() => {
    if (!staff?.is_platform_admin) return;
    loadStaff();
    supabase
      .from('organizations')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        setOrgs((data as OrgOption[]) ?? []);
        if (data && data.length > 0) setOrganizationId((prev) => prev || data[0].id);
      });
  }, [staff]);

  const sendInvite = async () => {
    setFormError(null);
    setFormSuccess(null);
    if (!email.trim() || !organizationId) {
      setFormError('Email and organization are required.');
      return;
    }
    setSubmitting(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Your session has expired — please sign in again.');

      const res = await fetch('/.netlify/functions/invite-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          email: email.trim(),
          full_name: fullName.trim() || null,
          organization_id: organizationId,
          role,
          is_platform_admin: canAddUsers,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to send invite.');

      setFormSuccess(`Invite sent to ${email.trim()}.`);
      setEmail('');
      setFullName('');
      setCanAddUsers(false);
      loadStaff();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to send invite.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!staff?.is_platform_admin) {
    return <p>Global-admin access required.</p>;
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Global Admin — Staff Across All Orgs</h1>
        <button className="btn-primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : '+ Add user'}
        </button>
      </div>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Every staff account currently has full access to all app functions. The one real permission split today is
        whether someone can add/manage other users (global admin) or not — finer-grained per-feature roles can come
        later.
      </p>

      {showForm && (
        <div className="card" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 480 }}>
          {formError && <p style={{ color: 'var(--tier-3)', margin: 0 }}>{formError}</p>}
          {formSuccess && <p style={{ color: 'var(--tier-1)', margin: 0 }}>{formSuccess}</p>}
          <div>
            <label style={labelStyle}>Email</label>
            <input style={fieldStyle} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@org.org" />
          </div>
          <div>
            <label style={labelStyle}>Full name</label>
            <input style={fieldStyle} value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div>
            <label style={labelStyle}>Organization</label>
            <select style={fieldStyle} value={organizationId} onChange={(e) => setOrganizationId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Role</label>
            <select style={fieldStyle} value={role} onChange={(e) => setRole(e.target.value as 'operator' | 'sender' | 'admin')}>
              <option value="operator">Operator (replies, drills)</option>
              <option value="sender">Sender (can send real alerts)</option>
              <option value="admin">Administrators</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={canAddUsers} onChange={(e) => setCanAddUsers(e.target.checked)} />
            Can add/manage users (global admin)
          </label>
          <button className="btn-primary" onClick={sendInvite} disabled={submitting}>
            {submitting ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      )}

      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
            <th style={{ padding: 10 }}>Name</th>
            <th style={{ padding: 10 }}>Role</th>
            <th style={{ padding: 10 }}>Can add users</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={{ borderBottom: '1px solid var(--brand-gray-300)' }}>
              <td style={{ padding: 10 }}>{r.full_name ?? '—'}</td>
              <td style={{ padding: 10 }}>{ROLE_LABELS[r.role] ?? r.role}</td>
              <td style={{ padding: 10 }}>{r.is_platform_admin ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
