/**
 * Jest-compatible stub for jwks-rsa.
 *
 * Fixes P0-5: jwks-rsa transitively imports `jose`, which ships ESM-only,
 * which blows up jest's default CJS transformer before tests collect.
 * Tests in this repo never need real JWKS — they pass HS256 tokens signed
 * with WINDY_JWT_SECRET, which shared/jwt-verify.js accepts as the fallback
 * path. This stub returns a no-op client so jwt-verify.js imports cleanly.
 *
 * Any test that genuinely needs RS256 + JWKS validation should start a
 * local mock JWKS server (see tests/integration/test_jwks_contract.js for
 * the pattern). Do not rely on this stub for such tests.
 */

function jwksClient() {
  return {
    getSigningKey(_kid, cb) {
      const err = new Error('jwks-rsa stubbed in test — use HS256 fallback');
      setImmediate(() => cb(err));
    },
  };
}

module.exports = jwksClient;
module.exports.default = jwksClient;
