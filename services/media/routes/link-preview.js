/**
 * Windy Chat — Link Preview / Open Graph Route
 * K4: Rich Media — OG metadata extraction
 *
 * GET /api/v1/media/link-preview?url=<url>
 *   - Fetches URL, parses OG meta tags
 *   - Caches results in SQLite for 24 hours
 *   - Timeout: 5s, max response body: 500KB
 *   - Rate limit: 30/min
 *   - Validates URL is http/https, not private IP
 */

const { Router } = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');
const mediaDb = require('../lib/db');

const router = Router();

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours in ms
const FETCH_TIMEOUT = 5000; // 5 seconds
const MAX_BODY_SIZE = 500 * 1024; // 500KB

// Rate limit: 30 requests per minute
const linkPreviewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Link preview rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Check if an IP address is in a private range.
 */
function isPrivateIP(hostname) {
  // Block common private/reserved ranges by hostname pattern
  const privatePatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\./,
    /^169\.254\./,
    /^fc00:/i,
    /^fd/i,
    /^fe80:/i,
    /^::1$/,
    /^\[::1\]$/,
  ];
  return privatePatterns.some(p => p.test(hostname));
}

/**
 * Validate that a URL is safe to fetch (http/https, not private IP).
 */
function validateUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'URL must use http or https protocol' };
    }
    if (isPrivateIP(parsed.hostname)) {
      return { valid: false, error: 'URL must not point to a private/reserved IP address' };
    }
    return { valid: true, parsed };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Fetch a URL and return the response body as a string.
 * Enforces timeout and max body size.
 */
function fetchUrl(urlString, redirectCount = 0) {
  if (redirectCount > 3) {
    return Promise.reject(new Error('Too many redirects'));
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(urlString);
    const httpModule = parsed.protocol === 'https:' ? https : http;

    const req = httpModule.get(urlString, {
      timeout: FETCH_TIMEOUT,
      headers: {
        'User-Agent': 'WindyChat-LinkPreview/1.0',
        'Accept': 'text/html',
      },
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        // Handle relative redirects
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, urlString).href;
        }
        const validation = validateUrl(redirectUrl);
        if (!validation.valid) {
          return reject(new Error(validation.error));
        }
        res.resume();
        return resolve(fetchUrl(redirectUrl, redirectCount + 1));
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      let data = '';
      let size = 0;

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        size += Buffer.byteLength(chunk);
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          // We have enough HTML to parse OG tags (they're in the <head>)
          resolve(data);
          return;
        }
        data += chunk;
      });

      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
  });
}

/**
 * Parse OG meta tags from HTML string.
 */
function parseOGTags(html) {
  const result = {
    title: null,
    description: null,
    image: null,
    site_name: null,
  };

  // Match <meta property="og:*" content="*"> and <meta content="*" property="og:*">
  const metaRegex = /<meta\s+[^>]*?(?:property|name)\s*=\s*["']og:(\w+)["'][^>]*?content\s*=\s*["']([^"']*)["'][^>]*?\/?\s*>|<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?(?:property|name)\s*=\s*["']og:(\w+)["'][^>]*?\/?\s*>/gi;

  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const property = (match[1] || match[4] || '').toLowerCase();
    const content = match[2] || match[3] || '';

    if (property === 'title' && !result.title) {
      result.title = decodeHtmlEntities(content);
    } else if (property === 'description' && !result.description) {
      result.description = decodeHtmlEntities(content);
    } else if (property === 'image' && !result.image) {
      result.image = decodeHtmlEntities(content);
    } else if (property === 'site_name' && !result.site_name) {
      result.site_name = decodeHtmlEntities(content);
    }
  }

  // Fallback: try <title> tag if no og:title
  if (!result.title) {
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    if (titleMatch) {
      result.title = decodeHtmlEntities(titleMatch[1].trim());
    }
  }

  // Fallback: try <meta name="description"> if no og:description
  if (!result.description) {
    const descMatch = html.match(/<meta\s+[^>]*?name\s*=\s*["']description["'][^>]*?content\s*=\s*["']([^"']*)["']/i)
      || html.match(/<meta\s+[^>]*?content\s*=\s*["']([^"']*)["'][^>]*?name\s*=\s*["']description["']/i);
    if (descMatch) {
      result.description = decodeHtmlEntities(descMatch[1]);
    }
  }

  return result;
}

/**
 * Decode common HTML entities.
 */
function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/');
}

/**
 * Generate a URL hash for cache key.
 */
function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex');
}

// ── GET /api/v1/media/link-preview ──
router.get('/link-preview', linkPreviewLimiter, asyncHandler(async (req, res) => {
  const { url } = req.query;

  if (!url || typeof url !== 'string' || !url.trim()) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  // Validate URL
  const validation = validateUrl(url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  const urlHash = hashUrl(url);

  // Check cache
  const cached = mediaDb.getLinkPreview.get(urlHash);
  if (cached && (Date.now() - cached.cached_at) < CACHE_TTL) {
    return res.json({
      url: cached.url,
      title: cached.title,
      description: cached.description,
      image: cached.image,
      site_name: cached.site_name,
      cached: true,
    });
  }

  // Fetch and parse
  try {
    const html = await fetchUrl(url);
    const og = parseOGTags(html);

    // Cache the result
    mediaDb.insertLinkPreview.run({
      url_hash: urlHash,
      url,
      title: og.title,
      description: og.description,
      image: og.image,
      site_name: og.site_name,
      cached_at: Date.now(),
    });

    res.json({
      url,
      title: og.title,
      description: og.description,
      image: og.image,
      site_name: og.site_name,
      cached: false,
    });
  } catch (err) {
    console.warn(`[media] Link preview fetch failed for ${url}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch link preview', detail: err.message });
  }
}));

module.exports = router;
