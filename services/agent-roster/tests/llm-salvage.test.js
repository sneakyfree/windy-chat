/**
 * salvageLeakedToolCalls — leaked tool-call markup must never reach the
 * room as plain text. Seen live 2026-07-08 (gemini-2.5-flash via Mind):
 * the model emitted `<function(web_search){...}</function>` as content
 * with no structured tool_calls; the runner posted it verbatim into the
 * owner's DM and never ran the search.
 *
 * Run: node --test services/agent-roster/tests/llm-salvage.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { salvageLeakedToolCalls } = require('../lib/llm');

describe('salvageLeakedToolCalls', () => {
  it('passes through messages with real tool_calls untouched', () => {
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'x', type: 'function', function: { name: 'web_search', arguments: '{}' } }],
    };
    assert.equal(salvageLeakedToolCalls(msg), msg);
  });

  it('passes through plain prose untouched', () => {
    const msg = { role: 'assistant', content: 'Noah Lyles won the gold medal!' };
    assert.equal(salvageLeakedToolCalls(msg), msg);
  });

  it('salvages the live-observed <function(name){args}</function> leak', () => {
    const msg = {
      role: 'assistant',
      content: '<function(web_search){"query": "tips for keeping roses healthy"}</function>',
    };
    const out = salvageLeakedToolCalls(msg);
    assert.equal(out.tool_calls.length, 1);
    assert.equal(out.tool_calls[0].function.name, 'web_search');
    assert.deepEqual(JSON.parse(out.tool_calls[0].function.arguments),
      { query: 'tips for keeping roses healthy' });
    assert.equal(out.content, '');
  });

  it('salvages <function=name>{args}</function> variant and keeps surrounding prose', () => {
    const msg = {
      role: 'assistant',
      content: 'Let me look that up. <function=web_search>{"query": "weather Portland"}</function>',
    };
    const out = salvageLeakedToolCalls(msg);
    assert.equal(out.tool_calls[0].function.name, 'web_search');
    assert.equal(out.content, 'Let me look that up.');
  });

  it('salvages <tool_call> JSON envelope', () => {
    const msg = {
      role: 'assistant',
      content: '<tool_call>{"name": "send_email", "arguments": {"to": "a@b.c"}}</tool_call>',
    };
    const out = salvageLeakedToolCalls(msg);
    assert.equal(out.tool_calls[0].function.name, 'send_email');
    assert.deepEqual(JSON.parse(out.tool_calls[0].function.arguments), { to: 'a@b.c' });
  });

  it('salvages markup with a truncated closing tag', () => {
    const msg = {
      role: 'assistant',
      content: '<function(web_search){"query": "roses"}',
    };
    const out = salvageLeakedToolCalls(msg);
    assert.equal(out.tool_calls[0].function.name, 'web_search');
  });

  it('scrubs unparseable markup instead of posting it', () => {
    const msg = {
      role: 'assistant',
      content: '<function(web_search){"query": broken json</function>',
    };
    const out = salvageLeakedToolCalls(msg);
    assert.equal(out.tool_calls, undefined);
    assert.ok(!out.content.includes('<function'), 'markup removed');
    assert.ok(out.content.length > 0, 'honest fallback text present');
  });
});
