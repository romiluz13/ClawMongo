# Upstream Sync Wave 9

## Scope

- Range: `cbb8c43f60...3d8c29cc53`
- Why this wave next: it continues the plugin/setup-wizard migration and lands the LanceDB unbundle change before the later outbound interactive payload work starts touching more runtime seams.
- Goal: absorb the remaining low-risk plugin/runtime cleanup while preserving MongoDB-first memory behavior and ClawMongo packaging boundaries.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with review.
- Accept plugin-sdk export checks and packaging/build script updates.
- Keep ClawMongo package identity and do not reintroduce non-Mongo memory defaults.

### `src/agents/pi-tools.ts`

- Classification: safe adopt with guardrails.
- Accept sandbox backend plumbing needed by upstream runtime evolution.
- Preserve MongoDB-first memory tool exposure and runtime-write behavior.

### `src/config/validation.ts`

- Classification: safe adopt.
- Accept legacy plugin-id cleanup as long as it does not weaken MongoDB-first config validation.

## Candidate Upstream Ideas in This Wave

- Leaner plugin-sdk export discipline.
- Cleaner setup-surface ownership across channels/plugins.
- Packaging cleanup that reduces accidental LanceDB coupling in published artifacts.

## Likely Irrelevant Upstream Changes

- Setup wizard wording and adapter reshuffles that do not intersect with memory/backend truth.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 9 is only complete when:

- the range `cbb8c43f60...3d8c29cc53` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
