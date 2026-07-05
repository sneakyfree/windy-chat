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
const { TOOLS, executeTool } = require('./tools');
const { consumeMessage, consumeMail, quotaMessage } = require('./quota');

const INITIAL_SYNC_AGE_SECS = 30;
const SYNC_TIMEOUT_MS = 30000;
const BACKOFF_MAX_MS = 60000;

function newTxnId() {
  return `windy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class AgentRunner {
  constructor({ matrixUserId, accessToken, agentName, ownerWindyId, homeserver, ownerContext, agentMailAddress }) {
    this.matrixUserId = matrixUserId;
    this.accessToken = accessToken;
    this.agentName = agentName;
    this.ownerWindyId = ownerWindyId;
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
  }

  /** Update owner context (mailAddress + displayName) — called by the
   *  roster on reconcile so newly-activated mailboxes light up live. */
  updateOwnerContext(ctx) {
    this.ownerContext = { ...this.ownerContext, ...ctx };
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
            // Solo room — invite the owner.
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
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
        ...(options.headers || {}),
      },
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
      // @agent_et26-acnz-e2dd:... -> ET26-ACNZ-E2DD (provision lowercased it)
      const localpart = this.matrixUserId.slice(1).split(':')[0];
      const passport = localpart.replace(/^agent_/, '').toUpperCase();
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
    const body = event.content?.body;
    if (!body || typeof body !== 'string') return;
    // Ignore old events on first cold start so we don't reply to a week
    // of backlog with a flurry.
    const ageSecs = (Date.now() - (event.origin_server_ts || 0)) / 1000;
    if (ageSecs > INITIAL_SYNC_AGE_SECS) return;

    console.log(`[runner ${this.matrixUserId}] msg from ${event.sender} in ${roomId}: ${body.slice(0, 80)}`);
    this.lastEventAt = new Date().toISOString();

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
    // not the agent's).
    const msgGate = consumeMessage(this.ownerWindyId);
    if (!msgGate.allowed) {
      try {
        await this._sendMessage(roomId, quotaMessage('message', msgGate.resetInHours));
      } catch (_e) { /* fall-through */ }
      return;
    }

    await this._setTyping(roomId, true);
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
      const toolsAvailable = !!sendFromAddress;
      const tools = toolsAvailable ? TOOLS : null;

      const result = await generateReply({
        history,
        agentName: this.agentName,
        ownerDisplayName: this.ownerContext?.displayName || null,
        tools,
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
          });
          // Surface a grandma-friendly result. Successes are short
          // confirmations; failures are honest and actionable.
          if (out.ok) {
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
    } catch (err) {
      console.error(`[runner ${this.matrixUserId}] LLM error: ${err.message}`);
      this.lastError = err.message;
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
    const res = await this._request(`/_matrix/client/v3/sync?${params.toString()}`, { method: 'GET' });
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
    const inviteRooms = data.rooms?.invite || {};
    for (const roomId of Object.keys(inviteRooms)) {
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
