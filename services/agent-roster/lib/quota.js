/**
 * Per-user daily quotas for the agent-roster.
 *
 * Without this, a single grandma's runaway agent (or one curious user
 * spam-pinging the LLM) can burn through the Groq free tier for the
 * whole fleet. With it, every owner gets a generous-but-finite daily
 * budget that resets at UTC midnight; honest grandma-friendly errors
 * tell the user when they hit the wall.
 *
 * Storage: per-process Map keyed by windy_identity_id. Reset on UTC
 * date change. Restart resets all counters — acceptable for v1; users
 * gain a small accidental refill on rare service redeploys, which is
 * better than over-strict false-positives.
 *
 * Why per-user not per-agent: a single owner can hatch multiple
 * agents; the budget belongs to the human, not their digital fleet.
 *
 * Quotas (defaults — overridable by env):
 *   QUOTA_MESSAGES_PER_DAY = 200   — each LLM call against the agent
 *   QUOTA_MAILS_PER_DAY    = 50    — each successful send_email tool call
 *
 * Failure mode: agent_runner consults this BEFORE the LLM call; if
 * over-quota, it skips the LLM call and replies with a quota-honest
 * message. Tool-call quotas are checked at tool-execution time.
 */

const MESSAGES_PER_DAY = parseInt(process.env.QUOTA_MESSAGES_PER_DAY || '200', 10);
const MAILS_PER_DAY = parseInt(process.env.QUOTA_MAILS_PER_DAY || '50', 10);

// Map<windyId, {date: 'YYYY-MM-DD', messages: int, mails: int}>
const counters = new Map();

function utcDate() {
  return new Date().toISOString().slice(0, 10);
}

function bucket(windyId) {
  const today = utcDate();
  let row = counters.get(windyId);
  if (!row || row.date !== today) {
    row = { date: today, messages: 0, mails: 0 };
    counters.set(windyId, row);
  }
  return row;
}

function hoursTilUtcMidnight() {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((tomorrow.getTime() - now.getTime()) / 3600_000));
}

/**
 * Check + consume a message budget. Returns { allowed, remaining, resetInHours }.
 * Call BEFORE the LLM request; on `allowed: false` skip the LLM and reply
 * with quota_message() instead.
 *
 * `multiplier` scales the daily limit — ADR-056: verified owners earn a
 * larger allowance (the $1 upgrade genuinely buys a bigger day), so the
 * runner passes >1 for clearance above 'registered'.
 */
function consumeMessage(windyId, multiplier = 1) {
  if (!windyId) return { allowed: true, remaining: Infinity, resetInHours: 0 };
  const limit = Math.floor(MESSAGES_PER_DAY * Math.max(1, multiplier));
  const row = bucket(windyId);
  if (row.messages >= limit) {
    return { allowed: false, remaining: 0, resetInHours: hoursTilUtcMidnight() };
  }
  row.messages += 1;
  return { allowed: true, remaining: limit - row.messages, resetInHours: hoursTilUtcMidnight() };
}

function consumeMail(windyId) {
  if (!windyId) return { allowed: true, remaining: Infinity, resetInHours: 0 };
  const row = bucket(windyId);
  if (row.mails >= MAILS_PER_DAY) {
    return { allowed: false, remaining: 0, resetInHours: hoursTilUtcMidnight() };
  }
  row.mails += 1;
  return { allowed: true, remaining: MAILS_PER_DAY - row.mails, resetInHours: hoursTilUtcMidnight() };
}

/** Grandma-friendly quota-hit message. */
function quotaMessage(kind, resetInHours) {
  const verb = kind === 'mail' ? 'send another email' : 'chat more with me';
  const hr = resetInHours === 1 ? '1 hour' : `${resetInHours} hours`;
  return `You've used your daily allowance — we'll reset in about ${hr}. You'll be able to ${verb} then. (We cap daily use to keep the service running smoothly for everyone.)`;
}

/** Snapshot for /status endpoint. */
function snapshot() {
  const out = [];
  for (const [windyId, row] of counters.entries()) {
    out.push({ windyId, date: row.date, messages: row.messages, mails: row.mails });
  }
  return {
    limits: { messages_per_day: MESSAGES_PER_DAY, mails_per_day: MAILS_PER_DAY },
    today: utcDate(),
    users: out,
  };
}

module.exports = { consumeMessage, consumeMail, quotaMessage, snapshot };
