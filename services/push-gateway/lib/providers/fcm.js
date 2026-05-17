/**
 * FCM (Firebase Cloud Messaging) provider — Android push delivery.
 *
 * Extracted from server.js inline transport so we can:
 *   1. Unit-test the wrapper without mocking out the entire express app,
 *   2. Expose a precise status() value to /health (unconfigured | ok | failed),
 *   3. Keep the env-var contract identical so production deploys don't drift.
 *
 * Env contract (do not rename without coordinated deploy):
 *   FIREBASE_SERVICE_ACCOUNT — absolute path OR require()-resolvable id of the
 *     service-account JSON. Same semantics as before this refactor.
 *
 * Status semantics (drives /health):
 *   'unconfigured' — FIREBASE_SERVICE_ACCOUNT missing OR init() never ran OR init failed.
 *   'ok'           — initialized; either no sends yet or last send succeeded.
 *   'failed'       — initialized but the most recent send() threw / rejected.
 *
 * Returns from send():
 *   { ok: true,  messageId?: string }                  on success
 *   { stubbed: true }                                  when not configured (dev only)
 *   { ok: false, error: <string>, statusCode?: int }   on failure
 */

let fcmApp = null;
let initError = null;
let lastSendOk = null; // null = no sends yet; true/false = last result

function isConfigured() {
  return fcmApp !== null;
}

function status() {
  if (!fcmApp) return 'unconfigured';
  if (lastSendOk === false) return 'failed';
  return 'ok';
}

/**
 * Initialize the FCM SDK. Idempotent — safe to call multiple times; subsequent
 * calls are no-ops once the app is created. Returns true on success.
 *
 * `adminOverride` lets tests inject a mocked firebase-admin without going
 * through require() — see tests/providers/fcm.test.js.
 */
function init({ adminOverride } = {}) {
  if (fcmApp) return true;
  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!serviceAccountPath) {
    return false;
  }
  try {
    const admin = adminOverride || require('firebase-admin');
    // require() the service account JSON. Path must be absolute or resolvable
    // from this module's cwd — matches pre-refactor behavior exactly.
    const serviceAccount = require(serviceAccountPath);
    fcmApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    initError = null;
    return true;
  } catch (err) {
    initError = err;
    fcmApp = null;
    return false;
  }
}

/**
 * Send a notification to a single FCM device token.
 *
 * `payload` shape (matches the previous inline implementation):
 *   { title, body, badge?, roomId?, eventId?, deepLink?, eventType?, imageUrl? }
 *
 * `channelId` is computed by the caller via channelForEvent(payload.eventType)
 * — we accept it pre-resolved to keep this module agnostic of the channel map.
 */
async function send(pushkey, payload, { adminOverride, channelId } = {}) {
  if (!fcmApp) {
    return { stubbed: true };
  }
  try {
    const admin = adminOverride || require('firebase-admin');
    const message = {
      token: pushkey,
      data: {
        room_id: payload.roomId || '',
        event_id: payload.eventId || '',
        deep_link: payload.deepLink || '',
        type: payload.eventType || 'chat_message',
      },
      notification: {
        title: payload.title,
        body: payload.body,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
      android: {
        priority: 'high',
        notification: {
          channelId: channelId || 'chat_messages',
          sound: 'default',
          defaultVibrateTimings: true,
          notificationCount: payload.badge,
          ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
        },
      },
    };
    const messageId = await admin.messaging().send(message);
    lastSendOk = true;
    return { ok: true, messageId };
  } catch (err) {
    lastSendOk = false;
    return { ok: false, error: err.message || 'FCM delivery failed' };
  }
}

/** Test-only — reset module state between unit tests. */
function _reset() {
  fcmApp = null;
  initError = null;
  lastSendOk = null;
}

module.exports = { init, send, status, isConfigured, _reset };
