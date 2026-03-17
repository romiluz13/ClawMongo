# Upstream Sync Wave 11

## Scope

- Range: `0feb939cb3...0277aa0159`
- Why this wave next: it clears the remaining shared-interactive follow-up train in one bounded hop without touching protected MongoDB-first seams.
- Goal: absorb the upstream shared-interactive rendering and message-action refinements while keeping MongoDB memory ownership unchanged.

## Protected Hotspots

- No protected MongoDB-first hotspots changed in this range.

## Candidate Upstream Ideas in This Wave

- Shared interactive rendering across channel plugins.
- Message action capability plumbing that broadens channel support without changing backend truth.
- Slack interactive registration cleanup that matches the local Wave 10 fixes.

## Likely Irrelevant Upstream Changes

- Channel-specific renderer/test adjustments that do not alter memory/backend behavior.
- Matrix outbound optional-handler guards.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/bundled-runtime-deps.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 11 is only complete when:

- the range `0feb939cb3...0277aa0159` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
