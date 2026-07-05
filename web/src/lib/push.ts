/**
 * Web push — closes the "closed tab = silent agent" gap.
 *
 * The server side has been complete for months (push-gateway: VAPID
 * web-push provider, /api/v1/chat/push/{vapid-key,register}, and the
 * Matrix /_matrix/push/v1/notify handler); this module is the missing
 * client half:
 *
 *   1. GET  {chat}/api/v1/chat/push/vapid-key      → public key
 *   2. pushManager.subscribe(applicationServerKey)  → subscription
 *   3. POST {chat}/api/v1/chat/push/register        (windy JWT auth)
 *      pushkey = JSON.stringify(subscription) — this is what the
 *      gateway's web-push provider JSON.parses back at send time.
 *   4. POST /_matrix/client/v3/pushers/set          (matrix token)
 *      so Synapse notifies the gateway on every message event.
 *
 * The SAME pushkey string is used in (3) and (4) — the gateway keys
 * its platform/mute lookup on it. Known limit: Synapse caps pushkey at
 * 512 chars; Chrome/Firefox/Safari subscription JSON is ~350-450 so it
 * fits, but some Edge/WNS endpoints run longer and will fail pusher
 * registration — surfaced as 'error', the toggle just stays off.
 */
import { env } from '../env';

export type PushStatus =
  | 'enabled'
  | 'disabled'
  | 'unsupported'
  | 'denied'
  | 'unavailable'
  | 'error';

const PUSH_BASE = `${env.matrixUrl}/api/v1/chat/push`;
const APP_ID = 'ai.windychat.web';
const ENABLED_FLAG = 'windy_push_enabled';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function windyIdentityId(): string | null {
  const jwt = localStorage.getItem('windy_jwt');
  if (!jwt) return null;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return payload.windy_identity_id || payload.sub || null;
  } catch {
    return null;
  }
}

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function pushState(): PushStatus {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return localStorage.getItem(ENABLED_FLAG) === '1' &&
    Notification.permission === 'granted'
    ? 'enabled'
    : 'disabled';
}

export async function enableWebPush(): Promise<PushStatus> {
  if (!pushSupported()) return 'unsupported';
  const jwt = localStorage.getItem('windy_jwt');
  const matrixToken = localStorage.getItem('matrix_access_token');
  const userId = windyIdentityId();
  if (!jwt || !matrixToken || !userId) return 'error';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  // 1. Public VAPID key (503 = keys not configured on this deploy).
  let publicKey: string;
  try {
    const res = await fetch(`${PUSH_BASE}/vapid-key`);
    if (res.status === 503) return 'unavailable';
    if (!res.ok) return 'error';
    publicKey = (await res.json()).publicKey;
  } catch {
    return 'error';
  }

  // 2. Browser subscription (reuse an existing one when present —
  //    subscribe() with the same key is idempotent per spec, but a key
  //    mismatch throws, so drop and re-subscribe on that path).
  let subscription: PushSubscription;
  try {
    const reg = await navigator.serviceWorker.ready;
    try {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    } catch {
      const existing = await reg.pushManager.getSubscription();
      if (existing) await existing.unsubscribe();
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }
  } catch {
    return 'error';
  }

  const pushkey = JSON.stringify(subscription);

  // 3. Register with the push-gateway (platform + mute lookups key on
  //    this exact string).
  try {
    const res = await fetch(`${PUSH_BASE}/register`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        pushkey,
        userId,
        platform: 'web',
        appId: APP_ID,
        deviceName: 'Web browser',
      }),
    });
    if (!res.ok) return 'error';
  } catch {
    return 'error';
  }

  // 4. Synapse pusher — this is what makes MESSAGE events push. The
  //    gateway's notify URL is served on the same public host (nginx
  //    routes /_matrix/push/ to the gateway, everything else under
  //    /_matrix/ to Synapse).
  try {
    const res = await fetch(`${env.matrixUrl}/_matrix/client/v3/pushers/set`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${matrixToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        app_id: APP_ID,
        pushkey,
        kind: 'http',
        app_display_name: 'Windy Chat Web',
        device_display_name: 'Web browser',
        lang: 'en',
        data: { url: `${env.matrixUrl}/_matrix/push/v1/notify` },
        append: false,
      }),
    });
    if (!res.ok) return 'error';
  } catch {
    return 'error';
  }

  localStorage.setItem(ENABLED_FLAG, '1');
  return 'enabled';
}

export async function disableWebPush(): Promise<void> {
  localStorage.removeItem(ENABLED_FLAG);
  const matrixToken = localStorage.getItem('matrix_access_token');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      // Delete the Synapse pusher first (kind: null removes it), then
      // drop the browser subscription. Both best-effort.
      if (matrixToken) {
        await fetch(`${env.matrixUrl}/_matrix/client/v3/pushers/set`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${matrixToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            app_id: APP_ID,
            pushkey: JSON.stringify(sub),
            kind: null,
          }),
        }).catch(() => {});
      }
      await sub.unsubscribe();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Silent refresh on app load: if the user enabled push before and the
 * browser still grants permission, re-run the pipeline (subscriptions
 * rotate; unified-login mints fresh Matrix sessions whose pushers we
 * want current). No permission prompt is ever shown from here.
 */
export async function resubscribeIfGranted(): Promise<void> {
  if (!pushSupported()) return;
  if (Notification.permission !== 'granted') return;
  if (localStorage.getItem(ENABLED_FLAG) !== '1') return;
  await enableWebPush().catch(() => {});
}
