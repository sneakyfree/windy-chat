/**
 * Windy Admin ledger inputs (ADR-WA-001): generateReply must surface
 * the resolved model + token usage so the runner can emit llm.call
 * envelopes — the model field is the midwife A/B dimension.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { generateReply } = require('../lib/llm');

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
});

test('groq reply carries model + usage', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      model: 'llama-3.3-70b-versatile',
      usage: { prompt_tokens: 321, completion_tokens: 45 },
      choices: [{ message: { role: 'assistant', content: 'hi there' } }],
    }),
    text: async () => '',
  });
  const result = await generateReply({ history: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.provider, 'groq');
  assert.equal(result.model, 'llama-3.3-70b-versatile');
  assert.equal(result.usage.tokens_in, 321);
  assert.equal(result.usage.tokens_out, 45);
  assert.equal(result.content, 'hi there');
});

test('per-model 429 fallback reports the fallback model', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  let calls = 0;
  globalThis.fetch = async (_url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    if (body.model === 'llama-3.3-70b-versatile') {
      return { ok: false, status: 429, text: async () => 'rate limit', json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: body.model,
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: 'assistant', content: 'fallback says hi' } }],
      }),
      text: async () => '',
    };
  };
  const result = await generateReply({ history: [{ role: 'user', content: 'hi' }] });
  assert.equal(calls, 2);
  assert.equal(result.model, 'llama-3.1-8b-instant');
  assert.equal(result.usage.tokens_in, 10);
});

test('missing usage degrades to nulls, not a crash', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
    text: async () => '',
  });
  const result = await generateReply({ history: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.model, 'llama-3.3-70b-versatile'); // falls back to requested model
  assert.equal(result.usage.tokens_in, null);
  assert.equal(result.usage.tokens_out, null);
});
