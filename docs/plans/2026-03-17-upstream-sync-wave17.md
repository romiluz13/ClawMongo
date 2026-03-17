# Upstream Sync Wave 17

## Scope

- Range: `0a6f22a694...c4b18ab3c9`
- Why this wave next: it reduces the remaining gap with a 6-commit slice that does not touch any protected MongoDB-first seams.
- Goal: absorb status/config/security lazy-load improvements while keeping MongoDB runtime memory behavior unchanged.

## Protected Hotspots

- No protected MongoDB-first hotspots changed in this range.

## Candidate Upstream Ideas in This Wave

- Lazy-load heavy status helpers to keep command startup lighter.
- Keep native command defaults off expensive channel registry paths.
- Split security audit runtime surfaces for lower routine overhead.

## Likely Irrelevant Upstream Changes

- Internal status/audit refactors that do not affect memory/backend ownership.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 17 is only complete when:

- the range `0a6f22a694...c4b18ab3c9` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
