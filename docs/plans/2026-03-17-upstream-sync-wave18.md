# Upstream Sync Wave 18

## Scope

- Range: `c4b18ab3c9...ed82c7e57b`
- Why this wave next: it is another compact 5-commit hop with only a safe `package.json` change in the protected set.
- Goal: absorb provider/status/plugin refinements and Feishu/channel work without changing MongoDB memory ownership.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with review.
- Upstream removes the temporary `land:gate` helper and adds a dedicated OpenShell E2E command.
- Preserve ClawMongo package identity and keep excluded backend dependencies out.

## Candidate Upstream Ideas in This Wave

- More aggressive lazy-loading in status paths.
- Cleaner provider auth-choice metadata handling in plugin surfaces.
- Better Feishu structured interaction coverage.

## Likely Irrelevant Upstream Changes

- Test-only additions around OpenShell and Feishu coverage.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/interactive.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 18 is only complete when:

- the range `c4b18ab3c9...ed82c7e57b` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
