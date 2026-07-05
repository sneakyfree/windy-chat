/**
 * ADR-056 §5 — midwife exhaustion-upsell.
 *
 * The quota wall must be a warm hand-off, never a dead screen:
 *  - link-your-own-compute is ALWAYS offered
 *  - the $1 line appears only when (a) VERIFIED_HATCH_UPSELL=1 and
 *    (b) the agent is positively known to be unverified ('registered')
 *  - verified owners get a multiplied daily allowance so the upgrade
 *    genuinely buys a bigger day
 *
 * node --test (roster has no jest); fetch stubbed on globalThis.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AgentRunner } = require('../lib/agent-runner');
const { getClearance, exhaustionMessage, _resetCache } = require('../lib/upsell');
const { consumeMessage } = require('../lib/quota');

const realFetch = globalThis.fetch;

function stubFetch(impl) {
  globalThis.fetch = impl;
}

test.beforeEach(() => {
  _resetCache();
  delete process.env.VERIFIED_HATCH_UPSELL;
  delete process.env.UPGRADE_URL;
});

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.VERIFIED_HATCH_UPSELL;
});

// ─── getClearance ──────────────────────────────────────────────────

test('getClearance reads clearance_level from the Eternitas trust API', async () => {
  const calls = [];
  stubFetch(async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ clearance_level: 'registered' }) };
  });
  assert.equal(await getClearance('ET26-TEST-0001'), 'registered');
  assert.ok(calls[0].includes('/api/v1/trust/ET26-TEST-0001'));
});

test('getClearance returns null (unknown) when the trust API is down — and caches the failure', async () => {
  let hits = 0;
  stubFetch(async () => { hits += 1; throw new Error('ECONNREFUSED'); });
  assert.equal(await getClearance('ET26-TEST-0002'), null);
  assert.equal(await getClearance('ET26-TEST-0002'), null);
  assert.equal(hits, 1); // failure cached — no per-message hammering
});

// ─── exhaustionMessage honesty rules ───────────────────────────────

test('unverified + upsell flag ON → offers BOTH compute-link and the $1 upgrade with passport link', () => {
  process.env.VERIFIED_HATCH_UPSELL = '1';
  const msg = exhaustionMessage({
    passport: 'ET26-TEST-0003', clearance: 'registered', resetInHours: 5,
  });
  assert.ok(msg.includes('link it to me'), 'compute-link option present');
  assert.ok(msg.includes('one dollar'), '$1 option present');
  assert.ok(msg.includes('https://app.windyword.ai/upgrade?passport=ET26-TEST-0003'));
  assert.ok(!msg.toLowerCase().includes('trial'), 'ADR-052: never "trial"');
  assert.ok(!msg.toLowerCase().includes('limited'), 'ADR-052: never "limited"');
});

test('upsell flag OFF (dark default) → no $1 line even for unverified', () => {
  const msg = exhaustionMessage({
    passport: 'ET26-TEST-0004', clearance: 'registered', resetInHours: 3,
  });
  assert.ok(msg.includes('link it to me'));
  assert.ok(!msg.includes('one dollar'));
  assert.ok(!msg.includes('/upgrade'));
});

test('verified agent is never re-sold the $1', () => {
  process.env.VERIFIED_HATCH_UPSELL = '1';
  const msg = exhaustionMessage({
    passport: 'ET26-TEST-0005', clearance: 'verified', resetInHours: 3,
  });
  assert.ok(msg.includes('link it to me'));
  assert.ok(!msg.includes('one dollar'));
});

test('unknown clearance (trust API down) → compute-link only, no $1', () => {
  process.env.VERIFIED_HATCH_UPSELL = '1';
  const msg = exhaustionMessage({
    passport: 'ET26-TEST-0006', clearance: null, resetInHours: 3,
  });
  assert.ok(msg.includes('link it to me'));
  assert.ok(!msg.includes('one dollar'));
});

test('the wall is never a dead screen — message always has a next step', () => {
  const msg = exhaustionMessage({ passport: null, clearance: null, resetInHours: 1 });
  assert.ok(msg.includes('refills in about 1 hour'));
  assert.ok(msg.includes('thinking power of my own'));
});

// ─── quota multiplier ──────────────────────────────────────────────

test('verified multiplier raises the daily message limit', () => {
  const uid = `owner-${Date.now()}-mult`;
  // Exhaust the base limit at multiplier 1…
  let last;
  for (let i = 0; i < 10_000; i += 1) {
    last = consumeMessage(uid, 1);
    if (!last.allowed) break;
  }
  assert.equal(last.allowed, false, 'base limit exhausted');
  // …the same owner at multiplier 2 still has headroom.
  const upgraded = consumeMessage(uid, 2);
  assert.equal(upgraded.allowed, true, 'multiplied limit grants headroom');
});

// ─── _handleMessage wall behavior ──────────────────────────────────

test('_handleMessage sends the warm exhaustion message (not silence) at the wall', async () => {
  process.env.VERIFIED_HATCH_UPSELL = '1';
  stubFetch(async (url) => {
    if (String(url).includes('/api/v1/trust/')) {
      return { ok: true, json: async () => ({ clearance_level: 'registered' }) };
    }
    return { ok: true, json: async () => ({ active: false }) };
  });

  const runner = Object.create(AgentRunner.prototype);
  runner.matrixUserId = '@agent_et26-wall-test:chat.windychat.ai';
  runner.ownerWindyId = `owner-${Date.now()}-wall`;
  runner._yieldCache = null;
  runner._realFlyActive = async () => false;
  const sent = [];
  runner._sendMessage = async (_room, text) => { sent.push(text); };
  runner._setTyping = async () => {};

  // Exhaust the owner's budget first.
  for (;;) {
    if (!consumeMessage(runner.ownerWindyId, 1).allowed) break;
  }

  await runner._handleMessage('!room:hs', {
    type: 'm.room.message',
    sender: '@qa.grandma:chat.windychat.ai',
    origin_server_ts: Date.now(),
    content: { body: 'are you there?' },
  });

  assert.equal(sent.length, 1, 'midwife did not go dark');
  assert.ok(sent[0].includes('thinking power'), 'warm exhaustion copy');
  assert.ok(sent[0].includes('/upgrade?passport=ET26-WALL-TEST'), '$1 path offered to unverified');
});
