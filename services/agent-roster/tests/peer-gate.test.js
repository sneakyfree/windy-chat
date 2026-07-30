/**
 * [P1] Agent↔agent Eternitas gate (2026-07-26).
 *
 * Guiding principle #6 makes agent↔agent a first-class feature *for
 * credentialed agents*. Before this, `_handleMessage` dropped every
 * non-owner sender, so a passport bought nothing on the chat path. These
 * tests pin the three things that must stay true:
 *
 *   1. Credentials decide. An agent with a clean Eternitas profile gets a
 *      conversation; an uncredentialed sender still gets nothing.
 *   2. The gate fails CLOSED. Unreachable Eternitas denies — unlike the
 *      rest of the runner, which fails toward answering.
 *   3. A peer never gets tool authority, and never touches the owner's
 *      held send.
 *
 * Run: node --test services/agent-roster/tests/peer-gate.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

// The gate reads Eternitas through services/shared/trust-client. Mock mode
// is deterministic and keyed off substrings in the passport, so we can build
// every case as a Matrix id. MUST be set before the module is required.
process.env.ETERNITAS_USE_MOCK = 'true';

const peerGate = require('../lib/peer-gate');
const { AgentRunner } = require('../lib/agent-runner');

const OWNER = '@grant.whitmer:chat.windychat.ai';
const SELF = '@agent_et26-self-good:chat.windychat.ai';
const SELF_PASSPORT = 'ET26-SELF-GOOD';
const ROOM = '!room:chat.windychat.ai';

// Mock-mode passports (trust-client.mockProfile):
//   default    → band=good, clearance=cleared, allowed_actions includes dm_bots
//   ...TOP...  → clearance=top_secret, dm_bots allowed
//   CRITICAL   → band=critical, allowed_actions=[]
//   SUSPENDED  → status=suspended
//   REVOKED    → status=revoked
const PEER_GOOD = '@agent_et26-peer-abcd:chat.windychat.ai';
const PEER_TOP = '@agent_et26-top-abcd:chat.windychat.ai';
const PEER_CRITICAL = '@agent_et26-critical-1:chat.windychat.ai';
const PEER_SUSPENDED = '@agent_et26-suspended-1:chat.windychat.ai';
const PEER_REVOKED = '@agent_et26-revoked-1:chat.windychat.ai';
const HUMAN_STRANGER = '@mallory:chat.windychat.ai';

// ── passportFromMatrixId ───────────────────────────────────────────────

test('[P1] a peer Matrix id maps back to its Eternitas passport', () => {
  assert.equal(peerGate.passportFromMatrixId(PEER_GOOD), 'ET26-PEER-ABCD');
  assert.equal(peerGate.passportFromMatrixId(SELF), SELF_PASSPORT);
});

test('[P1] non-agent and malformed ids map to null, never a guess', () => {
  assert.equal(peerGate.passportFromMatrixId(HUMAN_STRANGER), null);
  assert.equal(peerGate.passportFromMatrixId('@grant.whitmer:chat.windychat.ai'), null);
  // Right prefix, wrong passport shape — Eternitas 400s on these, so we
  // must not spend a round trip proving it.
  assert.equal(peerGate.passportFromMatrixId('@agent_xx99-nope:chat.windychat.ai'), null);
  assert.equal(peerGate.passportFromMatrixId('@agent_:chat.windychat.ai'), null);
  assert.equal(peerGate.passportFromMatrixId(null), null);
  assert.equal(peerGate.passportFromMatrixId('agent_et26-no-sigil:host'), null);
});

// ── classifyPeer ───────────────────────────────────────────────────────

test('[P1] a credentialed agent in good standing is allowed', async () => {
  const v = await peerGate.classifyPeer({
    senderMatrixId: PEER_GOOD, selfPassport: SELF_PASSPORT, policy: 'trusted',
  });
  assert.equal(v.allow, true);
  assert.equal(v.peerPassport, 'ET26-PEER-ABCD');
  assert.equal(v.clearance, 'cleared');
});

test('[P1] a non-owner HUMAN is still refused — this does not widen the human surface', async () => {
  const v = await peerGate.classifyPeer({
    senderMatrixId: HUMAN_STRANGER, selfPassport: SELF_PASSPORT, policy: 'open',
  });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'not_an_agent');
});

test('[P1] revoked, suspended and critical passports are all refused', async () => {
  for (const [sender, reason] of [
    [PEER_REVOKED, 'passport_not_active'],
    [PEER_SUSPENDED, 'passport_not_active'],
    [PEER_CRITICAL, 'passport_critical'],
  ]) {
    const v = await peerGate.classifyPeer({
      senderMatrixId: sender, selfPassport: SELF_PASSPORT, policy: 'trusted',
    });
    assert.equal(v.allow, false, `${sender} must be denied`);
    assert.equal(v.reason, reason);
    assert.equal(v.side, 'sender');
  }
});

test('[P1] policy=off refuses every peer without even calling Eternitas', async () => {
  const v = await peerGate.classifyPeer({
    senderMatrixId: PEER_TOP, selfPassport: SELF_PASSPORT, policy: 'off',
  });
  assert.equal(v.allow, false);
  assert.equal(v.reason, 'owner_disabled_peers');
});

test('[P1] our OWN suspended passport denies inbound, and says so on our side', async () => {
  const v = await peerGate.classifyPeer({
    senderMatrixId: PEER_GOOD, selfPassport: 'ET26-SUSPENDED-SELF', policy: 'trusted',
  });
  assert.equal(v.allow, false);
  assert.equal(v.side, 'recipient', 'a recipient-side failure must not be blamed on the peer');
});

// ── evaluateProfile: fail-closed + policy difference ───────────────────

test('[P1] FAIL CLOSED: unreachable Eternitas denies (unlike the rest of the runner)', () => {
  const r = peerGate.evaluateProfile(null, 'trusted');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'trust_api_unreachable');
});

test('[P1] an unknown passport denies', () => {
  const r = peerGate.evaluateProfile({ status: 'not_found', allowed_actions: [] }, 'trusted');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'passport_not_found');
});

test('[P1] trusted requires dm_bots; open does not, but still requires a live passport', () => {
  const noDm = { status: 'active', band: 'good', allowed_actions: ['read', 'send'] };
  assert.equal(peerGate.evaluateProfile(noDm, 'trusted').reason, 'missing_allowed_action');
  assert.equal(peerGate.evaluateProfile(noDm, 'open').ok, true);
  // "open" is not "off with extra steps" — a critical passport is still out.
  const critical = { status: 'active', band: 'critical', allowed_actions: [] };
  assert.equal(peerGate.evaluateProfile(critical, 'open').ok, false);
});

test('[P1] denial reasons never leak scoring internals (directory P1-5)', async () => {
  const v = await peerGate.classifyPeer({
    senderMatrixId: PEER_CRITICAL, selfPassport: SELF_PASSPORT, policy: 'trusted',
  });
  const keys = Object.keys(v);
  for (const leaky of ['integrity_score', 'dimensions', 'tier_multiplier', 'allowed_actions']) {
    assert.ok(!keys.includes(leaky), `verdict must not carry ${leaky}`);
  }
  assert.ok(!peerGate.denialNotice(v.reason).match(/\d{3}/), 'notice must not quote a score');
});

// ── rate limiting ──────────────────────────────────────────────────────

test('[P1] a chatty peer is capped per hour so it cannot drain the owner\'s day', () => {
  peerGate._resetForTest();
  process.env.AGENT_PEER_MSGS_PER_HOUR = '3';
  const results = [1, 2, 3, 4].map(() => peerGate.consumePeerMessage(SELF_PASSPORT, 'ET26-CHATTY'));
  assert.deepEqual(results.map(r => r.allowed), [true, true, true, false]);
  assert.ok(results[3].resetInMinutes > 0);
  // Buckets are per (self, peer) — a different peer starts fresh.
  assert.equal(peerGate.consumePeerMessage(SELF_PASSPORT, 'ET26-OTHER').allowed, true);
  delete process.env.AGENT_PEER_MSGS_PER_HOUR;
});

test('[P1] a denial notice goes out at most once an hour, so refusal cannot become the spam', () => {
  peerGate._resetForTest();
  assert.equal(peerGate.shouldSendDenialNotice(SELF_PASSPORT, 'ET26-LOOPER', ROOM), true);
  assert.equal(peerGate.shouldSendDenialNotice(SELF_PASSPORT, 'ET26-LOOPER', ROOM), false);
  assert.equal(peerGate.shouldSendDenialNotice(SELF_PASSPORT, 'ET26-LOOPER', '!other:h'), true);
});

// ── chimpanzee override ────────────────────────────────────────────────

test('[P1] the owner can open and close peer chat by saying so', () => {
  assert.deepEqual(peerGate.parseOwnerPolicyCommand('agents off'), { action: 'set', policy: 'off' });
  assert.deepEqual(peerGate.parseOwnerPolicyCommand('Agents On!'), { action: 'set', policy: 'trusted' });
  assert.deepEqual(peerGate.parseOwnerPolicyCommand('  let agents talk to me  '), { action: 'set', policy: 'trusted' });
  assert.deepEqual(peerGate.parseOwnerPolicyCommand('agent status'), { action: 'status' });
});

test('[P1] a sentence that merely mentions agents does NOT flip the policy', () => {
  for (const t of [
    'can other agents talk to me?',
    'turn the agents off tomorrow',
    'what are agents on this network',
    'hi',
    '',
  ]) {
    assert.equal(peerGate.parseOwnerPolicyCommand(t), null, `must not match: ${t}`);
  }
});

test('[P1] policy copy is plain English and tells the owner what a peer cannot do', () => {
  const on = peerGate.policyDescription('trusted');
  assert.match(on, /agents off/, 'must always show the way back out');
  assert.match(on, /send email|search the web/i, 'must state that peers have no tool authority');
  assert.match(peerGate.policyDescription('off'), /agents on/);
});

// ── the runner, end to end ─────────────────────────────────────────────

function makeRunner() {
  const r = Object.create(AgentRunner.prototype);
  r.matrixUserId = SELF;
  r.ownerMatrixId = OWNER;
  r.peerPolicy = null;
  r.lastEventAt = null;
  r.pendingSend = null;
  r.sent = [];
  r._reachedLoop = false;
  r._sendMessage = async (_roomId, text) => { r.sent.push(text); };
  // First call past the band gate. Returning true yields to the "real Fly"
  // and stops the flow here, keeping the test hermetic (no LLM, no network).
  r._realFlyActive = async () => { r._reachedLoop = true; return true; };
  return r;
}

function freshMsg(sender, body = 'hi') {
  return { sender, content: { body, msgtype: 'm.text' }, origin_server_ts: Date.now() };
}

test('[P1] a credentialed peer now reaches the agent loop — the whole point', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  await r._handleMessage(ROOM, freshMsg(PEER_GOOD));
  assert.equal(r._reachedLoop, true, 'a cleared peer must be answered');
});

test('[P1] a revoked peer is refused and told why, exactly once', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  await r._handleMessage(ROOM, freshMsg(PEER_REVOKED));
  await r._handleMessage(ROOM, freshMsg(PEER_REVOKED));
  assert.equal(r._reachedLoop, false, 'a revoked peer must never reach the loop');
  assert.equal(r.sent.length, 1, 'refusal is sent once per hour, not per message');
  assert.match(r.sent[0], /passport isn't active/i);
});

test('[P1] a non-owner human is still dropped in silence (PR #137 stands)', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  await r._handleMessage(ROOM, freshMsg(HUMAN_STRANGER));
  assert.equal(r._reachedLoop, false);
  assert.equal(r.sent.length, 0, 'an uninvited human learns nothing from the agent');
});

test('[P1] a peer cannot confirm the owner\'s held email send', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  r.pendingSend = { to: 'x@y.z', subject: 's', body: 'b', roomId: ROOM, ts: Date.now() };
  r._isConfirmWord = () => true;
  r._executeConfirmedSend = async () => { throw new Error('a peer must never trigger a send'); };
  await r._handleMessage(ROOM, freshMsg(PEER_GOOD, 'send'));
  assert.ok(r.pendingSend, 'the owner\'s held draft must survive a peer message untouched');
});

test('[P1] the owner turning peers off takes effect immediately', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  await r._handleMessage(ROOM, freshMsg(OWNER, 'agents off'));
  assert.equal(r.peerPolicy, 'off');
  assert.match(r.sent[0], /\*\*off\*\*/);
  assert.equal(r._reachedLoop, false, 'a policy command is its own turn — no LLM call');

  await r._handleMessage(ROOM, freshMsg(PEER_GOOD));
  assert.equal(r._reachedLoop, false, 'the peer that was welcome a moment ago is now refused');

  await r._handleMessage(ROOM, freshMsg(OWNER, 'agents on'));
  assert.equal(r.peerPolicy, 'trusted');
  await r._handleMessage(ROOM, freshMsg(PEER_GOOD));
  assert.equal(r._reachedLoop, true, 'and welcome again once the owner says so');
});

test('[P1] a PEER cannot flip the policy — only the chimpanzee', async () => {
  peerGate._resetForTest();
  const r = makeRunner();
  await r._handleMessage(ROOM, freshMsg(PEER_GOOD, 'agents off'));
  assert.equal(r.peerPolicy, null, 'a peer saying the magic words must change nothing');
  assert.equal(r._reachedLoop, true, 'it is just a message to answer');
});
