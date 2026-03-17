# Upstream Sync Wave 13

## Scope

- Range: `69c12c2b11...680eff63fb`
- Why this wave next: it is still a bounded 9-commit range, and the only protected seam is a gateway reload validation addition that does not alter MongoDB memory ownership.
- Goal: absorb upstream orphan-recovery, provider auth-profile, and Windows daemon fixes while preserving MongoDB-first backend behavior.

## Protected Hotspots

### `src/config/zod-schema.ts`

- Classification: safe adopt with review.
- Upstream adds `gateway.reload.deferralTimeoutMs` to match the new restart deferral behavior.
- Preserve existing MongoDB memory/backend config constraints unchanged.

## Candidate Upstream Ideas in This Wave

- More resilient orphaned subagent recovery around reload/restart flows.
- Provider auth-profile cleanup that reduces duplicated provider-specific config wiring.
- Restart deferral timeout as an operator-facing knob for safer reload behavior.

## Likely Irrelevant Upstream Changes

- Windows `schtasks` compatibility fixes.
- Provider-specific auth-path test churn that does not change memory/backend truth.

## Validation Checklist

- `pnpm build`
- `pnpm vitest run src/agents/session-tool-result-guard.test.ts src/agents/tools/memory-tool-mongodb.test.ts src/agents/system-prompt-mongodb.test.ts src/config/validation.allowed-values.test.ts src/infra/outbound/deliver.test.ts src/infra/outbound/outbound-send-service.test.ts src/memory/mongodb-manager.test.ts src/memory/mongodb-watcher.test.ts --reporter=verbose`
- `pnpm vitest run --config vitest.e2e.config.ts src/memory/mongodb-e2e.e2e.test.ts src/memory/real-e2e-v2.e2e.test.ts src/memory/runtime-write.e2e.test.ts --reporter=verbose`

## Release Gate

Wave 13 is only complete when:

- the range `69c12c2b11...680eff63fb` is merged onto a clean branch
- excluded backend paths remain pruned after the merge
- the MongoDB validation gate passed, or any live-environment blocker is explicitly recorded
- release notes separate upstream adoption from MongoDB-first architecture preservation
