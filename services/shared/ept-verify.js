/**
 * Eternitas Passport Token (EPT) verification — the ecosystem-unified
 * bearer for AGENTS (humans use the account-server JWT in jwt-verify.js).
 *
 * Third application of the pattern (windy-mind PR #45, windy-mail #62,
 * now windy-chat, 2026-07-05): ES256 over P-256, verified against the
 * Eternitas JWKS at /.well-known/eternitas-keys. Claims: sub=passport,
 * ope=operator, bot=name, typ=bot type, tru=trust 0-100, ver=tier,
 * rev=revoked flag.
 *
 * Used by the one-soul handoff: the real Windy Fly presents its EPT to
 * POST /api/v1/onboarding/agent/session and receives its own
 * @agent_<passport> Matrix credentials — no registration secret, no
 * service token on user machines.
 */
'use strict';

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const ETERNITAS_URL = process.env.ETERNITAS_URL || 'https://api.eternitas.ai';

// JWKS client with 1-hour cache (mirrors jwt-verify.js).
const jwks = jwksClient({
  jwksUri: `${ETERNITAS_URL}/.well-known/eternitas-keys`,
  cache: true,
  cacheMaxAge: 60 * 60 * 1000,
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
 * Verify an EPT. Resolves to its claims; rejects on any problem.
 * ES256-only, issuer-pinned, revocation-flag honored. No HS fallback
 * of any kind — an agent token is never verified with a shared secret.
 */
async function verifyEpt(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) throw new Error('invalid EPT');
  if (decoded.header.alg !== 'ES256') {
    throw new Error('EPT must be ES256');
  }
  const publicKey = await getSigningKey(decoded.header);
  const claims = jwt.verify(token, publicKey, {
    algorithms: ['ES256'],
    issuer: 'eternitas.ai',
  });
  if (claims.rev) throw new Error('EPT revoked');
  if (!claims.sub || typeof claims.sub !== 'string') {
    throw new Error('EPT missing passport subject');
  }
  return claims;
}

module.exports = { verifyEpt };
