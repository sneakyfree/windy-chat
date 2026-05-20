/** Authentication state management */
import { setToken, clearToken, unifiedLogin } from './api';
import { initClient, saveSession, clearSession, startSync } from './matrix';

export interface AuthState {
  isLoggedIn: boolean;
  userId: string | null;
  displayName: string | null;
  chatUserId: string | null;
  matrixUserId: string | null;
}

// Derive the Matrix localpart ("@grantwhitmer3:chat.windychat.ai" → "grantwhitmer3")
// from a full Matrix user ID. Used as the @handle in the Social feed + profile.
function localpartFrom(matrixUserId: string | null): string | null {
  if (!matrixUserId) return null;
  const m = /^@([^:]+):/.exec(matrixUserId);
  return m ? m[1] : null;
}

export function getAuthState(): AuthState {
  const jwt = localStorage.getItem('windy_jwt');
  const matrixUserId = localStorage.getItem('matrix_user_id');
  const storedDisplayName = localStorage.getItem('windy_display_name');
  if (!jwt) return { isLoggedIn: false, userId: null, displayName: null, chatUserId: null, matrixUserId: null };

  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    const chatUserId = localpartFrom(matrixUserId);
    // Display-name precedence: explicit localStorage (from unifiedLogin
    // response) > JWT claim > chat handle > userId. UUID-as-name was the
    // grandma-demo symptom we just closed.
    const displayName =
      storedDisplayName ||
      payload.display_name ||
      chatUserId ||
      payload.sub;
    return {
      isLoggedIn: true,
      userId: payload.sub,
      displayName,
      chatUserId,
      matrixUserId,
    };
  } catch {
    return { isLoggedIn: false, userId: null, displayName: null, chatUserId: null, matrixUserId: null };
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

    // Persist display name from the unified-login response so the feed
    // can render "Grant Whitmer" instead of a UUID. unifiedLogin returns
    // both the snake_case `display_name` (legacy) and the chat-onboarding
    // schema's `display_name` for the existing-user branch.
    const displayName = result.display_name || result.matrix?.displayName;
    if (typeof displayName === 'string' && displayName.trim()) {
      localStorage.setItem('windy_display_name', displayName.trim());
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
  localStorage.removeItem('windy_display_name');
}
