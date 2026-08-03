import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import type { CloudDashboardConfig } from './config';
import type { HumanSessionIdentity } from './client';

interface AuthValue {
  loading: boolean;
  session: Session | null;
  identity: HumanSessionIdentity | null;
  supabase: SupabaseClient;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function CloudAuthProvider({ config, children }: { config: CloudDashboardConfig; children: ReactNode }) {
  const client = useMemo(() => createAuthClient(config), [config.supabaseUrl, config.supabaseAnonKey]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    let active = true;
    client.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: listener } = client.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      setSession(nextSession);
      setLoading(false);
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [client]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }, [client]);

  const signOut = useCallback(async () => {
    const { error } = await client.auth.signOut();
    if (error) throw error;
  }, [client]);

  const identity = session ? { userId: session.user.id, accessToken: session.access_token } : null;
  return <AuthContext.Provider value={{ loading, session, identity, supabase: client, signIn, signOut }}>{children}</AuthContext.Provider>;
}

export function useCloudAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useCloudAuth must be used inside CloudAuthProvider');
  return value;
}

function createAuthClient(config: CloudDashboardConfig): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}
