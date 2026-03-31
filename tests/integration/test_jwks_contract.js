/**
 * Contract Test: JWKS Validation against Windy Pro
 *
 * Proves that jwt-verify.js correctly:
 *   1. Fetches JWKS from Pro's /.well-known/jwks.json
 *   2. Validates RS256 tokens using the public key
 *   3. Rejects tokens signed with wrong keys
 *   4. Falls back to HS256 when JWKS server is unreachable
 *
 * Run: node --test tests/integration/test_jwks_contract.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');

// Generate RSA key pair for testing
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Generate a second (wrong) key pair
const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Extract RSA components for JWKS format
const pubKeyObj = crypto.createPublicKey(publicKey);
const jwk = pubKeyObj.export({ format: 'jwk' });
const KID = 'windy-pro-test-key-1';

// Build JWKS document matching Pro's expected format
const jwksDocument = {
  keys: [{
    kty: 'RSA',
    use: 'sig',
    alg: 'RS256',
    kid: KID,
    n: jwk.n,
    e: jwk.e,
  }],
};

let mockJwksServer;
let mockJwksPort;
const HS256_SECRET = 'test-hs256-fallback-secret';

// Start mock JWKS server
before(async () => {
  mockJwksServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/jwks.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jwksDocument));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise((resolve) => {
    mockJwksServer.listen(0, () => {
      mockJwksPort = mockJwksServer.address().port;
      resolve();
    });
  });

  // Set env vars BEFORE requiring jwt-verify (it reads them at module load)
  process.env.WINDY_ACCOUNT_SERVER_URL = `http://localhost:${mockJwksPort}`;
  process.env.WINDY_JWT_SECRET = HS256_SECRET;
  process.env.CHAT_API_TOKEN = 'test-contract-token';
});

after(() => new Promise((resolve) => {
  if (mockJwksServer) mockJwksServer.close(() => resolve());
  else resolve();
}));

function signRS256(payload) {
  const jwt = require('../../services/social/node_modules/jsonwebtoken');
  return jwt.sign(payload, privateKey, {
    algorithm: 'RS256',
    keyid: KID,
    expiresIn: '1h',
  });
}

function signRS256WrongKey(payload) {
  const jwt = require('../../services/social/node_modules/jsonwebtoken');
  return jwt.sign(payload, wrongPrivateKey, {
    algorithm: 'RS256',
    keyid: KID,
    expiresIn: '1h',
  });
}

function signHS256(payload) {
  const jwt = require('../../services/social/node_modules/jsonwebtoken');
  return jwt.sign(payload, HS256_SECRET, {
    algorithm: 'HS256',
    expiresIn: '1h',
  });
}

// ═══════════════════════════════════════════
// RS256 + JWKS Validation
// ═══════════════════════════════════════════

describe('JWKS Contract: RS256 validation', () => {
  it('validates RS256 token signed with correct key', async () => {
    // Fresh require to pick up env vars
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { verifyToken } = require('../../services/shared/jwt-verify');

    const token = signRS256({ sub: 'user_123', windy_identity_id: 'uuid-abc' });
    const decoded = await verifyToken(token);
    assert.equal(decoded.sub, 'user_123');
    assert.equal(decoded.windy_identity_id, 'uuid-abc');
  });

  it('rejects RS256 token signed with wrong key', async () => {
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { verifyToken } = require('../../services/shared/jwt-verify');

    const token = signRS256WrongKey({ sub: 'attacker' });

    // Should fall back to HS256 which will also fail (different secret)
    await assert.rejects(
      () => verifyToken(token),
      (err) => {
        assert.ok(err.message.includes('invalid') || err.message.includes('signature'),
          `Expected signature error, got: ${err.message}`);
        return true;
      }
    );
  });

  it('includes kid in JWKS response', async () => {
    // Verify the mock JWKS server serves the correct format
    const res = await new Promise((resolve, reject) => {
      http.get(`http://localhost:${mockJwksPort}/.well-known/jwks.json`, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    assert.ok(res.keys);
    assert.equal(res.keys.length, 1);
    assert.equal(res.keys[0].kty, 'RSA');
    assert.equal(res.keys[0].use, 'sig');
    assert.equal(res.keys[0].alg, 'RS256');
    assert.equal(res.keys[0].kid, KID);
    assert.ok(res.keys[0].n, 'JWKS key must have n (modulus)');
    assert.equal(res.keys[0].e, 'AQAB');
  });
});

// ═══════════════════════════════════════════
// HS256 Fallback
// ═══════════════════════════════════════════

describe('JWKS Contract: HS256 fallback', () => {
  it('validates HS256 token directly (no JWKS needed)', async () => {
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { verifyToken } = require('../../services/shared/jwt-verify');

    const token = signHS256({ sub: 'dev_user', windy_identity_id: 'dev-uuid' });
    const decoded = await verifyToken(token);
    assert.equal(decoded.sub, 'dev_user');
    assert.equal(decoded.windy_identity_id, 'dev-uuid');
  });

  it('falls back to HS256 when JWKS server is down', async () => {
    // Point to a non-existent server
    process.env.WINDY_ACCOUNT_SERVER_URL = 'http://localhost:1';
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { verifyToken } = require('../../services/shared/jwt-verify');

    // RS256 token should fail JWKS fetch, then fall back to HS256
    // Since the token is RS256-signed (not HS256), HS256 verify will also fail
    const rsaToken = signRS256({ sub: 'fallback_user' });
    await assert.rejects(() => verifyToken(rsaToken));

    // But HS256 tokens should still work
    const hs256Token = signHS256({ sub: 'hs256_user' });
    const decoded = await verifyToken(hs256Token);
    assert.equal(decoded.sub, 'hs256_user');

    // Restore
    process.env.WINDY_ACCOUNT_SERVER_URL = `http://localhost:${mockJwksPort}`;
  });
});

// ═══════════════════════════════════════════
// Middleware Integration
// ═══════════════════════════════════════════

describe('JWKS Contract: Express middleware', () => {
  it('sets req.user from RS256 JWT', async () => {
    process.env.WINDY_ACCOUNT_SERVER_URL = `http://localhost:${mockJwksPort}`;
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { createAuthMiddleware } = require('../../services/shared/jwt-verify');

    const middleware = createAuthMiddleware();
    const token = signRS256({ sub: 'middleware_user', windy_identity_id: 'mw-uuid' });

    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status: () => ({ json: () => {} }) };

    await new Promise((resolve) => {
      middleware(req, res, () => {
        assert.equal(req.user.sub, 'middleware_user');
        assert.equal(req.user.windy_identity_id, 'mw-uuid');
        resolve();
      });
    });
  });

  it('service token bypasses JWT validation', async () => {
    delete require.cache[require.resolve('../../services/shared/jwt-verify')];
    const { createAuthMiddleware } = require('../../services/shared/jwt-verify');

    const middleware = createAuthMiddleware();
    const req = { headers: { authorization: `Bearer ${process.env.CHAT_API_TOKEN}` } };
    const res = { status: () => ({ json: () => {} }) };

    await new Promise((resolve) => {
      middleware(req, res, () => {
        assert.equal(req.user.sub, 'service');
        assert.equal(req.user.role, 'service');
        resolve();
      });
    });
  });
});
