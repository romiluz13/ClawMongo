# Upstream Sync Wave 22

## Scope

- Range: `c7137270d1...ae60094fb5`
- Why this wave next: the sync report shows no protected MongoDB-first hotspots and no excluded backend paths in this 16-commit range.
- Goal: absorb upstream channel and plugin contract coverage, plus session-route preservation and onboarding manifest cleanup, without changing MongoDB memory truth.

## Protected Hotspots

- No protected MongoDB-first seams changed in this range.

## Candidate Upstream Ideas in This Wave

- Keep expanding contract-style coverage around channels and plugins so future upstream syncs stay safer.
- Preserve external channel routes when a webchat view opens a session, as long as runtime persistence remains MongoDB-native.
- Let plugin manifests own more onboarding auth metadata without changing backend truth boundaries.

## Likely Irrelevant Upstream Changes

- Test helper and contract reshaping that does not affect memory ownership or runtime persistence.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 22 is only complete when:

- the range `c7137270d1...ae60094fb5` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
