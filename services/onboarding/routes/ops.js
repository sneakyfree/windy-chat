/**
 * Windy Chat — Ops fleet-health aggregator (ADR-060 / MULTI-SERVICE-OPS)
 *
 * Chat is a constellation: ~11 services behind nginx path-routing over a
 * Synapse homeserver. Each service has its own internal /health + /version,
 * but none of them is externally routed — so an agent healing the platform
 * was blind to which PIECE failed. This route is the one gateway-routed,
 * auth-gated read that fans out to every service's internal /health and
 * /version (plus the Synapse core) and returns the whole constellation:
 *
 *   GET /api/v1/ops/health  →  { status, services: { name: {status, …} } }
 *
 * It satisfies three agent-control baseline knobs at once: get_health
 * (overall + per-service), get_status (every service's version — did the
 * deploy reach all of them?), and get_capabilities (which services are
 * actually up).
 *
 * Auth: an Eternitas passport (EPT — agents) OR a Windy account JWT /
 * service token (humans, sister services). Fleet health is content-free,
 * so any caller in good standing may read it; denials are structured and
 * name the remediation (ADR-060 §3.3).
 *
 * Privacy hard line: responses are built from a WHITELIST of fields
 * (status / version / commit / uptime / primitive dependency flags).
 * Nothing else from a service's health body is forwarded — a service
 * that ever leaked content into /health would still never leak it here.
 *
 * Fleet registry: defaults below mirror docker-compose service DNS names.
 * WINDY_OPS_FLEET (JSON object, name → base URL), when set, REPLACES the
 * default map entirely — the env var IS the fleet. Prod sets it to the
 * live service set so a never-deployed service isn't reported "down".
 * It is read per-request, so reconfiguration needs no code change.
 */
'use strict';

const express = require('express');
const { verifyEpt } = require('../../shared/ept-verify');
const { verifyToken } = require('../../shared/jwt-verify');
const {
  TokenRevokedError,
  RevocationUnavailableError,
} = require('../../shared/token-revocation');
const { asyncHandler } = require('../../shared/async-handler');
const adminTelemetry = require('../../shared/admin-telemetry');

const router = express.Router();

const PROBE_TIMEOUT_MS = Number(process.env.WINDY_OPS_PROBE_TIMEOUT_MS || 2500);

const AUTH_REMEDIATION =
  'Send `Authorization: Bearer <token>` — an Eternitas passport (EPT) for ' +
  'agents, or a Windy account JWT (account.windyword.ai) for humans and ' +
  'services.';

// ── Auth: EPT first (agents), then account-server JWT / service token ──
async function opsAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({
      ok: false,
      error: 'missing_authorization',
      remediation: AUTH_REMEDIATION,
    });
  }
  const token = match[1];

  // Agents: Eternitas passport (ES256, revocation-flag honored).
  try {
    const claims = await verifyEpt(token);
    req.opsCaller = { actor_type: 'agent', actor_id: claims.sub };
    return next();
  } catch {
    // Not an EPT — fall through to the human/service paths.
  }

  // Sister services: static service token (same convention as jwt-verify).
  const serviceToken = process.env.CHAT_API_TOKEN || '';
  if (serviceToken && token === serviceToken) {
    req.opsCaller = { actor_type: 'service', actor_id: 'service' };
    return next();
  }

  // Humans: account-server JWT (RS256 via JWKS; HS256 dev fallback).
  try {
    const user = await verifyToken(token);
    req.opsCaller = { actor_type: 'human', actor_id: String(user.sub || 'unknown') };
    return next();
  } catch (err) {
    if (err instanceof RevocationUnavailableError) {
      return res.status(503).json({
        ok: false,
        error: 'identity_service_unavailable',
        remediation: 'The account-server revocation check is unavailable — retry shortly.',
      });
    }
    return res.status(401).json({
      ok: false,
      error: err instanceof TokenRevokedError ? 'token_revoked' : 'invalid_token',
      remediation: AUTH_REMEDIATION,
    });
  }
}

// ── Fleet registry ──
function resolveFleet() {
  const raw = process.env.WINDY_OPS_FLEET;
  if (raw) {
    try {
      const fleet = JSON.parse(raw);
      if (fleet && typeof fleet === 'object' && !Array.isArray(fleet)) return fleet;
      console.warn('[ops] WINDY_OPS_FLEET must be a JSON object — using defaults');
    } catch (err) {
      console.warn(`[ops] WINDY_OPS_FLEET is not valid JSON (${err.message}) — using defaults`);
    }
  }
  return {
    synapse: process.env.SYNAPSE_URL || 'http://synapse:8008',
    onboarding: `http://127.0.0.1:${process.env.PORT || 8101}`,
    directory: 'http://directory:8102',
    'push-gateway': 'http://push-gateway:8103',
    backup: 'http://backup:8104',
    social: 'http://social:8105',
    translation: 'http://translation:8106',
    'agent-roster': 'http://agent-roster:8106',
    media: 'http://media:8107',
    'call-history': 'http://call-history:8108',
    hub: 'http://hub:8109',
  };
}

// ── Probe helpers — whitelist everything, forward nothing else ──
function scrubDependencies(deps) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return undefined;
  const out = {};
  for (const [key, val] of Object.entries(deps)) {
    if (typeof val === 'boolean' || typeof val === 'number') out[key] = val;
    else if (typeof val === 'string') out[key] = val.slice(0, 100);
    // objects/arrays dropped — dependency flags are primitives by contract
  }
  return Object.keys(out).length ? out : undefined;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON body — ignore */ }
  return { httpStatus: res.status, body };
}

/** Synapse serves a plain-text /health and no MF1 /version. */
async function probeSynapse(base) {
  const startedAt = Date.now();
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return {
      status: res.status === 200 ? 'up' : 'degraded',
      version: null,
      duration_ms: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      status: 'down',
      error: String(err.message || 'unreachable').slice(0, 200),
      duration_ms: Date.now() - startedAt,
    };
  }
}

async function probeService(base) {
  const startedAt = Date.now();
  const [health, version] = await Promise.allSettled([
    fetchJson(`${base}/health`),
    fetchJson(`${base}/version`),
  ]);

  if (health.status === 'rejected') {
    return {
      status: 'down',
      error: String(health.reason && health.reason.message || 'unreachable').slice(0, 200),
      duration_ms: Date.now() - startedAt,
    };
  }

  const entry = {
    status: health.value.httpStatus === 200 ? 'up' : 'degraded',
    duration_ms: Date.now() - startedAt,
  };
  const healthBody = health.value.body;
  if (healthBody && typeof healthBody === 'object') {
    if (typeof healthBody.version === 'string') entry.version = healthBody.version;
    if (typeof healthBody.uptime === 'string') entry.uptime = healthBody.uptime;
    const deps = scrubDependencies(healthBody.dependencies);
    if (deps) entry.dependencies = deps;
  }
  const versionBody = version.status === 'fulfilled' ? version.value.body : null;
  if (versionBody && typeof versionBody === 'object') {
    if (typeof versionBody.version === 'string') entry.version = versionBody.version;
    if (typeof versionBody.commit_sha_short === 'string') entry.commit = versionBody.commit_sha_short;
    if (typeof versionBody.environment === 'string') entry.environment = versionBody.environment;
  }
  return entry;
}

// ── The aggregator ──
router.get('/health', opsAuth, asyncHandler(async (req, res) => {
  const startedAt = Date.now();
  const fleet = resolveFleet();
  const names = Object.keys(fleet);

  const probes = await Promise.all(names.map((name) =>
    name === 'synapse' ? probeSynapse(fleet[name]) : probeService(fleet[name])
  ));

  const services = {};
  const summary = { total: names.length, up: 0, degraded: 0, down: 0 };
  names.forEach((name, i) => {
    services[name] = probes[i];
    summary[probes[i].status] += 1;
  });

  // Synapse is the heart — every message flows through it. If it is down,
  // chat is down, however healthy the satellites look.
  let status = 'ok';
  if (services.synapse && services.synapse.status === 'down') status = 'down';
  else if (summary.up < summary.total) status = 'degraded';

  // ADR-060 §3.9 — content-free control-plane telemetry, fire-and-forget.
  adminTelemetry.emit({
    service: 'chat-onboarding',
    event_type: 'control.action',
    actor_type: req.opsCaller.actor_type,
    actor_id: req.opsCaller.actor_id,
    metadata: {
      tool: 'ops.fleet_health',
      ok: true,
      tier: 'auto_allow',
      fleet_total: summary.total,
      fleet_up: summary.up,
    },
  });

  // Always 200: a degraded constellation is still a SUCCESSFUL observation.
  // The aggregator's own liveness is signaled by reachability, and agent
  // clients must be able to read the body of a degraded report.
  res.json({
    service: 'windy-chat',
    status,
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    summary,
    services,
  });
}));

module.exports = router;
