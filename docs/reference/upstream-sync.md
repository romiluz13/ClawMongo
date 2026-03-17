# Upstream Sync

ClawMongo stays close to upstream OpenClaw on purpose. The fork only takes a hard fork position in one place: MongoDB remains the canonical runtime memory and backend truth.

## Operating Rule

- Adopt upstream broadly and quickly when a change is backend-agnostic.
- Keep MongoDB authoritative when upstream touches memory ownership, retrieval freshness, or runtime persistence.
- Ignore backend-only fixes for SQLite, QMD, LanceDB, or similar paths unless the upstream idea is valuable enough to re-express in MongoDB-native seams.
- Treat Markdown memory files as bridge or operator-authored context, not canonical runtime truth.

## Sync Workflow

### 0. Steady-state cadence

When ClawMongo is already close to upstream, the default routine should be a
steady-state check instead of starting a new merge wave blindly.

```bash
pnpm upstream:steady
```

This does three things:

- fetches and validates MongoDB-first drift guardrails
- checks whether the current branch is still at `0 behind upstream/main`
- prints a bounded sync report only if upstream moved

Interpret the result like this:

- exit `0`: already at steady state, no catch-up work needed
- exit `2`: upstream moved, start the next bounded merge wave

Use this as the default daily or pre-release habit. Use the full merge-wave
workflow below only when `pnpm upstream:steady` reports drift.

### 1. Pre-sync hygiene

- Keep `main` clean before every merge wave.
- Commit MongoDB work in small logical slices before touching upstream.
- Fetch upstream and run the drift guard first.

```bash
bash scripts/sync-upstream.sh --ref origin/main --fail-if-outside-allowlist --fail-if-excluded-present
```

### 2. Generate a bounded sync brief

- Produce a structured report for the exact wave you plan to absorb.
- Use `origin/main..upstream/main` for the general report.
- Use release tags for a smaller bounded wave.

```bash
pnpm upstream:report
pnpm upstream:report -- --base v2026.3.11 --target v2026.3.12
```

The report highlights:

- divergence against upstream
- protected MongoDB-first hotspots
- excluded backend paths touched upstream
- candidate idea-port commits
- likely backend-specific commits that can be ignored

### 3. Triage conflicts

- Safe adopt: merge upstream behavior directly.
- Mongo conflict: preserve MongoDB truth first, then layer upstream-compatible behavior around that seam.
- Idea-port candidate: keep the user-facing benefit, reject the upstream backend-specific implementation, and reimplement it through MongoDB events, chunks, structured memory, graph, or episodes.
- Irrelevant backend change: do not reimplement it.

Resolve conflicts in this order:

1. memory truth boundary
2. runtime write path
3. retrieval and search behavior
4. config and schema validation
5. prompt and memory tool behavior
6. everything else

### 4. Merge on a clean tree only

```bash
bash scripts/sync-upstream.sh --merge
```

The merge script already refuses to run on a dirty working tree and reminds us to re-run the MongoDB-first validation suite afterward.

## Protected Seams

These files must be reviewed explicitly any time upstream changes them:

- memory backend resolution and config validation
- runtime conversation write paths
- transcript and session append paths
- prompt and memory tool behavior
- retrieval and search manager logic
- MongoDB structured memory, graph, episodes, sync, and schema layers
- gateway and outbound persistence seams
- onboarding and config surfaces that expose memory choices

The exact path list lives in `scripts/upstream-protected-paths.txt`.

## Excluded Paths

ClawMongo does not carry upstream backend code for non-Mongo memory managers. The exact exclusion list lives in `scripts/upstream-excluded-paths.txt` and should stay narrow and explicit.

## Validation Gate

Every sync wave must pass:

- `pnpm build`
- targeted unit tests for the changed protected seams
- prompt and memory tool tests
- config and schema validation tests
- transcript, session, gateway, and outbound persistence tests
- the live MongoDB memory suites:

```bash
pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose
```

The acceptance bar is:

- live conversation writes go directly to MongoDB events and searchable chunks
- `memory_search` stays fresh without transcript-sync dependence
- `memory_write` persists structured memory only in MongoDB
- Markdown bridge files import correctly without becoming canonical runtime truth
- upstream changes do not silently reintroduce alternate backend assumptions

## Release Gate

Do not publish a ClawMongo release until:

- the target upstream wave is merged
- protected seams were explicitly reviewed
- the MongoDB validation gate passed
- release notes separate upstream adoption from MongoDB-native architecture preservation
