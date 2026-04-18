/**
 * Unit test for trust-client telemetry counters (P3-1).
 *
 * Verifies local_hits / local_misses / upstream_hits / upstream_misses
 * / not_found / rate_limited / fetch_errors increment correctly by
 * pointing the client at a stand-in Eternitas that scripts response
 * shapes. No real Eternitas required.
 *
 * Run: node --test services/shared/tests/trust-client-metrics.test.js
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

let standinPort;
let standinServer;
let scripted = {}; // passport → { status, body, headers }

function startStandin() {
  return new Promise((resolve) => {
    standinServer = http.createServer((req, res) => {
      const m = req.url.match(/^\/api\/v1\/trust\/([^/?]+)$/);
      if (!m) { res.writeHead(404); res.end('{}'); return; }
      const passport = decodeURIComponent(m[1]);
      const cfg = scripted[passport];
      if (!cfg) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
      const headers = { 'Content-Type': 'application/json', ...(cfg.headers || {}) };
      res.writeHead(cfg.status, headers);
      res.end(typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body));
    });
    standinServer.listen(0, '127.0.0.1', () => {
      standinPort = standinServer.address().port;
      process.env.ETERNITAS_URL = `http://127.0.0.1:${standinPort}`;
      process.env.ETERNITAS_USE_MOCK = 'false';
      resolve();
    });
  });
}
function stopStandin() {
  return new Promise((resolve) => standinServer && standinServer.close(() => resolve()));
}

const trustClient = require('../trust-client');

describe('trust-client metrics', { concurrency: false }, () => {
  before(startStandin);
  after(stopStandin);
  beforeEach(() => {
    trustClient._clearCacheForTest();
    trustClient._resetMetricsForTest();
    scripted = {};
  });

  it('increments local_miss then local_hit on repeat call', async () => {
    scripted['ET26-HIT'] = {
      status: 200,
      headers: { 'x-trust-cache': 'miss' },
      body: {
        passport_number: 'ET26-HIT', status: 'active',
        integrity_score: 800, dimensions: {},
        band: 'good', clearance_level: 'cleared', tier_multiplier: 1.5,
        allowed_actions: ['read', 'send'], denied_actions: [],
        cache_ttl_seconds: 300,
      },
    };

    const first = await trustClient.getTrustProfile('ET26-HIT');
    assert.equal(first.status, 'active');
    const m1 = trustClient.getTrustClientMetrics();
    assert.equal(m1.local_hits, 0);
    assert.equal(m1.local_misses, 1);
    assert.equal(m1.upstream_misses, 1);
    assert.equal(m1.upstream_hits, 0);

    const second = await trustClient.getTrustProfile('ET26-HIT');
    assert.equal(second.status, 'active');
    const m2 = trustClient.getTrustClientMetrics();
    assert.equal(m2.local_hits, 1);
    assert.equal(m2.local_misses, 1);
    // Upstream counters unchanged — we served from our cache, no GET
    assert.equal(m2.upstream_misses, 1);
  });

  it('records upstream_hits when Eternitas reports X-Trust-Cache: hit', async () => {
    scripted['ET26-UHIT'] = {
      status: 200,
      headers: { 'x-trust-cache': 'hit' },
      body: {
        passport_number: 'ET26-UHIT', status: 'active',
        integrity_score: 800, dimensions: {},
        band: 'good', clearance_level: 'cleared', tier_multiplier: 1.5,
        allowed_actions: [], denied_actions: [],
        cache_ttl_seconds: 300,
      },
    };
    await trustClient.getTrustProfile('ET26-UHIT');
    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.upstream_hits, 1);
    assert.equal(m.upstream_misses, 0);
  });

  it('increments not_found on 404', async () => {
    scripted['ET26-404'] = { status: 404, body: { detail: 'not found' } };
    const p = await trustClient.getTrustProfile('ET26-404');
    assert.equal(p.status, 'not_found');
    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.not_found, 1);
    assert.equal(m.fetch_errors, 0);
  });

  it('increments rate_limited on 429', async () => {
    scripted['ET26-RL'] = {
      status: 429, headers: { 'retry-after': '30' }, body: '{}',
    };
    const p = await trustClient.getTrustProfile('ET26-RL');
    assert.equal(p, null);
    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.rate_limited, 1);
  });

  it('increments fetch_errors on 500', async () => {
    scripted['ET26-500'] = { status: 500, body: { detail: 'boom' } };
    const p = await trustClient.getTrustProfile('ET26-500');
    assert.equal(p, null);
    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.fetch_errors, 1);
  });

  it('computes derived rates correctly', async () => {
    // Two misses → two fetches (both upstream miss)
    scripted['ET26-R1'] = {
      status: 200, headers: { 'x-trust-cache': 'miss' },
      body: { passport_number: 'ET26-R1', status: 'active', integrity_score: 100, dimensions: {}, band: 'good', clearance_level: 'cleared', tier_multiplier: 1, allowed_actions: [], denied_actions: [], cache_ttl_seconds: 300 },
    };
    scripted['ET26-R2'] = {
      status: 200, headers: { 'x-trust-cache': 'hit' },
      body: { passport_number: 'ET26-R2', status: 'active', integrity_score: 100, dimensions: {}, band: 'good', clearance_level: 'cleared', tier_multiplier: 1, allowed_actions: [], denied_actions: [], cache_ttl_seconds: 300 },
    };
    await trustClient.getTrustProfile('ET26-R1');
    await trustClient.getTrustProfile('ET26-R2');
    // And three hits on our side
    await trustClient.getTrustProfile('ET26-R1');
    await trustClient.getTrustProfile('ET26-R1');
    await trustClient.getTrustProfile('ET26-R2');

    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.local_misses, 2);
    assert.equal(m.local_hits, 3);
    assert.equal(m.total_requests, 5);
    assert.equal(m.local_hit_rate, 0.6); // 3 / 5
    assert.equal(m.upstream_hits, 1);
    assert.equal(m.upstream_misses, 1);
    assert.equal(m.upstream_hit_rate, 0.5); // 1 / 2
  });

  it('returns null rates when no traffic yet', async () => {
    const m = trustClient.getTrustClientMetrics();
    assert.equal(m.local_hit_rate, null);
    assert.equal(m.upstream_hit_rate, null);
    assert.equal(m.total_requests, 0);
  });
});
