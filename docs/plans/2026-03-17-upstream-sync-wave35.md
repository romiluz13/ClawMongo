# Upstream Sync Wave 35

- Base: `6a27db0cd7` (`v2026.3.13-1`)
- Target: `68d2bd27c9` (`v2026.3.13-1`)
- Scope: 24 upstream commits

## Why this wave

This is a safe medium batch. The sync report flags four protected MongoDB-first
hotspots, and all four stay within shared runtime/provider/config seams rather
than changing memory ownership:

- `package.json` continues the plugin-SDK boundary cleanup.
- `src/agents/pi-embedded-runner/compact.ts` and
  `src/agents/pi-embedded-runner/run/attempt.ts` pick up bundled MCP tooling and
  provider attribution work.
- `src/config/zod-schema.ts` reflects upstream config surface changes, not
  alternate backend behavior.

The rest of the range stays in the plugin/provider refactor train: shared auth
helpers, public plugin-SDK seam cleanup, bundled web-search capability, native
command alias validation, and setup/test harness hardening.

## Protected MongoDB-first hotspots

- `package.json`
  - Review plugin-SDK export changes only.
  - Do not accept any alternate memory/backend surfaces.
- `src/agents/pi-embedded-runner/compact.ts`
  - Accept embedded Pi/runtime improvements.
  - Preserve MongoDB-first memory flush ownership.
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - Accept bundled MCP/provider attribution changes.
  - Preserve canonical MongoDB runtime write behavior.
- `src/config/zod-schema.ts`
  - Accept config validation updates unless they weaken MongoDB-first settings.

## Expected upstream themes

- Shared provider auth/model/catalog refactors
- Bundled MCP tool runtime support
- Provider attribution metadata
- Plugin web-search capability support
- Native command alias conflict validation
- Channel/setup seam cleanup and test fixes

## MongoDB-first merge policy

- Accept upstream runtime/plugin/provider improvements directly when they do not
  redefine memory truth.
- Keep MongoDB as the only canonical memory/backend system.
- If upstream setup/runtime seam changes break extension boundaries, restore the
  boundary in the smallest possible compatibility fix without reopening
  alternate backends.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/plugin-sdk/index.test.ts src/plugins/provider-runtime.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/loader.test.ts src/plugins/stage-bundled-plugin-runtime.test.ts src/infra/outbound/thread-id.test.ts src/tts/tts.test.ts extensions/discord/src/channel.test.ts extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts extensions/imessage/src/channel.outbound.test.ts extensions/imessage/src/probe.test.ts extensions/whatsapp/src/setup-surface.test.ts extensions/signal/src/setup-allow-from.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
