/**
 * Per-agent Matrix listener. One instance per hatched agent.
 *
 * Responsibilities:
 *   1. Long-poll Synapse's /sync endpoint as the agent's Matrix user
 *   2. On incoming m.room.message events from non-self senders:
 *      - generate a reply via the LLM module
 *      - send the reply back to the room
 *      - emit typing indicators while drafting
 *   3. Survive transient failures with exponential backoff
 *
 * Why this approach (vs matrix-js-sdk / matrix-bot-sdk):
 *   - Zero dependencies. The /sync REST contract is stable and tiny.
 *   - No browser-globals polyfilling needed (matrix-js-sdk wants
 *     `localStorage`, `IndexedDB`, `crypto.subtle` etc. in Node).
 *   - Easier to reason about under load — one fetch loop per agent,
 *     all running in the same asyncio event loop via node's libuv.
 *
 * The /sync long-poll holds for 30s; on each iteration we walk all
 * joined rooms and dispatch new m.room.message events newer than
 * INITIAL_SYNC_AGE_SECS so we don't backlog-spam old conversations on
 * cold start.
 */

const { generateReply } = require('./llm');
const { getSliders } = require('./settings');
const { availableTools, executeTool } = require('./tools');
const windySearch = require('./windy-search');
const { consumeMessage, consumeMail, quotaMessage } = require('./quota');
const { getClearance, exhaustionMessage } = require('./upsell');
const adminTelemetry = require('../../shared/admin-telemetry');

// ADR-056: verified owners earn a larger daily message allowance — the
// $1 upgrade genuinely buys a bigger day, so the exhaustion upsell is
// honest. Multiplier applies to any clearance above 'registered'.
const VERIFIED_QUOTA_MULTIPLIER = Math.max(
  1, parseFloat(process.env.QUOTA_VERIFIED_MULTIPLIER || '2'),
);

const INITIAL_SYNC_AGE_SECS = 30;
const SYNC_TIMEOUT_MS = 30000;
// Client-side socket ceiling for quick Matrix calls (send/typing/history/join).
// The /sync long-poll passes its own longer timeout (SYNC_TIMEOUT_MS + buffer).
// Without this, a half-open socket hangs _request forever and the agent goes
// silent to its owner until the process restarts.
const REQUEST_TIMEOUT_MS = 15000;
const BACKOFF_MAX_MS = 60000;
// [I1 Phase 1b] How long a held "reply send to confirm" draft stays valid.
const PENDING_SEND_TTL_MS = 15 * 60 * 1000;

function newTxnId() {
  return `windy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class AgentRunner {
  constructor({ matrixUserId, accessToken, agentName, ownerWindyId, ownerMatrixId, homeserver, ownerContext, agentMailAddress }) {
    this.matrixUserId = matrixUserId;
    this.accessToken = accessToken;
    this.agentName = agentName;
    this.ownerWindyId = ownerWindyId;
    // [I1] The owner's Matrix id (@localpart:server), resolved by the roster
    // from user_profiles. The personal agent acts ONLY on its owner's
    // messages and only auto-joins rooms the owner invited it to. May be null
    // in rare pre-provision states — the gates fail SAFE toward the prior
    // behaviour so the owner is never locked out (see _handleMessage / _syncOnce).
    this.ownerMatrixId = ownerMatrixId || null;
    // ownerContext is { mailAddress, displayName } — provided by the
    // roster so the agent can act ON BEHALF OF the operator (send mail
    // from their address, address them by name in replies). May be
    // null on cold-start before the owner activates chat; in that case
    // tool calls fall back to a friendly "set up Mail first" reply.
    this.ownerContext = ownerContext || {};
    // The agent's OWN mailbox (minted at hatch, e.g.
    // fable-s-agent@windymail.ai). Used as the send-from address when the
    // operator has no windymail address of their own — which is the common
    // case, since most people sign up with an external email. Without this,
    // the send_email tool stays disabled forever for those users and the
    // agent can only ever say "I'm still learning that". Resend has
    // windymail.ai verified, so the From: header works for any agent mailbox.
    this.agentMailAddress = agentMailAddress || null;
    // Strip any trailing slash; the /_matrix paths assume bare host.
    this.homeserver = (homeserver || 'https://chat.windychat.ai').replace(/\/$/, '');
    this.since = null;
    this.startedAt = Date.now();
    this.running = false;
    this.lastError = null;
    this.lastEventAt = null;
    this.repliesSent = 0;
    this.toolCallsExecuted = 0;
    this._loopPromise = null;
    // [I1 Phase 1b] Self-building send_email recipient allow-list. Addresses
    // the owner has confirmed a send to (this process lifetime) go immediately;
    // any NEW address is HELD until the owner replies "send". In-memory by
    // design — the set is a friction-reducer, not the security boundary (the
    // confirm is). Worst case after a restart: the owner re-confirms a known
    // address once. `pendingSend` holds at most one draft at a time.
    this.knownRecipients = new Set();
    this.pendingSend = null;  // { to, subject, body, roomId, ts }
  }

  /** Update owner context (mailAddress + displayName) — called by the
   *  roster on reconcile so newly-activated mailboxes light up live. */
  updateOwnerContext(ctx) {
    this.ownerContext = { ...this.ownerContext, ...ctx };
  }

  /** [I1] Who invited this agent to a room, from the stripped invite state in
   *  a /sync `rooms.invite` entry. Returns the inviter's Matrix id (the sender
   *  of our own membership=invite event) or null when it can't be determined. */
  _inviteSender(inviteRoom) {
    const events = inviteRoom?.invite_state?.events || [];
    for (const ev of events) {
      if (
        ev.type === 'm.room.member' &&
        ev.state_key === this.matrixUserId &&
        ev.content?.membership === 'invite'
      ) {
        return ev.sender || null;
      }
    }
    return null;
  }

  /** [I1 Phase 1b] Normalise a send_email `to` (single or comma-list) into a
   *  lowercased address array. */
  _recipientsOf(to) {
    if (!to || typeof to !== 'string') return [];
    return to.split(',').map(r => r.trim().toLowerCase()).filter(Boolean);
  }

  /** [I1 Phase 1b] Does this owner message confirm a held send? Strict, so it
   *  never swallows a real request (e.g. "send it to my doctor"). */
  _isConfirmWord(body) {
    return /^\s*(send|send it|yes,?\s*send(\s*it)?|confirm)\s*[.!]?\s*$/i.test(body || '');
  }

  /** [I1 Phase 1b] Hold this send for owner confirmation iff it targets any
   *  address the owner hasn't confirmed before. */
  _shouldHoldSend(args) {
    const recips = this._recipientsOf(args?.to);
    return recips.length > 0 && recips.some(r => !this.knownRecipients.has(r));
  }

  /** Send context (from-address + display) — the operator's own windymail
   *  address if they have one, else the agent's own mailbox. */
  _resolveSendContext() {
    const ownerMail = this.ownerContext?.mailAddress || null;
    const sendFromAddress = ownerMail || this.agentMailAddress;
    const sendFromDisplay = ownerMail ? (this.ownerContext?.displayName || null) : this.agentName;
    return {
      ownerMailAddress: sendFromAddress,
      ownerDisplayName: sendFromDisplay,
      agentName: this.agentName,
      passport: this._passport(),
    };
  }

  /** [I1 Phase 1b] Execute a send the owner just confirmed: consume quota,
   *  send, remember the recipient(s), report. */
  async _executeConfirmedSend(roomId, held) {
    const mailGate = consumeMail(this.ownerWindyId);
    if (!mailGate.allowed) {
      await this._sendMessage(roomId, quotaMessage('mail', mailGate.resetInHours));
      return;
    }
    const ctx = this._resolveSendContext();
    this.toolCallsExecuted += 1;
    const out = await executeTool('send_email',
      { to: held.to, subject: held.subject, body: held.body }, ctx);
    adminTelemetry.emit({
      service: 'agent-roster', event_type: 'roster.tool_call', actor_type: 'agent',
      actor_id: ctx.passport, session_id: roomId,
      metadata: { tool: 'send_email', ok: !!out.ok, confirmed: true },
    });
    if (out.ok) {
      for (const r of this._recipientsOf(held.to)) this.knownRecipients.add(r);
      await this._sendMessage(roomId, `Sent ✓ — from ${out.from} to ${held.to}.`);
    } else {
      await this._sendMessage(roomId, out.error || 'Sorry — the send failed. Want to try again?');
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._loopPromise = this._loop().catch(err => {
      console.error(`[runner ${this.matrixUserId}] fatal loop error:`, err.message);
      this.running = false;
    });
  }

  /**
   * Hatch-race recovery. If the operator's Matrix account didn't exist when
   * this agent hatched, the DM room was created by the agent with no invitee
   * (the agent's room ends up as a 1-member room — just the agent). Once
   * the operator provisions their own Matrix user, nothing currently
   * back-invites them; the seedPendingAgentDMs path in onboarding only
   * fires if welcomed_at is null, which it usually isn't post-hatch.
   *
   * This method, called once per startup, finds any joined rooms where the
   * agent is the only member and the operator's Matrix ID is resolvable,
   * and invites the operator. Idempotent — if already in the room, the
   * Synapse invite returns 400 M_FORBIDDEN which we swallow.
   */
  async _backInviteOwner(ownerMatrixId) {
    if (!ownerMatrixId) return;
    try {
      // List joined rooms; for each, check member count. If we're the only
      // member, invite the owner.
      const res = await this._request('/_matrix/client/v3/joined_rooms', { method: 'GET' });
      if (!res.ok) return;
      const data = await res.json();
      const rooms = data.joined_rooms || [];
      for (const roomId of rooms) {
        try {
          const mRes = await this._request(
            `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
            { method: 'GET' },
          );
          if (!mRes.ok) continue;
          const mData = await mRes.json();
          const memberIds = Object.keys(mData.joined || {});
          if (memberIds.length === 1 && memberIds[0] === this.matrixUserId) {
            // Solo room. This method exists ONLY to recover from the hatch race
            // (owner had no Matrix account when the agent created the DM, so was
            // never invited). Invite ONLY when the owner has NO membership event
            // at all. `joined_members` omits pending invites, so without this
            // check an owner who was already invited but never joined (a
            // deactivated or absent user) got re-invited on every reconcile
            // forever — Synapse happily re-sends a pending invite. Any existing
            // membership (invite/join/leave/ban) means we've done our job or the
            // owner made a choice; either way, don't nag.
            let ownerMembership = null;
            try {
              const stRes = await this._request(
                `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(ownerMatrixId)}`,
                { method: 'GET' },
              );
              if (stRes.ok) ownerMembership = (await stRes.json()).membership || null;
            } catch (_e) { /* no state event = never invited; fall through to invite */ }

            if (ownerMembership) {
              continue; // already invite/join/leave/ban — nothing to recover
            }

            const inviteRes = await this._request(
              `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
              {
                method: 'POST',
                body: JSON.stringify({ user_id: ownerMatrixId }),
              },
            );
            if (inviteRes.ok) {
              console.log(`[runner ${this.matrixUserId}] back-invited ${ownerMatrixId} to solo room ${roomId}`);
            }
          }
        } catch (_e) { /* per-room non-fatal */ }
      }
    } catch (err) {
      console.warn(`[runner ${this.matrixUserId}] back-invite scan failed: ${err.message}`);
    }
  }

  stop() {
    this.running = false;
  }

  async _request(path, options = {}) {
    const url = `${this.homeserver}${path}`;
    const { timeoutMs = REQUEST_TIMEOUT_MS, signal, ...fetchOptions } = options;
    const res = await fetch(url, {
      ...fetchOptions,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        ...(fetchOptions.headers || {}),
      },
      // Bound every Matrix call so a half-open socket can't hang the runner.
      // Callers may pass an explicit signal (honored) or timeoutMs override.
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return res;
  }

  async _sendMessage(roomId, body) {
    const txnId = newTxnId();
    const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`;
    const res = await this._request(path, {
      method: 'PUT',
      body: JSON.stringify({ msgtype: 'm.text', body, windy_original: true }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`send ${res.status}: ${detail.slice(0, 200)}`);
    }
    this.repliesSent += 1;
  }

  async _setTyping(roomId, isTyping) {
    try {
      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.matrixUserId)}`;
      await this._request(path, {
        method: 'PUT',
        body: JSON.stringify({ typing: isTyping, timeout: isTyping ? 15000 : 0 }),
      });
    } catch (_e) { /* non-fatal */ }
  }

  /**
   * Pull recent room history from Matrix and turn it into the
   * standard chat-completions shape: alternating user/assistant
   * messages. Used to give the LLM a memory of the conversation so
   * it isn't a per-message vending machine.
   *
   * We fetch up to limit*2 history events and keep only m.room.message
   * with msgtype m.text (drop typing/read-receipts/media-with-no-body).
   * The agent's own past messages become role:assistant; everyone
   * else becomes role:user (multi-party rooms collapse non-agent
   * speakers into the user voice — fine for v0 DM-mostly traffic).
   */
  async _fetchHistory(roomId, limit = 12) {
    try {
      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit * 2}`;
      const res = await this._request(path, { method: 'GET' });
      if (!res.ok) return [];
      const data = await res.json();
      const chunk = (data.chunk || []).reverse(); // chronological (oldest → newest)
      const history = [];
      for (const ev of chunk) {
        if (ev.type !== 'm.room.message') continue;
        const body = ev.content?.body;
        const msgtype = ev.content?.msgtype;
        if (!body || msgtype !== 'm.text') continue;
        history.push({
          role: ev.sender === this.matrixUserId ? 'assistant' : 'user',
          content: body,
        });
      }
      return history.slice(-limit);
    } catch (err) {
      console.warn(`[runner ${this.matrixUserId}] history fetch failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Post-tool synthesis (2026-07-06, web_search): feed the tool result
   * back to the LLM (OpenAI tool-message shape) so it answers the user
   * in its own words instead of us dumping raw JSON at grandma.
   * tool_choice:'none' blocks a second tool round — one search per
   * inbound message, matching the loop's no-recursion posture. Any
   * budget notice_to_user rides inside the tool content; the search
   * prompt section tells the model to relay it gently.
   */
  async _synthesizeToolReply({ history, call, toolResult, canMail, canSearch, ept, sliders }) {
    const followUp = [
      ...history,
      { role: 'assistant', content: null, tool_calls: [call] },
      {
        role: 'tool',
        tool_call_id: call.id || 'call_0',
        name: call.function?.name || 'web_search',
        content: JSON.stringify(toolResult),
      },
    ];
    try {
      const { availableTools } = require('./tools');
      const synth = await generateReply({
        history: followUp,
        agentName: this.agentName,
        ownerDisplayName: this.ownerContext?.displayName || null,
        tools: availableTools({ canMail, canSearch }),
        toolChoice: 'none',
        canMail,
        canSearch,
        ept,
        sliders,
      });
      if (synth.content && synth.content.trim()) return synth.content;
    } catch (err) {
      console.warn(`[runner ${this.matrixUserId}] synthesis failed: ${err.message}`);
    }
    // Fallback: readable digest of the top results — never raw JSON.
    const results = toolResult.results || [];
    if (!results.length) return "I searched but didn't find anything useful — want me to try different words?";
    const lines = results.slice(0, 3).map((r) => `• ${r.title} — ${r.snippet}`);
    const notice = toolResult.notice_to_user ? '\n\n(One more thing — ' +
      "I've used most of this month's included web searches; the allowance resets on the 1st.)" : '';
    return `Here's what I found:\n${lines.join('\n')}${notice}`;
  }

  /** @agent_et26-acnz-e2dd:... -> ET26-ACNZ-E2DD (provision lowercased it) */
  _passport() {
    const localpart = this.matrixUserId.slice(1).split(':')[0];
    return localpart.replace(/^agent_/, '').toUpperCase();
  }

  /**
   * One-soul yield (2026-07-05): is the REAL Windy Fly connected to
   * chat for this agent? We ask Windy Mind's runtime-claim presence
   * bit for the agent's `matrix` channel slot. Held -> the permanent
   * brain is online and the midwife stays silent. Any doubt (Mind
   * unreachable, timeout, malformed) -> answer anyway. A silent agent
   * is a worse failure than a duplicate voice; availability first.
   * 15s cache so a chatty room doesn't hammer Mind.
   */
  async _realFlyActive() {
    const now = Date.now();
    if (this._yieldCache && now - this._yieldCache.at < 15000) {
      return this._yieldCache.active;
    }
    let active = false;
    try {
      const passport = this._passport();
      const mindApi = process.env.MIND_API_URL || 'https://api.windymind.ai';
      const res = await fetch(
        `${mindApi}/v1/runtime/claim/${encodeURIComponent(passport)}/status?source=matrix`,
        { signal: AbortSignal.timeout(4000) },
      );
      if (res.ok) {
        const data = await res.json();
        active = data.active === true;
      }
    } catch { /* fail open */ }
    this._yieldCache = { at: now, active };
    return active;
  }

  async _handleMessage(roomId, event) {
    if (event.sender === this.matrixUserId) return;
    // [I1] Owner-only gate. Previously the runner replied — with send_email +
    // web_search tool authority — to ANY non-self sender, so a stranger who
    // got the agent into a room could drive it: send mail FROM the owner's
    // verified windymail.ai address to an attacker-chosen recipient
    // (spoofing/phishing) and burn the owner's quota. A personal agent takes
    // instructions from its person, full stop. Fail SAFE: if the owner's
    // Matrix id couldn't be resolved (rare pre-provision state) we fall back
    // to the prior behaviour rather than going silent — never lock the owner out.
    if (this.ownerMatrixId && event.sender !== this.ownerMatrixId) {
      console.log(`[runner ${this.matrixUserId}] ignoring non-owner sender ${event.sender} in ${roomId}`);
      return;
    }
    const body = event.content?.body;
    if (!body || typeof body !== 'string') return;
    // Ignore old events on first cold start so we don't reply to a week
    // of backlog with a flurry.
    const ageSecs = (Date.now() - (event.origin_server_ts || 0)) / 1000;
    if (ageSecs > INITIAL_SYNC_AGE_SECS) return;

    // [D1] Never log message content — private DM/room bodies must not reach
    // service logs / aggregation. Log metadata only.
    console.log(`[runner ${this.matrixUserId}] msg from ${event.sender} in ${roomId} (${body.length} chars)`);
    this.lastEventAt = new Date().toISOString();

    // [I1 Phase 1b] Held-send confirmation. If we're holding a draft to a NEW
    // recipient and the owner replies "send", dispatch it now — the confirm is
    // its own turn and only the owner (gate above) can reach here, so an
    // injected instruction that queued the draft can't complete the send. Any
    // other message supersedes the pending draft.
    if (this.pendingSend && this.pendingSend.roomId === roomId) {
      if (Date.now() - this.pendingSend.ts > PENDING_SEND_TTL_MS) {
        this.pendingSend = null;
      } else if (this._isConfirmWord(body)) {
        const held = this.pendingSend;
        this.pendingSend = null;
        await this._executeConfirmedSend(roomId, held);
        return;
      } else {
        this.pendingSend = null;
      }
    }

    // One-soul yield: if the real Windy Fly holds the matrix claim,
    // the midwife stays silent — the permanent brain answers.
    if (await this._realFlyActive()) {
      console.log(`[runner ${this.matrixUserId}] real Fly online — yielding`);
      return;
    }

    // Daily message-quota check BEFORE the LLM call. If over-budget,
    // reply with an honest cap message and bail — no LLM cost, no
    // surprise to the user. Quota is keyed to the OWNER's windy_id
    // so multi-agent owners share the budget (the human's allowance,
    // not the agent's). Verified owners (clearance above 'registered')
    // get a multiplied allowance — see VERIFIED_QUOTA_MULTIPLIER.
    const passport = this._passport();
    const clearance = await getClearance(passport); // 5-min cached, fail-null
    const quotaMult = clearance && clearance !== 'registered'
      ? VERIFIED_QUOTA_MULTIPLIER
      : 1;
    const msgGate = consumeMessage(this.ownerWindyId, quotaMult);
    if (!msgGate.allowed) {
      // Quota walls are funnel signal (ADR-WA-001 §3: rate-limit hits).
      adminTelemetry.emit({
        service: 'agent-roster',
        event_type: 'roster.quota_denied',
        actor_type: 'agent',
        actor_id: passport,
        session_id: roomId,
        metadata: { quota: 'message', clearance: clearance || 'unknown' },
      });
      // ADR-056 §5 — the wall is a warm hand-off, never a dead screen:
      // offer link-your-own-compute (always) and the $1 verified
      // upgrade (only when known-unverified AND the upsell flag is on).
      try {
        await this._sendMessage(roomId, exhaustionMessage({
          passport,
          clearance,
          resetInHours: msgGate.resetInHours,
        }));
      } catch (_e) { /* fall-through */ }
      return;
    }

    await this._setTyping(roomId, true);
    const exchangeStartedAt = Date.now();
    try {
      // Pull conversation memory from Matrix /messages.
      const history = await this._fetchHistory(roomId);
      // Defensive: if history doesn't end with the current message
      // (timing race between sync + messages), append it.
      const last = history[history.length - 1];
      if (!last || last.content !== body) {
        history.push({ role: 'user', content: body });
      }

      // Tool calls — expose the send tool if there's ANY windymail address
      // to send from: the operator's own if they have one, else the agent's
      // own mailbox. Sending from the agent's address is honest ("Fable's
      // Agent <fable-s-agent@windymail.ai>") and means a fresh gmail-signup
      // user's agent can actually send email instead of only ever chatting.
      const ownerMail = this.ownerContext?.mailAddress || null;
      const sendFromAddress = ownerMail || this.agentMailAddress;
      // When sending from the agent's own mailbox, the From: display name
      // should be the agent (not the human), so the recipient sees who's
      // really writing.
      const sendFromDisplay = ownerMail ? (this.ownerContext?.displayName || null) : this.agentName;
      // Capability-gated tool list (2026-07-06): mail needs a send-from
      // address; web search needs the windy-search + eternitas platform
      // env. Search is deliberately NOT gated on mail — an agent without
      // a mailbox can still look things up for its owner.
      const canMail = !!sendFromAddress;
      const canSearch = windySearch.isConfigured();
      const tools = availableTools({ canMail, canSearch });

      // Per-agent EPT for the Mind route (Phase 1.5) — same credential
      // machinery web_search uses (6h cache). Failure just means the
      // direct Groq chain answers this turn; never block the reply.
      let agentEpt = null;
      if (process.env.ETERNITAS_URL && process.env.ETERNITAS_PLATFORM_API_KEY) {
        try {
          agentEpt = await windySearch.getAgentEpt(passport);
        } catch (err) {
          console.warn(`[runner ${this.matrixUserId}] EPT fetch failed (mind route skipped): ${err.message}`);
        }
      }

      // windy.panel.v1: the owner's slider settings, read fresh each message
      // so a control-panel change applies to the very next reply.
      const sliders = getSliders(this.matrixUserId);

      const llmStartedAt = Date.now();
      const result = await generateReply({
        history,
        agentName: this.agentName,
        ownerDisplayName: this.ownerContext?.displayName || null,
        tools,
        canMail,
        canSearch,
        ept: agentEpt,
        sliders,
      });
      adminTelemetry.emit({
        service: 'agent-roster',
        event_type: 'llm.call',
        actor_type: 'agent',
        actor_id: passport,
        model: result.model || null,
        provider: result.provider || null,
        tokens_in: result.usage?.tokens_in ?? null,
        tokens_out: result.usage?.tokens_out ?? null,
        duration_ms: Date.now() - llmStartedAt,
        session_id: roomId,
        metadata: { tool_calls: (result.tool_calls || []).length },
      });

      // If the LLM emitted tool_calls, execute them in order and
      // surface results back to the user. We keep it simple — one
      // round of tool execution per inbound message; no agent-loop
      // recursion. This matches the always-confirm grandma UX:
      // confirmation is its own turn, the actual send is the next.
      const toolCalls = result.tool_calls || [];
      if (toolCalls.length > 0) {
        // Send the assistant's textual reply first (if any), THEN
        // execute each tool call and append its result as a follow-up
        // message. This keeps the conversation transcript readable.
        if (result.content && result.content.trim()) {
          await this._sendMessage(roomId, result.content);
        }
        for (const call of toolCalls) {
          const name = call.function?.name;
          let args;
          try {
            args = JSON.parse(call.function?.arguments || '{}');
          } catch {
            await this._sendMessage(roomId, `I tried to run the ${name} tool but the arguments were malformed — sorry. Try asking me again.`);
            continue;
          }
          console.log(`[runner ${this.matrixUserId}] tool ${name}(${JSON.stringify(args).slice(0, 200)})`);
          // Per-tool quota check. Today only send_email has a quota;
          // other future tools may add their own. Each quota is daily
          // and per-owner.
          if (name === 'send_email') {
            // [I1 Phase 1b] Hold sends to any NEW recipient for the owner's
            // explicit confirmation; addresses the owner has confirmed before
            // send immediately. Enforced here in code (not the prompt), so an
            // injected instruction that makes the model call send_email to a
            // new attacker address only queues a draft the owner must approve —
            // it never sends on its own. No quota consumed on a held draft.
            if (this._shouldHoldSend(args)) {
              const unknowns = this._recipientsOf(args.to).filter(r => !this.knownRecipients.has(r));
              this.pendingSend = { to: args.to, subject: args.subject, body: args.body, roomId, ts: Date.now() };
              await this._sendMessage(roomId, `📧 Ready to send to ${unknowns.join(', ')}. Reply **send** to confirm — I only send to a new address once you say so.`);
              adminTelemetry.emit({
                service: 'agent-roster', event_type: 'roster.tool_call', actor_type: 'agent',
                actor_id: passport, session_id: roomId,
                metadata: { tool: 'send_email', ok: false, held: true },
              });
              continue;
            }
            const mailGate = consumeMail(this.ownerWindyId);
            if (!mailGate.allowed) {
              await this._sendMessage(roomId, quotaMessage('mail', mailGate.resetInHours));
              continue;
            }
          }
          this.toolCallsExecuted += 1;
          const out = await executeTool(name, args, {
            ownerMailAddress: sendFromAddress,
            ownerDisplayName: sendFromDisplay,
            agentName: this.agentName,
            passport: this._passport(),
          });
          // First-tool-use funnel signal. web_search spend is already
          // ledgered server-side by windy-search (cost.charge); this
          // event is the roster-side view + covers send_email.
          adminTelemetry.emit({
            service: 'agent-roster',
            event_type: 'roster.tool_call',
            actor_type: 'agent',
            actor_id: passport,
            session_id: roomId,
            metadata: { tool: name || 'unknown', ok: !!out.ok },
          });
          // Surface a grandma-friendly result. Action tools (send_email)
          // get short confirmations; information tools (web_search) get a
          // SYNTHESIS pass — the raw results go back to the LLM, which
          // answers the user in its own words. Failures are honest and
          // actionable either way.
          if (out.ok && name === 'web_search') {
            const answer = await this._synthesizeToolReply({
              history, call: { ...call, function: { name, arguments: call.function?.arguments } },
              toolResult: out, canMail, canSearch, ept: agentEpt, sliders,
            });
            await this._sendMessage(roomId, answer);
          } else if (out.ok) {
            if (name === 'send_email') {
              await this._sendMessage(roomId, `Sent ✓ — from ${out.from} to ${args.to}.`);
            } else {
              await this._sendMessage(roomId, `Done — ${name} succeeded.`);
            }
          } else {
            await this._sendMessage(roomId, out.error || `Sorry — the ${name} tool failed.`);
          }
        }
      } else {
        // Plain text reply path
        const replyText = result.content || "I'm not sure how to respond to that yet.";
        await this._sendMessage(roomId, replyText);
      }
      // One exchange = one owner message fully handled. These are the
      // per-exchange beats midwife session analytics aggregate over
      // (ADR-WA-001 §3): count + duration per session_id, by model.
      adminTelemetry.emit({
        service: 'agent-roster',
        event_type: 'roster.exchange',
        actor_type: 'agent',
        actor_id: passport,
        model: result.model || null,
        provider: result.provider || null,
        duration_ms: Date.now() - exchangeStartedAt,
        session_id: roomId,
        metadata: { tool_calls: toolCalls.length },
      });
    } catch (err) {
      console.error(`[runner ${this.matrixUserId}] LLM error: ${err.message}`);
      this.lastError = err.message;
      adminTelemetry.emit({
        service: 'agent-roster',
        event_type: 'roster.exchange_failed',
        actor_type: 'agent',
        actor_id: passport,
        duration_ms: Date.now() - exchangeStartedAt,
        session_id: roomId,
        metadata: {},
      });
      try {
        await this._sendMessage(roomId, "I hit a snag generating a reply — try again in a moment.");
      } catch (_e) { /* fall-through */ }
    } finally {
      await this._setTyping(roomId, false);
    }
  }

  async _syncOnce() {
    const params = new URLSearchParams();
    params.set('timeout', String(SYNC_TIMEOUT_MS));
    if (this.since) params.set('since', this.since);
    // First sync: tiny filter so we don't pull megabytes of history.
    if (!this.since) {
      params.set('filter', JSON.stringify({ room: { timeline: { limit: 1 } } }));
    }
    // /sync is a long-poll held server-side for SYNC_TIMEOUT_MS; give the
    // socket a ceiling above that (+10s) so a genuinely dead connection still
    // aborts and _loop retries with backoff, rather than hanging forever.
    const res = await this._request(`/_matrix/client/v3/sync?${params.toString()}`, {
      method: 'GET',
      timeoutMs: SYNC_TIMEOUT_MS + 10000,
    });
    if (!res.ok) {
      throw new Error(`sync ${res.status}`);
    }
    const data = await res.json();
    this.since = data.next_batch;

    // Walk joined rooms looking for new messages.
    const joinRooms = data.rooms?.join || {};
    for (const [roomId, room] of Object.entries(joinRooms)) {
      const events = room.timeline?.events || [];
      for (const event of events) {
        if (event.type !== 'm.room.message') continue;
        try {
          await this._handleMessage(roomId, event);
        } catch (err) {
          console.error(`[runner ${this.matrixUserId}] handleMessage error: ${err.message}`);
        }
      }
    }

    // Auto-join invite rooms so the agent can be added to new DM rooms
    // post-hatch (e.g., the owner re-invites it after a leave).
    // [I1] Only auto-join rooms the OWNER invited us to. A stranger inviting
    // the agent (then messaging it) was the entry point for the spoofing/
    // injection finding; combined with the owner-only gate in _handleMessage
    // this keeps the agent out of stranger rooms entirely. Fail SAFE: if the
    // inviter can't be determined or the owner id is unknown, join anyway so a
    // legitimate owner re-invite is never missed.
    const inviteRooms = data.rooms?.invite || {};
    for (const roomId of Object.keys(inviteRooms)) {
      const inviter = this._inviteSender(inviteRooms[roomId]);
      if (this.ownerMatrixId && inviter && inviter !== this.ownerMatrixId) {
        console.log(`[runner ${this.matrixUserId}] declining invite to ${roomId} from non-owner ${inviter}`);
        continue;
      }
      try {
        await this._request(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`, {
          method: 'POST',
          body: '{}',
        });
        console.log(`[runner ${this.matrixUserId}] auto-joined invite room ${roomId}`);
      } catch (err) {
        console.warn(`[runner ${this.matrixUserId}] auto-join ${roomId} failed: ${err.message}`);
      }
    }
  }

  async _loop() {
    let backoffMs = 1000;
    while (this.running) {
      try {
        await this._syncOnce();
        backoffMs = 1000; // reset on success
      } catch (err) {
        this.lastError = err.message;
        console.warn(`[runner ${this.matrixUserId}] sync error: ${err.message}; backoff ${backoffMs}ms`);
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }

  status() {
    return {
      matrixUserId: this.matrixUserId,
      agentName: this.agentName,
      ownerWindyId: this.ownerWindyId,
      running: this.running,
      startedAt: new Date(this.startedAt).toISOString(),
      lastEventAt: this.lastEventAt,
      lastError: this.lastError,
      repliesSent: this.repliesSent,
    };
  }
}

module.exports = { AgentRunner };
