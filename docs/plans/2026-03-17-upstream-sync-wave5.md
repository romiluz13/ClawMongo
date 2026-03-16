# Upstream Sync Wave 5

## Scope

- Range: `6a458ef29e...e2dac5d5cb`
- Why this wave next: it is a narrow 45-commit slice with limited MongoDB-sensitive seams. The main protected changes are runtime startup/config hardening and outbound/persistence-adjacent fixes, not a broad memory refactor.
- Goal: absorb the next safe post-Wave-4 cluster while preserving MongoDB as the canonical runtime backend and keeping conversation/event writes direct.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with guardrails.
- Accept backend-agnostic dependency and packaging changes.
- Preserve ClawMongo package identity and do not reintroduce non-Mongo memory dependencies.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: Mongo conflict.
- Accept runner lifecycle and startup improvements that are backend-agnostic.
- Preserve the direct MongoDB runtime write path and session persistence behavior.

### `src/config/validation.ts`

- Classification: safe adopt with guardrails.
- Pull upstream config validation fixes that reduce startup failures.
- Keep MongoDB-first validation intact and reject alternate-memory fallback behavior.

### `src/infra/outbound/deliver.ts`

- Classification: Mongo conflict with broad safe-adopt surface.
- Accept upstream outbound fixes that improve delivery correctness and startup stability.
- Preserve persistence ordering and any hooks that support MongoDB-first runtime recall.

## Candidate Upstream Ideas in This Wave

- Config validation changes that avoid spurious startup failures.
- Startup memory and lazy-load improvements that keep the runtime lean without changing memory ownership.
- Outbound and gateway guard hardening that improves delivery safety.

## Likely Irrelevant Upstream Changes

- Pure changelog and release-note maintenance.
- CLI/provider startup optimizations that do not touch protected seams.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 5 is only complete when:

- the range `6a458ef29e...e2dac5d5cb` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
