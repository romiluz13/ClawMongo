# Upstream Sync Wave 12

## Scope

- Range: `0277aa0159...69c12c2b11`
- Why this wave next: it absorbs the remaining shared-interactive follow-ups plus the setup-surface rename train in one small range with no MongoDB-first hotspots.
- Goal: take upstream setup/onboard UX improvements and Slack/plugin fixes without changing MongoDB memory ownership or runtime write semantics.

## Protected Hotspots

- No protected MongoDB-first hotspots changed in this range.

## Candidate Upstream Ideas in This Wave

- Package-root lazy plugin runtime resolution.
- Better setup command primacy while keeping current compatibility surfaces.
- Additional Slack interactive guardrails for oversized merged block payloads.

## Likely Irrelevant Upstream Changes

- Broad docs refresh around setup/onboard wording.
- Provider/channel doc churn that does not alter runtime memory/backend behavior.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/plugins/interactive.test.ts extensions/slack/src/monitor/events/interactions.test.ts src/channels/plugins/message-actions.test.ts src/channels/plugins/actions/actions.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 12 is only complete when:

- the range `0277aa0159...69c12c2b11` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
