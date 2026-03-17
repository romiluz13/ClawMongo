# Upstream Sync Wave 26

## Scope

- Range: `7a09255361...94a01c9789`
- Why this wave next: the range is small and the only protected MongoDB-first files touched are import-boundary updates in the embedded runner, not changes to the runtime event-write contract itself.
- Goal: absorb the plugin-sdk channel seam cleanup and the Node.js 25 gaxios compatibility fixes without weakening MongoDB as canonical runtime memory truth.

## Protected Hotspots

### `src/agents/pi-embedded-runner/compact.ts`

- Classification: safe adopt with review.
- Upstream replaces direct extension imports with `src/plugin-sdk/*` imports for reaction/button helpers.
- No runtime write semantics changed.

### `src/agents/pi-embedded-runner/run/attempt.ts`

- Classification: safe adopt with review.
- Same seam adjustment as `compact.ts`: plugin-sdk import routing only.
- No change to canonical MongoDB event writes or transcript persistence.

## Candidate Upstream Ideas in This Wave

- Keep channel capability helpers flowing through plugin-sdk seams instead of reaching directly into extensions.
- Keep Node.js 25 gaxios compatibility fixes localized to entry surfaces instead of leaking package-root side effects.

## Likely Irrelevant Upstream Changes

- None significant in this bounded range.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/index.test.ts src/infra/gaxios-fetch-compat.test.ts src/plugin-sdk/index.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/infra/outbound/targets.test.ts src/infra/outbound/channel-adapters.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/auto-reply/reply/commands-session-lifecycle.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts src/plugins/providers.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/contracts/provider.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/web-search-provider.contract.test.ts src/plugins/contracts/auth.contract.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/discovery.contract.test.ts src/plugins/contracts/wizard.contract.test.ts src/commands/doctor-browser.test.ts src/infra/bonjour.test.ts extensions/discord/src/channel.test.ts --reporter=verbose`
- `pnpm vitest run src/plugins/contracts/catalog.contract.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 26 is only complete when:

- the range `7a09255361...94a01c9789` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
