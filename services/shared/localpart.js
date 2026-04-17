/**
 * Windy Chat — Shared Matrix localpart generator
 *
 * Same localpart has to fall out of every entry path — /unified-login,
 * /api/v1/chat/provision, /api/v1/webhooks/identity/created, agent
 * provisioning — so a given Windy identity always maps to the same
 * @handle:chat.windyword.ai regardless of which code path fired first.
 *
 * Previously `services/onboarding/routes/provision.js` used
 * `displayNameToLocalpart` with a `windy_`-prefixed output while
 * `services/onboarding/routes/webhooks.js` used `mailAlignedLocalpart`
 * with no prefix — so the same user got either `@windy_grant:` or
 * `@grant.whitmer:` depending on which path won the race (P1-2).
 *
 * This module centralizes the mail-aligned algorithm. Matrix localpart
 * regex is [a-z0-9._=/-]; Mail localpart is [a-z0-9._-]; the intersection
 * is [a-z0-9._-] and that's what we use so Chat and Mail handles stay
 * one-to-one (`grant.whitmer@windymail.ai` ↔ `@grant.whitmer:chat.windyword.ai`).
 */

const crypto = require('crypto');

/**
 * Produce a stable Matrix localpart from whatever identity fields are
 * available. Priority is first+last → username → email local-part →
 * display name with spaces-to-dots.
 *
 * @param {object} parts
 * @param {string} [parts.firstName]
 * @param {string} [parts.lastName]
 * @param {string} [parts.username]
 * @param {string} [parts.email]
 * @param {string} [parts.displayName]
 * @returns {string} localpart (≤ 32 chars, [a-z0-9._-], non-empty)
 */
function mailAlignedLocalpart({ firstName, lastName, username, email, displayName } = {}) {
  let base;
  if (firstName && lastName) {
    base = `${firstName}.${lastName}`;
  } else if (username) {
    base = username;
  } else if (email && email.includes('@')) {
    base = email.split('@')[0];
  } else {
    base = (displayName || '').replace(/\s+/g, '.');
  }
  base = base.toLowerCase().trim().replace(/[^a-z0-9._-]/g, '');
  if (!base || !/^[a-z0-9]/.test(base)) {
    // Fallback: random but deterministic-shaped, so monitors can tell a
    // random handle apart from a normal-looking one at a glance.
    base = `user-${crypto.randomBytes(2).toString('hex')}`;
  }
  return base.slice(0, 32);
}

/**
 * Given a base localpart + a lookup function that returns truthy when
 * the localpart is already taken, return a collision-free variant by
 * appending `-<hex3>`. Tries up to 3 random suffixes.
 *
 * The lookup is caller-supplied so this module doesn't depend on any
 * particular database.
 *
 * @param {string} base
 * @param {(candidate: string) => boolean} isTaken
 * @returns {string}
 */
function resolveUniqueLocalpart(base, isTaken) {
  if (!isTaken(base)) return base;
  for (let i = 0; i < 3; i++) {
    const suffix = crypto.randomBytes(3).toString('hex');
    const candidate = `${base}-${suffix}`.slice(0, 32);
    if (!isTaken(candidate)) return candidate;
  }
  throw new Error(`Could not generate unique localpart for base="${base}"`);
}

module.exports = { mailAlignedLocalpart, resolveUniqueLocalpart };
