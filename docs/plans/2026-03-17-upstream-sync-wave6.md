# Upstream Sync Wave 6

## Scope

- Range: `e2dac5d5cb...4a0f72866b`
- Why this wave next: it is a very small 19-commit slice with only two protected MongoDB-sensitive seams. Most of the wave is plugin/runtime packaging and startup hardening.
- Goal: absorb the provider-runtime bundling slice while preserving MongoDB-first runtime behavior and keeping compaction semantics intact.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with guardrails.
- Accept backend-agnostic dependency and packaging updates.
- Preserve ClawMongo package identity and MongoDB-first dependency boundaries.

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: Mongo conflict with low expected pressure.
- Accept upstream runtime/packaging-related adjustments around compaction only when they do not alter the MongoDB durability contract.
- Preserve the rule that durable memory stays in MongoDB rather than drifting back into Markdown writes.

## Candidate Upstream Ideas in This Wave

- Runtime packaging and plugin-bundling hardening that reduce startup failures and low-memory regressions.
- Context engine ownership cleanup that lowers cross-runtime ambiguity without changing memory ownership.

## Likely Irrelevant Upstream Changes

- Release-process documentation moves.
- Marketplace or plugin asset maintenance that does not touch the Mongo runtime contract.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 6 is only complete when:

- the range `e2dac5d5cb...4a0f72866b` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
