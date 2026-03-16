# Upstream Sync Wave 7

## Scope

- Range: `4a0f72866b...dd40741e18`
- Why this wave next: it is a very small 5-commit hop that advances plugin bundling/onboarding ownership without materially increasing MongoDB merge risk.
- Goal: absorb the compatible bundle setup slice while preserving MongoDB-first runtime behavior.

## Protected Hotspots

### `src/config/validation.ts`

- Classification: safe adopt with guardrails.
- Accept backend-agnostic validation changes.
- Preserve MongoDB-first validation and reject any alternate-memory fallback behavior.

## Candidate Upstream Ideas in This Wave

- Better plugin bundle packaging and onboarding ownership boundaries.
- Broader plugin surface cleanup that reduces core/runtime coupling.

## Likely Irrelevant Upstream Changes

- Channel onboarding movement that does not affect MongoDB memory semantics directly.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 7 is only complete when:

- the range `4a0f72866b...dd40741e18` is merged onto a clean branch
- all protected hotspots above were reviewed explicitly
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
