/**
 * [I1] Owner-only gate (2026-07-10): the roster runner must act ONLY on its
 * owner's messages and only auto-join rooms the owner invited it to. Before
 * this, it replied — with send_email authority — to ANY non-self sender, so a
 * stranger who got the agent into a room could drive it (send mail from the
 * owner's verified address, burn quota).
 *
 * node --test; downstream (_realFlyActive) stubbed to detect "got past the gate".
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { AgentRunner } = require('../lib/agent-runner');

const OWNER = '@grant.whitmer:chat.windychat.ai';
const AGENT = '@agent_et26-gate-test:chat.windychat.ai';
const STRANGER = '@mallory:chat.windychat.ai';

function makeRunner(ownerMatrixId) {
  const r = Object.create(AgentRunner.prototype);
  r.matrixUserId = AGENT;
  r.ownerMatrixId = ownerMatrixId;
  r.lastEventAt = null;
  r._reachedLoop = false;
  // First call past the owner gate; return true so the flow yields and stops
  // here (no LLM), keeping the test hermetic.
  r._realFlyActive = async () => { r._reachedLoop = true; return true; };
  return r;
}

function freshMsg(sender) {
  return { sender, content: { body: 'hi', msgtype: 'm.text' }, origin_server_ts: Date.now() };
}

test('[I1] a stranger message short-circuits before the agent loop', async () => {
  const r = makeRunner(OWNER);
  await r._handleMessage('!room:chat.windychat.ai', freshMsg(STRANGER));
  assert.equal(r._reachedLoop, false, 'stranger must be ignored before any tool/LLM path');
  assert.equal(r.lastEventAt, null);
});

test('[I1] the owner message proceeds past the gate', async () => {
  const r = makeRunner(OWNER);
  await r._handleMessage('!room:chat.windychat.ai', freshMsg(OWNER));
  assert.equal(r._reachedLoop, true, 'owner must be processed');
});

test('[I1] fail-safe: unknown owner id keeps prior behaviour (never lock the owner out)', async () => {
  const r = makeRunner(null);
  await r._handleMessage('!room:chat.windychat.ai', freshMsg(STRANGER));
  assert.equal(r._reachedLoop, true, 'with no resolved owner id, do not go silent');
});

test('[I1] _inviteSender returns the inviter from stripped invite state, null when absent', () => {
  const r = Object.create(AgentRunner.prototype);
  r.matrixUserId = AGENT;
  const inviteRoom = {
    invite_state: {
      events: [
        { type: 'm.room.member', state_key: AGENT, sender: STRANGER, content: { membership: 'invite' } },
      ],
    },
  };
  assert.equal(r._inviteSender(inviteRoom), STRANGER);
  assert.equal(r._inviteSender({}), null);
  assert.equal(r._inviteSender({ invite_state: { events: [] } }), null);
});
