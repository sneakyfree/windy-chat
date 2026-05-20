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
  localStorage.removeItem('matrix_access_token');
  localStorage.removeItem('matrix_user_id');
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

export async function getNotifications() {
  const res = await apiFetch(`${env.socialUrl}/notifications`);
  if (!res.ok) throw new Error(`Notifications failed: ${res.status}`);
  return res.json();
}

export async function getTrending() {
  const res = await apiFetch(`${env.socialUrl}/posts/trending`);
  if (!res.ok) throw new Error(`Trending failed: ${res.status}`);
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
