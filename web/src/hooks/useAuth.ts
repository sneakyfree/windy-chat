import { useState, useEffect, useCallback } from 'react';
import { type AuthState, getAuthState, login as doLogin, logout as doLogout } from '../lib/auth';
import { restoreSession, startSync } from '../lib/matrix';
import { refreshAccessToken, tokenSecondsLeft, getRefreshToken } from '../lib/api';

export function useAuth() {
  const [auth, setAuth] = useState<AuthState>(getAuthState);

  useEffect(() => {
    // Restore Matrix session on mount
    if (auth.isLoggedIn) {
      const client = restoreSession();
      if (client) startSync().catch(console.warn);
    }
  }, []);

  // Silent access-token refresh (#247 parity). The account-server JWT lives
  // 15 minutes; the Matrix session lives on independently, so without this
  // the app half-dies mid-session: chat keeps working while social, alerts,
  // profile, and the mail panel all 401. On mount (covers "reopened the tab
  // hours later" — the JWT is stale but the refresh token is good for 30
  // days) and then every 5 minutes, refresh whenever <10 minutes remain.
  useEffect(() => {
    if (!auth.isLoggedIn || !getRefreshToken()) return;
    let cancelled = false;
    const tick = async () => {
      const left = tokenSecondsLeft();
      if (left !== null && left < 600) {
        const jwt = await refreshAccessToken();
        if (jwt && !cancelled) setAuth(getAuthState());
      }
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [auth.isLoggedIn]);

  const login = useCallback(async (jwt: string, refreshToken?: string | null) => {
    const state = await doLogin(jwt, refreshToken);
    setAuth(state);
    return state;
  }, []);

  const logout = useCallback(() => {
    doLogout();
    setAuth({ isLoggedIn: false, userId: null, displayName: null, chatUserId: null, matrixUserId: null });
  }, []);

  return { auth, login, logout };
}
