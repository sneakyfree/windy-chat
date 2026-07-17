/** API client for Windy Chat backend services */
import { env } from '../env';

function getToken(): string | null {
  return localStorage.getItem('windy_jwt');
}

export function setToken(token: string) {
  localStorage.setItem('windy_jwt', token);
}

export function clearToken() {
  localStorage.removeItem('windy_jwt');
  localStorage.removeItem('windy_refresh');
  localStorage.removeItem('matrix_access_token');
  localStorage.removeItem('matrix_user_id');
}

// ── Silent access-token refresh ──
// The account-server access token lives 15 minutes; without a refresh the
// social feed / alerts / mail panel silently 401 mid-session (the Matrix
// session keeps working, which makes the breakage look random). Mirrors the
// windy-pro web fix (#247): store the rotating refresh token, mint a fresh
// JWT before expiry.

export function setRefreshToken(t: string) {
  localStorage.setItem('windy_refresh', t);
}
export function getRefreshToken(): string | null {
  return localStorage.getItem('windy_refresh');
}

/** Seconds until the stored access token expires (negative = already expired). */
export function tokenSecondsLeft(): number | null {
  const jwt = getToken();
  if (!jwt) return null;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    if (!payload.exp) return null;
    return Math.floor(payload.exp - Date.now() / 1000);
  } catch {
    return null;
  }
}

/**
 * Exchange the stored refresh token for a fresh access token. Returns the
 * new JWT, or null when there is no refresh token / it was rejected (in
 * which case the stale state is left alone — the UI decides what to do).
 */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;
  try {
    const res = await fetch(`${env.accountServerUrl}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) {
      // Rotated-away or revoked refresh token — drop it so we stop retrying.
      if (res.status === 401 || res.status === 403) localStorage.removeItem('windy_refresh');
      return null;
    }
    const data = await res.json();
    const jwt = data.token || data.access_token;
    if (!jwt) return null;
    setToken(jwt);
    if (data.refreshToken || data.refresh_token) setRefreshToken(data.refreshToken || data.refresh_token);
    return jwt;
  } catch {
    return null;
  }
}

async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(url, { ...options, headers });
}

// ── Auth ──

export async function unifiedLogin(jwt: string) {
  const res = await fetch(`${env.onboardingUrl}/chat/provision/unified-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  return res.json();
}

export async function loginWithCredentials(email: string, password: string) {
  const res = await fetch(`${env.accountServerUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  return res.json();
}

// ── Social ──

export async function getFeed(cursor?: string) {
  const params = cursor ? `?cursor=${cursor}` : '';
  const res = await apiFetch(`${env.socialUrl}/posts${params}`);
  if (!res.ok) throw new Error(`Feed failed: ${res.status}`);
  return res.json();
}

// ── Media ──

export interface UploadedMedia {
  media_id: string;
  url: string;
  thumbnail_url: string | null;
  mime_type: string;
  size: number;
  original_name: string;
}

/**
 * Upload a single file to the media service. Returns the media_id needed
 * when creating a post. Media is owned by the uploader; the post composer
 * keeps a list of media_ids to attach to the next createPost call.
 */
export async function uploadMedia(file: File): Promise<UploadedMedia> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${env.mediaUrl}/upload`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Upload failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return res.json();
}

export function mediaUrlFor(mediaId: string): string {
  return `${env.mediaUrl}/${mediaId}`;
}
export function mediaThumbnailUrlFor(mediaId: string): string {
  return `${env.mediaUrl}/${mediaId}/thumbnail`;
}

export async function createPost(content: string, opts?: { visibility?: string; media_ids?: string[] }) {
  // Snapshot the author's display info from localStorage so the feed can
  // render "Grant Whitmer" + "@grantwhitmer3" instead of the raw user_id
  // UUID. The social service trusts these for presentation; the
  // authoritative userId comes from the JWT.
  const displayName = localStorage.getItem('windy_display_name') || undefined;
  const matrixUserId = localStorage.getItem('matrix_user_id') || '';
  const chatUserIdMatch = /^@([^:]+):/.exec(matrixUserId);
  const chatUserId = chatUserIdMatch ? chatUserIdMatch[1] : undefined;

  const res = await apiFetch(`${env.socialUrl}/posts`, {
    method: 'POST',
    body: JSON.stringify({ content, displayName, chatUserId, ...opts }),
  });
  if (!res.ok) throw new Error(`Post failed: ${res.status}`);
  return res.json();
}

export async function likePost(postId: string) {
  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/like`, { method: 'POST' });
  if (!res.ok) throw new Error(`Like failed: ${res.status}`);
  return res.json();
}

export async function unlikePost(postId: string) {
  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/like`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Unlike failed: ${res.status}`);
  return res.json();
}

// ── Personal Profile (chat-onboarding side) ──
//
// /api/v1/chat/profile/me returns / updates the authenticated user's
// own user_profiles row. PATCH is partial — fields omitted from the body
// keep their existing value (server-side COALESCE).

export interface MyProfile {
  chatUserId: string;
  windyIdentityId: string;
  displayName: string;
  languages: string[];
  primaryLanguage: string;
  avatarUrl: string | null;
  bio: string | null;
  createdAt: string;
  onboardingComplete: boolean;
}

// Use a RELATIVE path so the Cloudflare Pages Function at
// `web/functions/api/[[path]].ts` proxies the call to chat.windychat.ai
// from the browser's POV as same-origin. Going absolute to env.matrixUrl
// turns this into a cross-origin call that hits the backend's CORS
// allowlist, which surfaces in the SPA as a stuck "Failed to fetch" if
// the browser cached an earlier denied preflight.
const onboardingBase = '/api/v1/chat/profile';

export async function getMyProfile(): Promise<MyProfile | null> {
  const res = await apiFetch(`${onboardingBase}/me`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getMyProfile failed: ${res.status}`);
  const data = await res.json();
  return data.profile;
}

export async function updateMyProfile(updates: Partial<{
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  languages: string[];
  primaryLanguage: string;
}>): Promise<MyProfile> {
  const res = await apiFetch(`${onboardingBase}/me`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`updateMyProfile failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  // Keep localStorage in sync so post composer's denormalized display info
  // matches the new value immediately.
  if (data.profile?.displayName) {
    localStorage.setItem('windy_display_name', data.profile.displayName);
  }
  return data.profile;
}

// ── Comments ──

export interface Comment {
  id: string;
  postId: string;
  userId: string;
  displayName?: string | null;
  chatUserId?: string | null;
  parentCommentId?: string | null;
  likeCount?: number;
  liked?: boolean;
  content: string;
  createdAt: string;
}

export async function getComments(postId: string): Promise<{ comments: Comment[]; count: number }> {
  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/comments`);
  if (!res.ok) throw new Error(`Load comments failed: ${res.status}`);
  return res.json();
}

export async function createComment(
  postId: string,
  content: string,
  opts?: { parentCommentId?: string | null },
): Promise<Comment> {
  // Snapshot the same author display info we attach to posts. The server
  // trusts these for presentation; userId remains JWT-bound and authoritative.
  const displayName = localStorage.getItem('windy_display_name') || undefined;
  const matrixUserId = localStorage.getItem('matrix_user_id') || '';
  const chatUserIdMatch = /^@([^:]+):/.exec(matrixUserId);
  const chatUserId = chatUserIdMatch ? chatUserIdMatch[1] : undefined;

  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/comments`, {
    method: 'POST',
    body: JSON.stringify({
      content,
      displayName,
      chatUserId,
      parentCommentId: opts?.parentCommentId || null,
    }),
  });
  if (!res.ok) throw new Error(`Create comment failed: ${res.status}`);
  return res.json();
}

export async function likeComment(postId: string, commentId: string) {
  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/comments/${commentId}/like`, { method: 'POST' });
  if (!res.ok) throw new Error(`Like comment failed: ${res.status}`);
  return res.json() as Promise<{ liked: boolean; likeCount: number }>;
}

export async function unlikeComment(postId: string, commentId: string) {
  const res = await apiFetch(`${env.socialUrl}/posts/${postId}/comments/${commentId}/like`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Unlike comment failed: ${res.status}`);
  return res.json() as Promise<{ liked: boolean; likeCount: number }>;
}

export async function followUser(userId: string) {
  const res = await apiFetch(`${env.socialUrl}/follow/${userId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`Follow failed: ${res.status}`);
  return res.json();
}

export async function unfollowUser(userId: string) {
  const res = await apiFetch(`${env.socialUrl}/follow/${userId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Unfollow failed: ${res.status}`);
  return res.json();
}

export interface Notification {
  id: string;
  type: 'like' | 'comment' | 'comment_like' | 'comment_reply' | 'repost' | 'follow' | string;
  fromUserId: string;
  postId?: string;
  read: boolean;
  createdAt: string;
}

export async function getNotifications(opts?: { unreadOnly?: boolean }): Promise<{
  notifications: Notification[];
  count: number;
  unreadCount: number;
}> {
  const q = opts?.unreadOnly ? '?unread=true' : '';
  const res = await apiFetch(`${env.socialUrl}/notifications/${q}`);
  if (!res.ok) throw new Error(`Notifications failed: ${res.status}`);
  return res.json();
}

export async function markNotificationsRead(notificationIds: string[]): Promise<{ markedRead: number }> {
  const res = await apiFetch(`${env.socialUrl}/notifications/read`, {
    method: 'POST',
    body: JSON.stringify({ notificationIds }),
  });
  if (!res.ok) throw new Error(`Mark read failed: ${res.status}`);
  return res.json();
}

export async function getTrending() {
  const res = await apiFetch(`${env.socialUrl}/posts/trending`);
  if (!res.ok) throw new Error(`Trending failed: ${res.status}`);
  return res.json();
}

export async function getPostsByHashtag(tag: string, opts?: { limit?: number; offset?: number }) {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;
  const cleanTag = tag.replace(/^#/, '');
  const res = await apiFetch(
    `${env.socialUrl}/posts/hashtag/${encodeURIComponent(cleanTag)}?limit=${limit}&offset=${offset}`,
  );
  if (!res.ok) throw new Error(`Hashtag feed failed: ${res.status}`);
  return res.json();
}

export async function getUserProfile(userId: string) {
  const res = await apiFetch(`${env.socialUrl}/profile/${userId}`);
  if (!res.ok) throw new Error(`Profile failed: ${res.status}`);
  return res.json();
}

export async function getPresence(userId: string) {
  const res = await apiFetch(`${env.socialUrl}/presence/${userId}`);
  if (!res.ok) throw new Error(`Presence failed: ${res.status}`);
  return res.json();
}
