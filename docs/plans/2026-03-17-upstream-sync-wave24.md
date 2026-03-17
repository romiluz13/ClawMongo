# Upstream Sync Wave 24

## Scope

- Range: `0ca1b18517...bbf3b4acf2`
- Why this wave next: this 14-commit range is compact, plugin-focused, and only touches one protected seam after the plugin-sdk entrypoint guardrail was fixed locally.
- Goal: absorb the remaining plugin-owned channel seam cleanup, provider catalog/auth contract work, and the new routing subpath export without changing MongoDB memory ownership.

## Protected Hotspots

### `package.json`

- Classification: safe adopt with review.
- Upstream adds the `./plugin-sdk/routing` export only.
- ClawMongo keeps the upstream export while locally filtering the removed `memory-lancedb` entrypoint from generated package exports and build artifacts.

## Candidate Upstream Ideas in This Wave

- Keep moving provider contract coverage into plugin-owned registries and auth boundaries.
- Finish shared routing imports through plugin-sdk seams so channel/plugin ownership stays explicit.

## Likely Irrelevant Upstream Changes

- Test-only provider contract expansions that do not alter MongoDB-backed runtime persistence.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugin-sdk/index.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/infra/outbound/targets.test.ts src/infra/outbound/channel-adapters.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/contracts/provider.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/web-search-provider.contract.test.ts src/commands/doctor-browser.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 24 is only complete when:

- the range `0ca1b18517...bbf3b4acf2` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
