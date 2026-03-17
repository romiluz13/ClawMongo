# Upstream Sync Wave 32

- Base: `eeb140b4f0` (`v2026.3.13-1`)
- Target: `8a10903cf7` (`v2026.3.13-1`)
- Scope: 17 upstream commits

## Why this wave

This range is safe to batch. The sync report shows no protected MongoDB-first
hotspots and no excluded backend paths. The work is concentrated in plugin
catalog migration, setup-surface refactors, test coverage, docs, and UI/runtime
cleanup that does not compete with MongoDB memory ownership.

## Protected MongoDB-first hotspots

- None in this range.

## Expected upstream themes

- Compaction/tool-result cleanup
- Launcher startup regression fix
- Provider catalog migration into extensions
- Shared setup-surface and account helpers for bundled channels
- Expanded plugin/channel contract coverage
- UI chat lifecycle and streaming polish

## MongoDB-first merge policy

- Accept upstream changes directly unless they introduce a non-Mongo memory
  truth path, which this range does not.
- Treat the compaction fixes as prompt/runtime hygiene only; do not let them
  weaken the MongoDB-only memory contract.
- Keep watching plugin/runtime refactors for indirect effects on setup and
  channel loading, but preserve them unless they cross the memory boundary.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/wizard.contract.test.ts src/plugins/contracts/registry.contract.test.ts src/channels/plugins/contracts/session-binding.contract.test.ts src/channels/plugins/contracts/threading.contract.test.ts src/channels/plugins/contracts/directory.contract.test.ts src/infra/gaxios-fetch-compat.test.ts src/plugins/stage-bundled-plugin-runtime.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
