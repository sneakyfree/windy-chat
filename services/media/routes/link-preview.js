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
const dns = require('dns');
const net = require('net');
const { URL } = require('url');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../shared/async-handler');
const mediaDb = require('../lib/db');

const dnsLookup = dns.promises ? dns.promises.lookup : require('util').promisify(dns.lookup);

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

// ── SSRF defenses ──
//
// P1-7 fix. The previous hostname-pattern check had documented bypasses:
//   1. DNS rebinding — hostname resolves public at check time, private
//      at fetch time.
//   2. IPv6-mapped IPv4 — `[::ffff:127.0.0.1]` not matched by IPv4 regex.
//   3. Integer/hex IP encodings — `http://2130706433/`, `http://0x7f000001/`.
//   4. Cloud-metadata hostnames — `metadata.google.internal`,
//      `metadata.azure.com` not in the deny list.
//
// The fix: resolve the hostname ourselves, validate every resolved IP
// against a canonical private-IP deny list, and use a custom
// http/https Agent whose `lookup` returns the exact IP we validated.
// That closes the DNS-rebinding window — Node connects to the checked
// IP, not to a freshly-resolved one.

// Hostnames that should never resolve on our side regardless of what
// DNS says. Blocked BEFORE resolution.
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'metadata.azure.com',
  'metadata.goog',
  'instance-data',
]);

/**
 * Return true if an IP address (v4 or v6, normalized) is in any
 * reserved range we refuse to connect to. Handles IPv6-mapped IPv4
 * (`::ffff:127.0.0.1` → 127.0.0.1).
 */
function isPrivateIP(ip) {
  if (!ip) return true;
  // Unwrap IPv6-mapped IPv4
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];

  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                          // 0.0.0.0/8
    if (a === 10) return true;                         // 10.0.0.0/8
    if (a === 127) return true;                        // 127.0.0.0/8
    if (a === 169 && b === 254) return true;           // 169.254.0.0/16 (link-local, AWS/GCP metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16.0.0/12
    if (a === 192 && b === 168) return true;           // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (bench)
    if (a >= 224) return true;                         // 224.0.0.0/4 + reserved future
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true; // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;        // ULA
    // IPv6-mapped IPv4. Two wire forms Node produces:
    //   ::ffff:1.2.3.4        (dotted)  — caught by the regex at top
    //   ::ffff:0102:0304      (hex)     — caught here
    if (lower.startsWith('::ffff:')) {
      const tail = lower.slice('::ffff:'.length);
      if (net.isIPv4(tail)) return isPrivateIP(tail);
      const parts = tail.split(':');
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        if (!Number.isNaN(hi) && !Number.isNaN(lo) && hi >= 0 && hi <= 0xFFFF && lo >= 0 && lo <= 0xFFFF) {
          const dotted = `${(hi >> 8) & 0xFF}.${hi & 0xFF}.${(lo >> 8) & 0xFF}.${lo & 0xFF}`;
          return isPrivateIP(dotted);
        }
      }
      // Unrecognized mapped form — treat as private (fail-closed).
      return true;
    }
    if (lower.startsWith('fe') || lower.startsWith('ff')) return true;        // multicast / reserved
    return false;
  }
  // Unknown format — refuse
  return true;
}

/**
 * Resolve a hostname to a safe IP we can safely connect to. Returns
 * the IP + family, or throws a user-facing Error.
 *
 * Every resolved address must pass isPrivateIP — if ANY returned IP is
 * private, we deny the whole fetch (the author could be rotating a
 * DNS record; better to refuse than to pick arbitrarily).
 */
function ssrfDenied(message) {
  const err = new Error(message);
  err.code = 'SSRF_DENIED';
  return err;
}

async function resolveSafeAddress(hostname) {
  if (!hostname) throw ssrfDenied('Invalid URL: missing host');
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw ssrfDenied('URL host is blocked');
  }
  // Strip brackets from literal IPv6 host
  const h = lower.replace(/^\[(.+)\]$/, '$1');

  // If the host is already a literal IP, validate it directly. Integer-
  // encoded URL hosts (e.g. 2130706433) are already unpacked by the URL
  // parser into dotted-quad form on node ≥ 18 — if not, dns.lookup
  // below will resolve them.
  if (net.isIP(h)) {
    if (isPrivateIP(h)) throw ssrfDenied('URL must not point to a private/reserved IP address');
    return { address: h, family: net.isIPv6(h) ? 6 : 4 };
  }

  // Ask the resolver for ALL records, v4 and v6.
  let addrs;
  try {
    addrs = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw ssrfDenied(`DNS lookup failed: ${err.code || err.message}`);
  }
  if (!addrs || addrs.length === 0) {
    throw ssrfDenied('DNS lookup returned no addresses');
  }
  for (const a of addrs) {
    if (isPrivateIP(a.address)) {
      throw ssrfDenied('URL resolves to a private/reserved IP address');
    }
  }
  // All IPs pass — pin the first public one so the fetch connects to
  // the exact IP we validated (defeats DNS rebinding between validation
  // and connect).
  return addrs[0];
}

/**
 * Build an http/https Agent whose `lookup` always returns the
 * pre-validated IP. Prevents DNS rebinding at connect time.
 */
function pinnedAgent(protocol, address, family) {
  const opts = {
    lookup(_host, _opts, cb) { cb(null, address, family); },
    keepAlive: false,
  };
  return protocol === 'https:' ? new https.Agent(opts) : new http.Agent(opts);
}

/**
 * Validate that a URL is safe to fetch (http/https, not private IP).
 * NOTE: does NOT resolve the hostname — that's done in fetchUrl so we
 * can reuse the resolved IP at connect time.
 */
function validateUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: 'URL must use http or https protocol' };
    }
    if (BLOCKED_HOSTNAMES.has(parsed.hostname.toLowerCase())) {
      return { valid: false, error: 'URL host is blocked' };
    }
    return { valid: true, parsed };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Fetch a URL and return the response body as a string.
 * Enforces timeout, max body size, and SSRF-safe DNS resolution.
 */
async function fetchUrl(urlString, redirectCount = 0) {
  if (redirectCount > 3) {
    throw new Error('Too many redirects');
  }

  const parsed = new URL(urlString);
  const httpModule = parsed.protocol === 'https:' ? https : http;

  // Resolve + validate BEFORE connecting. This throws on DNS failure,
  // blocked host, or private-IP resolution.
  const { address, family } = await resolveSafeAddress(parsed.hostname);
  const agent = pinnedAgent(parsed.protocol, address, family);

  return new Promise((resolve, reject) => {
    const req = httpModule.get(urlString, {
      agent,
      timeout: FETCH_TIMEOUT,
      headers: {
        'User-Agent': 'WindyChat-LinkPreview/1.0',
        'Accept': 'text/html',
      },
    }, (res) => {
      // Handle redirects
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, urlString).href;
        }
        // Re-validate AND re-resolve for the new URL. Otherwise an
        // attacker redirects example.com → 127.0.0.1 and the pinned
        // agent of the first hop is irrelevant.
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
    if (err && err.code === 'SSRF_DENIED') {
      return res.status(400).json({ error: err.message });
    }
    console.warn(`[media] Link preview fetch failed for ${url}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch link preview', detail: err.message });
  }
}));

module.exports = router;
// Internals exposed for unit testing the SSRF defense (P1-7). Do not
// import these from production code.
module.exports.__test_internals__ = { isPrivateIP, resolveSafeAddress, validateUrl, BLOCKED_HOSTNAMES };
