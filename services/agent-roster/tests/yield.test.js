/**
 * One-soul yield (2026-07-05): the midwife stays silent when the real
 * Windy Fly holds the matrix runtime claim, answers when it doesn't,
 * and — crucially — answers when Mind is unreachable (fail-open: a
 * silent agent is a worse failure than a duplicate voice).
 *
 * node --test (roster has no jest); fetch stubbed on globalThis.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AgentRunner } = require('../lib/agent-runner');

const realFetch = globalThis.fetch;

function makeRunner() {
  const runner = Object.create(AgentRunner.prototype);
  runner.matrixUserId = '@agent_et26-yield-test:chat.windychat.ai';
  runner._yieldCache = null;
  return runner;
}

function stubFetch(impl) {
  globalThis.fetch = impl;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test('yields when Mind reports an active matrix claim', async () => {
  const calls = [];
  stubFetch(async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ active: true, source: 'matrix' }) };
  });
  const runner = makeRunner();
  assert.equal(await runner._realFlyActive(), true);
  // Passport reconstructed correctly from the localpart.
  assert.ok(calls[0].includes('/v1/runtime/claim/ET26-YIELD-TEST/status'));
  assert.ok(calls[0].includes('source=matrix'));
});

test('answers when no claim is held', async () => {
  stubFetch(async () => ({ ok: true, json: async () => ({ active: false, source: null }) }));
  assert.equal(await makeRunner()._realFlyActive(), false);
});

test('fails OPEN when Mind is unreachable (midwife answers)', async () => {
  stubFetch(async () => { throw new Error('ECONNREFUSED'); });
  assert.equal(await makeRunner()._realFlyActive(), false);
});

test('caches for 15s so a chatty room does not hammer Mind', async () => {
  let hits = 0;
  stubFetch(async () => {
    hits += 1;
    return { ok: true, json: async () => ({ active: true, source: 'matrix' }) };
  });
  const runner = makeRunner();
  await runner._realFlyActive();
  await runner._realFlyActive();
  await runner._realFlyActive();
  assert.equal(hits, 1);
});

test('_handleMessage never reaches the LLM when the real Fly is active', async () => {
  const runner = makeRunner();
  runner.lastEventAt = null;
  let sent = 0;
  runner._realFlyActive = async () => true;
  runner._sendMessage = async () => { sent += 1; };

  await runner._handleMessage('!room:hs', {
    type: 'm.room.message',
    sender: '@qa.grandma:chat.windychat.ai',
    origin_server_ts: Date.now(),
    content: { body: 'hello?' },
  });

  assert.equal(sent, 0);
});
