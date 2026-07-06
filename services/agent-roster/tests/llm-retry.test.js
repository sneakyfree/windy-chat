/**
 * Groq tool_use_failed resilience (2026-07-06): llama's tool-calling is
 * stochastic — a malformed emission 400s. generateReply must retry once
 * with tools, then fall back to a text-only answer, never a dead chat.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { generateReply } = require('../lib/llm');

const realFetch = globalThis.fetch;
const TOOL_FAIL = JSON.stringify({
  error: { message: 'Failed to call a function.', code: 'tool_use_failed' },
});

function groqRes(msg) {
  return {
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: msg }] }),
    text: async () => '',
  };
}

function groq400() {
  return { ok: false, status: 400, text: async () => TOOL_FAIL, json: async () => ({}) };
}

test.afterEach(() => { globalThis.fetch = realFetch; delete process.env.GROQ_API_KEY; });

const TOOLS = [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }];

test('tool_use_failed retries once with tools and succeeds', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? groq400() : groqRes({ role: 'assistant', content: 'answered' });
  };
  const out = await generateReply({ history: [{ role: 'user', content: 'q' }], agentName: 'A', tools: TOOLS });
  assert.equal(out.content, 'answered');
  assert.equal(calls, 2);
});

test('persistent tool failure falls back to text-only answer', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (_url, opts) => {
    calls += 1;
    bodies.push(JSON.parse(opts.body));
    return calls <= 2 ? groq400() : groqRes({ role: 'assistant', content: 'plain answer' });
  };
  const out = await generateReply({ history: [{ role: 'user', content: 'q' }], agentName: 'A', tools: TOOLS });
  assert.equal(out.content, 'plain answer');
  assert.equal(out.provider, 'groq-notools');
  assert.equal(calls, 3);
  assert.equal(bodies[2].tools, undefined); // final attempt really dropped tools
});
