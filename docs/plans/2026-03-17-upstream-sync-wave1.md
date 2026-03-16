# Upstream Sync Wave 1

## Scope

- Range: `v2026.3.11...v2026.3.12`
- Why this wave first: it is materially smaller than the next release hop and already contains useful runner, compaction, and gateway improvements without forcing a giant catch-up merge.
- Goal: absorb the first bounded release wave while preserving the MongoDB-first runtime memory contract.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with guardrails.
- Take upstream dependency, runtime floor, and test harness updates.
- Preserve ClawMongo package identity, the `clawmongo` binary, and fork-specific upstream tooling scripts.

### `src/agents/memory-search.ts`

- Classification: idea-port candidate.
- Keep upstream memory search UX improvements if they improve recall quality or context shaping.
- Do not allow the implementation to route freshness back through transcript sync or non-Mongo managers.

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: Mongo conflict.
- Upstream compaction improvements are desirable, especially transcript update handling.
- Preserve the ClawMongo rule that durable memory flushes go to MongoDB only, not to Markdown memory files.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: Mongo conflict.
- This is a primary runtime write seam.
- Adopt upstream runner improvements around tool execution, snapshots, turn ending, and session lifecycle only after they are re-layered around direct MongoDB event writes.

### `src/agents/pi-tools.ts`

- Classification: Mongo conflict with idea-port potential.
- Accept upstream tool-surface improvements.
- Keep `memory_write` as the durable-memory path and do not reintroduce generic file writes as the memory sink.

### `src/config/zod-schema.ts`

- Classification: safe adopt with guardrails.
- Pull upstream config validation changes that are backend-agnostic.
- Reject anything that weakens MongoDB-first validation or broadens non-Mongo memory behavior in user-facing config flows.

### `src/gateway/server-methods/chat.ts`

- Classification: Mongo conflict.
- Upstream chat and gateway improvements are worth taking.
- Preserve direct MongoDB conversation persistence and do not regress to transcript-first memory freshness.

### `src/memory/search-manager.ts`

- Classification: Mongo conflict.
- Keep any interface or query-shaping improvements from upstream.
- Preserve the ClawMongo rule that runtime search reads MongoDB directly and never depends on manager sync before answering.

## Candidate Upstream Ideas in This Wave

- Post-compaction transcript updates.
- Post-compaction memory sync concepts, but re-expressed as MongoDB-native event and projection behavior.
- `sessions_yield` for cleaner cooperative turn endings.
- `sessionKey` plumbing across context-engine seams.
- Final assistant snapshot preservation before `end_turn`.

## Likely Irrelevant Upstream Changes

- Backend-specific memory fixes tied to QMD or SQLite behavior.
- Packaging or compatibility work that only exists to keep alternate memory stacks healthy.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 1 is only complete when:

- the range `v2026.3.11...v2026.3.12` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- live MongoDB memory tests passed against the local Docker fullstack
- the release notes call out both upstream adoption and the MongoDB-first preservation decisions
