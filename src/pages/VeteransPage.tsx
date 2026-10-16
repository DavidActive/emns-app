import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

interface EnrolledPerson {
  id: string;
  full_name: string;
  phone_number: string;
  enrolled: boolean;
  branch_of_service: string | null;
  va_connected: boolean | null;
}

export default function VeteransPage() {
  const navigate = useNavigate();
  const [people, setPeople] = useState<EnrolledPerson[]>([]);

  useEffect(() => {
    supabase
      .from('enrolled_people')
      .select('id, full_name, phone_number, enrolled, branch_of_service, va_connected')
      .order('full_name')
      .then(({ data }) => setPeople((data as EnrolledPerson[]) ?? []));
  }, []);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Veterans &amp; Supporters</h1>
        <button className="btn-primary" onClick={() => navigate('/veterans/new')}>
          + Add Veteran / Supporter
        </button>
      </div>
      <p style={{ color: 'var(--brand-gray-600)' }}>
        Roster for your VetSupport Group. Click a row to view or edit that person's profile — branch, VA
        connection, primary contact, and enrollment status aren't things we can learn from a text message, so
        they're maintained here. For AI activity summaries and roster-wide triage, see the Reports page.
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--brand-gray-300)' }}>
            <th style={{ padding: 10 }}>Name</th>
            <th style={{ padding: 10 }}>Phone</th>
            <th style={{ padding: 10 }}>Branch</th>
            <th style={{ padding: 10 }}>VA-connected</th>
            <th style={{ padding: 10 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr
              key={p.id}
              onClick={() => navigate(`/veterans/${p.id}`)}
              style={{ borderBottom: '1px solid var(--brand-gray-300)', cursor: 'pointer' }}
            >
              <td style={{ padding: 10, fontWeight: 600, color: 'var(--brand-teal)' }}>{p.full_name}</td>
              <td style={{ padding: 10 }}>{p.phone_number}</td>
              <td style={{ padding: 10 }}>{p.branch_of_service ?? '—'}</td>
              <td style={{ padding: 10 }}>{p.va_connected === null ? '—' : p.va_connected ? 'Yes' : 'No'}</td>
              <td style={{ padding: 10 }}>{p.enrolled ? 'Enrolled' : 'Inactive'}</td>
            </tr>
          ))}
          {people.length === 0 && (
            <tr>
              <td colSpan={5} style={{ padding: 20, textAlign: 'center', color: 'var(--brand-gray-600)' }}>
                No one enrolled yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
