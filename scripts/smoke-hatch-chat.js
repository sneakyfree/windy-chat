#!/usr/bin/env node
/**
 * Post-deploy smoke test — the full grandma path against PROD:
 *
 *   sign-in → hatch SSE (idempotent replay) → chat unified-login →
 *   send a DM → an agent answers.
 *
 * Exists because chat deploys silently rotted before (the backend sat
 * 6 commits stale for days until the 2026-07-05 E2E drill caught it).
 * Run this after EVERY chat/pro deploy; it uses the standing QA
 * identity (creds in the fleet lockbox — never committed here):
 *
 *   QA_EMAIL=... QA_PASSWORD=... node scripts/smoke-hatch-chat.js
 *
 * Optional env:
 *   ACCOUNT_BASE  (default https://app.windyword.ai/api/v1)
 *   CHAT_BASE     (default https://chat.windychat.ai)
 *   MIND_BASE     (default https://api.windymind.ai)
 *   QA_ROOM       fallback DM room if the hatch replay omits it
 *   REPLY_TIMEOUT_S  how long to wait for the agent's answer (default 90)
 *
 * One-soul aware: if the real Windy Fly holds the matrix claim, the
 * midwife yields and the FLY answers — either voice passes; silence
 * fails.
 */
'use strict';

const ACCOUNT_BASE = process.env.ACCOUNT_BASE || 'https://app.windyword.ai/api/v1';
const CHAT_BASE = process.env.CHAT_BASE || 'https://chat.windychat.ai';
const MIND_BASE = process.env.MIND_BASE || 'https://api.windymind.ai';
const REPLY_TIMEOUT_S = parseInt(process.env.REPLY_TIMEOUT_S || '90', 10);

const results = [];
function step(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) finish();
}
function finish() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? 'SMOKE PASS' : 'SMOKE FAIL'} — ${results.length - failed.length}/${results.length} steps green`);
  process.exit(failed.length === 0 ? 0 : 1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const email = process.env.QA_EMAIL;
  const password = process.env.QA_PASSWORD;
  if (!email || !password) {
    console.error('QA_EMAIL and QA_PASSWORD are required (see fleet lockbox).');
    process.exit(2);
  }

  // ── 1. Sign in (account-server) ──────────────────────────────────
  let token;
  {
    const res = await fetch(`${ACCOUNT_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    token = data.token || data.access_token || null;
    step('sign-in', res.ok && !!token, res.ok ? '' : `HTTP ${res.status}`);
  }

  // ── 2. Hatch SSE (idempotent replay for the QA identity) ─────────
  let passport = null;
  let dmRoomId = process.env.QA_ROOM || null;
  {
    const res = await fetch(`${ACCOUNT_BASE}/agent/hatch`, {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    if (!res.ok || !res.body) {
      step('hatch SSE', false, `HTTP ${res.status}`);
      return;
    }
    const text = await res.text(); // stream is finite — ceremony then close
    const events = text
      .split('\n\n')
      .map((frame) => {
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('');
        try { return JSON.parse(data); } catch { return null; }
      })
      .filter(Boolean);

    const cert = events.find((e) => e.type === 'birth_certificate.ready');
    const complete = events.find((e) => e.type === 'hatch.complete');
    passport = cert?.data?.passport_number || null;
    dmRoomId = cert?.data?.chat?.dm_room_id || dmRoomId;
    const ok = !!complete && complete.status !== 'failed';
    step(
      'hatch SSE',
      ok,
      ok ? `passport ${passport || '(replay without cert)'}${complete.data?.resumed ? ', resumed' : ''}` : 'no ok hatch.complete frame',
    );
  }

  // ── 3. Chat unified-login (mints the grandma Matrix session) ─────
  let matrixToken; let matrixUserId;
  {
    const res = await fetch(`${CHAT_BASE}/api/v1/onboarding/unified-login`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    matrixToken = data.matrix?.accessToken || data.access_token || null;
    matrixUserId = data.matrix?.matrixUserId || data.matrix_user_id || null;
    step('chat unified-login', res.ok && !!matrixToken && !!matrixUserId,
      res.ok ? matrixUserId : `HTTP ${res.status}`);
  }

  if (!dmRoomId) {
    step('DM room known', false, 'no dm_room_id from hatch replay and no QA_ROOM env');
    return;
  }

  // ── 3b. One-soul context: who should answer? ─────────────────────
  let flyHoldsClaim = false;
  if (passport) {
    try {
      const res = await fetch(
        `${MIND_BASE}/v1/runtime/claim/${encodeURIComponent(passport)}/status?source=matrix`,
        { signal: AbortSignal.timeout(5000) },
      );
      if (res.ok) flyHoldsClaim = (await res.json()).active === true;
    } catch { /* informational only */ }
    console.log(`  (one-soul: ${flyHoldsClaim ? 'real Fly holds the claim — it should answer' : 'no claim — midwife should answer'})`);
  }

  // ── 4. Send a DM ──────────────────────────────────────────────────
  const marker = `smoke-${Date.now()}`;
  const sentAt = Date.now();
  {
    const txn = `smoke${Date.now()}`;
    const res = await fetch(
      `${CHAT_BASE}/_matrix/client/v3/rooms/${encodeURIComponent(dmRoomId)}/send/m.room.message/${txn}`,
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${matrixToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: `Smoke test ${marker}: what is 3 + 4? (reply with the number)`,
        }),
      },
    );
    step('send DM', res.ok, res.ok ? dmRoomId : `HTTP ${res.status}`);
  }

  // ── 5. An agent answers (midwife or real Fly — silence fails) ────
  {
    const deadline = Date.now() + REPLY_TIMEOUT_S * 1000;
    let reply = null;
    while (Date.now() < deadline && !reply) {
      await sleep(3000);
      const res = await fetch(
        `${CHAT_BASE}/_matrix/client/v3/rooms/${encodeURIComponent(dmRoomId)}/messages?dir=b&limit=10`,
        { headers: { Authorization: `Bearer ${matrixToken}` } },
      ).catch(() => null);
      if (!res || !res.ok) continue;
      const data = await res.json().catch(() => ({}));
      reply = (data.chunk || []).find(
        (ev) => ev.type === 'm.room.message'
          && ev.sender !== matrixUserId
          && ev.sender?.startsWith('@agent_')
          && (ev.origin_server_ts || 0) > sentAt,
      ) || null;
    }
    step(
      'agent replied',
      !!reply,
      reply
        ? `${reply.sender} in ${Math.round(((reply.origin_server_ts || Date.now()) - sentAt) / 1000)}s: "${String(reply.content?.body || '').slice(0, 80)}"`
        : `no agent reply within ${REPLY_TIMEOUT_S}s — grandma would see silence`,
    );
  }

  finish();
}

main().catch((err) => {
  console.error(`✗ unhandled: ${err.message}`);
  process.exit(1);
});
