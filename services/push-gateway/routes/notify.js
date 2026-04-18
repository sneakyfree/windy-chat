/**
 * Windy Push Bus — Shared Notification Endpoint
 *
 * POST /api/v1/push/notify
 *
 * Canonical publish surface for all Windy services. Any producer (Mail,
 * Chat homeserver, Clone, Fly, Code) can publish a notification for a
 * user by windy_identity_id and this endpoint fans it out to every
 * registered device (FCM / APNs / Web Push) that belongs to them.
 *
 * Contract (stable — services depend on this):
 *   Request body:
 *     {
 *       "windy_identity_id": "id_abc123",     // required
 *       "event_type":        "chat.new_message" | "mail.inbound" | ... ,
 *       "title":             "Grant Whitmer",
 *       "body":              "New message",
 *       "deep_link":         "windy://chat/!room:chat.windyword.ai"   // optional
 *     }
 *   Headers:
 *     X-Push-Bus-Token: <shared secret (PUSH_BUS_TOKEN)>
 *
 *   Response:
 *     { "delivered": <int>, "rejected": [<pushkey>...], "event_type": "..." }
 *
 * Privacy: per homeserver policy, `body` should not contain message content
 * for chat.* events — publishers are responsible for stripping sensitive
 * text upstream (we pass through whatever the caller provides).
 */

const express = require('express');
const { asyncHandler } = require('../../shared/async-handler');

const router = express.Router();
const pushDb = require('../lib/db');

const PUSH_BUS_TOKEN = process.env.PUSH_BUS_TOKEN || '';

function busAuthMiddleware(req, res, next) {
  if (!PUSH_BUS_TOKEN) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ error: 'PUSH_BUS_TOKEN not configured' });
    }
    console.warn('[notify] PUSH_BUS_TOKEN not set — skipping auth (NODE_ENV != production)');
    return next();
  }
  const token = req.headers['x-push-bus-token'];
  if (!token || token !== PUSH_BUS_TOKEN) {
    return res.status(401).json({ error: 'Invalid push bus token' });
  }
  next();
}

router.post('/notify', busAuthMiddleware, asyncHandler(async (req, res) => {
  const {
    windy_identity_id, user_id, event_type, title, body, deep_link,
    subscribers_only,
  } = req.body || {};

  const recipient = windy_identity_id || user_id;
  if (!recipient || typeof recipient !== 'string') {
    return res.status(400).json({ error: 'windy_identity_id is required' });
  }
  if (!event_type || typeof event_type !== 'string') {
    return res.status(400).json({ error: 'event_type is required' });
  }
  if (!title || typeof title !== 'string') {
    return res.status(400).json({ error: 'title is required' });
  }

  // `subscribers_only: true` means the caller has already delivered device
  // push via another path (e.g. Synapse's native /_matrix/push/v1/notify) and
  // we should only fan out to cross-service subscribers. Today there are no
  // registered subscribers, so this is a no-op log — future wiring for
  // Mail/Clone/Fly/Code to consume these events lands here.
  if (subscribers_only === true) {
    console.log(`[notify] ${event_type} → ${recipient} (subscribers_only, device push skipped)`);
    return res.json({ delivered: 0, rejected: [], event_type, subscribers_only: true });
  }

  // Push tokens are indexed by user_id — fan out to every device the user has
  // registered. See /api/v1/chat/push/register in server.js for how tokens get in.
  const tokens = pushDb.db
    .prepare('SELECT pushkey, platform FROM push_tokens WHERE user_id = ?')
    .all(recipient);

  const payload = {
    title,
    body: body || '',
    deepLink: deep_link || null,
    eventType: event_type,
  };

  // Delegate actual send to the transports initialized in server.js.
  // We use the global published senders on `app.locals` — see server.js.
  const { sendFCM, sendAPNs, sendWebPush } = req.app.locals.transports || {};
  if (!sendFCM || !sendAPNs || !sendWebPush) {
    console.error('[notify] transports not initialized on app.locals');
    return res.status(500).json({ error: 'Push transports not initialized' });
  }

  const rejected = [];
  let delivered = 0;
  for (const t of tokens) {
    let result;
    if (t.platform === 'web') result = await sendWebPush(t.pushkey, payload);
    else if (t.platform === 'ios') result = await sendAPNs(t.pushkey, payload);
    else result = await sendFCM(t.pushkey, payload);

    if (result && result.success) {
      delivered += 1;
      pushDb.touchToken.run(Date.now(), t.pushkey);
    } else {
      rejected.push(t.pushkey);
    }
  }

  console.log(`[notify] ${event_type} → ${recipient}: ${delivered}/${tokens.length} delivered`);

  res.json({ delivered, rejected, event_type });
}));

module.exports = router;
