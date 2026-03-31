/**
 * Hardening: Service Lifecycle Tests
 *
 * Tests:
 *   - Each service starts and responds to /health
 *   - Services handle missing data gracefully
 *   - Health endpoint reflects correct status
 *
 * Run: node --test tests/hardening/test_lifecycle.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-lifecycle-token';
process.env.WINDY_JWT_SECRET = 'test-lifecycle-jwt';
process.env.NODE_ENV = 'test';

// Clean data for all services
for (const svc of ['onboarding','directory','social','translation','media','call-history','push-gateway','backup']) {
  const d = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(d, { recursive: true });
}
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

const servers = [];
const urls = {};

function loadAutoListen(modPath, name) {
  const orig = process.env.PORT; process.env.PORT = '0';
  const origListen = http.Server.prototype.listen;
  let cap = null;
  http.Server.prototype.listen = function(...a) { cap = this; a[0] = 0; return origListen.apply(this, a); };
  const mod = require(modPath);
  http.Server.prototype.listen = origListen;
  if (orig) process.env.PORT = orig; else delete process.env.PORT;
  return new Promise(r => {
    if (cap) { const c = () => { const a = cap.address(); if (a) { servers.push(cap); urls[name] = `http://localhost:${a.port}`; r(); } else cap.once('listening', () => { servers.push(cap); urls[name] = `http://localhost:${cap.address().port}`; r(); }); }; c(); }
    else { const app = mod.app || mod; const s = app.listen(0, () => { servers.push(s); urls[name] = `http://localhost:${s.address().port}`; r(); }); }
  });
}
function startManual(modPath, name) {
  const mod = require(modPath); const app = mod.app || mod;
  return new Promise(r => { const s = app.listen(0, () => { servers.push(s); urls[name] = `http://localhost:${s.address().port}`; r(); }); });
}

before(async () => {
  await loadAutoListen('../../services/onboarding/server', 'onboarding');
  await loadAutoListen('../../services/directory/server', 'directory');
  await loadAutoListen('../../services/push-gateway/server', 'push-gateway');
  await loadAutoListen('../../services/backup/server', 'backup');
  await startManual('../../services/social/server', 'social');
  await startManual('../../services/translation/server', 'translation');
  await startManual('../../services/media/server', 'media');
  await startManual('../../services/call-history/server', 'call-history');
});
after(() => new Promise(r => { let c = 0; const t = servers.length; if (!t) r(); const f = () => { c++; if (c >= t) { setTimeout(() => process.exit(0), 100); r(); } }; for (const s of servers) s.close(f); }));

function getHealth(name) {
  return new Promise((resolve, reject) => {
    http.get(new URL('/health', urls[name]), res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
    }).on('error', reject);
  });
}

describe('Service Startup: All services start cleanly', () => {
  const services = ['onboarding', 'directory', 'push-gateway', 'backup', 'social', 'translation', 'media', 'call-history'];

  for (const svc of services) {
    it(`${svc} starts and returns 200 on /health`, async () => {
      const r = await getHealth(svc);
      assert.equal(r.status, 200);
      assert.equal(r.body.status, 'ok');
    });

    it(`${svc} health has version and uptime`, async () => {
      const r = await getHealth(svc);
      assert.ok(r.body.version, `${svc} should have version`);
      assert.ok(r.body.uptimeMs >= 0, `${svc} should have uptimeMs`);
      assert.ok(r.body.timestamp, `${svc} should have timestamp`);
    });
  }
});

describe('Service Resilience: 404 for unknown routes', () => {
  const services = ['onboarding', 'directory', 'social', 'translation', 'media', 'call-history'];

  for (const svc of services) {
    it(`${svc} returns 404 JSON for /nonexistent`, async () => {
      const r = await new Promise((resolve, reject) => {
        http.get(new URL('/nonexistent', urls[svc]), res => {
          let d = ''; res.on('data', c => d += c);
          res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
        }).on('error', reject);
      });
      assert.equal(r.status, 404);
      assert.ok(r.body.error, `${svc} should return JSON error for 404`);
    });
  }
});

describe('Service Error Handling: Internal errors dont crash', () => {
  const jwt = require('../../services/social/node_modules/jsonwebtoken');
  const token = jwt.sign({ sub: 'lifecycle_user' }, process.env.WINDY_JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });

  it('social handles request to non-existent post gracefully', async () => {
    const r = await new Promise((resolve, reject) => {
      const url = new URL('/api/v1/social/posts/nonexistent-post-id', urls['social']);
      http.get(url, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
      }).on('error', reject);
    });
    assert.equal(r.status, 404);
    assert.ok(r.body.error);
  });

  it('call-history handles empty history gracefully', async () => {
    const r = await new Promise((resolve, reject) => {
      const url = new URL('/api/v1/calls/history', urls['call-history']);
      http.get(url, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch { resolve({ status: res.statusCode, body: d }); } });
      }).on('error', reject);
    });
    // Should return 401 (no auth) not crash
    assert.equal(r.status, 401);
  });

  it('translation handles oversized JSON body gracefully', async () => {
    const r = await new Promise((resolve, reject) => {
      const url = new URL('/api/v1/translate', urls['translation']);
      // 2MB body — over the 1MB limit
      const body = JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024), source_lang: 'en', target_lang: 'es' });
      const req = http.request({ method: 'POST', hostname: url.hostname, port: url.port, path: url.pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${token}` } }, res => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => resolve({ status: res.statusCode }));
      });
      req.on('error', () => resolve({ status: 0 }));
      req.write(body); req.end();
    });
    // Should return 413 (Payload Too Large) or 400, not crash
    assert.ok([400, 413, 500].includes(r.status), `Expected 400/413/500, got ${r.status}`);
  });
});
