/**
 * "Sign in with Windy" — OAuth2 authorization-code + PKCE against the
 * account-server (account.windyword.ai).
 *
 * beginWindySignIn() navigates the whole page to GET /api/v1/oauth/authorize.
 * The account-server renders its own login page for signed-out users, then
 * 302s back to /auth/callback?code=…&state=…. completeWindySignIn() (called
 * once on app boot) verifies state, exchanges the code + PKCE verifier at
 * POST /api/v1/oauth/token, and returns the access token (a Windy JWT the
 * chat backend accepts everywhere a Pro JWT is accepted).
 */
import { env } from '../env';

const STORAGE_KEY = 'windy_sso_pkce';
const CLIENT_ID = 'windy-chat'; // registered by the account-server ecosystem seed
export const SSO_CALLBACK_PATH = '/auth/callback';

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function callbackUri(): string {
  return window.location.origin + SSO_CALLBACK_PATH;
}

/** Kick off SSO: stash state + PKCE verifier, navigate to the authorize page. */
export async function beginWindySignIn(): Promise<void> {
  const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));

  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ state, verifier }));

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: callbackUri(),
    response_type: 'code',
    scope: 'openid profile email windy_chat:*',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  window.location.href = `${env.accountServerUrl}/api/v1/oauth/authorize?${params.toString()}`;
}

/**
 * Complete SSO if (and only if) the current URL is the OAuth callback.
 * Returns the access token, or null when this page load isn't a callback.
 * Throws with a user-facing message on any failure. Always strips the
 * code/state from the URL before returning.
 */
export async function completeWindySignIn(): Promise<string | null> {
  if (window.location.pathname !== SSO_CALLBACK_PATH) return null;

  const qs = new URLSearchParams(window.location.search);
  const code = qs.get('code');
  const state = qs.get('state');
  const oauthError = qs.get('error');
  const storedRaw = sessionStorage.getItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);

  // Clean the URL before any network round-trip so a failure can't leave
  // ?code= sitting in the address bar / history.
  window.history.replaceState(null, '', '/');

  if (oauthError) {
    throw new Error(qs.get('error_description') || `Sign-in was cancelled (${oauthError}).`);
  }
  if (!code) {
    throw new Error('Sign-in was interrupted — no code came back. Please try again.');
  }
  const stored = storedRaw ? (JSON.parse(storedRaw) as { state: string; verifier: string }) : null;
  if (!stored || !state || stored.state !== state) {
    throw new Error('Sign-in session expired. Please try again.');
  }

  const res = await fetch(`${env.accountServerUrl}/api/v1/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUri(),
      client_id: CLIENT_ID,
      code_verifier: stored.verifier,
    }),
  });
  const data = await res.json().catch(() => ({} as Record<string, string>));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Sign-in failed (${res.status}).`);
  }
  return data.access_token as string;
}
