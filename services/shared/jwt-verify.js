const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const JWT_SECRET = process.env.WINDY_JWT_SECRET || 'dev-secret-change-me';
const CHAT_API_TOKEN = process.env.CHAT_API_TOKEN || '';
const ACCOUNT_SERVER_URL = process.env.WINDY_ACCOUNT_SERVER_URL || 'http://localhost:8098';

// JWKS client with 1-hour cache
const jwks = jwksClient({
  jwksUri: `${ACCOUNT_SERVER_URL}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 60 * 60 * 1000, // 1 hour
  rateLimit: true,
  jwksRequestsPerMinute: 5,
});

function getSigningKey(header) {
  return new Promise((resolve, reject) => {
    jwks.getSigningKey(header.kid, (err, key) => {
      if (err) return reject(err);
      resolve(key.getPublicKey());
    });
  });
}

/**
 * Verify a JWT token. Tries RS256 (JWKS) first, falls back to HS256 (shared secret).
 */
async function verifyToken(token) {
  // Decode header to check algorithm
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) throw new Error('Invalid token');

  // If the token uses RS256, verify with JWKS
  if (decoded.header.alg === 'RS256') {
    try {
      const publicKey = await getSigningKey(decoded.header);
      return jwt.verify(token, publicKey, { algorithms: ['RS256'] });
    } catch (jwksErr) {
      // Fall back to HS256 shared secret if JWKS fetch fails (development)
      return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    }
  }

  // HS256 tokens (development / legacy)
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

/**
 * Creates Express middleware that validates JWTs issued by windy-pro account-server.
 * - RS256 via JWKS (production)
 * - HS256 fallback (development)
 * - Static CHAT_API_TOKEN for service-to-service calls
 */
function createAuthMiddleware(options = {}) {
  const { optional = false } = options;

  return async (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      if (optional) return next();
      return res.status(401).json({ error: 'Missing Authorization header' });
    }

    // Static token check (service-to-service)
    if (CHAT_API_TOKEN && authHeader === `Bearer ${CHAT_API_TOKEN}`) {
      req.user = { sub: 'service', role: 'service' };
      return next();
    }

    // JWT check (RS256 via JWKS, fallback to HS256)
    const token = authHeader.replace(/^Bearer\s+/i, '');
    try {
      const decoded = await verifyToken(token);
      req.user = decoded;
      next();
    } catch (err) {
      if (optional) return next();
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

module.exports = { createAuthMiddleware, verifyToken };
