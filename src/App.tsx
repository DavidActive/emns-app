import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import LoginPage from './pages/LoginPage';
import SetPasswordPage from './pages/SetPasswordPage';
import AppShell from './components/AppShell';
import DashboardHome from './pages/DashboardHome';
import TriageInbox from './pages/TriageInbox';
import AlertsHistoryPage from './pages/AlertsHistoryPage';
import ReportsPage from './pages/ReportsPage';
import VeteransPage from './pages/VeteransPage';
import VeteranEditPage from './pages/VeteranEditPage';
import OrgSettingsPage from './pages/OrgSettingsPage';
import UserAdminPage from './pages/UserAdminPage';

function RequireAuth({ children }: { children: JSX.Element }) {
  const { session, loading } = useAuth();
  if (loading) return <div style={{ padding: 40 }}>Loading…</div>;
  if (!session) return <Navigate to="/login" replace />;
  return children;
}

// Supabase invite/recovery links land wherever the project's Site URL is set (often "/"),
// with the token in the URL hash (e.g. "#access_token=...&type=invite"). Regardless of
// which path the link lands on, redirect straight to /set-password so a fresh invite
// always prompts the user to create a password before touching the rest of the app.
function InviteRedirect() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const hash = location.hash;
    if ((hash.includes('type=invite') || hash.includes('type=recovery')) && location.pathname !== '/set-password') {
      navigate(`/set-password${hash}`, { replace: true });
    }
  }, [location, navigate]);

  return null;
}

export default function App() {
  return (
    <>
      <InviteRedirect />
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/set-password" element={<SetPasswordPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardHome />} />
        <Route path="triage" element={<TriageInbox />} />
        <Route path="alerts" element={<AlertsHistoryPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="veterans" element={<VeteransPage />} />
        <Route path="veterans/:id" element={<VeteranEditPage />} />
        <Route path="settings" element={<OrgSettingsPage />} />
        <Route path="admin/users" element={<UserAdminPage />} />
      </Route>
      </Routes>
    </>
  );
}
