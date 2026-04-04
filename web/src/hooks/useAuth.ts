import { useState, useEffect, useCallback } from 'react';
import { type AuthState, getAuthState, login as doLogin, logout as doLogout } from '../lib/auth';
import { restoreSession, startSync } from '../lib/matrix';

export function useAuth() {
  const [auth, setAuth] = useState<AuthState>(getAuthState);

  useEffect(() => {
    // Restore Matrix session on mount
    if (auth.isLoggedIn) {
      const client = restoreSession();
      if (client) startSync().catch(console.warn);
    }
  }, []);

  const login = useCallback(async (jwt: string) => {
    const state = await doLogin(jwt);
    setAuth(state);
    return state;
  }, []);

  const logout = useCallback(() => {
    doLogout();
    setAuth({ isLoggedIn: false, userId: null, displayName: null, matrixUserId: null });
  }, []);

  return { auth, login, logout };
}
