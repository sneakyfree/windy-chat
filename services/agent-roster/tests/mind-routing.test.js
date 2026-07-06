/**
 * Phase 1.5 — generateReply routes through Windy Mind when the agent's
 * EPT is available, and falls back to the Groq-direct chain on any Mind
 * failure. The model that Mind resolved (the A/B dimension) rides back
 * on the reply.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { generateReply } = require('../lib/llm');

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
  delete process.env.MIND_API_URL;
  delete process.env.ROSTER_MIND_DISABLE;
});

function mindRes(model, content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      id: 'chatcmpl-x',
      model,
      usage: { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109 },
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    }),
    text: async () => '',
  };
}

function groqRes(content) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      model: 'llama-3.3-70b-versatile',
      usage: { prompt_tokens: 50, completion_tokens: 4 },
      choices: [{ message: { role: 'assistant', content } }],
    }),
    text: async () => '',
  };
}

test('with an EPT the reply comes from Mind, carrying the resolved model', async () => {
  process.env.MIND_API_URL = 'https://api.windymind.ai';
  process.env.GROQ_API_KEY = 'gsk_test';
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes('windymind')) {
      assert.equal(opts.headers.Authorization, 'Bearer ept-test-token');
      const body = JSON.parse(opts.body);
      assert.equal(body.surface, 'midwife');
      assert.equal(body.messages[0].role, 'system');
      return mindRes('gemini-2.5-flash', 'hello from mind');
    }
    throw new Error('groq should not be called');
  };
  const result = await generateReply({
    history: [{ role: 'user', content: 'hi' }],
    ept: 'ept-test-token',
  });
  assert.equal(result.provider, 'mind');
  assert.equal(result.model, 'gemini-2.5-flash');
  assert.equal(result.content, 'hello from mind');
  assert.equal(result.usage.tokens_in, 100);
  assert.deepEqual(calls.filter((u) => u.includes('windymind')).length, 1);
});

test('mind failure falls back to groq-direct', async () => {
  process.env.MIND_API_URL = 'https://api.windymind.ai';
  process.env.GROQ_API_KEY = 'gsk_test';
  globalThis.fetch = async (url) => {
    if (String(url).includes('windymind')) {
      return { ok: false, status: 502, text: async () => 'broker error', json: async () => ({}) };
    }
    return groqRes('hello from groq');
  };
  const result = await generateReply({
    history: [{ role: 'user', content: 'hi' }],
    ept: 'ept-test-token',
  });
  assert.equal(result.provider, 'groq');
  assert.equal(result.content, 'hello from groq');
});

test('no EPT skips Mind entirely', async () => {
  process.env.MIND_API_URL = 'https://api.windymind.ai';
  process.env.GROQ_API_KEY = 'gsk_test';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return groqRes('direct');
  };
  const result = await generateReply({ history: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.provider, 'groq');
  assert.ok(urls.every((u) => !u.includes('windymind')));
});

test('ROSTER_MIND_DISABLE=1 is a killswitch', async () => {
  process.env.MIND_API_URL = 'https://api.windymind.ai';
  process.env.GROQ_API_KEY = 'gsk_test';
  process.env.ROSTER_MIND_DISABLE = '1';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return groqRes('direct');
  };
  const result = await generateReply({
    history: [{ role: 'user', content: 'hi' }],
    ept: 'ept-test-token',
  });
  assert.equal(result.provider, 'groq');
  assert.ok(urls.every((u) => !u.includes('windymind')));
});

test('tools + tool_choice pass through to Mind', async () => {
  process.env.MIND_API_URL = 'https://api.windymind.ai';
  let sentBody;
  globalThis.fetch = async (url, opts) => {
    sentBody = JSON.parse(opts.body);
    return mindRes('llama-3.3-70b-versatile', 'ok');
  };
  const tools = [{ type: 'function', function: { name: 'web_search', parameters: {} } }];
  await generateReply({
    history: [{ role: 'user', content: 'hi' }],
    tools,
    toolChoice: 'none',
    ept: 'ept-test-token',
  });
  assert.deepEqual(sentBody.tools, tools);
  assert.equal(sentBody.tool_choice, 'none');
});
