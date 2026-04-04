/** Authentication state management */
import { setToken, clearToken, unifiedLogin } from './api';
import { initClient, saveSession, clearSession, startSync } from './matrix';

export interface AuthState {
  isLoggedIn: boolean;
  userId: string | null;
  displayName: string | null;
  matrixUserId: string | null;
}

export function getAuthState(): AuthState {
  const jwt = localStorage.getItem('windy_jwt');
  const matrixUserId = localStorage.getItem('matrix_user_id');
  if (!jwt) return { isLoggedIn: false, userId: null, displayName: null, matrixUserId: null };

  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return {
      isLoggedIn: true,
      userId: payload.sub,
      displayName: payload.display_name || payload.sub,
      matrixUserId,
    };
  } catch {
    return { isLoggedIn: false, userId: null, displayName: null, matrixUserId: null };
  }
}

export async function login(jwt: string): Promise<AuthState> {
  setToken(jwt);

  try {
    const result = await unifiedLogin(jwt);

    if (result.matrix?.accessToken && result.matrix?.matrixUserId) {
      saveSession(result.matrix.accessToken, result.matrix.matrixUserId);
      initClient(result.matrix.accessToken, result.matrix.matrixUserId);
      startSync().catch(console.warn);
    }

    return getAuthState();
  } catch (err) {
    console.warn('[auth] Unified login failed, using JWT only:', err);
    return getAuthState();
  }
}

export function logout() {
  clearToken();
  clearSession();
}
