/**
 * Windy Search client for roster agents (2026-07-06).
 *
 * Gives every hatched agent metered web access through windy-search
 * (api.windysearch.com) — the Grant-decided architecture: BYOM native
 * search is PRIMARY for models that have it; Windy Search is the
 * metered BACKUP for models that don't. Roster agents run on Groq
 * (no native search), so they are exactly the metered population.
 *
 * Auth is per-agent: each hatched agent has an Eternitas passport, and
 * eternitas persists a 365-day EPT (ES256 JWT) minted at hatch. The
 * roster fetches it via the platform-authenticated endpoint
 * (POST /api/v1/bots/{passport}/ept, X-API-Key: et_plt_*) and caches it
 * in memory. Per-agent EPTs mean windy-search's per-passport monthly
 * budget, EII-tier rate limits, and integrity-event audit all attribute
 * to the individual fly — not to a shared service identity.
 *
 * Budget notices: windy-search's 80% warning is edge-triggered
 * server-side (fires on exactly the crossing request, once a month), so
 * relaying `notice_to_user` can never nag. A budget-429 (identified by
 * the X-Cost-Cap-USD header — distinct from the 60s rate-limit 429)
 * maps to a friendly, actionable failure.
 *
 * Required env (all three, else isConfigured() is false and the tool is
 * simply not offered to the LLM):
 *   WINDY_SEARCH_BASE_URL        e.g. https://api.windysearch.com
 *   ETERNITAS_URL                e.g. https://api.eternitas.ai
 *   ETERNITAS_PLATFORM_API_KEY   Windy Chat's et_plt_* key
 */
'use strict';

// passport -> { token, fetchedAt }. EPTs live ~365d; a 6h cache TTL just
// bounds staleness after a revocation (windy-search verifies the JWT and
// its `rev` claim on every call anyway — this cache is a latency saver,
// not a security boundary).
const EPT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const eptCache = new Map();

function isConfigured() {
  return Boolean(
    process.env.WINDY_SEARCH_BASE_URL
    && process.env.ETERNITAS_URL
    && process.env.ETERNITAS_PLATFORM_API_KEY,
  );
}

/** Test hook — clears the module-level EPT cache. */
function _clearEptCache() {
  eptCache.clear();
}

async function getAgentEpt(passport, { force = false } = {}) {
  const cached = eptCache.get(passport);
  if (!force && cached && Date.now() - cached.fetchedAt < EPT_CACHE_TTL_MS) {
    return cached.token;
  }
  const base = process.env.ETERNITAS_URL.replace(/\/$/, '');
  const res = await fetch(
    `${base}/api/v1/bots/${encodeURIComponent(passport)}/ept`,
    {
      method: 'POST',
      headers: { 'X-API-Key': process.env.ETERNITAS_PLATFORM_API_KEY },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`eternitas EPT fetch ${res.status}: ${detail.slice(0, 150)}`);
  }
  const data = await res.json();
  if (!data.ept_token) throw new Error('eternitas EPT fetch: empty token');
  eptCache.set(passport, { token: data.ept_token, fetchedAt: Date.now() });
  return data.ept_token;
}

// Notice wording mirrors windy-agent's (tools/windy_search_client.py) so
// every fly in the ecosystem explains the allowance the same way.
const WARNING_NOTICE =
  'HEADS-UP FOR YOUR USER (mention once, gently, woven into your reply '
  + 'in your own words): this agent has used 80% of its included monthly '
  + 'web-access allowance. Web access still works — nothing is broken. '
  + 'The allowance resets on the 1st. For unlimited web access they can '
  + 'power this agent with a model that has built-in web search, or '
  + 'raise the allowance in their Windy account.';

const EXHAUSTED_MESSAGE =
  "I've used up this month's included web searches (the allowance "
  + 'resets on the 1st). I can still help from what I already know — '
  + 'or, to keep me searching the web this month, you can power me '
  + 'with a model that has built-in web search, or raise the allowance '
  + 'in your Windy account.';

function _isBudget429(res) {
  return res.status === 429 && res.headers.get('X-Cost-Cap-USD') !== null;
}

/**
 * Search the web as `passport`. Returns:
 *   { ok:true, query, results:[{title,snippet,url}], notice_to_user? }
 *   { ok:false, error, budget_exhausted? }
 * Never throws — failures come back grandma-explainable.
 */
async function webSearch({ passport, query, limit = 5 }) {
  if (!isConfigured()) {
    return { ok: false, error: "Web search isn't set up on this server yet." };
  }
  let ept;
  try {
    ept = await getAgentEpt(passport);
  } catch (err) {
    console.warn(`[windy-search] EPT fetch failed for ${passport}: ${err.message}`);
    return { ok: false, error: "I couldn't verify my credentials to search the web just now — try again in a minute." };
  }

  const base = process.env.WINDY_SEARCH_BASE_URL.replace(/\/$/, '');
  let res;
  try {
    res = await fetch(`${base}/web/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ept}`,
      },
      body: JSON.stringify({ query, limit }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return { ok: false, error: "The web search service didn't answer — try again in a minute." };
  }

  if (res.status === 401) {
    // Stale/revoked cached EPT — refresh once and retry.
    eptCache.delete(passport);
    try {
      ept = await getAgentEpt(passport, { force: true });
      res = await fetch(`${base}/web/search`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ept}`,
        },
        body: JSON.stringify({ query, limit }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      return { ok: false, error: "I couldn't verify my credentials to search the web just now — try again in a minute." };
    }
  }

  if (_isBudget429(res)) {
    return { ok: false, budget_exhausted: true, error: EXHAUSTED_MESSAGE };
  }
  if (res.status === 429) {
    return { ok: false, error: "I'm searching a little too fast — give me a minute and ask again." };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn(`[windy-search] /web/search ${res.status}: ${detail.slice(0, 150)}`);
    return { ok: false, error: 'The web search service hit a snag — try again shortly.' };
  }

  const data = await res.json();
  const out = {
    ok: true,
    query: data.query || query,
    results: (data.results || []).map((r) => ({
      title: r.title, snippet: r.snippet, url: r.url,
    })),
  };
  if (data.budget_warning) {
    out.notice_to_user = WARNING_NOTICE;
  }
  return out;
}

module.exports = {
  isConfigured,
  getAgentEpt,
  webSearch,
  _clearEptCache,
  WARNING_NOTICE,
  EXHAUSTED_MESSAGE,
};
