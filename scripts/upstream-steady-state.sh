#!/usr/bin/env bash
set -euo pipefail

# Lightweight routine for keeping ClawMongo at 0 behind upstream/main.
# This is intentionally stricter than merge-wave tooling:
# - it validates MongoDB-first drift guardrails
# - it checks the current branch directly against upstream/main
# - it emits a bounded report only when upstream moved

REF="HEAD"
MAX_COMMITS=12
REPORT=true

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" && -x "/opt/homebrew/bin/node" ]]; then
  NODE_BIN="/opt/homebrew/bin/node"
fi

usage() {
  cat <<'EOF'
Usage: bash scripts/upstream-steady-state.sh [options]

Options:
  --ref <git-ref>        Check this ref against upstream/main (default: HEAD).
  --max-commits <count>  Number of commits to include in the behind report
                         when drift exists (default: 12).
  --no-report            Skip the bounded sync report when behind.
  --help                 Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      continue
      ;;
    --ref)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --ref"
        exit 1
      fi
      REF="$2"
      shift 2
      ;;
    --max-commits)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --max-commits"
        exit 1
      fi
      MAX_COMMITS="$2"
      shift 2
      ;;
    --no-report)
      REPORT=false
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

echo "=== ClawMongo Steady-State Upstream Check ==="

bash scripts/sync-upstream.sh \
  --ref "$REF" \
  --fail-if-outside-allowlist \
  --fail-if-excluded-present

BEHIND=$(git rev-list --count "${REF}..upstream/main")
AHEAD=$(git rev-list --count "upstream/main..${REF}")

echo ""
echo "Steady-state status for ${REF}: ${AHEAD} ahead / ${BEHIND} behind upstream/main"

if [[ "$BEHIND" == "0" ]]; then
  echo "ClawMongo is at steady state: no upstream catch-up work is required."
  exit 0
fi

echo "ClawMongo is behind upstream/main. Start a bounded sync wave before publishing."

if [[ "$REPORT" == "true" ]]; then
  if [[ -z "$NODE_BIN" ]]; then
    echo "Node.js is required to print the bounded sync report."
    exit 3
  fi
  echo ""
  echo "--- Suggested bounded report ---"
  "$NODE_BIN" --import tsx scripts/upstream-sync-report.ts \
    --base "$REF" \
    --target upstream/main \
    --max-commits "$MAX_COMMITS"
fi

exit 2
