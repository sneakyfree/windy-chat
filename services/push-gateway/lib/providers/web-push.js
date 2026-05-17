/**
 * Web Push (VAPID) provider — browser push delivery.
 *
 * Uses the `web-push` npm package. Same env contract as the pre-refactor
 * inline implementation.
 *
 * Env contract:
 *   VAPID_PUBLIC_KEY  — base64url-encoded P-256 public key
 *   VAPID_PRIVATE_KEY — base64url-encoded P-256 private key
 *   VAPID_SUBJECT     — mailto: or https: URL identifying the sender
 *                       (defaults to mailto:admin@windychat.ai)
 *
 * Status semantics (drives /health) — same shape as fcm.js.
 *
 * Subscription-expired handling:
 *   The caller (server.js / routes/notify.js) is responsible for deleting the
 *   pushkey from the DB when send() returns { ok: false, expired: true }.
 *   We don't import pushDb here to keep this module unit-testable in isolation.
 */

let ready = false;
let lastSendOk = null;

function isConfigured() {
  return ready;
}

function status() {
  if (!ready) return 'unconfigured';
  if (lastSendOk === false) return 'failed';
  return 'ok';
}

function init({ webpushOverride } = {}) {
  if (ready) return true;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@windychat.ai';
  if (!publicKey || !privateKey) return false;
  try {
    const webpush = webpushOverride || require('web-push');
    webpush.setVapidDetails(subject, publicKey, privateKey);
    ready = true;
    return true;
  } catch (_err) {
    ready = false;
    return false;
  }
}

async function send(pushkey, payload, { webpushOverride } = {}) {
  if (!ready) {
    return { stubbed: true };
  }
  try {
    const webpush = webpushOverride || require('web-push');
    const subscription = typeof pushkey === 'string' ? JSON.parse(pushkey) : pushkey;
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: payload.roomId || 'windy-chat',
      data: {
        room_id: payload.roomId,
        event_id: payload.eventId,
        url: payload.deepLink || '/',
      },
    });
    const result = await webpush.sendNotification(subscription, body);
    lastSendOk = true;
    return { ok: true, statusCode: result?.statusCode };
  } catch (err) {
    lastSendOk = false;
    // 404 / 410 → endpoint is dead, caller should delete the subscription.
    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
      return { ok: false, error: 'subscription_expired', expired: true, statusCode: err.statusCode };
    }
    return { ok: false, error: err.message || 'Web Push delivery failed' };
  }
}

function _reset() {
  ready = false;
  lastSendOk = null;
}

module.exports = { init, send, status, isConfigured, _reset };
