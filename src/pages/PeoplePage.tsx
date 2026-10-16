import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

interface PersonRow {
  id: string;
  full_name: string;
  employee_id: string | null;
  mobile_phone: string;
  is_active: boolean;
  sms_opted_out: boolean;
}

export default function PeoplePage() {
  const navigate = useNavigate();
  const [people, setPeople] = useState<PersonRow[]>([]);

  useEffect(() => {
    supabase
      .from('people')
      .select('id, full_name, employee_id, mobile_phone, is_active, sms_opted_out')
      .order('full_name')
      .then(({ data }) => setPeople((data as PersonRow[]) ?? []));
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>People</h1>
        <button className="btn-primary" onClick={() => navigate('/people/new')}>
          + Add person
        </button>
      </div>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Everyone who can receive notifications from your organization. Click a row to view or edit.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
            <th style={{ padding: 10 }}>Name</th>
            <th style={{ padding: 10 }}>Employee ID</th>
            <th style={{ padding: 10 }}>Mobile phone</th>
            <th style={{ padding: 10 }}>Texts</th>
            <th style={{ padding: 10 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr
              key={p.id}
              onClick={() => navigate(`/people/${p.id}`)}
              style={{ borderBottom: '1px solid var(--brand-gray-300)', cursor: 'pointer' }}
            >
              <td style={{ padding: 10, fontWeight: 600, color: 'var(--brand-teal)' }}>{p.full_name}</td>
              <td style={{ padding: 10 }}>{p.employee_id ?? '—'}</td>
              <td style={{ padding: 10 }}>{p.mobile_phone}</td>
              <td style={{ padding: 10 }}>{p.sms_opted_out ? 'Opted out' : 'OK'}</td>
              <td style={{ padding: 10 }}>{p.is_active ? 'Active' : 'Inactive'}</td>
            </tr>
          ))}
          {people.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>
                No people yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
