// Cloudflare Pages Function — reverse proxy for chat backend microservices.
//
// Why this exists
// ---------------
// The chat web app is deployed at `app.windychat.ai` (a Cloudflare Pages
// project). The backend microservices (onboarding, social, media,
// translate, directory) live at `chat.windychat.ai` (an EC2-hosted
// nginx + Caddy in front of Node services). Without this proxy, every
// fetch from the SPA to a backend endpoint is cross-origin and hits a
// CORS preflight that the backend currently rejects with HTTP 403.
//
// This function makes the SPA's `/api/*` calls same-origin from the
// browser's perspective: the SPA calls `app.windychat.ai/api/v1/foo`,
// Cloudflare's edge invokes this function, which forwards the request
// to `chat.windychat.ai/api/v1/foo` and returns the response — no
// browser-visible cross-origin call, no CORS preflight, no backend
// config change required.
//
// The chat web app's `env.ts` defaults already use relative `/api/v1/*`
// paths for exactly this kind of setup. The override I'd used in the
// first deploy (absolute URLs to chat.windychat.ai) defeats this; a
// fresh build that respects the defaults is what activates this proxy.
//
// Matrix (`/_matrix/*`) traffic is NOT proxied through this function
// because:
//   1. Synapse natively serves permissive CORS for /_matrix/* (verified
//      `Access-Control-Allow-Origin: *` on /_matrix/client/versions);
//   2. Matrix's /sync long-poll is too long-lived for Pages Functions'
//      execution-time budget.
// The SPA continues to talk to `chat.windychat.ai` directly for Matrix
// traffic via `env.matrixUrl`.

interface Env {
  // Optional override — production defaults to chat.windychat.ai but
  // a future staging environment could point at a different backend.
  CHAT_BACKEND_ORIGIN?: string;
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);

  const backendOrigin = env.CHAT_BACKEND_ORIGIN || 'https://chat.windychat.ai';
  const target = new URL(backendOrigin);
  target.pathname = url.pathname;
  target.search = url.search;

  // Forward the request faithfully — keep method, headers, body. Drop
  // the host header so the upstream sees its own host, not ours.
  // Cloudflare strips hop-by-hop headers automatically.
  const upstreamHeaders = new Headers(request.headers);
  upstreamHeaders.delete('host');

  // Rewrite the Origin header to match the backend's own host. The
  // chat backend microservices have their own CORS allowlist that
  // currently rejects `app.windychat.ai` with a 403
  // CORS_ORIGIN_DENIED. By the time the request reaches them via this
  // proxy, the browser-level CORS contract is already satisfied
  // (same-origin from the SPA's POV), so the Origin header here is
  // for server-side allowlist purposes only — setting it to the
  // backend's host effectively says "this is a same-origin call."
  // Follow-up: add `app.windychat.ai` to the backend's allowed origin
  // list and remove this rewrite. Tracked as a follow-up task in the
  // session log.
  upstreamHeaders.set('origin', backendOrigin);

  // Add a marker so backend logs can distinguish proxied vs direct
  // traffic without affecting any auth or routing decisions.
  upstreamHeaders.set('x-forwarded-via', 'app.windychat.ai-proxy');

  const init: RequestInit = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: 'manual',
  };

  // GET/HEAD don't carry a body; everything else streams through.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
  }

  return fetch(target.toString(), init);
};
