# Upstream Sync Wave 27

## Scope

- Range: `94a01c9789...776e5d8a08`
- Why this wave next: the range is small, the protected runner files only change import boundaries again, and no excluded backend paths are touched.
- Goal: absorb the next plugin-sdk seam cleanup and lazy channel runtime setup work without changing MongoDB memory ownership or runtime freshness.

## Protected Hotspots

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: safe adopt with review.
- Upstream switches helper imports from `plugin-sdk/*` to `plugin-sdk-internal/*`.
- No event-write or transcript-persistence behavior changes.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: safe adopt with review.
- Same import-boundary move as `compact.ts`.
- No change to MongoDB canonical memory writes.

## Candidate Upstream Ideas in This Wave

- Keep plugin-sdk public surfaces smaller and move internal helper access behind explicit internal entrypoints.
- Lazy-resolve channel runtime without widening public plugin-sdk contracts.

## Likely Irrelevant Upstream Changes

- Docs and skill metadata adjustments that do not affect MongoDB-backed runtime memory.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/index.test.ts src/infra/gaxios-fetch-compat.test.ts src/plugin-sdk/index.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/infra/outbound/targets.test.ts src/infra/outbound/channel-adapters.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/auto-reply/reply/commands-session-lifecycle.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts src/plugins/providers.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/contracts/provider.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/web-search-provider.contract.test.ts src/plugins/contracts/auth.contract.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/discovery.contract.test.ts src/plugins/contracts/wizard.contract.test.ts src/commands/doctor-browser.test.ts src/infra/bonjour.test.ts extensions/discord/src/channel.test.ts extensions/amazon-bedrock/index.test.ts --reporter=verbose`
- `pnpm vitest run src/plugins/contracts/catalog.contract.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 27 is only complete when:

- the range `94a01c9789...776e5d8a08` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
