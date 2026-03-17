# Upstream Sync Wave 37

- Base: `6c866b8543` (`v2026.3.13-1`)
- Target: `38a6415a70` (`v2026.3.13-1`)
- Scope: 46 upstream commits

## Why this wave

This is a safe medium batch. The sync report flags only one protected
MongoDB-first hotspot:

- `package.json` for release/dependency/export surface review.

The rest of the range is concentrated in plugin/setup/runtime cleanup,
channel/runtime refactors, and shared test-helper extraction. That makes it a
good candidate for a faster batch without reopening memory/backend ownership.

## Protected MongoDB-first hotspots

- `package.json`
  - Review plugin-SDK export, dependency, and release-surface changes only.
  - Do not accept alternate memory/backend surfaces.

## Candidate idea-port review

- `da9e0b658d` `refactor(outbound): share base session helpers`
  - Accept the refactor if it stays backend-agnostic.
  - Reject any shift that weakens MongoDB as the canonical conversation-memory
    write path.

## Expected upstream themes

- Plugin SDK boundary cleanup
- Shared setup wizard and channel setup helpers
- Agent/runtime seam cleanup
- Outbound/session helper deduplication
- Channel/runtime helper routing
- Dynamic import boundary tightening

## MongoDB-first merge policy

- Accept upstream setup/plugin/runtime cleanup directly unless it changes memory
  truth, which this range should not.
- Keep MongoDB as the only canonical memory/backend system.
- Preserve ClawMongo compatibility fixes when refactors reopen runtime, plugin,
  or test seam regressions.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/openai-ws-connection.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/plugins/provider-runtime.test.ts src/plugins/loader.test.ts src/cli/channel-options.test.ts src/plugins/contracts/wizard.contract.test.ts src/plugins/contracts/catalog.contract.test.ts extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts extensions/whatsapp/src/setup-surface.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
