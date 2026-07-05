/**
 * ADR-056 §5 — compute exhaustion is the midwife's conversion moment.
 *
 * When an owner's daily allowance runs out the midwife must never go
 * dark: the wall becomes a warm hand-off to (1) linking your own
 * compute — free, always — and (2) the $1 verified upgrade.
 *
 * Honesty rules baked in:
 *  - The $1 line is only shown to agents we positively know are
 *    unverified (Eternitas trust clearance === 'registered'). A
 *    verified agent is never re-sold what it already has, and an
 *    unknown tier (trust API unreachable) gets the compute-link
 *    option only.
 *  - The $1 line ships DARK: it appears only when
 *    VERIFIED_HATCH_UPSELL=1, which flips at ADR-056 go-live together
 *    with VERIFIED_HATCH_ENABLED on Eternitas — otherwise we'd send
 *    grandma to an upgrade page that says "not open yet".
 *  - Verified owners get a larger daily allowance (quota multiplier in
 *    agent-runner), so the upgrade genuinely buys a bigger day — the
 *    message never promises something the wall doesn't deliver.
 */

const CLEARANCE_CACHE_MS = 5 * 60 * 1000; // matches every other trust consumer

// Map<passport, { at: epochMs, clearance: string|null }>
const clearanceCache = new Map();

/**
 * Fetch (with 5-min cache) the agent's Eternitas clearance name —
 * 'registered' | 'verified' | ... — or null when unknown/unreachable.
 * Failures are cached too, so a dead trust API costs one 4s timeout
 * per agent per 5 minutes, not one per message.
 */
async function getClearance(passport) {
  if (!passport) return null;
  const now = Date.now();
  const hit = clearanceCache.get(passport);
  if (hit && now - hit.at < CLEARANCE_CACHE_MS) return hit.clearance;

  let clearance = null;
  try {
    const base = process.env.ETERNITAS_URL || 'https://api.eternitas.ai';
    const res = await fetch(
      `${base}/api/v1/trust/${encodeURIComponent(passport)}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (res.ok) {
      const data = await res.json();
      if (typeof data.clearance_level === 'string') clearance = data.clearance_level;
    }
  } catch { /* unknown — fail to null */ }
  clearanceCache.set(passport, { at: now, clearance });
  return clearance;
}

function upsellEnabled() {
  return process.env.VERIFIED_HATCH_UPSELL === '1';
}

/**
 * The warm exhaustion message. `clearance` comes from getClearance();
 * pass it in (the caller already fetched it for the quota multiplier).
 */
function exhaustionMessage({ passport, clearance, resetInHours }) {
  const hr = resetInHours === 1 ? '1 hour' : `${resetInHours} hours`;
  const lines = [
    `I've used up my shared thinking power for today — it refills in about ${hr}, and I'll be right here when it does.`,
    '',
    'I never want to go quiet on you, so here is how to give me thinking power of my own:',
    '• If you have your own AI account (OpenAI, Anthropic, Google…), you can link it to me in the Windy app — that stays free, always.',
  ];
  if (upsellEnabled() && clearance === 'registered' && passport) {
    const upgradeUrl = process.env.UPGRADE_URL || 'https://app.windyword.ai/upgrade';
    lines.push(
      `• Or, for one dollar, one time, I get my verified Eternitas passport — full access to the whole Windy ecosystem and a bigger daily allowance: ${upgradeUrl}?passport=${encodeURIComponent(passport)}`,
    );
  }
  return lines.join('\n');
}

/** Test hook — clears the clearance cache between test cases. */
function _resetCache() {
  clearanceCache.clear();
}

module.exports = { getClearance, exhaustionMessage, upsellEnabled, _resetCache };
