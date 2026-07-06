/**
 * Windy Chat Hub — routes.
 *
 * The heavy lifting lives in the mautrix bridges themselves; this router
 * is a thin authenticated proxy onto their shared bridgev2 provisioning
 * API (/_matrix/provision/v3/*), plus bookkeeping in connected_platforms.
 *
 * Why a proxy and not direct client→bridge calls: the provisioning API is
 * authenticated with a single shared secret that must never reach a
 * client, and the acting Matrix user is chosen by a `user_id` query param
 * — so the server MUST be the one to set both, pinned to the caller's own
 * JWT-resolved MXID. A client can only ever provision itself.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');

const { asyncHandler } = require('../../shared/async-handler');
const { getPlatform, listConfiguredPlatforms } = require('../lib/bridges');
const {
  upsertConnection,
  listConnectionsForUser,
  deleteConnection,
  resolveMatrixUserId,
} = require('../lib/db');

const router = express.Router();

// Provisioning sub-paths we forward. Everything the login/logout/status
// flows need, nothing else — the bridge's admin surface stays private.
const ALLOWED_PATH = /^v3\/(whoami|logins|login\/[A-Za-z0-9._\/-]+|logout\/[A-Za-z0-9._-]+|contacts|search_users|resolve_identifier|create_dm|create_group)$/;

// display_and_wait steps (QR scans, app taps) long-poll on the bridge
// side; give those calls a much longer leash than plain steps.
const LONG_POLL_TIMEOUT_MS = 125_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function requireMatrixUser(req, res) {
  const mxid = resolveMatrixUserId(req.user || {});
  if (!mxid) {
    res.status(409).json({
      error: 'no_chat_account',
      message: 'No Windy Chat account is provisioned for this identity yet — sign in to chat once, then retry.',
    });
    return null;
  }
  return mxid;
}

// ── GET /platforms — what can I connect, what have I connected ──────
router.get('/platforms', asyncHandler(async (req, res) => {
  const mxid = requireMatrixUser(req, res);
  if (!mxid) return;
  const connections = listConnectionsForUser.all(mxid);
  const platforms = listConfiguredPlatforms().map((p) => ({
    ...p,
    connections: connections.filter((c) => c.platform === p.key)
      .map(({ windy_identity_id, matrix_user_id, ...pub }) => pub),
  }));
  res.json({ platforms });
}));

// ── ALL /:platform/provision/* — generic bridgev2 provisioning proxy ─
router.all('/:platform/provision/*', asyncHandler(async (req, res) => {
  const platform = getPlatform(req.params.platform);
  if (!platform) {
    return res.status(404).json({ error: 'unknown_or_unconfigured_platform' });
  }
  const mxid = requireMatrixUser(req, res);
  if (!mxid) return;

  const subPath = req.params[0] || '';
  if (subPath.includes('..') || !ALLOWED_PATH.test(subPath)) {
    return res.status(400).json({ error: 'unsupported_provision_path' });
  }

  const url = new URL(`${platform.baseUrl}/_matrix/provision/${subPath}`);
  // Forward caller query params EXCEPT user_id — that is pinned server-side.
  for (const [k, v] of Object.entries(req.query)) {
    if (k !== 'user_id') url.searchParams.set(k, String(v));
  }
  url.searchParams.set('user_id', mxid);

  const isWait = /\/wait($|\/)/.test(subPath) || subPath.includes('display_and_wait');
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    isWait ? LONG_POLL_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  );

  let bridgeResp;
  try {
    bridgeResp = await fetch(url, {
      method: req.method,
      headers: {
        Authorization: `Bearer ${platform.secret}`,
        'Content-Type': 'application/json',
      },
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : JSON.stringify(req.body ?? {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const timedOut = err.name === 'AbortError';
    return res.status(timedOut ? 504 : 502).json({
      error: timedOut ? 'bridge_timeout' : 'bridge_unreachable',
      platform: platform.key,
    });
  }
  clearTimeout(timer);

  let body = null;
  const text = await bridgeResp.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }

  // Bookkeeping. A successful login flow ends in a step whose payload
  // carries the new login's id; logout paths carry it in the URL.
  const now = new Date().toISOString();
  if (bridgeResp.ok && body) {
    const loginId = body.login_id
      || (body.step_type === 'complete' && body.login && body.login.id)
      || null;
    if (loginId && subPath.startsWith('v3/login/')) {
      upsertConnection.run({
        id: uuidv4(),
        matrix_user_id: mxid,
        windy_identity_id: req.user.windy_identity_id || req.user.sub || null,
        platform: platform.key,
        login_id: String(loginId),
        state: 'connected',
        remote_name: (body.login && (body.login.remote_name || body.login.name)) || null,
        created_at: now,
        updated_at: now,
      });
    }
  }
  if (bridgeResp.ok && subPath.startsWith('v3/logout/')) {
    const loginId = subPath.split('/')[2] || '';
    deleteConnection.run(mxid, platform.key, loginId);
  }

  res.status(bridgeResp.status).json(body);
}));

// ── GET /:platform/whoami — convenience passthrough that also syncs DB ─
router.get('/:platform/whoami', asyncHandler(async (req, res) => {
  const platform = getPlatform(req.params.platform);
  if (!platform) {
    return res.status(404).json({ error: 'unknown_or_unconfigured_platform' });
  }
  const mxid = requireMatrixUser(req, res);
  if (!mxid) return;

  const url = new URL(`${platform.baseUrl}/_matrix/provision/v3/whoami`);
  url.searchParams.set('user_id', mxid);
  let bridgeResp;
  try {
    bridgeResp = await fetch(url, {
      headers: { Authorization: `Bearer ${platform.secret}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    return res.status(502).json({ error: 'bridge_unreachable', platform: platform.key });
  }
  const body = await bridgeResp.json().catch(() => null);

  // Sync connection rows from the bridge's authoritative login list —
  // whoami is what surfaces BAD_CREDENTIALS ("re-pair Telegram") states.
  if (bridgeResp.ok && body && Array.isArray(body.logins)) {
    const now = new Date().toISOString();
    for (const login of body.logins) {
      upsertConnection.run({
        id: uuidv4(),
        matrix_user_id: mxid,
        windy_identity_id: req.user.windy_identity_id || req.user.sub || null,
        platform: platform.key,
        login_id: String(login.id || ''),
        state: (login.state && (login.state.state_event || login.state)) || 'connected',
        remote_name: login.remote_name || login.name || null,
        created_at: now,
        updated_at: now,
      });
    }
  }
  res.status(bridgeResp.status).json(body);
}));

module.exports = router;
