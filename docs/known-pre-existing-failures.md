# Known Pre-Existing Test Failures

This file tracks test failures that are **not** caused by the commit
under review — usually missing external fixtures (a live Synapse, a
live Eternitas) or node:test harness artifacts when many suites share
the same runner. Each entry names the failure, why it fails, and what
it'd take to retire the workaround.

Triage buckets come from the Wave 10 cleanup PR:
- **(a)** SQLite lock contention — fixable by isolating the DB
- **(b)** Assertion drift — update test or fix code
- **(c)** Needs a live service fixture we don't stand up in CI

Wave 10 fixed every (a) and (b) case; only (c)-class entries below
remain.

---

## (c.1) `tests/integration/test_trust_live.js` — file-level timeout

**What fails:** Under `node --test tests/integration/test_trust_live.js`
the 8 individual `it()` tests finish (6 pass, 2 live-probes skip when
Eternitas isn't reachable) but the outer file-level wrapper is
reported as `cancelled` / `testTimeoutFailure` after ~30s because the
process does not exit cleanly.

**Why:** The test keeps a stand-in HTTP server (`startStandin()`) and
boots the onboarding + directory apps via `startServices()`. Those
servers call `app.listen(0)` which opens sockets and registers setInterval
timers (push-token cleanup, trust-cache reap) that never get cleared in
`after()`. Node's test runner waits for these to close, hits its
30s file-level deadline, and marks the file cancelled. Every assertion
that ran inside still passes.

Running against a real Eternitas (`ETERNITAS_URL=http://live:8500
LIVE_ETERNITAS_URL=…`) makes the two `skip`s run for real; it does not
fix the file-level wrapper timeout — that's a handle-leak issue in
our service apps, not a fixture issue.

**Fix path:** audit `services/onboarding/server.js` +
`services/directory/server.js` for intervals that aren't `unref()`'d,
and add `clearInterval` calls to the tests' `after()` hook.

**What to do meanwhile:** run this file with `--test-timeout=60000`
(doubles the wrapper limit and gives us a clean exit), or invoke it
alone in CI rather than batched with other integration suites. Its
assertions are reliable; only the wrapper is flaky.

---

## (c.2) `tests/integration/test_onboarding_flow.js` — IPC deserialize error in batch

**What fails:** `node --test` with multiple integration files in a single
invocation reports
`Unable to deserialize cloned data due to invalid or unsupported version.`
against this file. Run alone it passes 24/24.

**Why:** Our test files call `process.exit(0)` from their `after()`
hooks (a pattern used by 26 of ~30 test files in this repo) to paper
over lingering handles from service servers. When two files in the
same runner both exit this way, the parent runner's IPC stream to the
child can be interrupted mid-write, and the next child's structured
clone fails to deserialize.

**Fix path:** replace the
`server.close(() => { setTimeout(() => process.exit(0), 100); resolve(); })`
boilerplate across `tests/**` with `server.close(resolve)` once the
underlying handle leaks in each service are fixed. This is a
sweeping change across 26 files and belongs in its own PR — it's
orthogonal to individual test correctness.

**What to do meanwhile:** run integration test files one at a time in
CI (`for f in tests/integration/*.js; do node --test "$f"; done`),
which is our current Makefile/CI pattern. The batched
`node --test tests/integration/*.js` invocation is not a supported
entry point; it's only surfaced by local ad-hoc runs.

---

## (c.3) Agent-DM end-to-end against a real Synapse

**What's missing:** `tests/integration/test_agent_onboarding.js` (Wave 10
updated) and `services/onboarding/tests/grandma-ribbon.test.js` (Wave 8)
both exercise the deferred-DM / post-provision hook using dev stubs.
They do not hit a real Synapse homeserver, so they don't verify:

- the agent's access token actually mints a Matrix session (we stub it
  with `dev_token_…`);
- the welcome message is accepted by Synapse's
  `PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}`;
- the owner actually receives a room invite event.

**Fix path:** when the Wave 1-era "synapse-fixture" target lands
(planned for Q3 in `docs/DNA_STRAND_MASTER_PLAN.md`), these suites
should gain a `describe.skipIf(!process.env.SYNAPSE_FIXTURE_URL)`
block asserting the real round-trip. Until then the dev-stub coverage
is sufficient for the pre-launch smoke layer (`scripts/smoke-test.sh`
covers the real Synapse path end-to-end against a live deploy).
