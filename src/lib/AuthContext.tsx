import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

export interface StaffProfile {
  id: string;
  organization_id: string | null;
  full_name: string | null;
  role: 'admin' | 'staff' | 'viewer' | 'support';
  is_global_admin: boolean;
}

interface AuthContextValue {
  session: Session | null;
  staff: StaffProfile | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  staff: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [staff, setStaff] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setStaff(null);
      return;
    }
    supabase
      .from('staff_users')
      .select('id, organization_id, full_name, role, is_global_admin')
      .eq('user_id', session.user.id)
      .maybeSingle()
      .then(({ data }) => setStaff(data as StaffProfile | null));
  }, [session]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, staff, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
