/**
 * windy.panel.v1 application (contract §2.1): the owner's sliders must
 * actually reach the midwife — creativity → temperature, response_length →
 * max_tokens, tone sliders → static directive block. Absent sliders must
 * change NOTHING (today's exact behavior is the zero-risk default).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { generateReply, buildToneDirectives, sliderGenParams } = require('../lib/llm');
const { getSliders } = require('../lib/settings');

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GROQ_API_KEY;
});

test('no sliders → no tone block, default params (today\'s behavior)', () => {
  assert.equal(buildToneDirectives({}), '');
  assert.equal(buildToneDirectives(undefined), '');
  assert.deepEqual(sliderGenParams({}), {});
  assert.deepEqual(sliderGenParams(undefined), {});
});

test('default value 5 injects nothing', () => {
  const allFives = {
    personality: 5, humor: 5, warmth: 5, formality: 5,
    verbosity: 5, proactivity: 5,
  };
  assert.equal(buildToneDirectives(allFives), '');
});

test('tone thresholds mirror the gateway engine (>7 high, <3 low)', () => {
  const high = buildToneDirectives({ humor: 9 });
  assert.match(high, /witty and crack jokes/);
  const low = buildToneDirectives({ humor: 1 });
  assert.match(low, /No jokes/);
  const warm = buildToneDirectives({ warmth: 10 });
  assert.match(warm, /close friend/);
  const brief = buildToneDirectives({ verbosity: 0 });
  assert.match(brief, /very brief/);
  // Boundary: 7 and 3 are the median band — nothing injected.
  assert.equal(buildToneDirectives({ humor: 7, formality: 3 }), '');
});

test('creativity + response_length map to generation params', () => {
  assert.deepEqual(sliderGenParams({ creativity: 8 }), { temperature: 0.8 });
  assert.deepEqual(sliderGenParams({ response_length: 0 }), { maxTokens: 250 });
  assert.deepEqual(sliderGenParams({ response_length: 10 }), { maxTokens: 4000 });
  assert.deepEqual(
    sliderGenParams({ creativity: 0, response_length: 2 }),
    { temperature: 0, maxTokens: 1000 },
  );
});

test('sliders reach the provider request: system prompt + params', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  let seenBody = null;
  globalThis.fetch = async (_url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama-3.3-70b-versatile',
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      text: async () => '',
    };
  };
  const result = await generateReply({
    history: [{ role: 'user', content: 'hi' }],
    agentName: 'Mabel',
    sliders: { humor: 9, creativity: 10, response_length: 10 },
  });
  assert.equal(result.content, 'ok');
  assert.equal(seenBody.temperature, 1);
  assert.equal(seenBody.max_tokens, 4000);
  const system = seenBody.messages.find((m) => m.role === 'system').content;
  assert.match(system, /Tone \(set by your owner's control panel\)/);
  assert.match(system, /witty and crack jokes/);
});

test('absent sliders leave the provider request untouched', async () => {
  process.env.GROQ_API_KEY = 'gsk_test';
  let seenBody = null;
  globalThis.fetch = async (_url, opts) => {
    seenBody = JSON.parse(opts.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'llama-3.3-70b-versatile',
        usage: {},
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
      text: async () => '',
    };
  };
  await generateReply({ history: [{ role: 'user', content: 'hi' }], agentName: 'Mabel' });
  assert.equal(seenBody.temperature, undefined);
  assert.equal(seenBody.max_tokens, 512);
  const system = seenBody.messages.find((m) => m.role === 'system').content;
  assert.ok(!system.includes('control panel'));
});

test('settings reader fails soft to {} when the DB is missing', () => {
  // ONBOARDING_DB_PATH defaults to /onboarding-data/… which doesn't exist
  // in the test env — the reader must never throw, just return defaults.
  assert.deepEqual(getSliders('@agent_nobody:chat.windychat.ai'), {});
});
