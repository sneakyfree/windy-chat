/** Authentication state management */
import { setToken, setRefreshToken, clearToken, unifiedLogin, revokeAccountSession } from './api';
import { initClient, saveSession, clearSession, startSync, revokeMatrixSession, deleteCryptoStores } from './matrix';
import { PUSH_ENABLED_FLAG } from './push';
import { FILTER_STORAGE_KEY as HUB_FILTER_KEY } from './hub';

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

export async function login(jwt: string, refreshToken?: string | null): Promise<AuthState> {
  setToken(jwt);
  // Persist the rotating refresh token so useAuth's silent-refresh loop can
  // keep the 15-minute access token alive for the whole session (#247 parity).
  if (refreshToken) setRefreshToken(refreshToken);

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

/**
 * Complete logout. Session-hygiene fix: "sign out" used to be client-only —
 * both the Windy refresh token and the Matrix access token stayed VALID
 * server-side, and stale per-user keys survived in localStorage. Server-side
 * revokes run FIRST (while the tokens are still stored), then everything
 * local is cleared. Both revokes are best-effort so a dead network can never
 * trap the user in a session.
 */
export async function logout(): Promise<void> {
  // 1. Server-side revokes, while the tokens are still present.
  //    - Synapse invalidates the Matrix access token (/logout)
  //    - account-server deletes ALL refresh tokens + blacklists the JWT
  await Promise.all([revokeMatrixSession(), revokeAccountSession()]);

  // 2. Local clears (clearSession also stops the Matrix client).
  clearToken();
  clearSession();
  localStorage.removeItem('windy_display_name');
  localStorage.removeItem('windy_chat_onboarded');
  localStorage.removeItem(PUSH_ENABLED_FLAG);
  localStorage.removeItem(HUB_FILTER_KEY);

  // 3. Sweep matrix-js-sdk residue — e.g. mxjssdk_memory_filter_FILTER_SYNC_@…
  //    embeds the previous user's Matrix ID. Iterate backwards: removal
  //    reindexes localStorage.
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('mxjssdk_') || key.startsWith('mx_'))) {
      localStorage.removeItem(key);
    }
  }

  // 4. Drop the E2E crypto stores so keys don't persist across users.
  deleteCryptoStores();
}
