# Upstream Sync Wave 31

- Base: `1f1a93a1dc` (`v2026.3.13-1`)
- Target: `eeb140b4f0` (`v2026.3.13-1`)
- Scope: 18 upstream commits

## Why this wave

This range is still batchable after review. The protected MongoDB-first files are
only touched for late-bound gateway subagent plumbing and one package export
cleanup. There is no competing memory/backend behavior in this range.

## Protected MongoDB-first hotspots

- `package.json`
  - Safe removal of the old public `./extension-api` export.
- `src/agents/pi-embedded-runner/compact.ts`
- `src/agents/pi-embedded-runner/run/attempt.ts`
- `src/agents/pi-tools.ts`
- `src/gateway/tools-invoke-http.ts`
  - All changes are the same late-bound flag propagation:
    `allowGatewaySubagentBinding`.
  - This affects runtime plugin loading shape, not MongoDB memory ownership.

## Expected upstream themes

- Preserve all skills in prompt via compact fallback
- Gateway startup/test cleanup
- Status startup perf improvements
- Staged bundled runtime tree and late-bound subagent runtime for non-gateway loads
- Browser-safe logging and UI fixes

## MongoDB-first merge policy

- Accept upstream runtime/plugin startup improvements directly.
- Keep MongoDB as the only canonical memory/backend truth.
- Treat gateway subagent binding changes as safe unless they alter runtime memory
  writes, which this range does not.

## Validation gate

- `pnpm build`
- `pnpm test -- src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts src/commands/doctor-browser.test.ts src/gateway/server-plugins.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
