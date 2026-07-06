/**
 * Roster web_search wiring (2026-07-06): per-agent EPT fetch + caching,
 * windy-search result/notice mapping, budget-429 vs rate-limit-429
 * discrimination, and capability-gated tool lists.
 *
 * node --test (roster has no jest); fetch stubbed on globalThis.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const windySearch = require('../lib/windy-search');
const { availableTools } = require('../lib/tools');

const realFetch = globalThis.fetch;

function setEnv() {
  process.env.WINDY_SEARCH_BASE_URL = 'https://api.windysearch.test';
  process.env.ETERNITAS_URL = 'https://api.eternitas.test';
  process.env.ETERNITAS_PLATFORM_API_KEY = 'et_plt_' + '0'.repeat(40);
}

function clearEnv() {
  delete process.env.WINDY_SEARCH_BASE_URL;
  delete process.env.ETERNITAS_URL;
  delete process.env.ETERNITAS_PLATFORM_API_KEY;
}

function makeRes(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  windySearch._clearEptCache();
  clearEnv();
});

// ── configuration gating ────────────────────────────────────────────

test('isConfigured false when any env var missing', () => {
  clearEnv();
  assert.equal(windySearch.isConfigured(), false);
  process.env.WINDY_SEARCH_BASE_URL = 'https://x.test';
  process.env.ETERNITAS_URL = 'https://y.test';
  assert.equal(windySearch.isConfigured(), false); // key still missing
  process.env.ETERNITAS_PLATFORM_API_KEY = 'et_plt_x';
  assert.equal(windySearch.isConfigured(), true);
});

test('availableTools gates per capability', () => {
  assert.equal(availableTools({ canMail: false, canSearch: false }), null);
  const searchOnly = availableTools({ canMail: false, canSearch: true });
  assert.equal(searchOnly.length, 1);
  assert.equal(searchOnly[0].function.name, 'web_search');
  const mailOnly = availableTools({ canMail: true, canSearch: false });
  assert.equal(mailOnly.length, 1);
  assert.equal(mailOnly[0].function.name, 'send_email');
  const both = availableTools({ canMail: true, canSearch: true });
  assert.equal(both.length, 2);
});

// ── EPT fetch + cache ───────────────────────────────────────────────

test('getAgentEpt fetches once then serves from cache', async () => {
  setEnv();
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls += 1;
    assert.ok(String(url).includes('/api/v1/bots/ET26-TEST-AAAA/ept'));
    assert.equal(opts.headers['X-API-Key'], process.env.ETERNITAS_PLATFORM_API_KEY);
    return makeRes(200, { passport: 'ET26-TEST-AAAA', ept_token: 'ey.test.token' });
  };
  const a = await windySearch.getAgentEpt('ET26-TEST-AAAA');
  const b = await windySearch.getAgentEpt('ET26-TEST-AAAA');
  assert.equal(a, 'ey.test.token');
  assert.equal(b, 'ey.test.token');
  assert.equal(calls, 1);
});

// ── search result mapping ───────────────────────────────────────────

test('webSearch maps results and carries no notice under normal budget', async () => {
  setEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) {
      return makeRes(200, { ept_token: 'ey.t' });
    }
    return makeRes(200, {
      query: 'weather', backend: 'brave',
      results: [{ title: 'T', snippet: 'S', url: 'https://u.test' }],
      budget_warning: false, budget_used_usd: 0.01, budget_cap_usd: 5.0,
    });
  };
  const out = await windySearch.webSearch({ passport: 'ET26-A', query: 'weather' });
  assert.equal(out.ok, true);
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].title, 'T');
  assert.equal(out.notice_to_user, undefined);
});

test('webSearch threads the 80% warning notice', async () => {
  setEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) return makeRes(200, { ept_token: 'ey.t' });
    return makeRes(200, {
      query: 'q', results: [], budget_warning: true,
      budget_used_usd: 4.0, budget_cap_usd: 5.0,
    });
  };
  const out = await windySearch.webSearch({ passport: 'ET26-B', query: 'q' });
  assert.equal(out.ok, true);
  assert.ok(out.notice_to_user.includes('80%'));
});

// ── 429 discrimination ─────────────────────────────────────────────

test('budget-429 (X-Cost-Cap-USD) maps to friendly exhausted message', async () => {
  setEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) return makeRes(200, { ept_token: 'ey.t' });
    return makeRes(429, { detail: 'Monthly budget exhausted' },
      { 'X-Cost-Cap-USD': '5.00', 'Retry-After': '86400' });
  };
  const out = await windySearch.webSearch({ passport: 'ET26-C', query: 'q' });
  assert.equal(out.ok, false);
  assert.equal(out.budget_exhausted, true);
  assert.ok(out.error.includes('resets on the 1st'));
});

test('rate-limit 429 (no X-Cost header) is transient, not budget', async () => {
  setEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) return makeRes(200, { ept_token: 'ey.t' });
    return makeRes(429, { detail: 'Rate limit exceeded' },
      { 'X-RateLimit-Limit': '50', 'Retry-After': '60' });
  };
  const out = await windySearch.webSearch({ passport: 'ET26-D', query: 'q' });
  assert.equal(out.ok, false);
  assert.equal(out.budget_exhausted, undefined);
  assert.ok(out.error.includes('minute'));
});

// ── stale-EPT retry ─────────────────────────────────────────────────

test('401 refreshes the EPT once and retries', async () => {
  setEnv();
  let eptCalls = 0;
  let searchCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) {
      eptCalls += 1;
      return makeRes(200, { ept_token: `ey.t${eptCalls}` });
    }
    searchCalls += 1;
    if (searchCalls === 1) return makeRes(401, { detail: 'expired' });
    return makeRes(200, { query: 'q', results: [{ title: 'T', snippet: 'S', url: 'u' }] });
  };
  const out = await windySearch.webSearch({ passport: 'ET26-E', query: 'q' });
  assert.equal(out.ok, true);
  assert.equal(eptCalls, 2);   // initial + forced refresh
  assert.equal(searchCalls, 2); // 401 then success
});

// ── failure never throws ────────────────────────────────────────────

test('network failure returns grandma-explainable error', async () => {
  setEnv();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/ept')) return makeRes(200, { ept_token: 'ey.t' });
    throw new Error('ECONNREFUSED');
  };
  const out = await windySearch.webSearch({ passport: 'ET26-F', query: 'q' });
  assert.equal(out.ok, false);
  assert.ok(!out.error.includes('ECONNREFUSED')); // no jargon at grandma
});
