# Upstream Sync Wave 10

## Scope

- Range: `3d8c29cc53...0feb939cb3`
- Why this wave next: it absorbs the shared interactive outbound train while touching only one protected Mongo-first seam.
- Goal: take the upstream outbound/plugin improvements without changing MongoDB memory ownership or runtime write semantics.

## Protected Hotspots

### `src/infra/outbound/deliver.ts`

- Classification: safe adopt with review.
- Accept channel/plugin recovery and shared interactive payload delivery changes.
- Preserve existing ClawMongo mirror/session semantics and agent-scoped media root behavior.

## Candidate Upstream Ideas in This Wave

- Shared interactive payloads across channels.
- Better outbound plugin recovery when registries are lazy or reset.
- Cleaner delivery path for plugin-owned interactive rendering.

## Likely Irrelevant Upstream Changes

- Channel-specific interactive renderers that do not affect memory/backend truth.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/bundled-runtime-deps.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 10 is only complete when:

- the range `3d8c29cc53...0feb939cb3` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
