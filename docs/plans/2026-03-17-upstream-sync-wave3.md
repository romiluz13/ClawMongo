# Upstream Sync Wave 3

## Scope

- Range: `v2026.3.13-1...d9c285e930`
- Why this wave next: it is a bounded 37-commit slice that clusters around outbound and plugin-runtime refactors without reopening the deeper post-tag backlog all at once.
- Goal: absorb the first post-`v2026.3.13-1` upstream cluster while preserving the MongoDB-first runtime memory contract.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with guardrails.
- Take upstream dependency, runtime, and packaging updates that stay backend-agnostic.
- Preserve ClawMongo package identity, fork-specific scripts, and the rule that we do not add non-Mongo memory runtime dependencies back into the fork.

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: Mongo conflict.
- Adopt upstream compaction and runner safety fixes where they improve session correctness.
- Preserve the rule that durable memory writes remain MongoDB-only and never fall back to Markdown memory files.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: Mongo conflict.
- Accept runner lifecycle and tool-flow improvements from upstream.
- Keep direct MongoDB event persistence in the live runtime path.

### `src/gateway/server-methods/chat.ts`

- Classification: Mongo conflict.
- Take gateway fixes that improve request flow or channel behavior.
- Preserve MongoDB-first conversation persistence and do not reintroduce transcript-first freshness.

### `src/infra/outbound/deliver.ts`

- Classification: Mongo conflict with broad safe-adopt surface.
- Accept upstream outbound refactors that decouple channel runtime ownership and fix startup behavior.
- Preserve ClawMongo persistence hooks and any runtime write sequencing that supports MongoDB-first recall.

### `src/infra/outbound/outbound-send-service.ts`

- Classification: Mongo conflict with broad safe-adopt surface.
- Take upstream dependency injection and channel-runtime cleanup where it reduces divergence.
- Keep any ClawMongo-specific persistence or transcript coordination needed for MongoDB runtime truth.

## Candidate Upstream Ideas in This Wave

- Dynamic outbound send dependency resolution keyed by channel ID.
- Channel-runtime extraction into extensions where it reduces core divergence and startup cost.
- Startup hardening for outbound send dependency loading.
- UI and bootstrap guidance changes that clarify memory bootstrap expectations, but only as long as they do not make Markdown memory authoritative again.

## Likely Irrelevant Upstream Changes

- Release automation and npm publishing workflow changes that do not affect runtime behavior.
- Backend packaging or support changes whose purpose is to keep alternate memory stacks healthy.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 3 is only complete when:

- the range `v2026.3.13-1...d9c285e930` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- the MongoDB validation gate passed
- release notes separate upstream adoption from MongoDB-first architecture preservation
