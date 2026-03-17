# Upstream Sync Wave 14

## Scope

- Range: `680eff63fb...2580b81bd2`
- Why this wave next: it keeps the sync moving with another small 6-commit range that does not touch protected MongoDB-first seams.
- Goal: absorb plugin/channel capability refactors and onboarding-auth cleanup while leaving MongoDB memory ownership unchanged.

## Protected Hotspots

- No protected MongoDB-first hotspots changed in this range.

## Candidate Upstream Ideas in This Wave

- Push more channel capability diagnostics into plugin-owned surfaces.
- Consolidate provider onboarding auth flow closer to plugin runtime boundaries.
- Reduce core coupling around channel messaging hooks.

## Likely Irrelevant Upstream Changes

- Onboard docs wording churn.
- Windows smoke-test stabilization that does not change runtime memory/backend behavior.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 14 is only complete when:

- the range `680eff63fb...2580b81bd2` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
