/**
 * Windy Chat — Directory Search & Invite Routes
 * K3.2: Search by Name / Email / Phone (DNA Strand K)
 *
 * Endpoints:
 *   GET  /api/v1/chat/directory/search  — fuzzy name, exact email/phone search
 *   POST /api/v1/chat/directory/invite  — send SMS/email invite to non-users
 *
 * Search behavior:
 *   - Display name: fuzzy match (case-insensitive, partial)
 *   - Email: exact match
 *   - Phone: E.164 exact match
 *   - Max 20 results per query
 *   - Respects user privacy settings (opt-out)
 *
 * Invite:
 *   - SMS via Twilio or email via SendGrid
 *   - Max 20 invites per day per user (anti-spam)
 *   - Referral tracking via deep link
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// ── In-memory stores (replace with DB in production) ──

// User directory: userId → { displayName, email, phone, languages, avatarUrl, searchable }
const userDirectory = new Map();

// Invite tracking: userId → { count, resetAt }
const inviteTracker = new Map();

const MAX_SEARCH_RESULTS = 20;
const MAX_INVITES_PER_DAY = 20;

// ── Rate limiters ──
const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Search rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

const inviteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Invite rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Input validation helpers ──

function isValidUserId(val) {
  return typeof val === 'string' && val.length > 0 && val.length <= 255 && /^[a-zA-Z0-9_-]+$/.test(val);
}

function isValidEmail(val) {
  return typeof val === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

function isValidPhone(val) {
  return typeof val === 'string' && val.length <= 20 && /^\+?[0-9\s\-()]+$/.test(val);
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

// ── Helpers ──

/**
 * Fuzzy match a query against a display name.
 * Case-insensitive, partial matching.
 */
function fuzzyMatch(query, displayName) {
  const q = query.toLowerCase();
  const name = displayName.toLowerCase();

  // Exact prefix match (strongest)
  if (name.startsWith(q)) return { match: true, score: 3 };

  // Word-start match: "grant" matches "John Grant"
  const words = name.split(/\s+/);
  for (const word of words) {
    if (word.startsWith(q)) return { match: true, score: 2 };
  }

  // Contains match (weakest)
  if (name.includes(q)) return { match: true, score: 1 };

  return { match: false, score: 0 };
}

/**
 * Check daily invite limit for a user.
 */
function checkInviteLimit(userId) {
  const tracker = inviteTracker.get(userId);
  const now = Date.now();

  if (!tracker || now > tracker.resetAt) {
    // New day or first invite
    inviteTracker.set(userId, {
      count: 0,
      resetAt: now + 24 * 60 * 60 * 1000,
    });
    return { allowed: true, remaining: MAX_INVITES_PER_DAY };
  }

  if (tracker.count >= MAX_INVITES_PER_DAY) {
    const hoursLeft = Math.ceil((tracker.resetAt - now) / (1000 * 60 * 60));
    return { allowed: false, remaining: 0, resetInHours: hoursLeft };
  }

  return { allowed: true, remaining: MAX_INVITES_PER_DAY - tracker.count };
}

// ── POST /api/v1/chat/directory/register (register user in searchable directory) ──

router.post('/register', (req, res) => {
  try {
    const { userId, displayName, email, phone, languages, avatarUrl, searchable } = req.body;

    if (!userId || !isValidUserId(userId)) {
      return res.status(400).json({ error: 'userId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!displayName || typeof displayName !== 'string' || displayName.length > 100) {
      return res.status(400).json({ error: 'displayName is required, max 100 characters' });
    }

    const sanitizedDisplayName = stripHtml(displayName);

    // Validate optional email
    if (email !== undefined && email !== null && !isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Validate optional phone
    if (phone !== undefined && phone !== null && !isValidPhone(phone)) {
      return res.status(400).json({ error: 'Invalid phone format, max 20 chars, digits + country code' });
    }

    // Validate languages
    if (languages !== undefined && !Array.isArray(languages)) {
      return res.status(400).json({ error: 'languages must be an array' });
    }

    // Validate avatarUrl
    if (avatarUrl !== undefined && avatarUrl !== null && (typeof avatarUrl !== 'string' || avatarUrl.length > 2048)) {
      return res.status(400).json({ error: 'avatarUrl must be a string, max 2048 characters' });
    }

    userDirectory.set(userId, {
      displayName: sanitizedDisplayName,
      email: email ? email.toLowerCase().trim() : null,
      phone: phone || null,
      languages: languages || ['en'],
      avatarUrl: avatarUrl || null,
      searchable: searchable !== false, // Default: searchable
      registeredAt: new Date().toISOString(),
    });

    console.log(`📇 Registered in directory: "${sanitizedDisplayName}" (searchable: ${searchable !== false})`);

    res.status(201).json({
      success: true,
      userId,
      searchable: searchable !== false,
    });

  } catch (err) {
    console.error('Directory register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ── GET /api/v1/chat/directory/search ──

router.get('/search', searchLimiter, (req, res) => {
  try {
    const { q } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
      return res.status(400).json({
        error: 'Query must be at least 2 characters',
        param: 'q',
      });
    }

    if (q.length > 100) {
      return res.status(400).json({ error: 'Query must be 100 characters or fewer' });
    }

    const query = stripHtml(q.trim());
    const results = [];

    for (const [userId, user] of userDirectory) {
      // Respect privacy: skip users who opted out of search
      if (!user.searchable) continue;

      let matched = false;
      let matchType = null;
      let score = 0;

      // 1. Fuzzy name match
      const nameMatch = fuzzyMatch(query, user.displayName);
      if (nameMatch.match) {
        matched = true;
        matchType = 'name';
        score = nameMatch.score;
      }

      // 2. Exact email match
      if (!matched && user.email && user.email === query.toLowerCase()) {
        matched = true;
        matchType = 'email';
        score = 4; // Exact matches rank highest
      }

      // 3. Exact phone match (E.164)
      if (!matched && user.phone) {
        const cleanQuery = query.replace(/[\s\-()]/g, '');
        if (user.phone === cleanQuery || user.phone.endsWith(cleanQuery)) {
          matched = true;
          matchType = 'phone';
          score = 4;
        }
      }

      if (matched) {
        results.push({
          userId,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          languages: user.languages,
          matchType,
          score,
        });
      }
    }

    // Sort by relevance score (descending), then alphabetically
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.displayName.localeCompare(b.displayName);
    });

    // Limit results
    const limited = results.slice(0, MAX_SEARCH_RESULTS);

    // Remove internal score from response
    const cleaned = limited.map(({ score, ...rest }) => rest);

    res.json({
      query,
      results: cleaned,
      count: cleaned.length,
      totalMatches: results.length,
      truncated: results.length > MAX_SEARCH_RESULTS,
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

// ── POST /api/v1/chat/directory/invite ──

router.post('/invite', inviteLimiter, async (req, res) => {
  try {
    const { fromUserId, fromDisplayName, type, identifier } = req.body;

    if (!fromUserId || !isValidUserId(fromUserId)) {
      return res.status(400).json({ error: 'fromUserId is required, alphanumeric + hyphens/underscores, max 255 chars' });
    }

    if (!type || !['sms', 'email'].includes(type)) {
      return res.status(400).json({ error: 'type must be "sms" or "email"' });
    }

    if (!identifier || typeof identifier !== 'string' || identifier.length > 255) {
      return res.status(400).json({ error: 'identifier is required, max 255 characters' });
    }

    // Validate identifier format based on type
    if (type === 'email' && !isValidEmail(identifier)) {
      return res.status(400).json({ error: 'Invalid email format for invite' });
    }

    if (type === 'sms' && !isValidPhone(identifier)) {
      return res.status(400).json({ error: 'Invalid phone format for SMS invite' });
    }

    // Validate optional fromDisplayName
    if (fromDisplayName !== undefined && (typeof fromDisplayName !== 'string' || fromDisplayName.length > 100)) {
      return res.status(400).json({ error: 'fromDisplayName must be a string, max 100 characters' });
    }

    // Check daily invite limit
    const limit = checkInviteLimit(fromUserId);
    if (!limit.allowed) {
      return res.status(429).json({
        error: `Daily invite limit reached (${MAX_INVITES_PER_DAY}/day)`,
        resetInHours: limit.resetInHours,
      });
    }

    // Generate referral deep link
    const referralCode = uuidv4().slice(0, 8);
    const deepLink = `https://windypro.com/chat/join?ref=${referralCode}`;
    const senderName = fromDisplayName ? stripHtml(fromDisplayName) : 'Someone';

    if (type === 'sms') {
      // Send SMS invite
      const message = `${senderName} invited you to Windy Chat — real-time translated messaging! Join here: ${deepLink}`;

      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const fromNumber = process.env.TWILIO_PHONE_NUMBER;

      if (!accountSid || !authToken || !fromNumber) {
        console.log(`📱 [STUB] SMS invite to ${identifier}: ${message}`);
      } else {
        try {
          const twilio = require('twilio');
          const client = twilio(accountSid, authToken);
          await client.messages.create({
            body: message,
            from: fromNumber,
            to: identifier,
          });
          console.log(`📱 SMS invite sent to ${identifier}`);
        } catch (smsErr) {
          console.error('SMS invite error:', smsErr.message);
          return res.status(502).json({ error: 'Failed to send SMS invite' });
        }
      }
    } else {
      // Send email invite
      const apiKey = process.env.SENDGRID_API_KEY;
      const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'noreply@windypro.com';

      if (!apiKey) {
        console.log(`📧 [STUB] Email invite to ${identifier} from ${senderName}`);
      } else {
        try {
          const sgMail = require('@sendgrid/mail');
          sgMail.setApiKey(apiKey);
          await sgMail.send({
            to: identifier,
            from: fromEmail,
            subject: `${senderName} invited you to Windy Chat`,
            text: `${senderName} invited you to Windy Chat — messaging with real-time translation!\n\nJoin here: ${deepLink}`,
            html: `
              <div style="font-family: -apple-system, sans-serif; max-width: 400px; margin: 0 auto; padding: 40px 20px;">
                <h2>🌪️ You're invited to Windy Chat</h2>
                <p><strong>${senderName}</strong> wants to chat with you on Windy Chat — messaging with real-time translation!</p>
                <a href="${deepLink}" style="display:inline-block; background:#4f46e5; color:white; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:600; margin:20px 0;">Join Windy Chat</a>
                <p style="color:#888; font-size:13px; margin-top:24px;">Messages are translated automatically. Chat in any language.</p>
              </div>
            `,
          });
          console.log(`📧 Email invite sent to ${identifier}`);
        } catch (emailErr) {
          console.error('Email invite error:', emailErr.message);
          return res.status(502).json({ error: 'Failed to send email invite' });
        }
      }
    }

    // Track invite
    const tracker = inviteTracker.get(fromUserId);
    if (tracker) tracker.count++;

    console.log(`📨 Invite sent: ${senderName} → ${identifier} (${type}), ref: ${referralCode}`);

    res.json({
      success: true,
      type,
      identifier,
      referralCode,
      deepLink,
      invitesRemaining: limit.remaining - 1,
    });

  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ error: 'Invite failed' });
  }
});

module.exports = router;
