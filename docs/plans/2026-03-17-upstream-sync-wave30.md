# Upstream Sync Wave 30

- Base: `55253e2a9d` (`v2026.3.13-1`)
- Target: `1f1a93a1dc` (`v2026.3.13-1`)
- Scope: 17 upstream commits

## Why this wave

This is a clean bounded wave centered on gateway/channel startup laziness,
channel plugin resolution, and a small browser-profile schema improvement. The
MongoDB-first surface is limited to one additive config-schema change.

## Protected MongoDB-first hotspots

- `src/config/zod-schema.ts`
  - Accept upstream browser profile validation additions:
    `userDataDir` for `existing-session` profiles and the matching refine rule.
  - No memory/backend ownership impact.

## Expected upstream themes

- Deferred channel plugin startup
- Shared channel plugin id resolution
- Telegram/Discord probe and auth fixes
- Browser existing-session profile improvements
- Generated config/doc refresh

## MongoDB-first merge policy

- Accept upstream gateway/channel startup improvements directly.
- Keep MongoDB as the only canonical memory/backend truth.
- Treat config-schema additions as safe unless they touch memory/backend
  semantics, which this wave does not.

## Validation gate

- `pnpm build`
- `pnpm test -- src/plugin-sdk/index.test.ts src/commands/auth-choice.preferred-provider.test.ts src/plugins/providers.test.ts src/plugins/contracts/runtime.contract.test.ts src/plugins/contracts/catalog.contract.test.ts src/plugins/contracts/discovery.contract.test.ts src/plugins/contracts/auth-choice.contract.test.ts src/infra/outbound/channel-adapters.test.ts src/infra/outbound/outbound-send-service.test.ts extensions/discord/src/channel.test.ts --reporter=verbose`
- `MONGODB_TEST_URI='mongodb://admin:admin@localhost:27017/openclaw?authSource=admin&replicaSet=rs0&directConnection=true' pnpm exec vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`
