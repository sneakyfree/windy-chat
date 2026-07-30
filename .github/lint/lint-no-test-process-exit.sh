#!/usr/bin/env bash
#
# No process.exit() inside test files.
#
# WHY THIS LINT EXISTS
# --------------------
# `node --test` runs each file in a CHILD PROCESS and ships results back to
# the parent over an IPC channel using V8 serialization. `process.exit()`
# terminates the process immediately — including mid-write on that channel.
# The parent then receives a truncated message and dies with:
#
#   not ok 1 - tests/<file>.js
#     failureType: 'uncaughtException'
#     error: 'Unable to deserialize cloned data due to invalid or
#             unsupported version.'
#
# Every assertion in the file passes first, so the log reads
# `# pass 42 / # fail 0` immediately followed by `not ok 1`. It looks like a
# mystery flake. It is not: it is a race between the exit and the flush.
#
# 26 test files carried `setTimeout(() => process.exit(0), 100)` in their
# after() hook. On a fast idle laptop the flush wins and everything is green.
# On the Kit 0 runner — which is also hosting Synapse, Postgres, Eternitas
# and eight other stacks — the exit wins. `main` was red for four days, on a
# different test file each run, and two PRs were nearly merged on the
# assumption that CI is "just flaky".
#
# The right tool is the runner flag `--test-force-exit`, which force-exits
# AFTER results are reported. It is applied in .github/workflows/ci.yml and
# in every service's `npm test` script.
#
# If a test leaves a handle open, fix the handle or rely on
# --test-force-exit. Never exit from inside the test.

set -euo pipefail

ROOT="${1:-tests}"

# `git grep -n` would be nicer but this script also runs outside a checkout.
HITS=$(grep -rn --include='*.js' --include='*.ts' -E '(^|[^.[:alnum:]_])process\.exit\s*\(' "$ROOT" 2>/dev/null \
  | grep -v '^\s*//' \
  | grep -viE '^[^:]*:[0-9]+:\s*(\*|//)' \
  || true)

if [ -n "$HITS" ]; then
  echo "ERROR: process.exit() found in test files."
  echo
  echo "$HITS"
  echo
  echo "This corrupts the node:test IPC channel and produces the misleading"
  echo "'Unable to deserialize cloned data' failure while every assertion passes."
  echo "Use the runner flag --test-force-exit instead. See the header of"
  echo "$0 for the full explanation."
  exit 1
fi

echo "no-test-process-exit OK ($ROOT)"
