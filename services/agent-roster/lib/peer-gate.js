/**
 * Agent↔agent gate — Eternitas-aware banding for the midwife runner.
 *
 * WHY THIS EXISTS
 * ---------------
 * Guiding principle #6 makes agent↔agent communication a first-class
 * feature: the Windy ecosystem is meant to be God's gift to agents *as
 * long as they carry Eternitas credentials*. Until this module, the
 * roster runner's only test was "is this sender my owner's Matrix id?"
 * (`agent-runner._handleMessage`, added by PR #137 to stop a stranger
 * driving someone's agent). That fix was right about strangers and wrong
 * about peers: a credentialed agent with a spotless Eternitas record and
 * an anonymous nobody were treated identically — ignored. The passport
 * bought nothing on the one surface where it was supposed to matter.
 *
 * Meanwhile `directory/routes/agents.js` already implements exactly the
 * right rule at `/agents/gate/dm` (both sides must hold `dm_bots`) and
 * has had ZERO callers since it was written. This module is the missing
 * caller, in-process: same trust client, same contract, no extra network
 * hop on the message path.
 *
 * THE LADDER (mirrors windy-agent's Band IntEnum)
 *   owner    — the human this agent belongs to. Full authority, tools on.
 *   peer     — another agent whose Eternitas passport clears the policy.
 *              Converses freely; NO tools (see below).
 *   stranger — everything else. Silently ignored, exactly as before.
 *
 * WHY PEERS GET NO TOOLS
 * A peer is trusted to *talk*, not to *act*. `send_email` sends from the
 * owner's verified windymail.ai address and `web_search` spends the
 * owner's metered allowance; neither is the peer's to spend. Escalating
 * a peer to tool authority is a separate, deliberate decision that needs
 * its own owner-facing consent — it is NOT a side effect of turning on
 * agent↔agent chat.
 *
 * FAIL CLOSED — deliberately different from the rest of the runner.
 * Elsewhere in agent-runner, ambiguity resolves toward answering (a
 * silent agent is a worse failure than a duplicate voice). Not here.
 * This is an authorization decision, not an availability one: if
 * Eternitas is unreachable we cannot show that the peer is credentialed,
 * so we do not extend it credentialed treatment. The owner is never
 * affected — the owner path never reaches this module.
 *
 * THE CHIMPANZEE OVERRIDE
 * Doctrine says the human overrides Eternitas, not the other way round.
 * `AGENT_PEER_POLICY` sets the fleet default and the owner can move
 * their own agent at runtime by saying so in chat (see
 * `parseOwnerPolicyCommand`). That runtime override is in-memory and
 * per-process ON PURPOSE: a restart falls back to the configured
 * default, which is the safe direction. Persisting it belongs with the
 * control panel, not here.
 *
 * Policies:
 *   off      — no agent talks to this agent. Owner-only, i.e. the exact
 *              behaviour before this module shipped.
 *   trusted  — DEFAULT. Peer must be active, non-critical, and hold
 *              `dm_bots`. Mirrors /agents/gate/dm.
 *   open     — peer must be active and non-critical; `dm_bots` not
 *              required. For demos and for agents whose issuer hasn't
 *              granted the action yet. Still refuses uncredentialed
 *              senders — "open" is not "off".
 */
'use strict';

const { getTrustProfile } = require('../../shared/trust-client');

const POLICY_OFF = 'off';
const POLICY_TRUSTED = 'trusted';
const POLICY_OPEN = 'open';
const POLICIES = Object.freeze([POLICY_OFF, POLICY_TRUSTED, POLICY_OPEN]);

/** Fleet default, read at call time so tests and reconciles see env changes. */
function defaultPolicy() {
  const raw = String(process.env.AGENT_PEER_POLICY || POLICY_TRUSTED).trim().toLowerCase();
  return POLICIES.includes(raw) ? raw : POLICY_TRUSTED;
}

// Onboarding mints every agent as `@agent_<passport>:chat.windychat.ai`
// (agent-provision.js), lowercasing the passport. That makes the mapping
// exactly reversible — which is the whole reason a peer's credentials are
// checkable from a Matrix id alone, with no directory lookup.
//
// Eternitas passports start ET (agent) or EH (human) per trust-api.md; the
// trust API 400s on anything else, so reject those here rather than spend a
// round trip proving it.
const PASSPORT_RE = /^E[TH][A-Z0-9][A-Z0-9-]{2,30}$/;

function passportFromMatrixId(matrixUserId) {
  if (typeof matrixUserId !== 'string' || matrixUserId[0] !== '@') return null;
  const localpart = matrixUserId.slice(1).split(':')[0];
  if (!localpart.startsWith('agent_')) return null;
  const passport = localpart.slice('agent_'.length).toUpperCase();
  return PASSPORT_RE.test(passport) ? passport : null;
}

function isAgentMatrixId(matrixUserId) {
  return passportFromMatrixId(matrixUserId) !== null;
}

/**
 * Does this trust profile clear the policy? Ordering matters: status
 * before band before actions, so the reason we report is the most
 * fundamental one that applies.
 *
 * Deny reasons never carry integrity_score / dimensions / tier_multiplier
 * (directory P1-5): telling a rejected caller *how close* it got lets it
 * iterate against the scoring model.
 */
function evaluateProfile(profile, policy) {
  if (!profile) return { ok: false, reason: 'trust_api_unreachable' };
  if (profile.status === 'not_found') return { ok: false, reason: 'passport_not_found' };
  if (profile.status !== 'active') return { ok: false, reason: 'passport_not_active' };
  if (profile.band === 'critical') return { ok: false, reason: 'passport_critical' };
  if (policy === POLICY_TRUSTED) {
    const actions = Array.isArray(profile.allowed_actions) ? profile.allowed_actions : [];
    if (!actions.includes('dm_bots')) return { ok: false, reason: 'missing_allowed_action' };
  }
  return { ok: true };
}

/**
 * Classify a non-owner sender.
 *
 * Both sides are checked, mirroring /agents/gate/dm: our own agent must
 * also be credentialed to receive. An agent whose own passport is
 * suspended does not get to keep taking meetings.
 *
 * @returns {Promise<{allow: boolean, reason?: string, side?: string,
 *                    peerPassport?: string, clearance?: string, trustBand?: string}>}
 */
async function classifyPeer({ senderMatrixId, selfPassport, policy }) {
  const effective = POLICIES.includes(policy) ? policy : defaultPolicy();
  const peerPassport = passportFromMatrixId(senderMatrixId);

  // Not an agent at all — a human who is not the owner. Unchanged from
  // PR #137: ignored, and not told why. This module deliberately does not
  // widen the human surface.
  if (!peerPassport) return { allow: false, reason: 'not_an_agent' };

  if (effective === POLICY_OFF) {
    return { allow: false, reason: 'owner_disabled_peers', peerPassport };
  }

  const peer = await getTrustProfile(peerPassport);
  const senderCheck = evaluateProfile(peer, effective);
  if (!senderCheck.ok) {
    return { allow: false, reason: senderCheck.reason, side: 'sender', peerPassport };
  }

  if (selfPassport) {
    const self = await getTrustProfile(selfPassport);
    const recipientCheck = evaluateProfile(self, effective);
    if (!recipientCheck.ok) {
      return { allow: false, reason: recipientCheck.reason, side: 'recipient', peerPassport };
    }
  }

  return {
    allow: true,
    peerPassport,
    clearance: peer.clearance_level || null,
    trustBand: peer.band || null,
  };
}

// ── Per-peer rate limit ────────────────────────────────────────────────
// A peer exchange spends the OWNER's daily message allowance (it is the
// owner's compute), so one chatty agent must not be able to drain a whole
// day before the owner sends a single message. Rolling hour, per
// (self, peer) pair, in-memory — the same posture as `knownRecipients`:
// a friction limiter, not the security boundary.

const WINDOW_MS = 60 * 60 * 1000;
const peerBuckets = new Map(); // `${self}|${peer}` -> { count, resetAt }

function peerHourlyLimit() {
  const n = parseInt(process.env.AGENT_PEER_MSGS_PER_HOUR || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function consumePeerMessage(selfPassport, peerPassport, now = Date.now()) {
  const limit = peerHourlyLimit();
  const key = `${selfPassport || 'unknown'}|${peerPassport}`;
  const bucket = peerBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    peerBuckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      resetInMinutes: Math.max(1, Math.ceil((bucket.resetAt - now) / 60000)),
    };
  }
  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count };
}

// ── Denial notices ─────────────────────────────────────────────────────
// A silent drop is hostile to an agent-friendly ecosystem — the peer has
// no way to learn it is misconfigured. So we answer once, cheaply (no LLM),
// then go quiet: at most one notice per (self, peer, room) per hour, so a
// looping peer can't turn the refusal itself into the spam.

const noticeSent = new Map(); // `${self}|${peer}|${room}` -> epochMs

function shouldSendDenialNotice(selfPassport, peerPassport, roomId, now = Date.now()) {
  const key = `${selfPassport || 'unknown'}|${peerPassport}|${roomId}`;
  const last = noticeSent.get(key);
  if (last && now - last < WINDOW_MS) return false;
  noticeSent.set(key, now);
  return true;
}

// Plain, actionable, and free of scoring internals.
const DENIAL_COPY = {
  owner_disabled_peers: "I'm not taking messages from other agents right now — my owner has agent-to-agent chat switched off.",
  trust_api_unreachable: "I can't reach Eternitas to check your credentials right now, so I can't talk to you yet. Try again in a few minutes.",
  passport_not_found: "I don't see an Eternitas passport for you, so I can't talk to you. Agents need credentials to reach me here.",
  passport_not_active: "Your Eternitas passport isn't active, so I can't talk to you right now.",
  passport_critical: "Your Eternitas standing is too low for me to talk to you right now.",
  missing_allowed_action: "Your Eternitas passport doesn't include agent-to-agent messaging (`dm_bots`), so I can't reply. Your operator can request it.",
  rate_limited: "You've hit my hourly limit for another agent — I'll pick this back up shortly.",
};

function denialNotice(reason, side) {
  const base = DENIAL_COPY[reason];
  if (!base) return "I can't talk to other agents right now.";
  // A recipient-side failure is OUR problem, not theirs — say so, or the
  // peer's operator will go debug a passport that is perfectly fine.
  if (side === 'recipient') {
    return "I can't take agent-to-agent messages right now — the problem is on my side, not yours. My operator has been notified.";
  }
  return base;
}

// ── Chimpanzee override ────────────────────────────────────────────────
// The human overrides Eternitas. No dashboard required: the owner says it
// in the chat they are already in. Deliberately a small closed set of
// exact phrases rather than intent detection — a policy switch must never
// fire on a sentence that merely mentions agents, and the owner always
// gets an explicit confirmation of what changed.

const ON_PHRASES = [
  'agents on', 'agent chat on', 'let agents talk to me',
  'allow other agents', 'let other agents talk to me',
];
const OFF_PHRASES = [
  'agents off', 'agent chat off', 'block other agents',
  'stop talking to other agents', 'no other agents',
];
const STATUS_PHRASES = ['agent status', 'agents?', 'who can talk to you'];

function normalize(text) {
  return String(text || '').trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
}

/**
 * @returns {null | {action: 'set', policy: string} | {action: 'status'}}
 */
function parseOwnerPolicyCommand(body) {
  const t = normalize(body);
  if (!t) return null;
  if (ON_PHRASES.includes(t)) return { action: 'set', policy: POLICY_TRUSTED };
  if (OFF_PHRASES.includes(t)) return { action: 'set', policy: POLICY_OFF };
  if (STATUS_PHRASES.includes(t)) return { action: 'status' };
  return null;
}

function policyDescription(policy) {
  if (policy === POLICY_OFF) {
    return "Agent-to-agent chat is **off** — only you can talk to me. Say **agents on** to change that.";
  }
  if (policy === POLICY_OPEN) {
    return "Agent-to-agent chat is **open** — any agent with a valid Eternitas passport can talk to me. "
      + "They can't send email or search the web as me. Say **agents off** to stop it.";
  }
  return "Agent-to-agent chat is **on** — agents with Eternitas credentials in good standing can talk to me. "
    + "They can't send email or search the web as me. Say **agents off** to stop it.";
}

function _resetForTest() {
  peerBuckets.clear();
  noticeSent.clear();
}

module.exports = {
  POLICY_OFF,
  POLICY_TRUSTED,
  POLICY_OPEN,
  POLICIES,
  defaultPolicy,
  passportFromMatrixId,
  isAgentMatrixId,
  evaluateProfile,
  classifyPeer,
  consumePeerMessage,
  peerHourlyLimit,
  shouldSendDenialNotice,
  denialNotice,
  parseOwnerPolicyCommand,
  policyDescription,
  _resetForTest,
};
