/**
 * Matrix localpart derivation — UNIFIED entry point.
 *
 * Background: windy-chat has TWO provisioning paths that historically derived
 * different localparts for the same windy_identity_id:
 *   - /provision (client-initiated): displayName → `windy_<base>` (legacy)
 *   - /webhooks/identity/created (server-initiated): rich payload → `<base>` (mail-aligned)
 *
 * Per design doc (kit-army-config/docs/windy-chat-localpart-fresh-design-2026-05-17.md)
 * Option A: unify on mail-aligned, preserve legacy users, add atomicity.
 *
 * THIS MODULE is the single source of truth. Both routes call
 * `deriveLocalpartForWindyId()` which:
 *   1. Atomic lookup: if this windy_identity_id already has a chat_user_id
 *      in user_profiles, return THAT (first-writer-wins; race-safe).
 *   2. Else derive via mailAlignedLocalpart (rich payload preferred,
 *      displayName fallback hardened).
 *   3. Resolve uniqueness via random-suffix on collision (defensive —
 *      uniqueness is mostly guaranteed by step 1).
 *
 * The legacy `displayNameToLocalpart` (provision.js) is RETAINED for
 * `resolveOwnerMatrixId` — that's a forward-construction helper for
 * agent-owner lookup that doesn't insert a profile, so it can keep the
 * legacy shape. Only the actual PROVISION write-paths route through here.
 */

const crypto = require('crypto');

/**
 * Mail-aligned localpart derivation.
 *
 * Priority order:
 *   1. firstName + lastName  → `<first>.<last>`
 *   2. username              → `<username>`
 *   3. email local-part      → `<email-local>`
 *   4. displayName (whitespace → dots) → `<a.b.c>`
 *   5. random hex fallback   → `user-<6-hex>`
 *
 * Hardening (vs the original webhooks.js inline version):
 *   - Collapse consecutive dots ("Grant J. Whitmer" → grant.j.whitmer, not grant.j..whitmer)
 *   - Strip leading/trailing dots
 *   - Strip leading non-alphanumeric (Matrix localpart must start [a-z0-9])
 *
 * Matrix localpart spec allows [a-z0-9._=/-]; Mail allows [a-z0-9._-];
 * we use the narrower intersection to guarantee Mail ↔ Chat handle parity.
 */
function mailAlignedLocalpart({ firstName, lastName, username, email, displayName } = {}) {
  let base;
  if (firstName && lastName) {
    base = `${firstName}.${lastName}`;
  } else if (username) {
    base = username;
  } else if (email && email.includes('@')) {
    base = email.split('@')[0];
  } else if (displayName) {
    base = displayName.replace(/\s+/g, '.');
  } else {
    base = '';
  }

  // Normalize charset
  base = base
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, '');

  // Collapse consecutive dots ("grant.j..whitmer" → "grant.j.whitmer")
  base = base.replace(/\.+/g, '.');

  // Strip leading/trailing dots
  base = base.replace(/^\.+/, '').replace(/\.+$/, '');

  // Matrix localpart must start with alphanumeric; if not, prefix
  // a random fallback (shouldn't happen post-hardening but defensive).
  if (!base || !/^[a-z0-9]/.test(base)) {
    base = `user-${crypto.randomBytes(3).toString('hex')}`;
  }

  // Length cap (Matrix maximum is 255 but most Synapse deployments
  // prefer ≤ 32 for display).
  return base.slice(0, 32);
}

/**
 * Resolve uniqueness against the user_profiles table. If `base` is
 * already taken by ANOTHER windy_identity_id, append a short random
 * suffix. Tries up to 4 random suffixes before giving up.
 *
 * Note: the typical caller pattern is `deriveLocalpartForWindyId`
 * below which does the existing-windy-id lookup FIRST, so this
 * resolveUnique step only fires on genuine localpart collisions
 * (rare — different users with similar names).
 */
function resolveUniqueLocalpart(db, base) {
  const check = db.prepare('SELECT 1 FROM user_profiles WHERE chat_user_id = ?');
  if (!check.get(base)) return base;

  for (let i = 0; i < 4; i++) {
    const suffix = crypto.randomBytes(2).toString('hex');
    const candidate = `${base}-${suffix}`.slice(0, 32);
    if (!check.get(candidate)) return candidate;
  }

  // Last-ditch — long random suffix; nearly-guaranteed unique
  return `${base.slice(0, 24)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * THE unified entry point. Both /provision and /webhooks/identity/created
 * call this. Same windy_identity_id always returns the same chat_user_id
 * regardless of which route fires first.
 *
 * @param {object} args.db - better-sqlite3 instance (or compatible)
 * @param {string} args.windyIdentityId - REQUIRED. The user's windy identity.
 * @param {string} [args.firstName] - rich payload: first name
 * @param {string} [args.lastName] - rich payload: last name
 * @param {string} [args.username] - rich payload: username
 * @param {string} [args.email] - rich payload: email
 * @param {string} [args.displayName] - fallback: display name
 * @returns {{ chatUserId: string, existing: boolean }}
 */
function deriveLocalpartForWindyId({ db, windyIdentityId, firstName, lastName, username, email, displayName }) {
  if (!db) {
    throw new Error('deriveLocalpartForWindyId: db is required');
  }
  if (!windyIdentityId) {
    throw new Error('deriveLocalpartForWindyId: windyIdentityId is required');
  }

  // Step 1: Atomic lookup. If this windy_identity_id already has a
  // chat_user_id, return that — race-safe first-writer-wins.
  const existing = db
    .prepare('SELECT chat_user_id FROM user_profiles WHERE windy_identity_id = ?')
    .get(windyIdentityId);
  if (existing && existing.chat_user_id) {
    return { chatUserId: existing.chat_user_id, existing: true };
  }

  // Step 2: Derive a fresh mail-aligned localpart.
  const base = mailAlignedLocalpart({ firstName, lastName, username, email, displayName });

  // Step 3: Resolve uniqueness against the table (different users with
  // similar names get suffix-disambiguated).
  const chatUserId = resolveUniqueLocalpart(db, base);

  return { chatUserId, existing: false };
}

module.exports = {
  deriveLocalpartForWindyId,
  mailAlignedLocalpart,
  resolveUniqueLocalpart,
};
