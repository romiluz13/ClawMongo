# Upstream Sync Wave 4

## Scope

- Range: `d9c285e930...6a458ef29e`
- Why this wave next: it is a bounded 56-commit slice where the protected MongoDB seams are narrow. Most of the wave is platform, provider, UI, and plugin work, while the Mongo-sensitive changes are concentrated in compaction/runtime safety and config validation.
- Goal: absorb the next post-Wave-3 cluster while preserving direct MongoDB runtime truth and keeping compaction behavior Mongo-native.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with guardrails.
- Take upstream dependency and packaging updates that are backend-agnostic.
- Preserve ClawMongo package identity and do not reintroduce non-Mongo memory dependencies.

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: Mongo conflict with idea-port value.
- Upstream adds compaction timeout configuration and follow-up hardening.
- Accept the lifecycle and safety improvements, but preserve the rule that durable memory remains MongoDB-only and does not flush to Markdown memory files.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: Mongo conflict.
- Accept runner improvements that affect the turn lifecycle and failover correctness.
- Preserve direct MongoDB event persistence as the canonical runtime write path.

### `src/config/zod-schema.ts`

- Classification: safe adopt with guardrails.
- Pull backend-agnostic config validation updates.
- Reject anything that weakens MongoDB-first configuration or expands alternate memory assumptions.

## Candidate Upstream Ideas in This Wave

- Configurable compaction timeout behavior.
- Hardening of compaction follow-up behavior after timeout conditions.
- Startup and warmup reductions that improve baseline agent runtime cost without changing memory ownership.

## Likely Irrelevant Upstream Changes

- UI, Android, and channel-specific features that do not touch protected seams.
- Packaging or documentation changes that do not affect runtime architecture.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 4 is only complete when:

- the range `d9c285e930...6a458ef29e` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
