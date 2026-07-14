/**
 * Vendor drift guard — deploy/ops-hook/hook.py must stay byte-identical to
 * the fleet-canonical ops-hook in sneakyfree/windy-contracts
 * (ops-hook/hook.py). Re-vendor (cp) instead of editing the copy; see
 * deploy/ops-hook/README.md.
 *
 * node:test — run with: node --test deploy/ops-hook/hook-drift.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const VENDORED = path.join(__dirname, 'hook.py');

test('vendored hook present and canonical (env-driven, not a fork)', () => {
  assert.ok(fs.existsSync(VENDORED), 'deploy/ops-hook/hook.py missing');
  const text = fs.readFileSync(VENDORED, 'utf8');
  assert.ok(text.includes('windy ops-hook — the doctor that is NOT in the patient'));
  assert.ok(text.includes('OPS_HOOK_TOKEN') && text.includes('OPS_HOOK_SERVICES'),
    'per-service restart support (OPS_HOOK_SERVICES) must be present');
});

test('byte-identical to the canon when windy-contracts is checked out', (t) => {
  const canon = path.join(os.homedir(), 'windy-contracts', 'ops-hook', 'hook.py');
  if (!fs.existsSync(canon)) {
    t.skip('windy-contracts not checked out here; CI/lane does the byte-compare');
    return;
  }
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  assert.strictEqual(sha(VENDORED), sha(canon),
    'deploy/ops-hook/hook.py has DRIFTED from windy-contracts/ops-hook/hook.py — re-vendor (cp).');
});
