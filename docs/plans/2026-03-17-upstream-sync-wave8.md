# Upstream Sync Wave 8

## Scope

- Range: `dd40741e18...cbb8c43f60`
- Why this wave next: it pulls in the setup-wizard and provider-plugin migration train while leaving the protected MongoDB-first seams untouched in this range.
- Goal: absorb upstream plugin/runtime decoupling and onboarding movement without widening the memory/backend conflict surface.

## Protected Hotspots

- None changed in this wave's range.
- Keep a post-merge check on runtime memory seams anyway because upstream plugin/runtime movement can still create indirect pressure on session startup and delivery paths.

## Candidate Upstream Ideas in This Wave

- Bundled provider runtimes moving behind plugin hooks.
- Setup wizard expansion and onboarding decoupling.
- Better plugin end-to-end bundling coverage.

## Likely Irrelevant Upstream Changes

- Onboarding wording and wizard UX shifts that do not affect MongoDB memory ownership.
- Provider packaging mechanics that do not intersect with runtime memory storage.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 8 is only complete when:

- the range `dd40741e18...cbb8c43f60` is merged onto a clean branch
- the tree stays clean after pruning excluded backend paths
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
