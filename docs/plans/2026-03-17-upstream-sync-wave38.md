# Upstream Sync Wave 38

- Base: `bbdbd52f36` (`v2026.3.13-1`)
- Target: `9053f551cb` (`v2026.3.13-1`)
- Scope: 44 upstream commits

## Why this wave

This is the remaining upstream tail. It is small enough to finish in one final
guarded pass, but it still touches a few protected MongoDB-first seams and some
excluded non-Mongo memory paths.

## Protected MongoDB-first hotspots

- `package.json`
  - Review export, dependency, and release-surface changes only.
  - Do not accept alternate memory/backend surfaces.
- `src/agents/pi-embedded-runner/run/attempt.ts`
  - Preserve MongoDB-first runtime write semantics.
  - Accept upstream runner cleanup only if it does not weaken canonical event
    writes or reintroduce transcript-sync dependence.
- `src/agents/system-prompt.ts`
  - Preserve MongoDB-first memory/tool routing and Markdown bridge boundaries.
  - Accept upstream prompt cleanup only if runtime memory truth remains MongoDB.

## Excluded backend paths

Upstream changes this wave include excluded LanceDB and generic memory files.
Those paths must remain pruned or resolved in favor of ClawMongo’s MongoDB-only
backend policy:

- `extensions/memory-lancedb/index.test.ts`
- `extensions/memory-lancedb/index.ts`
- `src/memory/index.test.ts`
- `src/memory/manager.watcher-config.test.ts`
- `src/plugin-sdk/memory-lancedb.ts`

## Candidate idea-port review

- `88139c4271` `refactor(contracts): share session binding assertions`
  - Accept shared testkit extraction where it improves coverage without altering
    MongoDB-first runtime behavior.

## Expected upstream themes

- Gateway and macOS approval fixes
- Prompt/runtime cleanup
- Final plugin/channel entrypoint cleanup
- Test-helper consolidation across plugin/runtime surfaces
- Small build/test harness fixes

## MongoDB-first merge policy

- Keep MongoDB as the only canonical memory/backend system.
- Prune or reject any LanceDB-specific reintroduction.
- Accept upstream test/build/runtime cleanup directly unless it changes memory
  truth, runtime write ownership, or Markdown bridge semantics.

## Validation gate

- `pnpm build`
- `pnpm test -- src/commands/auth-choice.preferred-provider.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/plugins/contracts/loader.contract.test.ts src/plugins/provider-runtime.test.ts src/plugins/loader.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts extensions/discord/src/monitor/native-command.plugin-dispatch.test.ts extensions/whatsapp/src/setup-surface.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
