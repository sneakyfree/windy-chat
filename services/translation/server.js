/**
 * Windy Chat — Translation Proxy Service
 * K9: Translation Integration (DNA Strand K)
 *
 * Bridges Windy Chat with Windy Pro's translation engine.
 * Handles:
 *   - Translation requests with caching (24h TTL)
 *   - User language preferences
 *   - Rate limiting (100 translations/min per user)
 *
 * Port: 8106
 */

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { createCorsOptions } = require('../shared/cors');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { createHealthHandler } = require('../shared/health');
const { asyncHandler } = require('../shared/async-handler');
const { createAuthMiddleware } = require('../shared/jwt-verify');
const translationDb = require('./lib/db');

const appserviceRouter = require('./appservice/handler');

const app = express();
const PORT = process.env.PORT || 8106;
const TRANSLATE_URL = process.env.WINDY_TRANSLATE_URL || 'http://localhost:9877';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

app.use(cors(createCorsOptions()));
app.use(express.json({ limit: '1mb' }));

const auth = createAuthMiddleware();

// ── Matrix Application Service endpoints (K9) ──
// Synapse pushes events to /_matrix/app/v1/transactions/:txnId
app.use('/_matrix/app/v1', appserviceRouter);

// ── Health ──
app.get('/health', createHealthHandler({
  service: 'windy-chat-translation',
  version: '1.0.0',
  checks: async () => ({
    translateServer: TRANSLATE_URL,
    cacheEnabled: true,
  }),
}));

// ── Rate limiter for translations: 100/min per user ──
const translateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  keyGenerator: (req) => req.user?.sub || req.ip,
  message: { error: 'Translation rate limit exceeded (100/min)' },
});

/**
 * Generate a cache key from text + source + target language.
 */
function cacheKey(text, sourceLang, targetLang) {
  return crypto.createHash('sha256')
    .update(`${sourceLang}:${targetLang}:${text}`)
    .digest('hex');
}

/**
 * Forward translation request to Windy Pro's translate-api.
 * Returns { translated_text, confidence } or null on failure.
 */
function forwardToTranslateServer(text, sourceLang, targetLang) {
  return new Promise((resolve) => {
    const url = new URL('/api/v1/translate', TRANSLATE_URL);
    const body = JSON.stringify({
      text,
      source_lang: sourceLang,
      target_lang: targetLang,
    });

    const opts = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    };

    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({
            translated_text: result.translated_text || result.translation || data,
            confidence: result.confidence || null,
          });
        } catch {
          resolve(null);
        }
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ── Translate ──
app.post('/api/v1/translate', auth, translateLimiter, asyncHandler(async (req, res) => {
  const { text, source_lang, target_lang, room_id } = req.body;

  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text is required' });
  }
  if (!source_lang || typeof source_lang !== 'string') {
    return res.status(400).json({ error: 'source_lang is required' });
  }
  if (!target_lang || typeof target_lang !== 'string') {
    return res.status(400).json({ error: 'target_lang is required' });
  }
  if (source_lang === target_lang) {
    return res.json({ translated_text: text, source_lang, target_lang, confidence: 1.0, cached: false });
  }

  // Check cache
  const key = cacheKey(text, source_lang, target_lang);
  const cutoff = Date.now() - CACHE_TTL_MS;
  const cached = translationDb.getCache.get(key, cutoff);
  if (cached) {
    return res.json({
      translated_text: cached.translated_text,
      source_lang: cached.source_lang,
      target_lang: cached.target_lang,
      confidence: cached.confidence,
      cached: true,
    });
  }

  // Forward to Windy Pro translate-api
  const result = await forwardToTranslateServer(text, source_lang, target_lang);

  if (!result) {
    // Stub response when translate server is unavailable
    console.warn(`[translation] Translate server unavailable at ${TRANSLATE_URL} — returning stub`);
    return res.json({
      translated_text: text,
      source_lang,
      target_lang,
      confidence: 0,
      cached: false,
      stub: true,
    });
  }

  // Cache the result
  translationDb.upsertCache.run({
    cache_key: key,
    source_text: text,
    source_lang,
    target_lang,
    translated_text: result.translated_text,
    confidence: result.confidence,
    created_at: Date.now(),
  });

  res.json({
    translated_text: result.translated_text,
    source_lang,
    target_lang,
    confidence: result.confidence,
    cached: false,
  });
}));

// ── Language Preferences ──
app.get('/api/v1/translate/preferences', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const prefs = translationDb.getPreferences.get(userId);

  if (!prefs) {
    return res.json({
      user_id: userId,
      preferred_language: 'en',
      auto_translate: true,
    });
  }

  res.json({
    user_id: prefs.user_id,
    windy_identity_id: prefs.windy_identity_id,
    preferred_language: prefs.preferred_language,
    auto_translate: !!prefs.auto_translate,
  });
}));

app.post('/api/v1/translate/preferences', auth, asyncHandler(async (req, res) => {
  const userId = req.user.sub;
  const { preferred_language, auto_translate } = req.body;

  if (!preferred_language || typeof preferred_language !== 'string') {
    return res.status(400).json({ error: 'preferred_language is required' });
  }

  if (preferred_language.length < 2 || preferred_language.length > 10) {
    return res.status(400).json({ error: 'preferred_language must be a valid language code (2-10 chars)' });
  }

  translationDb.upsertPreferences.run({
    user_id: userId,
    windy_identity_id: req.user.windy_identity_id || null,
    preferred_language,
    auto_translate: auto_translate !== false ? 1 : 0,
    updated_at: new Date().toISOString(),
  });

  res.json({
    user_id: userId,
    preferred_language,
    auto_translate: auto_translate !== false,
  });
}));

// ── Prune expired cache entries (on startup and every hour) ──
function pruneExpiredCache() {
  const cutoff = Date.now() - CACHE_TTL_MS;
  const result = translationDb.pruneCache.run(cutoff);
  if (result.changes > 0) {
    console.log(`[translation] Pruned ${result.changes} expired cache entries`);
  }
}

pruneExpiredCache();
setInterval(pruneExpiredCache, 60 * 60 * 1000);

// ── 404 ──
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Error handler ──
app.use((err, _req, res, _next) => {
  console.error('[translation] Error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// Only listen if run directly (not imported by tests)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[translation] listening on :${PORT}`);
    console.log(`[translation] Translate server: ${TRANSLATE_URL}`);
  });
}

module.exports = { app };
