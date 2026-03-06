#!/usr/bin/env bash
set -euo pipefail

# Sync ClawMongo fork with upstream openclaw/openclaw.
# Usage:
#   bash scripts/sync-upstream.sh
#   bash scripts/sync-upstream.sh --ref origin/main --fail-if-behind
#   bash scripts/sync-upstream.sh --merge

MERGE=false
FAIL_IF_BEHIND=false
FAIL_IF_OUTSIDE_ALLOWLIST=false
REF="origin/main"
ALLOWLIST="scripts/upstream-drift-allowlist.txt"
BASELINE="scripts/upstream-drift-baseline.txt"

usage() {
  cat <<'EOF'
Usage: bash scripts/sync-upstream.sh [options]

Options:
  --merge             Merge upstream/main into the current branch.
  --ref <git-ref>     Compare this ref to upstream/main (default: origin/main).
  --fail-if-behind    Exit non-zero if <ref> is behind upstream/main.
  --fail-if-outside-allowlist
                     Exit non-zero if fork-only drift falls outside the allowlist.
  --allowlist <path> Allowlist of approved drift prefixes/files
                     (default: scripts/upstream-drift-allowlist.txt).
  --baseline <path>  Baseline of pre-existing fork drift to ignore when enforcing
                     the allowlist (default: scripts/upstream-drift-baseline.txt).
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
    --fail-if-outside-allowlist)
      FAIL_IF_OUTSIDE_ALLOWLIST=true
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
    --allowlist)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --allowlist"
        exit 1
      fi
      ALLOWLIST="$2"
      shift 2
      ;;
    --baseline)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --baseline"
        exit 1
      fi
      BASELINE="$2"
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

check_allowlist() {
  local ref="$1"
  local allowlist_path="$2"
  local baseline_path="$3"

  if [[ ! -f "$allowlist_path" ]]; then
    echo "Allowlist file not found: $allowlist_path"
    return 3
  fi

  mapfile -t allowed < <(grep -v '^\s*#' "$allowlist_path" | sed '/^\s*$/d')
  local baseline=()
  if [[ -f "$baseline_path" ]]; then
    mapfile -t baseline < <(grep -v '^\s*#' "$baseline_path" | sed '/^\s*$/d')
  fi
  mapfile -t ahead_files < <(git diff --name-only upstream/main..."$ref")

  local invalid=()
  for file in "${ahead_files[@]}"; do
    local matched=false
    for prefix in "${allowed[@]}"; do
      if [[ "$file" == "$prefix" || "$file" == "$prefix"* ]]; then
        matched=true
        break
      fi
    done
    if [[ "$matched" == false ]]; then
      for exact in "${baseline[@]}"; do
        if [[ "$file" == "$exact" ]]; then
          matched=true
          break
        fi
      done
    fi
    if [[ "$matched" == false ]]; then
      invalid+=("$file")
    fi
  done

  if [[ "${#invalid[@]}" -eq 0 ]]; then
    echo "Allowlist check passed ($allowlist_path; baseline: $baseline_path)."
    return 0
  fi

  echo "Allowlist violations:"
  printf '  %s\n' "${invalid[@]}"
  return 4
}

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

if [[ "$FAIL_IF_OUTSIDE_ALLOWLIST" == "true" ]]; then
  echo ""
  echo "Checking approved drift allowlist..."
  if ! check_allowlist "$REF" "$ALLOWLIST" "$BASELINE"; then
    echo ""
    echo "FAIL: fork drift extends outside $ALLOWLIST (after baseline $BASELINE)"
    exit 3
  fi
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
