# Upstream Sync Wave 21

## Scope

- Range: `d5b12f505c...c7137270d1`
- Why this wave next: it is only 2 commits, and the single protected seam is narrow enough to review directly.
- Goal: absorb plugin-owned outbound/channel seam refactors and security runtime splitting without changing MongoDB memory truth.

## Protected Hotspots

### `src/infra/outbound/deliver.ts`

- Classification: safe adopt with review.
- Upstream moves more formatting/media behavior behind channel/plugin adapters.
- Preserve mirror/session write behavior and MongoDB-backed runtime truth untouched.

## Candidate Upstream Ideas in This Wave

- Let channel plugins own more of their outbound formatting behavior.
- Split security audit runtime surfaces for lighter command paths.

## Likely Irrelevant Upstream Changes

- Test utility and channel helper reshaping that does not alter memory/backend ownership.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 21 is only complete when:

- the range `d5b12f505c...c7137270d1` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
