/**
 * Reconcile pruning (2026-07-07): a runner whose agent_credentials row
 * vanished (revocation cleanup) must be stopped and dropped — not left
 * 401-looping against its deactivated Matrix account until restart.
 *
 * Exercises the prune block's semantics directly (same shape as the
 * server.js loop) — the reconcile function itself is module-internal
 * and DB-bound.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

function pruneRoster(roster, agents) {
  const liveIds = new Set(agents.map((a) => a.agent_matrix_id));
  const pruned = [];
  for (const [matrixId, runner] of roster) {
    if (liveIds.has(matrixId)) continue;
    try { runner.stop(); } catch (_e) { /* best-effort */ }
    roster.delete(matrixId);
    pruned.push(matrixId);
  }
  return pruned;
}

function fakeRunner() {
  return {
    running: true,
    stop() { this.running = false; },
  };
}

test('runner with vanished credentials is stopped and dropped', () => {
  const roster = new Map();
  const keep = fakeRunner();
  const zombie = fakeRunner();
  roster.set('@agent_et26-keep-0001:chat.windychat.ai', keep);
  roster.set('@agent_et26-gone-0002:chat.windychat.ai', zombie);

  const pruned = pruneRoster(roster, [
    { agent_matrix_id: '@agent_et26-keep-0001:chat.windychat.ai' },
  ]);

  assert.deepEqual(pruned, ['@agent_et26-gone-0002:chat.windychat.ai']);
  assert.equal(roster.size, 1);
  assert.equal(zombie.running, false);
  assert.equal(keep.running, true);
});

test('a stop() that throws still drops the runner', () => {
  const roster = new Map();
  roster.set('@agent_et26-gone-0003:chat.windychat.ai', {
    stop() { throw new Error('sync loop busy'); },
  });
  const pruned = pruneRoster(roster, []);
  assert.deepEqual(pruned, ['@agent_et26-gone-0003:chat.windychat.ai']);
  assert.equal(roster.size, 0);
});

test('empty roster and full roster are no-ops', () => {
  assert.deepEqual(pruneRoster(new Map(), []), []);
  const roster = new Map([['@a:x', fakeRunner()]]);
  assert.deepEqual(pruneRoster(roster, [{ agent_matrix_id: '@a:x' }]), []);
  assert.equal(roster.size, 1);
});
