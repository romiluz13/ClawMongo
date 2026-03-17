# Upstream Sync Wave 29

- Base: `898d6840dc` (`v2026.3.13-1`)
- Target: `55253e2a9d` (`v2026.3.13-1`)
- Scope: 35 upstream commits

## Why this wave

This is another medium-size batch with mostly plugin/runtime ergonomics, test
tooling, setup subpaths, and channel/runtime hardening. The protected MongoDB
surface only moves in `package.json`, and the change is additive plugin-sdk
exports rather than a backend contract shift.

## Protected MongoDB-first hotspots

- `package.json`
  - Accept the new plugin-sdk setup/sandbox subpath exports.
  - Preserve ClawMongo package identity and keep the direct `gaxios` dependency
    pin we already rely on.

## Expected upstream themes

- Provider/runtime laziness and avoiding unnecessary bundled boots
- Plugin SDK setup/sandbox subpaths and entrypoint metadata refresh
- Channel parsing without plugin registry and Telegram/Slack hardening
- Secrets/runtime env handling and test harness cleanup

## MongoDB-first merge policy

- Take upstream runtime/plugin improvements directly when they do not redefine
  memory truth.
- Keep MongoDB as the only canonical memory/backend layer.
- Treat provider/runtime performance improvements as good upstream ideas we
  absorb unless they conflict with MongoDB ownership, which this range does not.

## Validation gate

- `pnpm build`
- `pnpm test -- src/index.test.ts src/infra/gaxios-fetch-compat.test.ts src/plugin-sdk/index.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/infra/outbound/targets.test.ts src/infra/outbound/channel-adapters.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/auto-reply/reply/session-delivery.test.ts src/auto-reply/reply/commands-session-lifecycle.test.ts src/cli/program/register.onboard.test.ts src/commands/auth-choice-options.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/provider-auth-choices.test.ts src/plugins/manifest-registry.test.ts src/plugins/providers.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/contracts/provider.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/web-search-provider.contract.test.ts src/plugins/contracts/auth.contract.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/discovery.contract.test.ts src/plugins/contracts/wizard.contract.test.ts src/commands/doctor-browser.test.ts src/infra/bonjour.test.ts extensions/discord/src/channel.test.ts extensions/amazon-bedrock/index.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
