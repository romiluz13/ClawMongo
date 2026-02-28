#!/usr/bin/env bash
set -euo pipefail

# Sync ClawMongo fork with upstream openclaw/openclaw.
# Usage:
#   bash scripts/sync-upstream.sh
#   bash scripts/sync-upstream.sh --ref origin/main --fail-if-behind
#   bash scripts/sync-upstream.sh --merge

MERGE=false
FAIL_IF_BEHIND=false
REF="origin/main"

usage() {
  cat <<'EOF'
Usage: bash scripts/sync-upstream.sh [options]

Options:
  --merge             Merge upstream/main into the current branch.
  --ref <git-ref>     Compare this ref to upstream/main (default: origin/main).
  --fail-if-behind    Exit non-zero if <ref> is behind upstream/main.
  --help              Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --merge)
      MERGE=true
      shift
      ;;
    --fail-if-behind)
      FAIL_IF_BEHIND=true
      shift
      ;;
    --ref)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --ref"
        exit 1
      fi
      REF="$2"
      shift 2
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

echo "=== ClawMongo Upstream Sync ==="

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git repository."
  exit 1
fi

# Ensure upstream remote exists
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Adding upstream remote..."
  git remote add upstream https://github.com/openclaw/openclaw.git
fi

echo "Fetching upstream + origin..."
git fetch upstream main --quiet
git fetch origin main --quiet

if ! git rev-parse --verify --quiet "$REF" >/dev/null; then
  echo "Ref not found: $REF"
  exit 1
fi

# Show divergence for the chosen ref and for current HEAD.
BEHIND=$(git rev-list --count "$REF"..upstream/main)
AHEAD=$(git rev-list --count upstream/main.."$REF")
HEAD_BRANCH=$(git rev-parse --abbrev-ref HEAD)
HEAD_BEHIND=$(git rev-list --count HEAD..upstream/main)
HEAD_AHEAD=$(git rev-list --count upstream/main..HEAD)

echo "Compared ref ($REF): ${AHEAD} ahead, ${BEHIND} behind upstream/main"
echo "Current branch ($HEAD_BRANCH): ${HEAD_AHEAD} ahead, ${HEAD_BEHIND} behind upstream/main"

if [[ "$BEHIND" -eq 0 ]]; then
  echo "Compared ref is up to date with upstream."
else
  echo ""
  echo "--- Conflict hotspots (changed in upstream since $REF) ---"
  HOTSPOTS=(
    "src/config/types.memory.ts"
    "src/memory/types.ts"
    "src/memory/backend-config.ts"
    "src/memory/search-manager.ts"
  )
  for file in "${HOTSPOTS[@]}"; do
    if git diff "$REF"...upstream/main --name-only | grep -q "$file"; then
      echo "  CHANGED: $file"
    else
      echo "  OK:      $file"
    fi
  done

  echo ""
  echo "Recent upstream diff summary vs $REF:"
  git diff --stat "$REF"...upstream/main | tail -10
fi

if [[ "$FAIL_IF_BEHIND" == "true" && "$BEHIND" -gt 0 ]]; then
  echo ""
  echo "FAIL: $REF is behind upstream/main by $BEHIND commit(s)."
  exit 2
fi

if [[ "$MERGE" == "true" ]]; then
  echo ""
  echo "Merging upstream/main into current branch ($HEAD_BRANCH)..."
  git merge upstream/main --no-edit
  echo ""
  echo "Post-merge checklist:"
  echo "  1. pnpm install"
  echo "  2. pnpm check"
  echo "  3. pnpm test -t \"memory|onboarding\""
  echo "  4. git push"
else
  echo ""
  echo "To merge on current branch: bash scripts/sync-upstream.sh --merge"
fi
