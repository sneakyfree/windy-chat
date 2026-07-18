/**
 * Connected-platforms ("Hub") API client + view preferences.
 *
 * The hub service lives behind the same reverse proxy as the other chat
 * backend services, so all paths here are RELATIVE (/api/v1/hub/…) and
 * carry the Windy JWT the SPA already holds — mirroring lib/api.ts.
 *
 * The login flow is a generic typed step machine, rendered client-side:
 *   GET  /:platform/provision/v3/login/flows        → available flows
 *   POST /:platform/provision/v3/login/start/:flow  → first step
 *   POST /:platform/provision/v3/login/step/:login_id/:step_id/:step_type
 *        body = user_input values, or {} for display_and_wait (long-polls
 *        up to ~125s; returns a refreshed QR step or a complete step)
 */
import * as matrix from './matrix';
import type { Provenance } from './provenance';

const hubBase = '/api/v1/hub';

// ── Types ──

export interface HubConnection {
  platform: string;
  login_id: string;
  /** Connection state — either a plain string or {state_event: '...'} */
  state?: string | { state_event?: string } | null;
  remote_name?: string | null;
  remote_id?: string | null;
}

export interface HubPlatform {
  key: string;
  displayName: string;
  puppetPrefix?: string;
  connections: HubConnection[];
}

export interface LoginFlow {
  id: string;
  name?: string;
  description?: string;
}

export interface LoginStepField {
  type: string; // phone_number | email | username | password | 2fa_code | …
  id: string;
  name?: string;
  description?: string;
  pattern?: string;
}

export interface LoginStep {
  login_id?: string;
  type: 'user_input' | 'display_and_wait' | 'cookies' | 'complete' | string;
  step_id: string;
  instructions?: string;
  user_input?: { fields?: LoginStepField[] };
  display_and_wait?: { type?: string; data?: string };
  complete?: { user_id?: string };
  error?: string;
}

export class HubApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'HubApiError';
    this.status = status;
    this.code = code;
  }
}

/** True when the backend says the user has no chat account yet (409). */
export function isNoChatAccount(err: unknown): boolean {
  return err instanceof HubApiError && (err.code === 'no_chat_account' || err.status === 409);
}

// ── Fetch plumbing (same bearer pattern as lib/api.ts) ──

async function hubFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = localStorage.getItem('windy_jwt');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${hubBase}${path}`, { ...options, headers });
  const text = await res.text().catch(() => '');
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const body = (data ?? {}) as Record<string, unknown>;
    const code =
      (typeof body.error === 'string' && body.error) ||
      (typeof body.errcode === 'string' && body.errcode) ||
      null;
    const message =
      (typeof body.message === 'string' && body.message) ||
      (typeof body.error === 'string' && body.error) ||
      `Request failed (${res.status})`;
    throw new HubApiError(message, res.status, code);
  }
  return data as T;
}

// ── Endpoints ──

export async function getPlatforms(): Promise<HubPlatform[]> {
  const data = await hubFetch<{ platforms?: HubPlatform[] }>('/platforms');
  return data?.platforms ?? [];
}

export async function getLoginFlows(platform: string): Promise<LoginFlow[]> {
  const data = await hubFetch<{ flows?: LoginFlow[] }>(
    `/${encodeURIComponent(platform)}/provision/v3/login/flows`,
  );
  return data?.flows ?? [];
}

export async function startLogin(platform: string, flowId: string): Promise<LoginStep> {
  return hubFetch<LoginStep>(
    `/${encodeURIComponent(platform)}/provision/v3/login/start/${encodeURIComponent(flowId)}`,
    { method: 'POST', body: '{}' },
  );
}

/**
 * Advance a login. For user_input steps `body` is {fieldId: value}; for
 * display_and_wait pass {} — the request long-polls server-side.
 */
export async function submitLoginStep(
  platform: string,
  loginId: string,
  stepId: string,
  stepType: string,
  body: Record<string, string>,
): Promise<LoginStep> {
  return hubFetch<LoginStep>(
    `/${encodeURIComponent(platform)}/provision/v3/login/step/${encodeURIComponent(loginId)}/${encodeURIComponent(stepId)}/${encodeURIComponent(stepType)}`,
    { method: 'POST', body: JSON.stringify(body) },
  );
}

export interface WhoamiLogin {
  id?: string;
  name?: string;
  state_event?: string;
  state?: { state_event?: string } | string;
}

export async function whoami(platform: string): Promise<{ logins?: WhoamiLogin[] } | null> {
  return hubFetch(`/${encodeURIComponent(platform)}/whoami`);
}

// ── Connection-state helpers ──

/** Normalize the various state shapes to a single state_event string. */
export function connectionStateEvent(conn: HubConnection): string {
  const s = conn.state;
  if (!s) return '';
  if (typeof s === 'string') return s.toUpperCase();
  if (typeof s.state_event === 'string') return s.state_event.toUpperCase();
  return '';
}

export function connectionNeedsRelink(conn: HubConnection): boolean {
  return connectionStateEvent(conn) === 'BAD_CREDENTIALS';
}

export function connectionIsHealthy(conn: HubConnection): boolean {
  const state = connectionStateEvent(conn);
  // Treat unknown/empty as healthy-enough — the platform listed it as a
  // live connection; only known-bad states get the re-link treatment.
  return state !== 'BAD_CREDENTIALS' && state !== 'LOGGED_OUT';
}

// ── Hub view preferences (default filter) ──
//
// The chosen lens ('all' | 'windy' | platform key) is stored in the
// com.windychat.hub account-data event so it follows the user across
// devices, mirrored to localStorage so the very first paint (before the
// initial sync delivers account data) already honors it.

export type HubFilter = 'all' | 'windy' | Provenance;

export const HUB_ACCOUNT_DATA_TYPE = 'com.windychat.hub';
// Exported so logout() can clear the previous user's view preference.
export const FILTER_STORAGE_KEY = 'windy_hub_default_filter';

export function getDefaultFilter(): HubFilter {
  try {
    const client = matrix.getClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const event = client?.getAccountData(HUB_ACCOUNT_DATA_TYPE as any);
    const fromAccount = event?.getContent?.()?.defaultFilter;
    if (typeof fromAccount === 'string' && fromAccount) return fromAccount as HubFilter;
  } catch {
    /* fall through to localStorage */
  }
  return (localStorage.getItem(FILTER_STORAGE_KEY) as HubFilter) || 'all';
}

export function setDefaultFilter(filter: HubFilter): void {
  localStorage.setItem(FILTER_STORAGE_KEY, filter);
  try {
    const client = matrix.getClient();
    if (!client) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing = client.getAccountData(HUB_ACCOUNT_DATA_TYPE as any)?.getContent?.() ?? {};
    // The SDK's setAccountData is typed against its own known event map;
    // com.windychat.hub is our custom event, hence the cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client.setAccountData as any)(HUB_ACCOUNT_DATA_TYPE, { ...existing, defaultFilter: filter })
      .catch(() => {
        /* non-fatal — localStorage already holds it */
      });
  } catch {
    /* non-fatal */
  }
}
