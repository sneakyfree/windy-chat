/**
 * Windy Admin telemetry emitter (ADR-WA-001): inert when unconfigured,
 * well-formed envelope when configured, and NEVER throws into the
 * caller — a dead ingest must not break chat.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const adminTelemetry = require('../admin-telemetry');

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WINDY_ADMIN_INGEST_URL;
  delete process.env.WINDY_ADMIN_INGEST_TOKEN;
});

test('emit is a no-op when unconfigured', async () => {
  let called = false;
  globalThis.fetch = async () => { called = true; };
  const out = await adminTelemetry.emit({ service: 's', event_type: 'x.y', actor_type: 'system' });
  assert.equal(out, null);
  assert.equal(called, false);
  assert.equal(adminTelemetry.isConfigured(), false);
});

test('emit posts a platform-stamped envelope with bearer auth', async () => {
  process.env.WINDY_ADMIN_INGEST_URL = 'http://admin-api:8900/';
  process.env.WINDY_ADMIN_INGEST_TOKEN = 'wat_test';
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url, opts };
    return { status: 202 };
  };
  const status = await adminTelemetry.emit({
    service: 'agent-roster',
    event_type: 'llm.call',
    actor_type: 'agent',
    actor_id: 'ET26-TEST-0001',
    model: 'llama-3.3-70b-versatile',
    provider: 'groq',
    duration_ms: 1200,
    session_id: '!room:chat.windychat.ai',
    metadata: { tool_calls: 0 },
  });
  assert.equal(status, 202);
  assert.equal(captured.url, 'http://admin-api:8900/v1/events'); // trailing slash trimmed
  assert.equal(captured.opts.headers.Authorization, 'Bearer wat_test');
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.events.length, 1);
  const ev = body.events[0];
  assert.equal(ev.platform, 'windy-chat');
  assert.equal(ev.event_type, 'llm.call');
  assert.equal(ev.actor_id, 'ET26-TEST-0001');
  assert.ok(ev.ts);
});

test('emit swallows fetch failures', async () => {
  process.env.WINDY_ADMIN_INGEST_URL = 'http://admin-api:8900';
  process.env.WINDY_ADMIN_INGEST_TOKEN = 'wat_test';
  globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
  const out = await adminTelemetry.emit({ service: 's', event_type: 'x.y', actor_type: 'system' });
  assert.equal(out, null); // resolved, not rejected
});

test('emit tolerates non-202 responses', async () => {
  process.env.WINDY_ADMIN_INGEST_URL = 'http://admin-api:8900';
  process.env.WINDY_ADMIN_INGEST_TOKEN = 'wat_test';
  globalThis.fetch = async () => ({ status: 422 });
  const out = await adminTelemetry.emit({ service: 's', event_type: 'x.y', actor_type: 'system' });
  assert.equal(out, 422);
});
