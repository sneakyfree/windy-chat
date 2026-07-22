/**
 * _request socket-timeout guard (2026-07-22): every Matrix call (sync, send,
 * typing, history, join, back-invite) used bare fetch with no client-side
 * timeout, so a half-open socket hung the runner and the agent went silent to
 * its owner until restart. _request now attaches AbortSignal.timeout — a quick
 * default for normal calls, a longer explicit one for the /sync long-poll —
 * and honors a caller-supplied signal.
 *
 * These assert the wiring deterministically (no reliance on the unref'd
 * AbortSignal.timeout timer, which doesn't hold the loop alive under a stubbed
 * fetch). node --test; global fetch stubbed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AgentRunner } = require('../lib/agent-runner');

function makeRunner() {
  const r = Object.create(AgentRunner.prototype);
  r.homeserver = 'https://hs.example';
  r.accessToken = 'tok';
  r.matrixUserId = '@agent_x:hs.example';
  return r;
}

test('_request attaches a timeout AbortSignal and preserves method + auth headers', async () => {
  const orig = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({}) };
  };
  try {
    const r = makeRunner();
    await r._request('/_matrix/client/v3/joined_rooms', { method: 'GET' });
    assert.ok(seen.init.signal instanceof AbortSignal, 'an AbortSignal was attached by default');
    assert.equal(seen.init.method, 'GET');
    assert.equal(seen.init.headers.Authorization, 'Bearer tok');
    assert.equal(seen.url, 'https://hs.example/_matrix/client/v3/joined_rooms');
    assert.equal(seen.init.timeoutMs, undefined, 'timeoutMs is consumed, not leaked into fetch init');
  } finally {
    globalThis.fetch = orig;
  }
});

test('_request propagates an abort (a stuck call rejects instead of hanging)', async () => {
  const orig = globalThis.fetch;
  // Model a socket that is already dead: if the signal is aborted, reject —
  // exactly what fetch does when AbortSignal.timeout fires in production.
  globalThis.fetch = (url, init) =>
    init.signal && init.signal.aborted
      ? Promise.reject(new Error('The operation was aborted'))
      : Promise.resolve({ ok: true });
  try {
    const r = makeRunner();
    await assert.rejects(
      () => r._request('/_matrix/client/v3/sync', { method: 'GET', signal: AbortSignal.abort() }),
      /abort/i,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test('an explicit caller signal is honored over the default timeout', async () => {
  const orig = globalThis.fetch;
  let seen;
  const ac = new AbortController();
  globalThis.fetch = async (url, init) => {
    seen = init;
    return { ok: true };
  };
  try {
    const r = makeRunner();
    await r._request('/x', { method: 'GET', signal: ac.signal });
    assert.equal(seen.signal, ac.signal, 'caller-supplied signal passed through');
  } finally {
    globalThis.fetch = orig;
  }
});
