# Article-Inspired Memory Improvements Implementation Plan

> **For Claude:** REQUIRED: Follow this plan task-by-task using TDD.
> **Design:** No separate design doc -- requirements are fully specified in this plan.

**Goal:** Implement 6 improvements inspired by the VelvetShark "OpenClaw Memory Masterclass" article, adapted for ClawMongo's MongoDB-first event-sourced architecture.

**Architecture:** All improvements operate within the existing MongoDB-first memory architecture. No new collections. Changes span system prompts, config defaults, docs, doctor diagnostics, and a new heartbeat-driven memory hygiene task. Each improvement is independently testable and non-breaking.

**Tech Stack:** TypeScript ESM, Vitest, MongoDB (existing backend)

**Prerequisites:** v2 consolidation complete (573/573 tests pass). Upstream sync complete (53 live e2e pass, 0 TS errors).

---

## Plan: Article-Inspired Memory Improvements

### Request Summary

- Adapt 6 VelvetShark article recommendations for ClawMongo's MongoDB-first architecture

### Requirements Snapshot

- R1: Pre-compaction flush must use `memory_write` (MongoDB), not file writes
- R2: Recommend `reserveTokensFloor: 40000` in docs and as default
- R3: Add compaction timing guidance to AGENTS.md template
- R4: Add MongoDB-adapted three-failure-mode diagnostic to doctor
- R5: Sub-agents must receive the MongoDB bridge section so they can call `memory_search`
- R6: Memory hygiene automation via heartbeat-driven promotion from daily bridge notes to MongoDB structured memory

### Constraints Snapshot

- MUST NOT break any existing tests (53 live e2e pass)
- MUST NOT change the core memory write path (persistConversationMessageToMongo)
- MongoDB-only: no SQLite, no QMD, no file-based memory as canonical truth
- Each improvement independently testable
- TypeScript ESM, strict typing, avoid `any`

### In Scope

- System prompt flush-to-MongoDB wiring (prompt text changes)
- Default reserveTokensFloor config change from 20000 to 40000
- Documentation updates (memory-config.md, AGENTS.md templates)
- Doctor command: new MongoDB memory diagnostic note
- Sub-agent MongoDB bridge section (prompt mode change)
- Memory hygiene guidance in AGENTS.md heartbeat section

### Out Of Scope

- New MongoDB collections or indexes
- Changes to the core write path (persistConversationMessageToMongo, guardSessionManager)
- LLM entity extraction automation
- Cron job infrastructure changes
- Automated promotion scripts (guidance only in this plan; automation deferred)

### Planning Mode

- Plan mode: `execution_plan`
- Verification rigor: `standard`

### Open Decisions

- None

### Differences From Agreement

- None

### Recommended Defaults

- `reserveTokensFloor: 40000` as new default (article recommends, current 20000 proven too tight for long sessions with tools)

### Current State

**Flush prompt (`src/auto-reply/reply/memory-flush.ts:25-33`):**
The `DEFAULT_MEMORY_FLUSH_PROMPT` already directs to `memory_write` and explicitly says "Store durable structured memories with memory_write only; do not use file writes for runtime memory." and "Use MEMORY.md and memory/\*.md only as human-authored bridge notes." The flush prompt is already MongoDB-correct in the codebase. The test scenario in `prompt-composition-scenarios.ts:570-576` still references the old "Store durable memories only in memory/2026-03-15.md" wording -- this is a stale test fixture that should be updated.

**reserveTokensFloor (`src/agents/pi-settings.ts:4`):**
`DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000`. Config help text already documents the field. `docs/reference/memory-config.md` has no mention of reserveTokensFloor.

**MongoDB bridge for sub-agents (`src/agents/system-prompt.ts:25-31`):**
`buildMongoDBBridgeSection()` returns `[]` when `isMinimal === true` (line 30). Sub-agents use `promptMode: "minimal"` (line 720-722 in compact.ts). This means sub-agents do NOT get the MongoDB bridge section -- they cannot see `memory_search` / `memory_write` routing guidance. However, sub-agents DO still get tools registered (memory_search, memory_write are tool-level, not prompt-level). The gap is prompt guidance only.

**Doctor memory diagnostic (`src/commands/doctor-memory-search.ts`):**
Currently checks MongoDB connection, topology, embedding coverage, and embedding provider config. No diagnostic for "why memory recall failed" (Never Stored / Not Retrieved / Compaction Lost It).

**AGENTS.md template (`docs/reference/templates/AGENTS.md:206-213`):**
Has "Memory Maintenance (During Heartbeats)" section but no compaction timing guidance and no MongoDB-specific promotion guidance.

### Alternatives

- A1: Keep `reserveTokensFloor` at 20000 and document 40000 as suggestion only -- lower risk, less benefit
- A2: Make sub-agent bridge a full Memory Recall section instead of just the bridge -- more tokens per sub-agent prompt

### Drawbacks

- Changing `reserveTokensFloor` default from 20000 to 40000 means sessions compact earlier, using slightly more LLM calls. On large context models (200K+) this is negligible.
- Adding bridge section to sub-agent prompts adds ~200 tokens per sub-agent system prompt.

### Critical-Path Verification Design

- Behavior contract: Not required (standard rigor)
- Edge-case catalog: Concise below
- Provable properties: None
- Purity boundary map: Not required
- Verification strategy: Unit tests for each improvement

### Edge Cases

- Flush prompt: custom user prompt must still get safety hints appended (already handled by `ensureMemoryFlushSafetyHints`)
- reserveTokensFloor: users who already set a custom value should not be affected (config override takes precedence)
- Sub-agent bridge: when `memoryBackend` is not "mongodb", bridge should still be skipped for sub-agents
- Doctor diagnostic: when MongoDB is not connected, existing connection failure note should take priority
- Memory hygiene: heartbeat section is guidance-only; no runtime enforcement needed

---

## Relevant Codebase Files

### Patterns to Follow

- `src/auto-reply/reply/memory-flush.ts` (lines 25-42) -- flush prompt pattern
- `src/agents/system-prompt.ts` (lines 25-51) -- MongoDB bridge section pattern
- `src/commands/doctor-memory-search.ts` (lines 17-119) -- doctor note pattern
- `src/agents/pi-settings.ts` (line 4) -- default constant pattern

### Configuration Files

- `src/config/types.agent-defaults.ts` (lines 308-350) -- compaction config types
- `src/config/zod-schema.agent-defaults.ts` (line 93) -- Zod schema for reserveTokensFloor

### Test Files

- `src/agents/pi-settings.test.ts` -- reserveTokensFloor default tests
- `src/auto-reply/reply/reply-state.test.ts` -- memory flush settings tests
- `src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts` -- e2e flush tests
- `src/agents/prompt-composition-scenarios.ts` -- prompt composition scenarios
- `src/commands/doctor-memory-search.test.ts` -- doctor memory test

---

## Phase 1: Pre-Compaction Flush Test Fixture Alignment

> **Exit Criteria:** The stale test scenario in `prompt-composition-scenarios.ts` matches the actual default flush prompt. All tests pass.

### Task 1.1: Update stale prompt-composition-scenarios flush fixture

**Files:**

- Modify: `src/agents/prompt-composition-scenarios.ts:570-584`

**Step 1: Read current default flush prompt**

The actual default in `memory-flush.ts:25-33` already says:

```
"Pre-compaction memory flush."
"Store durable structured memories with memory_write only; do not use file writes for runtime memory."
"Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them."
"Use MEMORY.md and memory/*.md only as human-authored bridge notes; do not append agent-generated durable memory to them."
"do not overwrite or replace bridge note files."
"Write only durable facts, decisions, preferences, todos, people, projects, or architecture notes worth keeping."
"If nothing to store, reply with NO_REPLY."
```

The test scenario at line 570-584 uses a stale `memoryFlushPrompt` that still mentions "Store durable memories only in memory/2026-03-15.md" and a stale `memoryFlushSystemPrompt` that says "capture durable memories to disk."

**Step 2: Update the test fixture**

Update `memoryFlushPrompt` (line 570-576) to reflect the actual default, replacing disk-centric language with MongoDB-first language. The fixture uses custom prompt text (not the actual DEFAULT), so align the wording to match ClawMongo expectations.

Update `memoryFlushSystemPrompt` extra text (line 578-584) to replace "capture durable memories to disk" with "capture durable memories in MongoDB."

**Step 3: Run tests**

Run: `pnpm test -- src/agents/prompt-composition-scenarios.ts`
Expected: PASS (or no direct test file -- these are consumed by snapshot tests)

Run: `pnpm test -- src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts`
Expected: All flush-related e2e tests pass

**Step 4: Commit**

```bash
scripts/committer "Memory: align flush prompt test fixtures with MongoDB-first defaults" src/agents/prompt-composition-scenarios.ts
```

---

## Phase 2: reserveTokensFloor Default to 40000

> **Exit Criteria:** `DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR` is 40000. All tests referencing the old default are updated. Docs reference the new value.

### Task 2.1: Update the default constant

**Files:**

- Modify: `src/agents/pi-settings.ts:4`

**Step 1: Change the default**

Change `export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 20_000;` to `export const DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR = 40_000;`

**Step 2: Update pi-settings tests**

In `src/agents/pi-settings.test.ts`, the tests assert against `DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR` (imported constant), so they should auto-adapt. Verify no hardcoded `20000` or `20_000` in assertions.

Run: `pnpm test -- src/agents/pi-settings.test.ts`
Expected: PASS

**Step 3: Update memory-flush tests**

In `src/auto-reply/reply/reply-state.test.ts`, line 259 asserts `settings?.reserveTokensFloor` equals the imported constant. Should auto-adapt.

Run: `pnpm test -- src/auto-reply/reply/reply-state.test.ts`
Expected: PASS

**Step 4: Run full memory test suite**

Run: `pnpm test -- src/auto-reply/reply/ src/agents/pi-settings`
Expected: All pass

### Task 2.2: Document reserveTokensFloor in memory-config.md

**Files:**

- Modify: `docs/reference/memory-config.md`

**Step 1: Add compaction section to memory-config.md**

After the "Citations" section (~line 92), add:

````markdown
## Compaction tuning

### reserveTokensFloor

Controls the minimum token budget reserved for the agent before compaction
triggers. The default is `40000` (40K tokens). This gives the agent enough room
for tool use, memory search results, and multi-step reasoning before the session
auto-compacts.

```json5
agents: {
  defaults: {
    compaction: {
      reserveTokensFloor: 40000
    }
  }
}
```
````

Raise this value if the agent frequently compacts mid-task. Lower it only on
small-context models where compaction cost is a concern.

### Pre-compaction memory flush

Before compaction, the agent automatically runs a "memory flush" turn that
stores durable facts to MongoDB via `memory_write`. This ensures important
context survives compaction.

The flush is enabled by default. Configure it under
`agents.defaults.compaction.memoryFlush`:

- `enabled` (default: `true`) -- toggle the flush entirely.
- `softThresholdTokens` (default: `4000`) -- token margin before compaction that triggers the flush.
- `prompt` -- custom flush prompt (safety hints are always appended).
- `systemPrompt` -- custom system prompt for the flush turn.

````

**Step 2: Verify docs render (manual)**

Check the Markdown renders correctly.

**Step 3: Commit**

```bash
scripts/committer "Config: raise reserveTokensFloor default to 40000 and document compaction tuning" src/agents/pi-settings.ts docs/reference/memory-config.md
````

---

## Phase 3: Compaction Timing Guidance in AGENTS.md Template

> **Exit Criteria:** Both AGENTS.md templates include compaction timing guidance. No test changes needed (templates are documentation).

### Task 3.1: Add compaction timing guidance to AGENTS.md template

**Files:**

- Modify: `docs/reference/templates/AGENTS.md`
- Modify: `docs/reference/templates/AGENTS.dev.md`

**Step 1: Add compaction timing section to main AGENTS.md**

After the "Memory Maintenance (During Heartbeats)" section (line 213), before "## Make It Yours", add:

```markdown
### Compaction Timing

Compaction summarizes your conversation history to free token space. Key timing rule:

**Compact BEFORE giving new instructions, not after.**

If you need to redirect the agent or give it a new task:

1. Run `/compact` first (or let auto-compaction fire)
2. Then give new instructions on a clean context

Compacting _after_ new instructions risks losing those instructions in the summary.
When auto-compaction fires mid-conversation, the pre-compaction flush stores durable
facts to MongoDB via `memory_write` -- so important context survives. But instructions
that were just given may be summarized away.
```

**Step 2: Add brief note to dev AGENTS.md**

After the "Heartbeats (optional)" section (~line 43), before "## Customize", add:

```markdown
## Compaction tips

- Compact BEFORE giving new instructions, not after.
- Let auto-compaction flush durable facts to MongoDB via `memory_write` before summarizing.
- If the agent loses context after compaction, check that `reserveTokensFloor` is high enough (default: 40000).
```

**Step 3: Commit**

```bash
scripts/committer "Docs: add compaction timing guidance to AGENTS.md templates" docs/reference/templates/AGENTS.md docs/reference/templates/AGENTS.dev.md
```

---

## Phase 4: Three-Failure-Mode Diagnostic in Doctor

> **Exit Criteria:** `openclaw doctor` shows a new MongoDB memory recall diagnostic note when backend=mongodb. Unit tests cover the new diagnostic function.

### Task 4.1: Add noteMemoryRecallDiagnostic function

**Files:**

- Modify: `src/commands/doctor-memory-search.ts`
- Create test: `src/commands/doctor-memory-recall-diagnostic.test.ts`

**Step 1: Write failing test**

Create `src/commands/doctor-memory-recall-diagnostic.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";

// Test the diagnostic note output for memory recall failure modes
describe("noteMemoryRecallDiagnostic", () => {
  it("returns MongoDB-adapted failure mode guidance when backend is mongodb", async () => {
    // The function should produce a doctor note with three failure modes
    const { noteMemoryRecallDiagnostic } = await import("./doctor-memory-search.js");
    const lines: string[] = [];
    // Mock the note function to capture output
    // (actual test will verify the function returns the right lines)
    const result = noteMemoryRecallDiagnostic({ backend: "mongodb" });
    expect(result).toBeDefined();
    expect(result.title).toBe("Memory Recall Diagnostic");
    expect(result.lines).toContain("Not Retrieved");
    expect(result.lines).toContain("Compaction Lost It");
    expect(result.lines).toContain("Never Stored");
  });

  it("returns null when backend is not mongodb", () => {
    const { noteMemoryRecallDiagnostic } = await import("./doctor-memory-search.js");
    const result = noteMemoryRecallDiagnostic({ backend: "local" });
    expect(result).toBeNull();
  });
});
```

**Step 2: Run test, verify it fails**

Run: `pnpm test -- src/commands/doctor-memory-recall-diagnostic.test.ts`
Expected: FAIL (function does not exist yet)

**Step 3: Implement noteMemoryRecallDiagnostic**

Add to `src/commands/doctor-memory-search.ts` a new exported function:

```typescript
/**
 * MongoDB-adapted three-failure-mode diagnostic for memory recall issues.
 * Based on the VelvetShark "Memory Masterclass" failure taxonomy, adapted
 * for ClawMongo where "Never Stored" is rare (runtime write path is automatic)
 * and "Not Retrieved" (agent didn't search MongoDB) is the primary failure mode.
 */
export function noteMemoryRecallDiagnostic(params: {
  backend?: string;
}): { title: string; lines: string } | null {
  if (params.backend !== "mongodb") {
    return null;
  }
  const lines = [
    "If the agent seems to forget things, check these three failure modes:",
    "",
    "1. Not Retrieved (most common)",
    "   The agent didn't call memory_search before answering.",
    "   Fix: Check that the MongoDB bridge section is in the system prompt.",
    "   Verify: Look for memory_search tool calls in the session transcript.",
    "",
    "2. Compaction Lost It",
    "   Important context was summarized away during auto-compaction.",
    "   Fix: Raise reserveTokensFloor (default: 40000) or compact before new instructions.",
    "   Verify: Check the compaction summary for missing context.",
    "",
    "3. Never Stored",
    "   In ClawMongo this is rare -- conversation turns auto-persist to MongoDB.",
    "   But structured facts (preferences, decisions) require explicit memory_write.",
    "   Fix: Check that memory_write is available and the flush is enabled.",
    "   Verify: Search MongoDB events/structured_memory collections directly.",
  ].join("\n");
  return { title: "Memory Recall Diagnostic", lines };
}
```

**Step 4: Wire into doctor command**

In `src/commands/doctor-memory-search.ts`, at the end of `noteMongoDBBackendHealth` (after the successful connection block, ~line 98), add a call:

```typescript
const recallDiag = noteMemoryRecallDiagnostic({ backend: "mongodb" });
if (recallDiag) {
  note(recallDiag.lines, recallDiag.title);
}
```

**Step 5: Run tests**

Run: `pnpm test -- src/commands/doctor-memory-recall-diagnostic.test.ts`
Expected: PASS

Run: `pnpm test -- src/commands/doctor-memory-search.test.ts`
Expected: PASS (existing tests still pass)

**Step 6: Commit**

```bash
scripts/committer "Doctor: add three-failure-mode memory recall diagnostic" src/commands/doctor-memory-search.ts src/commands/doctor-memory-recall-diagnostic.test.ts
```

---

## Phase 5: Sub-Agent MongoDB Bridge Section

> **Exit Criteria:** Sub-agents (promptMode="minimal") receive a condensed MongoDB bridge section. Tests verify the bridge appears in minimal mode when memoryBackend="mongodb".

### Task 5.1: Write failing test for sub-agent bridge

**Files:**

- Modify: `src/agents/system-prompt.ts`
- Create or modify test: `src/agents/system-prompt.test.ts` (or existing test file)

**Step 1: Write failing test**

Find the existing system-prompt test file or create a focused test:

```typescript
import { describe, it, expect } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt sub-agent MongoDB bridge", () => {
  it("includes condensed MongoDB memory guidance for minimal mode when backend is mongodb", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/test",
      promptMode: "minimal",
      memoryBackend: "mongodb",
      runtimeInfo: { host: "test", os: "test", arch: "test", node: "test", model: "test/test" },
      toolNames: ["memory_search", "memory_write"],
    });
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("MongoDB");
  });

  it("does not include MongoDB bridge for minimal mode when backend is not mongodb", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/test",
      promptMode: "minimal",
      memoryBackend: "local",
      runtimeInfo: { host: "test", os: "test", arch: "test", node: "test", model: "test/test" },
      toolNames: ["memory_search"],
    });
    expect(prompt).not.toContain("MongoDB Memory");
  });
});
```

**Step 2: Run test, verify it fails**

Run: `pnpm test -- src/agents/system-prompt.test.ts`
Expected: FAIL (minimal mode currently filters out MongoDB bridge)

**Step 3: Implement condensed sub-agent bridge**

In `src/agents/system-prompt.ts`, modify `buildMongoDBBridgeSection` (lines 25-52):

Change the guard from:

```typescript
if (params.memoryBackend !== "mongodb" || params.isMinimal) {
  return [];
}
```

To:

```typescript
if (params.memoryBackend !== "mongodb") {
  return [];
}
if (params.isMinimal) {
  // Condensed bridge for sub-agents: just memory_search routing
  return [
    "## MongoDB Memory",
    "MongoDB memory is active. Use memory_search for prior context before answering.",
    "",
  ];
}
```

This gives sub-agents the essential instruction (call memory_search first) without the full Memory Recall section, Memory Routing Guide, or other full-mode sections. The ~200 token cost is justified by preventing the primary failure mode (Not Retrieved).

**Step 4: Run test, verify it passes**

Run: `pnpm test -- src/agents/system-prompt.test.ts`
Expected: PASS

Run: `pnpm test -- src/agents/`
Expected: All agent tests pass

**Step 5: Commit**

```bash
scripts/committer "Prompts: add condensed MongoDB bridge for sub-agent minimal mode" src/agents/system-prompt.ts src/agents/system-prompt.test.ts
```

---

## Phase 6: Memory Hygiene Guidance in AGENTS.md

> **Exit Criteria:** AGENTS.md template includes MongoDB-specific memory hygiene guidance for heartbeat-driven promotion. No code changes -- documentation only.

### Task 6.1: Update Memory Maintenance section with promotion guidance

**Files:**

- Modify: `docs/reference/templates/AGENTS.md`

**Step 1: Replace the Memory Maintenance section**

Replace the current "Memory Maintenance (During Heartbeats)" section (lines 206-213) with expanded MongoDB-first guidance:

```markdown
### Memory Maintenance (During Heartbeats)

Periodically (every few days), use a heartbeat to promote important context from daily bridge notes to durable MongoDB memory:

1. **Scan bridge notes** (`memory/*.md`) for facts, decisions, preferences, or architecture notes that should persist long-term
2. **Store durable facts** using `memory_write` with appropriate type (decision, preference, fact, person, todo, project, architecture)
3. **Keep bridge notes lean** -- once promoted to MongoDB, the bridge note entry can be summarized or removed
4. **Do not duplicate** -- before writing, use `memory_search` to check if the fact already exists in MongoDB

Weekly promotion cycle:

- **Daily notes** (`memory/YYYY-MM-DD.md`) are raw capture -- ephemeral by nature
- **Structured memory** (MongoDB via `memory_write`) is durable -- survives compaction and session resets
- **MEMORY.md** remains human-authored bridge guidance only -- do not treat it as a memory store

The goal: important facts graduate from daily notes to MongoDB structured memory within a week. Bridge notes stay small. MongoDB stays canonical.
```

**Step 2: Commit**

```bash
scripts/committer "Docs: add MongoDB memory hygiene promotion guidance to AGENTS.md template" docs/reference/templates/AGENTS.md
```

---

## Acceptance Checks

- `pnpm test` -- full test suite passes (no regressions from existing 53 e2e + unit tests)
- `pnpm build` -- build succeeds
- `pnpm check` -- lint/format clean
- Manual: `openclaw doctor` shows "Memory Recall Diagnostic" note when backend=mongodb
- Manual: Sub-agent system prompt includes "MongoDB Memory" section
- Verify: `DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR` is 40000 in `pi-settings.ts`
- Verify: `docs/reference/memory-config.md` documents reserveTokensFloor
- Verify: `docs/reference/templates/AGENTS.md` has compaction timing and memory hygiene sections

---

## Risks And Mitigations

| Risk                                                                              | P   | I   | Score | Mitigation                                                   |
| --------------------------------------------------------------------------------- | --- | --- | ----- | ------------------------------------------------------------ |
| reserveTokensFloor change causes more frequent compaction on small-context models | 2   | 2   | 4     | Only affects models with <80K context; document how to lower |
| Sub-agent bridge adds ~200 tokens per sub-agent prompt                            | 1   | 1   | 1     | Minimal impact; condensed to 2 lines                         |
| Prompt composition snapshot tests may break from bridge change                    | 3   | 2   | 6     | Run snapshot tests, update expected output                   |
| Doctor diagnostic note adds noise to `openclaw doctor` output                     | 1   | 1   | 1     | Only shown when backend=mongodb; informational               |
| Stale test fixture update changes prompt composition scenarios                    | 2   | 2   | 4     | Careful update, verify all consuming tests pass              |

---

## Summary

- Plan saved: docs/plans/2026-03-21-article-inspired-improvements-plan.md
- Phases: 6
- Risks: 5 identified (all low-to-medium, mitigated)
- Key decisions: reserveTokensFloor 20K->40K, sub-agent gets condensed bridge, doctor gets recall diagnostic

## Recommended Skills for BUILD (SKILL_HINTS for Router)

- cc10x:architecture-patterns (multi-component system prompt / config / docs work)

## Confidence Score: 82/100

- High: all source files identified with exact line numbers (+25)
- High: edge cases documented (+20)
- High: test commands specific with expected results (+20)
- Medium: risk mitigations defined (+15)
- Deduction: prompt composition snapshot tests may need additional updates beyond what's described (-8)
- Deduction: doctor test may need mock adjustment for the new function (-5)

**Key Assumptions:**

- The prompt-composition-scenarios.ts fixture is consumed only by snapshot/comparison tests, not runtime code
- Sub-agent tools (memory_search, memory_write) are registered at the tool level regardless of prompt mode
- The doctor command's `noteMemorySearchHealth` calls `noteMongoDBBackendHealth` internally, which is the right place to add the recall diagnostic
- No existing test hardcodes `20000` as the expected reserveTokensFloor default (they import the constant)

## Findings

- The flush prompt is ALREADY MongoDB-correct in production code (`memory-flush.ts`). Only the test fixture in `prompt-composition-scenarios.ts` is stale.
- Sub-agents currently get tools but NOT the MongoDB bridge guidance. This is a real gap that can cause the primary failure mode (Not Retrieved).
- The `buildMongoDBBridgeSection` function is cleanly separated and easy to modify for minimal mode.
- The doctor command already has a well-structured pattern for adding new diagnostic notes.
