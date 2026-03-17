# Upstream Sync Wave 34

- Base: `763eff8b32` (`v2026.3.13-1`)
- Target: `6a27db0cd7` (`v2026.3.13-1`)
- Scope: 40 upstream commits

## Why this wave

This range is still acceptable as a larger batch after review. The sync report
flags only two protected MongoDB-first hotspots, and both are safe:

- `package.json` adds new plugin-SDK subpath exports.
- `src/agents/pi-embedded-runner/run/attempt.ts` only updates the Kimi provider
  id used by malformed tool-call argument repair.

The rest of the range stays in the plugin/setup/runtime refactor stream:
shared setup bases, patched account adapters, media-understanding provider
registration, TTS/provider metadata expansion, and channel runtime cleanup.

## Protected MongoDB-first hotspots

- `package.json`
  - Safe plugin-SDK export expansion only.
  - No memory/backend ownership changes.
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - Safe provider rename from `kimi-coding` to `kimi`.
  - No runtime write-path behavior change for MongoDB memory ownership.

## Expected upstream themes

- Shared setup SDK subpaths and setup-base reuse
- Media-understanding provider runtime expansion
- TTS/provider metadata growth
- Shared channel plugin base config refactors
- Outbound thread-id normalization
- Kimi provider canonicalization

## MongoDB-first merge policy

- Accept upstream setup/plugin/runtime refactors directly unless they introduce
  alternate memory truth, which this range does not.
- Keep MongoDB as the only canonical memory/backend truth.
- Preserve ClawMongo fixes when setup/runtime refactors create cycle or import
  regressions, but otherwise stay close to upstream.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/plugin-sdk/index.test.ts src/plugins/provider-runtime.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/loader.test.ts src/plugins/stage-bundled-plugin-runtime.test.ts src/infra/outbound/thread-id.test.ts src/tts/tts.test.ts extensions/discord/src/channel.test.ts extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts extensions/imessage/src/channel.outbound.test.ts extensions/imessage/src/probe.test.ts extensions/whatsapp/src/setup-surface.test.ts extensions/signal/src/setup-allow-from.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
