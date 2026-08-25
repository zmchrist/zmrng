#!/usr/bin/env bash
# Public-readiness scrub gate (issue #17).
#
# Fails if a former project name or client repo name appears as a WHOLE WORD in
# any tracked file. Uses word-boundary matching (`git grep -w`) rather than a
# substring match, so innocent tokens that merely CONTAIN a forbidden name —
# e.g. "ephemeral" contains "pheme" — do not trip the gate. Case-insensitive.
#
# Run it: `bash scripts/scrub-gate.sh` before making the repo public or merging
# any docs/config change. Exit 0 = clean, exit 1 = forbidden name found.
set -euo pipefail

# Former project name | former client repo name.
FORBIDDEN='pheme|bluebeam'

# Exclude this gate's own source (it necessarily spells the forbidden names) and
# the plan, whose acceptance section documents the gate.
if git grep -I -i -n -w -E "$FORBIDDEN" -- . \
  ':(exclude)scripts/scrub-gate.sh' \
  ':(exclude).agents/plans/public-readiness-and-harness-productization.md' ; then
  echo "" >&2
  echo "✗ scrub gate: a forbidden project/client name appears above as a whole word." >&2
  echo "  Genericize it before merging (see .agents/plans/public-readiness-and-harness-productization.md)." >&2
  exit 1
fi

echo "✓ scrub gate: no forbidden project/client names in tracked files"
