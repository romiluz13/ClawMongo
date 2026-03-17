# Upstream Sync Wave 15

## Scope

- Range: `2580b81bd2...7bea559166`
- Why this wave next: it limits the next protected review to one outbound seam while absorbing the shared interactive refactor train in a small 3-commit hop.
- Goal: take upstream interactive payload/refactor improvements without altering MongoDB memory truth or outbound persistence semantics.

## Protected Hotspots

### `src/infra/outbound/deliver.ts`

- Classification: safe adopt with review.
- Upstream centralizes reply-content checks via shared payload helpers.
- Preserve mirror/session write behavior and keep MongoDB-backed runtime truth untouched.

## Candidate Upstream Ideas in This Wave

- Shared interactive dispatch adapters.
- Unified reply-content checks across auto-reply and outbound delivery.
- Cleaner Slack block-action separation.

## Likely Irrelevant Upstream Changes

- Shared interactive refactors that do not interact with memory/backend ownership.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/interactive.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 15 is only complete when:

- the range `2580b81bd2...7bea559166` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
