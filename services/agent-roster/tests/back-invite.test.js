/**
 * back-invite loop guard (2026-07-05): a solo DM room whose owner was invited
 * but never joined (deactivated/absent user) must NOT be re-invited on every
 * reconcile — `joined_members` omits pending invites, so the old code looped
 * forever. _backInviteOwner now checks m.room.member state and skips 'invite'
 * or 'join'.
 *
 * node --test; _request stubbed on the instance.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AgentRunner } = require('../lib/agent-runner');

const OWNER = '@windy_absent:chat.windychat.ai';
const AGENT = '@agent_test:chat.windychat.ai';
const ROOM = '!solo:chat.windychat.ai';

function makeRunner(memberState) {
  const runner = Object.create(AgentRunner.prototype);
  runner.matrixUserId = AGENT;
  const calls = { invites: 0, requests: [] };
  runner._request = async (path, opts = {}) => {
    calls.requests.push(`${opts.method || 'GET'} ${path}`);
    if (path === '/_matrix/client/v3/joined_rooms') {
      return { ok: true, json: async () => ({ joined_rooms: [ROOM] }) };
    }
    if (path.endsWith('/joined_members')) {
      return { ok: true, json: async () => ({ joined: { [AGENT]: {} } }) }; // solo
    }
    if (path.includes('/state/m.room.member/')) {
      if (memberState === null) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, json: async () => ({ membership: memberState }) };
    }
    if (path.endsWith('/invite')) {
      calls.invites += 1;
      return { ok: true, json: async () => ({}) };
    }
    return { ok: false, json: async () => ({}) };
  };
  return { runner, calls };
}

test('never-invited owner (no state event) → invites once', async () => {
  const { runner, calls } = makeRunner(null);
  await runner._backInviteOwner(OWNER);
  assert.strictEqual(calls.invites, 1, 'should invite when owner has no membership');
});

test('owner already invited (pending) → does NOT re-invite', async () => {
  const { runner, calls } = makeRunner('invite');
  await runner._backInviteOwner(OWNER);
  assert.strictEqual(calls.invites, 0, 'must not re-invite a pending owner (this was the loop)');
});

test('owner already joined → does NOT re-invite', async () => {
  const { runner, calls } = makeRunner('join');
  await runner._backInviteOwner(OWNER);
  assert.strictEqual(calls.invites, 0, 'must not invite an already-joined owner');
});

test('owner who left → does NOT re-invite (respect the choice; no nagging)', async () => {
  const { runner, calls } = makeRunner('leave');
  await runner._backInviteOwner(OWNER);
  assert.strictEqual(calls.invites, 0, 'a left/deactivated owner must not be re-invited every reconcile');
});
