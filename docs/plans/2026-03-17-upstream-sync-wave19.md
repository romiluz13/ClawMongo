# Upstream Sync Wave 19

## Scope

- Range: `ed82c7e57b...4ab016a9bd`
- Why this wave next: it is a bounded 5-commit hop with no protected MongoDB-first hotspots.
- Goal: absorb gateway loopback/auth and bonjour recovery fixes plus associated coverage without changing MongoDB memory ownership.

## Protected Hotspots

- No protected MongoDB-first hotspots changed in this range.

## Candidate Upstream Ideas in This Wave

- Preserve loopback gateway scopes more reliably for local auth.
- Recover bonjour advertiser from ciao announce loops.
- Tighten plugin capability coverage while leaving runtime memory semantics alone.

## Likely Irrelevant Upstream Changes

- Test-only Feishu and plugin capability adjustments.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 19 is only complete when:

- the range `ed82c7e57b...4ab016a9bd` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
