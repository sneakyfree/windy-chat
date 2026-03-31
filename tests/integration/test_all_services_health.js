/**
 * Health Check Test: All 8 Services
 *
 * Proves every Windy Chat service (K2-K10) can:
 *   1. Start successfully
 *   2. Respond to GET /health
 *   3. Return {status: "ok", service: "<name>", version: "...", uptime, timestamp}
 *   4. Include dependency checks where applicable
 *
 * Run: node --test tests/integration/test_all_services_health.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

process.env.CHAT_API_TOKEN = 'test-health-token';
process.env.WINDY_JWT_SECRET = 'test-health-jwt';
process.env.NODE_ENV = 'test';

// Clean all data dirs
const serviceNames = [
  'onboarding', 'directory', 'push-gateway', 'backup', 'social',
  'translation', 'media', 'call-history',
];
for (const svc of serviceNames) {
  const dataDir = path.join(__dirname, '..', '..', 'services', svc, 'data');
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(dataDir, { recursive: true });
}
fs.mkdirSync(path.join(__dirname, '..', '..', 'services', 'media', 'data', 'media', 'thumbnails'), { recursive: true });

const servers = [];
const serviceUrls = {};

function loadAutoListenService(modulePath, name) {
  const originalPort = process.env.PORT;
  process.env.PORT = '0';
  const origListen = http.Server.prototype.listen;
  let capturedServer = null;
  http.Server.prototype.listen = function (...args) {
    capturedServer = this;
    if (typeof args[0] === 'number' || typeof args[0] === 'string') args[0] = 0;
    return origListen.apply(this, args);
  };
  const mod = require(modulePath);
  http.Server.prototype.listen = origListen;
  if (originalPort !== undefined) process.env.PORT = originalPort;
  else delete process.env.PORT;

  return new Promise((resolve) => {
    if (capturedServer) {
      const check = () => {
        const addr = capturedServer.address();
        if (addr) { servers.push(capturedServer); serviceUrls[name] = `http://localhost:${addr.port}`; resolve(); }
        else capturedServer.once('listening', () => { servers.push(capturedServer); serviceUrls[name] = `http://localhost:${capturedServer.address().port}`; resolve(); });
      };
      check();
    } else {
      const app = mod.app || mod;
      const srv = app.listen(0, () => { servers.push(srv); serviceUrls[name] = `http://localhost:${srv.address().port}`; resolve(); });
    }
  });
}

function startManualService(modulePath, name) {
  const mod = require(modulePath);
  const app = mod.app || mod;
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(srv);
      serviceUrls[name] = `http://localhost:${srv.address().port}`;
      resolve();
    });
  });
}

before(async () => {
  await loadAutoListenService('../../services/onboarding/server', 'onboarding');
  await loadAutoListenService('../../services/directory/server', 'directory');
  await loadAutoListenService('../../services/push-gateway/server', 'push-gateway');
  await startManualService('../../services/social/server', 'social');
  await startManualService('../../services/translation/server', 'translation');
  await startManualService('../../services/media/server', 'media');
  await startManualService('../../services/call-history/server', 'call-history');
  // Backup auto-listens too
  await loadAutoListenService('../../services/backup/server', 'backup');
});

after(() => new Promise((resolve) => {
  let closed = 0;
  const total = servers.length;
  if (total === 0) { resolve(); return; }
  const onClose = () => { closed++; if (closed >= total) { setTimeout(() => process.exit(0), 100); resolve(); } };
  for (const srv of servers) srv.close(onClose);
}));

function getHealth(serviceName) {
  return new Promise((resolve, reject) => {
    const url = new URL('/health', serviceUrls[serviceName]);
    http.get(url, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

// Expected service names in health responses
const expectedServices = {
  'onboarding': 'windy-chat-onboarding',
  'directory': 'windy-chat-directory',
  'push-gateway': 'windy-chat-push-gateway',
  'backup': 'windy-chat-backup',
  'social': 'windy-chat-social',
  'translation': 'windy-chat-translation',
  'media': 'windy-chat-media',
  'call-history': 'windy-chat-call-history',
};

describe('All Services Health Check', () => {
  for (const [name, expectedServiceName] of Object.entries(expectedServices)) {
    describe(`${name} (${expectedServiceName})`, () => {
      it('returns 200', async () => {
        const res = await getHealth(name);
        assert.equal(res.status, 200);
      });

      it('has status "ok"', async () => {
        const res = await getHealth(name);
        assert.equal(res.body.status, 'ok');
      });

      it('has correct service name', async () => {
        const res = await getHealth(name);
        assert.equal(res.body.service, expectedServiceName);
      });

      it('has version string', async () => {
        const res = await getHealth(name);
        assert.ok(res.body.version, 'version should be present');
        assert.match(res.body.version, /^\d+\.\d+\.\d+$/);
      });

      it('has uptime and timestamp', async () => {
        const res = await getHealth(name);
        assert.ok(res.body.uptime, 'uptime should be present');
        assert.ok(res.body.uptimeMs >= 0, 'uptimeMs should be non-negative');
        assert.ok(res.body.timestamp, 'timestamp should be present');
      });
    });
  }
});

describe('Services with dependency checks', () => {
  it('onboarding reports Twilio/SendGrid status', async () => {
    const res = await getHealth('onboarding');
    assert.ok('dependencies' in res.body, 'onboarding should have dependencies');
  });

  it('directory reports Twilio/SendGrid status', async () => {
    const res = await getHealth('directory');
    assert.ok('dependencies' in res.body, 'directory should have dependencies');
  });

  it('media reports sharp/ffmpeg status', async () => {
    const res = await getHealth('media');
    assert.ok('dependencies' in res.body, 'media should have dependencies');
    assert.ok('sharpAvailable' in res.body.dependencies);
    assert.ok('ffmpegAvailable' in res.body.dependencies);
  });

  it('translation reports translate server URL', async () => {
    const res = await getHealth('translation');
    assert.ok('dependencies' in res.body, 'translation should have dependencies');
  });
});
