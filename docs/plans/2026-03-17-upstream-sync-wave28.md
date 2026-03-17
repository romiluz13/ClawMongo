# Upstream Sync Wave 28

- Base: `776e5d8a08` (`v2026.3.13-1`)
- Target: `898d6840dc` (`v2026.3.13-1`)
- Scope: 21 upstream commits

## Why this wave

This range is a good medium-size batch. Most of the work is runtime lazy-loading,
channel contract coverage, docs, and extension test tooling. The MongoDB-first
surface is only touched in two protected files.

## Protected MongoDB-first hotspots

- `package.json`
  - Safe if we keep the ClawMongo package identity intact and absorb only the
    additive test/docs packaging changes.
  - Keep the existing direct `gaxios` dependency we already added locally.
- `src/config/zod-schema.ts`
  - Safe if merged as-is.
  - The upstream rename from `InstallRecordShape` to `PluginInstallRecordShape`
    is plugin-install schema plumbing, not a memory/backend change.

## Expected upstream themes

- Lazy-load Telegram, Slack, and Discord channel ops
- Channel contract centralization and broader contract coverage
- Extension test runner and changed-extension detection
- Marketplace/plugin install docs and packaging trims

## MongoDB-first merge policy

- Accept upstream runtime/channel/tooling improvements directly.
- Keep MongoDB as the only canonical memory/backend truth.
- Ignore any non-Mongo backend implications unless they introduce a reusable
  idea that we intentionally re-express later.

## Validation gate

- `pnpm build`
- `pnpm test -- src/index.test.ts src/infra/gaxios-fetch-compat.test.ts src/plugin-sdk/index.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/infra/outbound/targets.test.ts src/infra/outbound/channel-adapters.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/auto-reply/reply/commands-session-lifecycle.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts src/plugins/providers.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/contracts/provider.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/web-search-provider.contract.test.ts src/plugins/contracts/auth.contract.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/discovery.contract.test.ts src/plugins/contracts/wizard.contract.test.ts src/commands/doctor-browser.test.ts src/infra/bonjour.test.ts extensions/discord/src/channel.test.ts extensions/amazon-bedrock/index.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
