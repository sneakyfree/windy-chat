/**
 * Windy Chat — Translation Application Service Handler
 * K9: Real-time auto-translation via Synapse event stream
 *
 * When Synapse receives a message, it forwards the event to this handler.
 * The handler:
 *   1. Checks if the room has users with different preferred languages
 *   2. Translates the message via the translation proxy
 *   3. Posts translated versions as related events (m.relates_to)
 *
 * This runs as Express routes mounted on the translation service.
 */

const { Router } = require('express');
const http = require('http');
const crypto = require('crypto');
const translationDb = require('../lib/db');

const router = Router();

const HS_TOKEN = process.env.TRANSLATION_HS_TOKEN || '';
const AS_TOKEN = process.env.TRANSLATION_AS_TOKEN || '';
const SYNAPSE_URL = process.env.SYNAPSE_URL || 'http://localhost:8008';
const TRANSLATE_PROXY_URL = `http://localhost:${process.env.PORT || 8106}`;

// In-memory cache of room → languages needed
const roomLanguageCache = new Map();

/**
 * Verify that the request comes from Synapse using the hs_token.
 */
function verifyHsToken(req, res, next) {
  const token = req.query.access_token;
  if (!HS_TOKEN) {
    // Dev mode — skip verification
    return next();
  }
  if (token !== HS_TOKEN) {
    return res.status(403).json({ errcode: 'M_FORBIDDEN', error: 'Invalid hs_token' });
  }
  next();
}

/**
 * Forward a translation request to the local translation proxy.
 */
function translateText(text, sourceLang, targetLang) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text, source_lang: sourceLang, target_lang: targetLang });
    const url = new URL('/api/v1/translate', TRANSLATE_PROXY_URL);
    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': `Bearer ${process.env.CHAT_API_TOKEN || ''}`,
      },
      timeout: 5000,
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.translated_text || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

/**
 * Send a translated message back to the room as a related event.
 */
function sendTranslatedEvent(roomId, originalEventId, translatedText, targetLang) {
  return new Promise((resolve) => {
    if (!AS_TOKEN) { resolve(false); return; }

    const txnId = crypto.randomBytes(16).toString('hex');
    const eventBody = JSON.stringify({
      msgtype: 'm.text',
      body: translatedText,
      format: 'org.matrix.custom.html',
      formatted_body: `<em>[${targetLang}]</em> ${translatedText}`,
      'm.relates_to': {
        rel_type: 'm.translation',
        event_id: originalEventId,
      },
      'com.windypro.translation': {
        target_lang: targetLang,
        original_event_id: originalEventId,
        auto_translated: true,
      },
    });

    const url = new URL(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      SYNAPSE_URL
    );
    const opts = {
      method: 'PUT',
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}?access_token=${AS_TOKEN}&user_id=@windy_translator:chat.windypro.com`,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(eventBody),
      },
      timeout: 5000,
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve(res.statusCode < 300));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.write(eventBody);
    req.end();
  });
}

/**
 * Get the set of preferred languages for users in a room.
 * Returns a Map of userId → preferredLanguage.
 */
function getRoomLanguages(roomId) {
  // For now, return all known user preferences
  // In production, this would query room membership + user prefs
  return roomLanguageCache.get(roomId) || new Map();
}

// ── PUT /transactions/:txnId — Synapse pushes events here ──
router.put('/transactions/:txnId', verifyHsToken, async (req, res) => {
  const events = req.body?.events || [];

  // Process events asynchronously — respond immediately
  res.json({});

  for (const event of events) {
    // Only process text messages
    if (event.type !== 'm.room.message') continue;
    if (!event.content || event.content.msgtype !== 'm.text') continue;
    if (!event.content.body) continue;

    // Skip our own translated messages
    if (event.sender === '@windy_translator:chat.windypro.com') continue;
    if (event.content['com.windypro.translation']?.auto_translated) continue;

    const roomId = event.room_id;
    const text = event.content.body;
    const eventId = event.event_id;
    const senderLang = 'en'; // Default; in production, look up sender's preference

    // Get target languages for this room
    const roomLangs = getRoomLanguages(roomId);
    const targetLangs = new Set();
    for (const [userId, lang] of roomLangs) {
      if (userId !== event.sender && lang !== senderLang) {
        targetLangs.add(lang);
      }
    }

    // Translate to each needed language
    for (const targetLang of targetLangs) {
      const translated = await translateText(text, senderLang, targetLang);
      if (translated && translated !== text) {
        await sendTranslatedEvent(roomId, eventId, translated, targetLang);
        console.log(`[translation-as] Translated in ${roomId}: "${text.substring(0, 30)}..." → ${targetLang}`);
      }
    }
  }
});

// ── GET /rooms/:roomAlias — Synapse queries room existence ──
router.get('/rooms/:roomAlias', verifyHsToken, (_req, res) => {
  // We don't create rooms
  res.status(404).json({ errcode: 'M_NOT_FOUND' });
});

// ── GET /users/:userId — Synapse queries user existence ──
router.get('/users/:userId', verifyHsToken, (_req, res) => {
  // We don't create users (except the translator bot)
  res.status(404).json({ errcode: 'M_NOT_FOUND' });
});

// ── Admin endpoint: set room language preferences ──
router.post('/rooms/:roomId/languages', (req, res) => {
  const { roomId } = req.params;
  const { users } = req.body; // { userId: lang, ... }
  if (!users || typeof users !== 'object') {
    return res.status(400).json({ error: 'users object required: { userId: lang }' });
  }

  const langMap = new Map(Object.entries(users));
  roomLanguageCache.set(roomId, langMap);

  res.json({ room_id: roomId, languages: users, user_count: langMap.size });
});

module.exports = router;
