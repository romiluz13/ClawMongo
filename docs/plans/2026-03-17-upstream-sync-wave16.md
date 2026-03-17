# Upstream Sync Wave 16

## Scope

- Range: `7bea559166...0a6f22a694`
- Why this wave next: it is a compact 5-commit hop with only one protected seam, and that seam is a safe release/tooling addition in `package.json`.
- Goal: absorb the remaining interactive mapper cleanup and tooling/docs updates without touching MongoDB memory ownership.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with review.
- Upstream adds a `land:gate` convenience script for release-quality validation.
- Preserve ClawMongo package identity and keep excluded backend dependencies out.

## Candidate Upstream Ideas in This Wave

- Cleaner Discord and Telegram shared interactive helpers.
- A one-command land gate for full validation parity.

## Likely Irrelevant Upstream Changes

- Config-baseline docs sync.
- Setup smoke test maintenance.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/interactive.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 16 is only complete when:

- the range `7bea559166...0a6f22a694` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
