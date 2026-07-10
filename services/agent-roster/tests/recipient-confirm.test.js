/**
 * [I1 Phase 1b] Self-building send_email recipient allow-list (2026-07-10).
 * New recipients are HELD until the owner replies "send"; addresses the owner
 * has confirmed before send immediately. Enforced in code, so an injected
 * instruction that makes the model email a new attacker address only queues a
 * draft the owner must approve — it never self-sends.
 *
 * node --test; downstream (_executeConfirmedSend / _realFlyActive) stubbed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AgentRunner } = require('../lib/agent-runner');

const OWNER = '@grant.whitmer:chat.windychat.ai';
const AGENT = '@agent_et26-confirm-test:chat.windychat.ai';
const ROOM = '!room:chat.windychat.ai';

function bareRunner() {
  const r = Object.create(AgentRunner.prototype);
  r.matrixUserId = AGENT;
  r.ownerMatrixId = OWNER;
  r.knownRecipients = new Set();
  r.pendingSend = null;
  r.lastEventAt = null;
  return r;
}

test('[1b] _recipientsOf splits + lowercases single and comma-list', () => {
  const r = bareRunner();
  assert.deepEqual(r._recipientsOf('Doctor@Clinic.com'), ['doctor@clinic.com']);
  assert.deepEqual(r._recipientsOf('a@x.com, B@Y.com'), ['a@x.com', 'b@y.com']);
  assert.deepEqual(r._recipientsOf(''), []);
  assert.deepEqual(r._recipientsOf(undefined), []);
});

test('[1b] _isConfirmWord matches confirmations, not real requests', () => {
  const r = bareRunner();
  for (const y of ['send', 'Send', 'send it', 'yes send', 'yes, send it', 'confirm', ' send. ']) {
    assert.ok(r._isConfirmWord(y), `"${y}" should confirm`);
  }
  for (const n of ['send it to my doctor', 'what is the weather', 'email bob', 'sending', '']) {
    assert.ok(!r._isConfirmWord(n), `"${n}" must NOT confirm`);
  }
});

test('[1b] _shouldHoldSend: new recipient held, known allowed, comma-list w/ new held', () => {
  const r = bareRunner();
  assert.equal(r._shouldHoldSend({ to: 'new@x.com' }), true, 'unknown → hold');
  r.knownRecipients.add('known@x.com');
  assert.equal(r._shouldHoldSend({ to: 'known@x.com' }), false, 'known → send');
  assert.equal(r._shouldHoldSend({ to: 'Known@X.com' }), false, 'known is case-insensitive');
  assert.equal(r._shouldHoldSend({ to: 'known@x.com, new@x.com' }), true, 'any-new → hold');
  assert.equal(r._shouldHoldSend({ to: '' }), false, 'empty → no hold (executeTool errors)');
});

test('[1b] the owner "send" reply completes a held draft and short-circuits the LLM', async () => {
  const r = bareRunner();
  r.pendingSend = { to: 'new@x.com', subject: 's', body: 'b', roomId: ROOM, ts: Date.now() };
  let confirmed = null;
  r._executeConfirmedSend = async (roomId, held) => { confirmed = held; };
  r._reachedLoop = false;
  r._realFlyActive = async () => { r._reachedLoop = true; return true; };

  await r._handleMessage(ROOM, { sender: OWNER, content: { body: 'send', msgtype: 'm.text' }, origin_server_ts: Date.now() });

  assert.ok(confirmed && confirmed.to === 'new@x.com', 'held draft was dispatched');
  assert.equal(r.pendingSend, null, 'pending cleared');
  assert.equal(r._reachedLoop, false, 'confirm short-circuits before the LLM path');
});

test('[1b] a non-confirm message supersedes the draft (never auto-sends)', async () => {
  const r = bareRunner();
  r.pendingSend = { to: 'new@x.com', subject: 's', body: 'b', roomId: ROOM, ts: Date.now() };
  let confirmed = null;
  r._executeConfirmedSend = async (_roomId, held) => { confirmed = held; };
  r._reachedLoop = false;
  r._realFlyActive = async () => { r._reachedLoop = true; return true; };

  await r._handleMessage(ROOM, { sender: OWNER, content: { body: 'actually never mind', msgtype: 'm.text' }, origin_server_ts: Date.now() });

  assert.equal(confirmed, null, 'no send on a non-confirm');
  assert.equal(r.pendingSend, null, 'draft superseded');
  assert.equal(r._reachedLoop, true, 'proceeds to normal handling');
});

test('[1b] an expired hold is dropped, not sent', async () => {
  const r = bareRunner();
  r.pendingSend = { to: 'new@x.com', subject: 's', body: 'b', roomId: ROOM, ts: Date.now() - 20 * 60 * 1000 };
  let confirmed = null;
  r._executeConfirmedSend = async (_roomId, held) => { confirmed = held; };
  r._reachedLoop = false;
  r._realFlyActive = async () => { r._reachedLoop = true; return true; };

  await r._handleMessage(ROOM, { sender: OWNER, content: { body: 'send', msgtype: 'm.text' }, origin_server_ts: Date.now() });

  assert.equal(confirmed, null, 'expired hold must not fire');
  assert.equal(r.pendingSend, null);
});
