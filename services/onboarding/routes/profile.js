/**
 * Windy Chat — Display Name & Profile Setup Routes
 * K2.2: Display Name Setup (DNA Strand K)
 *
 * Endpoints:
 *   GET  /api/v1/chat/profile/check-name  — check display name availability
 *   POST /api/v1/chat/profile/setup       — set display name, languages, avatar
 *
 * Name rules:
 *   - Min 2, max 64 characters
 *   - Unicode allowed (international names)
 *   - Profanity filter (basic word list)
 *   - Unique across Windy Chat network
 *   - Suggests alternatives if taken
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { checkProfanity } = require('../lib/profanity');

const router = express.Router();

// ── File-based persistence for in-memory Maps ──
const DATA_DIR = path.join(__dirname, '..', 'data');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function loadPersistedData() {
  try {
    if (fs.existsSync(PROFILES_FILE)) {
      const raw = fs.readFileSync(PROFILES_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.displayNames && typeof data.displayNames === 'object') {
        for (const [key, value] of Object.entries(data.displayNames)) {
          displayNameRegistry.set(key, value);
        }
      }
      if (data.profiles && typeof data.profiles === 'object') {
        for (const [key, value] of Object.entries(data.profiles)) {
          userProfiles.set(key, value);
        }
      }
      console.log(`[Profile] Loaded ${displayNameRegistry.size} display names, ${userProfiles.size} profiles from disk`);
    }
  } catch (err) {
    console.error('[Profile] Failed to load persisted data:', err.message);
  }
}

function persistData() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    const data = {
      displayNames: Object.fromEntries(displayNameRegistry),
      profiles: Object.fromEntries(userProfiles),
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Profile] Failed to persist data:', err.message);
  }
}

// ── In-memory display name registry (persisted to disk as bridge until Redis/PostgreSQL) ──
const displayNameRegistry = new Map();  // name (lowercase) → { userId, displayName, languages, avatarUrl, createdAt }
const userProfiles = new Map();         // userId → profile

// Load persisted data on startup
loadPersistedData();

// ── Supported languages (subset — matches Windy Pro language list) ──
const SUPPORTED_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ja', 'ko',
  'ar', 'hi', 'bn', 'tr', 'vi', 'th', 'pl', 'nl', 'sv', 'da',
  'no', 'fi', 'cs', 'el', 'he', 'id', 'ms', 'ro', 'hu', 'uk',
  'sk', 'bg', 'hr', 'sr', 'sl', 'et', 'lv', 'lt', 'fil', 'sw',
]);

// ── Input validation helpers ──

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

// ── Helpers ──

/**
 * Validate display name.
 * Returns { valid, error? } or { valid, suggestions? } if taken.
 */
function validateDisplayName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Display name is required' };
  }

  const trimmed = stripHtml(name).trim();

  if (trimmed.length < 2) {
    return { valid: false, error: 'Display name must be at least 2 characters' };
  }

  if (trimmed.length > 64) {
    return { valid: false, error: 'Display name must be 64 characters or fewer' };
  }

  // Check for profanity
  if (checkProfanity(trimmed)) {
    return { valid: false, error: 'This display name is not allowed. Please choose another.' };
  }

  // Check uniqueness
  const normalized = trimmed.toLowerCase();
  if (displayNameRegistry.has(normalized)) {
    const suggestions = generateAlternatives(trimmed);
    return {
      valid: false,
      error: 'This display name is already taken',
      taken: true,
      suggestions,
    };
  }

  return { valid: true, displayName: trimmed };
}

/**
 * Generate alternative name suggestions when a name is taken.
 * K2.2.1: Suggest alternatives like "Grant W", "Grant Whitmer 2"
 */
function generateAlternatives(name) {
  const suggestions = [];
  const parts = name.trim().split(/\s+/);

  // "Grant W" — first name + last initial
  if (parts.length >= 2) {
    const abbrev = parts[0] + ' ' + parts[parts.length - 1][0] + '.';
    if (!displayNameRegistry.has(abbrev.toLowerCase())) {
      suggestions.push(abbrev);
    }
  }

  // "Grant Whitmer 2", "Grant Whitmer 3"
  for (let i = 2; i <= 5; i++) {
    const numbered = `${name} ${i}`;
    if (!displayNameRegistry.has(numbered.toLowerCase())) {
      suggestions.push(numbered);
      if (suggestions.length >= 3) break;
    }
  }

  // Underscore variant: "grant_whitmer"
  const underscored = name.toLowerCase().replace(/\s+/g, '_');
  if (!displayNameRegistry.has(underscored)) {
    suggestions.push(underscored);
  }

  return suggestions.slice(0, 3);
}

// ── GET /api/v1/chat/profile/check-name ──

router.get('/check-name', (req, res) => {
  try {
    const { name } = req.query;

    if (!name) {
      return res.status(400).json({ error: 'name query parameter is required' });
    }

    if (typeof name !== 'string' || name.length > 100) {
      return res.status(400).json({ error: 'name must be a string, max 100 characters' });
    }

    const sanitized = stripHtml(name);
    const result = validateDisplayName(sanitized);

    res.json({
      name: sanitized,
      available: result.valid,
      error: result.error || null,
      suggestions: result.suggestions || [],
    });
  } catch (err) {
    console.error('Check name error:', err);
    res.status(500).json({ error: 'Failed to check name availability' });
  }
});

// ── POST /api/v1/chat/profile/setup ──

router.post('/setup', async (req, res) => {
  try {
    const { verificationToken, displayName, languages, avatarUrl } = req.body;

    // Require verification token (from K2.1 verify/check)
    if (!verificationToken) {
      return res.status(401).json({
        error: 'Verification required. Complete phone/email verification first.',
        step: 'verify',
      });
    }

    if (typeof verificationToken !== 'string' || verificationToken.length > 255) {
      return res.status(400).json({ error: 'verificationToken must be a string, max 255 chars' });
    }

    // Validate display name — strip HTML first
    if (!displayName || typeof displayName !== 'string') {
      return res.status(400).json({ error: 'displayName is required and must be a string' });
    }

    if (displayName.length > 100) {
      return res.status(400).json({ error: 'displayName must be 100 characters or fewer' });
    }

    const sanitizedName = stripHtml(displayName);
    const nameResult = validateDisplayName(sanitizedName);
    if (!nameResult.valid) {
      return res.status(400).json({
        error: nameResult.error,
        suggestions: nameResult.suggestions || [],
        field: 'displayName',
      });
    }

    // Validate languages
    if (languages !== undefined && !Array.isArray(languages)) {
      return res.status(400).json({ error: 'languages must be an array' });
    }

    const primaryLanguage = languages && languages.length > 0 ? languages[0] : 'en';
    const validLanguages = (languages || ['en']).filter(l => typeof l === 'string' && SUPPORTED_LANGUAGES.has(l));
    if (validLanguages.length === 0) {
      return res.status(400).json({
        error: 'At least one valid language is required',
        supportedLanguages: [...SUPPORTED_LANGUAGES].sort(),
        field: 'languages',
      });
    }

    // Validate avatarUrl if provided
    if (avatarUrl !== undefined && avatarUrl !== null) {
      if (typeof avatarUrl !== 'string' || avatarUrl.length > 2048) {
        return res.status(400).json({ error: 'avatarUrl must be a string, max 2048 characters' });
      }
    }

    // Create profile
    const chatUserId = `windy_${uuidv4().replace(/-/g, '').slice(0, 12)}`;
    const now = new Date().toISOString();
    const profile = {
      chatUserId,
      displayName: nameResult.displayName,
      languages: validLanguages,
      primaryLanguage,
      avatarUrl: avatarUrl || null,
      createdAt: now,
      onboardingComplete: false,
    };

    // Register display name
    displayNameRegistry.set(nameResult.displayName.toLowerCase(), {
      userId: chatUserId,
      displayName: nameResult.displayName,
      languages: validLanguages,
      avatarUrl: avatarUrl || null,
      createdAt: now,
    });

    // Store profile
    userProfiles.set(chatUserId, profile);

    // Persist to disk (bridge until Redis/PostgreSQL migration)
    persistData();

    console.log(`👤 Profile created: "${nameResult.displayName}" (${chatUserId}), languages: [${validLanguages.join(', ')}]`);

    res.status(201).json({
      success: true,
      profile,
      message: 'Profile created successfully',
      nextStep: 'provision',  // Next: provision Matrix account (K2.4)
    });

  } catch (err) {
    console.error('Profile setup error:', err);
    res.status(500).json({ error: 'Profile setup failed' });
  }
});

// ── GET /api/v1/chat/profile/:userId ──

router.get('/:userId', (req, res) => {
  try {
    const { userId } = req.params;

    // Validate userId
    if (!userId || typeof userId !== 'string' || userId.length > 255 || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
      return res.status(400).json({ error: 'Invalid userId format' });
    }

    const profile = userProfiles.get(userId);

    if (!profile) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    res.json({ profile });
  } catch (err) {
    console.error('Profile get error:', err);
    res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

module.exports = router;
