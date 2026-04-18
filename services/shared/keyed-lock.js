/**
 * Windy Chat — In-process keyed lock
 *
 * Serializes concurrent async work that shares an idempotency key
 * (e.g. a windy_identity_id during first-login). Before this helper, 20
 * simultaneous /unified-login calls for the same new user all raced past
 * the "existing?" lookup, each ran the "new user — provision" branch,
 * and minted 20 different Matrix access_tokens with 19 orphaned
 * accounts in Synapse (P1-1).
 *
 * Limitations:
 *   - Single-process only. A multi-task deployment still races at the
 *     task boundary; for that you need a Redis lock. This helper is
 *     sufficient for single-process ECS tasks + the ALB sticky cookie
 *     story documented in deploy/aws/CHAT_DEPLOYMENT.md (P1.1 scale
 *     plan). When we multi-task in prod, swap this for redlock.
 *   - No TTL. If the held function hangs forever, the lock pins until
 *     the process restarts. Callers should impose their own timeout.
 *
 * Usage:
 *
 *   const { withKeyLock } = require('../shared/keyed-lock');
 *
 *   await withKeyLock(windy_identity_id, async () => {
 *     const existing = db.get(windy_identity_id);
 *     if (existing) return sendExisting(existing);
 *     const fresh = await expensiveProvision();
 *     db.set(windy_identity_id, fresh);
 *     return sendFresh(fresh);
 *   });
 */

const locks = new Map(); // key → Promise (tail of the per-key chain)

async function withKeyLock(key, fn) {
  if (!key) return fn(); // no key → no serialization
  const previous = locks.get(key) || Promise.resolve();
  // Chain our work behind whatever's already queued. Both resolve and
  // reject paths of `previous` unblock us — the previous holder's error
  // shouldn't abort the next in line, only its own response.
  const current = previous.then(() => fn(), () => fn());
  const tail = current.finally(() => {
    // Only clean up if WE are still the tail — otherwise someone queued
    // behind us and will replace the entry themselves.
    if (locks.get(key) === tail) locks.delete(key);
  });
  locks.set(key, tail);
  return current;
}

// Test helper — callers should not depend on this in production paths.
function _sizeForTest() { return locks.size; }

module.exports = { withKeyLock, _sizeForTest };
