# Upstream Sync Wave 33

- Base: `8a10903cf7` (`v2026.3.13-1`)
- Target: `763eff8b32` (`v2026.3.13-1`)
- Scope: 23 upstream commits

## Why this wave

This range is still batchable after review. The sync report shows only one
protected MongoDB-first hotspot, `package.json`, and that change is safe: the
`gaxios` dependency stays pinned to the exact version already required by the
fork. The rest of the range is plugin/runtime refactoring, onboarding
extraction, speech provider ownership, channel runtime cleanup, and test/doc
expansion that does not compete with MongoDB memory truth.

## Protected MongoDB-first hotspots

- `package.json`
  - Safe exact-version pin for `gaxios`.
  - No memory/backend ownership changes.

## Expected upstream themes

- Provider and gateway onboarding moved into extensions
- Speech/TTS provider registration and richer metadata
- Shared setup/runtime helpers for channels and bundled plugins
- Context overflow detection improvements
- Plugin registry and runtime ownership expansion
- Channel/plugin contract and live-test coverage growth

## MongoDB-first merge policy

- Accept upstream onboarding/plugin refactors directly unless they reintroduce
  alternate memory truth, which this range does not.
- Keep MongoDB as the only canonical memory/backend truth.
- Treat context-overflow changes as agent/runtime improvements only; do not let
  them alter MongoDB memory writes or retrieval boundaries.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/plugins/contracts/registry.contract.test.ts src/plugins/loader.test.ts src/plugins/stage-bundled-plugin-runtime.test.ts src/plugin-sdk/index.test.ts src/gateway/server-plugins.test.ts src/agents/auth-profiles.external-cli-sync.test.ts src/auto-reply/reply/tool-result-context-guard.test.ts src/infra/gaxios-fetch-compat.test.ts src/tts/tts.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
