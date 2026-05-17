/**
 * APNs (Apple Push Notification Service) provider — iOS push delivery.
 *
 * Uses the `apn` npm package (also reachable as `@parse/node-apn`) with a P8
 * key file at APNS_KEY_PATH. Same env contract as the pre-refactor inline
 * implementation so prod deploys don't drift.
 *
 * Env contract:
 *   APNS_KEY_PATH    — absolute path to the .p8 key file
 *   APNS_KEY_ID      — 10-char key ID from Apple Developer
 *   APNS_TEAM_ID     — 10-char team ID
 *   APNS_BUNDLE_ID   — app bundle id (used as APNs `topic`)
 *   NODE_ENV         — `production` flips the apn.Provider to prod gateway
 *
 * Status semantics (drives /health) — same shape as fcm.js.
 */

let provider = null;
let lastSendOk = null;

function isConfigured() {
  return provider !== null;
}

function status() {
  if (!provider) return 'unconfigured';
  if (lastSendOk === false) return 'failed';
  return 'ok';
}

function _hasAllEnv() {
  return Boolean(
    process.env.APNS_KEY_PATH
    && process.env.APNS_KEY_ID
    && process.env.APNS_TEAM_ID
    && process.env.APNS_BUNDLE_ID,
  );
}

/**
 * Initialize the APNs provider. Idempotent. Returns true on success.
 *
 * `apnOverride` lets tests inject a mocked apn module — see tests/providers/apns.test.js.
 */
function init({ apnOverride } = {}) {
  if (provider) return true;
  if (!_hasAllEnv()) return false;
  try {
    const apn = apnOverride || require('apn');
    provider = new apn.Provider({
      token: {
        key: process.env.APNS_KEY_PATH,
        keyId: process.env.APNS_KEY_ID,
        teamId: process.env.APNS_TEAM_ID,
      },
      production: process.env.NODE_ENV === 'production',
    });
    return true;
  } catch (_err) {
    provider = null;
    return false;
  }
}

async function send(pushkey, payload, { apnOverride } = {}) {
  if (!provider) {
    return { stubbed: true };
  }
  try {
    const apn = apnOverride || require('apn');
    const note = new apn.Notification();
    note.alert = { title: payload.title, body: payload.body };
    note.badge = payload.badge;
    note.sound = 'default';
    note.topic = process.env.APNS_BUNDLE_ID;
    note.payload = { room_id: payload.roomId, event_id: payload.eventId };
    note.pushType = 'alert';
    note.priority = 10;

    const result = await provider.send(note, pushkey);
    // apn returns { sent: [...], failed: [...] }
    if (result && Array.isArray(result.failed) && result.failed.length > 0) {
      lastSendOk = false;
      const first = result.failed[0] || {};
      return {
        ok: false,
        error: first.response?.reason || first.error || 'APNs delivery failed',
        statusCode: first.status,
      };
    }
    lastSendOk = true;
    const messageId = result?.sent?.[0]?.device || null;
    return { ok: true, messageId };
  } catch (err) {
    lastSendOk = false;
    return { ok: false, error: err.message || 'APNs delivery failed' };
  }
}

function _reset() {
  provider = null;
  lastSendOk = null;
}

module.exports = { init, send, status, isConfigured, _reset };
