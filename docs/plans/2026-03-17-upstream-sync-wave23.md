# Upstream Sync Wave 23

## Scope

- Range: `ae60094fb5...0ca1b18517`
- Why this wave next: this 25-commit range keeps the MongoDB-first risk low, with only one protected seam touched and no excluded backend paths changed.
- Goal: absorb the plugin-owned runtime contract work, channel runtime cleanup, and outbound fallback restoration while preserving MongoDB as the only canonical memory and backend truth.

## Protected Hotspots

### `src/config/zod-schema.ts`

- Classification: safe adopt with review.
- Upstream removes obsolete browser driver options and relay bind-host validation.
- This is configuration cleanup outside the MongoDB memory contract and can be adopted directly.

## Candidate Upstream Ideas in This Wave

- Keep moving runtime/provider test coverage into plugin-owned contracts to reduce future merge ambiguity.
- Preserve built-in outbound fallbacks and gate checks after the channel/plugin runtime seam refactor.

## Likely Irrelevant Upstream Changes

- Docs i18n regeneration.
- Browser-path cleanup that does not affect MongoDB-backed memory or persistence.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts --reporter=verbose`
- `pnpm vitest run src/infra/outbound/targets.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 23 is only complete when:

- the range `ae60094fb5...0ca1b18517` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
