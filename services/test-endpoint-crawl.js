/**
 * Windy Chat — Endpoint Crawl
 * Hits every known endpoint on onboarding + social to verify none return 404.
 *
 * Run: node services/test-endpoint-crawl.js
 */

const BASE_ONBOARDING = 'http://localhost:8101';
const BASE_SOCIAL = 'http://localhost:8105';

const JWT_SECRET = process.env.WINDY_JWT_SECRET || 'crawl-test-secret';
const API_TOKEN = process.env.CHAT_API_TOKEN || 'crawl-test-token';

// Generate a test JWT
const jwt = require('./social/node_modules/jsonwebtoken');
const validJwt = jwt.sign(
  { sub: 'crawl-user', windy_identity_id: 'wid-crawl', display_name: 'Crawl User' },
  JWT_SECRET,
  { algorithm: 'HS256', expiresIn: '1h' }
);
const AUTH = { Authorization: `Bearer ${validJwt}` };
const SVC_AUTH = { Authorization: `Bearer ${API_TOKEN}` };

async function req(method, base, path, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${base}${path}`, opts);
  let data;
  try { data = await r.json(); } catch { data = await r.text().catch(() => ''); }
  return { status: r.status, data };
}

async function crawl() {
  const results = [];

  function record(svc, endpoint, status, note) {
    results.push({ svc, endpoint, status, note });
  }

  // ═══════════════════════════════════════
  // ONBOARDING SERVICE
  // ═══════════════════════════════════════

  // Health (no auth)
  let r = await req('GET', BASE_ONBOARDING, '/health');
  record('onboarding', 'GET /health', r.status);

  // Provision — no body → 400 (not 404)
  r = await req('POST', BASE_ONBOARDING, '/api/v1/chat/provision', {}, AUTH);
  record('onboarding', 'POST /api/v1/chat/provision', r.status, 'expect 400');

  // Onboarding status — no param → 400 (not 404)
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/provision/onboarding/status', null, AUTH);
  record('onboarding', 'GET /chat/provision/onboarding/status', r.status, 'expect 400');

  // Onboarding status — with param
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/provision/onboarding/status?chatUserId=crawl-user', null, AUTH);
  record('onboarding', 'GET /chat/provision/onboarding/status?chatUserId=', r.status);

  // Unified login — no auth → 401
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {});
  record('onboarding', 'POST /onboarding/unified-login (no auth)', r.status, 'expect 401');

  // Unified login — with auth → 201
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {}, AUTH);
  record('onboarding', 'POST /onboarding/unified-login (auth)', r.status, 'expect 201');

  // Unified login — idempotent → 200
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {}, AUTH);
  record('onboarding', 'POST /onboarding/unified-login (2nd)', r.status, 'expect 200');

  // Verify (K2.1 OTP) retired 2026-07-06 — must stay 404
  r = await req('POST', BASE_ONBOARDING, '/api/v1/chat/verify/send', { type: 'email', destination: 'test@test.com' }, AUTH);
  record('onboarding', 'POST /chat/verify/send (retired)', r.status, 'expect 404');

  // Profile check-name
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/profile/check-name?name=CrawlUser', null, AUTH);
  record('onboarding', 'GET /chat/profile/check-name', r.status);

  // Profile get (404 expected — user not in display_names table)
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/profile/crawl-user', null, AUTH);
  record('onboarding', 'GET /chat/profile/:userId', r.status, 'expect 404 (no profile in display_names)');

  // Profile setup
  r = await req('POST', BASE_ONBOARDING, '/api/v1/chat/profile/setup', { displayName: 'Crawl', primaryLanguage: 'en' }, AUTH);
  record('onboarding', 'POST /chat/profile/setup', r.status);

  // Pair generate
  r = await req('POST', BASE_ONBOARDING, '/api/v1/chat/pair/generate', {}, AUTH);
  record('onboarding', 'POST /chat/pair/generate', r.status);

  // Pair confirm
  r = await req('POST', BASE_ONBOARDING, '/api/v1/chat/pair/confirm', { sessionId: 'x', authToken: 'x' }, AUTH);
  record('onboarding', 'POST /chat/pair/confirm', r.status);

  // Pair status (404 expected — nonexistent session)
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/pair/status/nonexistent', null, AUTH);
  record('onboarding', 'GET /chat/pair/status/:id', r.status, 'expect 404 (nonexistent session)');

  // Pair delete
  r = await req('DELETE', BASE_ONBOARDING, '/api/v1/chat/pair/session/nonexistent', null, AUTH);
  record('onboarding', 'DELETE /chat/pair/session/:id', r.status);

  // Agent room (404 expected — no room for x/y)
  r = await req('GET', BASE_ONBOARDING, '/api/v1/chat/agent-room?agentId=x&ownerId=y', null, AUTH);
  record('onboarding', 'GET /chat/agent-room', r.status, 'expect 404 (no room)');

  // Agent room via provision mount (404 expected — no room for x/y)
  r = await req('GET', BASE_ONBOARDING, '/api/v1/onboarding/agent-room?agentId=x&ownerId=y', null, AUTH);
  record('onboarding', 'GET /onboarding/agent-room', r.status, 'expect 404 (no room)');

  // Eternitas webhook
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/eternitas/webhook', {
    event: 'passport.revoked', passport: 'ET-CRAWL', bot_name: 'CrawlBot', timestamp: new Date().toISOString(),
  }, SVC_AUTH);
  record('onboarding', 'POST /onboarding/eternitas/webhook', r.status, 'expect 404 (no passport in DB)');

  // ═══════════════════════════════════════
  // SOCIAL SERVICE
  // ═══════════════════════════════════════

  // Health
  r = await req('GET', BASE_SOCIAL, '/health');
  record('social', 'GET /health', r.status);

  // Posts feed (auth)
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/posts', null, AUTH);
  record('social', 'GET /social/posts (feed)', r.status);

  // Create post
  r = await req('POST', BASE_SOCIAL, '/api/v1/social/posts', { content: 'Crawl test post' }, AUTH);
  record('social', 'POST /social/posts', r.status, 'expect 201');
  const postId = r.data?.id;

  // Get single post
  r = await req('GET', BASE_SOCIAL, `/api/v1/social/posts/${postId || 'nonexistent'}`);
  record('social', 'GET /social/posts/:id', r.status);

  // Get user posts
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/posts/user/crawl-user');
  record('social', 'GET /social/posts/user/:userId', r.status);

  // Like
  if (postId) {
    r = await req('POST', BASE_SOCIAL, `/api/v1/social/posts/${postId}/like`, {}, AUTH);
    record('social', 'POST /social/posts/:id/like', r.status);

    r = await req('DELETE', BASE_SOCIAL, `/api/v1/social/posts/${postId}/like`, null, AUTH);
    record('social', 'DELETE /social/posts/:id/like', r.status);
  }

  // Follow
  r = await req('POST', BASE_SOCIAL, '/api/v1/social/follow/other-user', {}, AUTH);
  record('social', 'POST /social/follow/:target', r.status);

  r = await req('DELETE', BASE_SOCIAL, '/api/v1/social/follow/other-user', null, AUTH);
  record('social', 'DELETE /social/follow/:target', r.status);

  r = await req('GET', BASE_SOCIAL, '/api/v1/social/follow/following/crawl-user');
  record('social', 'GET /social/follow/following/:userId', r.status);

  r = await req('GET', BASE_SOCIAL, '/api/v1/social/follow/followers/crawl-user');
  record('social', 'GET /social/follow/followers/:userId', r.status);

  // Notifications
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/notifications', null, AUTH);
  record('social', 'GET /social/notifications', r.status);

  r = await req('POST', BASE_SOCIAL, '/api/v1/social/notifications/read', { notificationIds: ['fake'] }, AUTH);
  record('social', 'POST /social/notifications/read', r.status);

  // Moderation
  if (postId) {
    r = await req('POST', BASE_SOCIAL, `/api/v1/social/moderation/${postId}/report`, { reason: 'spam' }, AUTH);
    record('social', 'POST /social/moderation/:id/report', r.status, 'expect 201');
  }

  // Ecosystem status
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/ecosystem-status', null, AUTH);
  record('social', 'GET /social/ecosystem-status', r.status);

  // Profile
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/profile/crawl-user', null, AUTH);
  record('social', 'GET /social/profile/:userId', r.status);

  // Presence
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/presence/crawl-user');
  record('social', 'GET /social/presence/:userId', r.status);

  // Dashboard summary
  r = await req('GET', BASE_SOCIAL, '/api/v1/social/dashboard-summary', null, AUTH);
  record('social', 'GET /social/dashboard-summary', r.status);

  // Eternitas verify (service-to-service)
  r = await req('POST', BASE_SOCIAL, '/api/v1/social/eternitas/verify', { userId: 'bot_test' }, SVC_AUTH);
  record('social', 'POST /social/eternitas/verify', r.status);

  r = await req('DELETE', BASE_SOCIAL, '/api/v1/social/eternitas/verify', { userId: 'bot_test' }, SVC_AUTH);
  record('social', 'DELETE /social/eternitas/verify', r.status);

  // Eternitas webhook (no signature → 401)
  r = await req('POST', BASE_SOCIAL, '/api/v1/social/eternitas/webhook', {
    event: 'passport.revoked', passport: 'ET-001', bot_name: 'test', timestamp: new Date().toISOString(),
  }, { ...SVC_AUTH, 'x-eternitas-signature': 'badsig' });
  record('social', 'POST /social/eternitas/webhook', r.status, 'expect 401 (bad sig)');

  // ═══════════════════════════════════════
  // JWT END-TO-END VERIFICATION
  // ═══════════════════════════════════════

  // Bad JWT → 401, not 500
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {}, { Authorization: 'Bearer invalid.jwt.token' });
  record('jwt-e2e', 'Bad JWT → unified-login', r.status, 'expect 401, NOT 500');

  // Expired JWT → 401
  const expiredJwt = jwt.sign({ sub: 'x' }, JWT_SECRET, { algorithm: 'HS256', expiresIn: '-1s' });
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {}, { Authorization: `Bearer ${expiredJwt}` });
  record('jwt-e2e', 'Expired JWT → unified-login', r.status, 'expect 401');

  // Wrong secret → 401
  const wrongJwt = jwt.sign({ sub: 'x' }, 'wrong-secret', { algorithm: 'HS256', expiresIn: '1h' });
  r = await req('POST', BASE_ONBOARDING, '/api/v1/onboarding/unified-login', {}, { Authorization: `Bearer ${wrongJwt}` });
  record('jwt-e2e', 'Wrong secret JWT → unified-login', r.status, 'expect 401');

  // ═══════════════════════════════════════
  // PRINT RESULTS
  // ═══════════════════════════════════════

  console.log('\n\x1b[36m═══ WINDY CHAT ENDPOINT CRAWL ═══\x1b[0m\n');

  let passed = 0, failed = 0, fiveHundreds = 0;
  for (const r of results) {
    const is404 = r.status === 404 && !r.note?.includes('expect 404');
    const is500 = r.status >= 500;
    if (is404) failed++;
    else if (is500) { failed++; fiveHundreds++; }
    else passed++;

    const icon = is404 ? '\x1b[31m404!\x1b[0m' : is500 ? '\x1b[31m5xx!\x1b[0m' : `\x1b[32m${r.status}\x1b[0m`;
    const note = r.note ? ` \x1b[90m(${r.note})\x1b[0m` : '';
    console.log(`  ${icon}  [${r.svc}] ${r.endpoint}${note}`);
  }

  console.log(`\n  \x1b[32m${passed} passed\x1b[0m, \x1b[${failed > 0 ? '31' : '32'}m${failed} failed\x1b[0m (${results.length} total)`);
  if (fiveHundreds > 0) console.log(`  \x1b[31m${fiveHundreds} server errors (500+)!\x1b[0m`);
  console.log(failed === 0 ? '\n  \x1b[32mALL ENDPOINTS REACHABLE\x1b[0m\n' : '\n  \x1b[31mFIX THE FAILURES ABOVE!\x1b[0m\n');

  if (failed > 0) process.exit(1);
}

crawl().catch(e => { console.error(e); process.exit(1); });
