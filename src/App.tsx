import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './lib/AuthContext';
import LoginPage from './pages/LoginPage';
import SetPasswordPage from './pages/SetPasswordPage';
import AppShell from './components/AppShell';
import DashboardHome from './pages/DashboardHome';
import InboxPage from './pages/InboxPage';
import InboxHistoryPage from './pages/InboxHistoryPage';
import PeoplePage from './pages/PeoplePage';
import PersonEditPage from './pages/PersonEditPage';
import ImportPage from './pages/ImportPage';
import GroupsPage from './pages/GroupsPage';
import GroupDetailPage from './pages/GroupDetailPage';
import OrgSettingsPage from './pages/OrgSettingsPage';
import UserAdminPage from './pages/UserAdminPage';
import EnrollPage from './pages/EnrollPage';
import ScenariosPage from './pages/ScenariosPage';
import ComposePage from './pages/ComposePage';
import EventsPage from './pages/EventsPage';

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
      <Route path="/enroll/:token" element={<EnrollPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardHome />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="history" element={<InboxHistoryPage />} />
        <Route path="people" element={<PeoplePage />} />
        <Route path="people/import" element={<ImportPage />} />
        <Route path="people/:id" element={<PersonEditPage />} />
        <Route path="groups" element={<GroupsPage />} />
        <Route path="groups/:id" element={<GroupDetailPage />} />
        <Route path="send" element={<ComposePage />} />
        <Route path="scenarios" element={<ScenariosPage />} />
        <Route path="events" element={<EventsPage />} />
        <Route path="settings" element={<OrgSettingsPage />} />
        <Route path="admin/users" element={<UserAdminPage />} />
      </Route>
      </Routes>
    </>
  );
}
