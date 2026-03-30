# Memory Extraction Pipeline Design

## Purpose

Connect ClawMongo's 8 retrieval lanes by wiring sync extraction into the event write path. Currently, events flow in but no derived data (structured facts, entities, episodes) is extracted — leaving 4 of 8 retrieval lanes permanently empty. The retrieval planner confidently routes queries to lanes with no data.

## Users

Any agent using ClawMongo as a general-purpose agentic framework — community bots, coding assistants, customer support agents, enterprise workflows.

## Success Criteria

- [ ] `writeEventAndProject()` triggers sync rule-based extraction (structured facts, entities, episode trigger check)
- [ ] All 8 retrieval planner lanes return real data when appropriate
- [ ] Planner reports coverage/freshness per lane (skips empty lanes)
- [ ] System prompt matches reality — honest about what's automatic vs explicit
- [ ] Tests: unit + e2e for each extraction path
- [ ] `pnpm build` PASS
- [ ] Live MongoDB gate PASS (production-readiness.e2e.test.ts new phases)

## Constraints

- MongoDB-only (no external deps)
- General-purpose (not community-management specific)
- No LLM calls in the hot write path (rule-based only)
- Extraction failures MUST NOT block event writes (universal best practice from all 6 researched systems)
- Existing `memory_search`, `memory_write`, `kb_search`, `memory_get` tool APIs unchanged
- Zero dead code — every capability actively used at runtime

## Out of Scope (This Wave)

- LLM-based extraction (Tier 3 — future enhancement, deferred)
- New public tools (no `memory_curate` or `memory_project`)
- File-based export layer (confirmed unnecessary)
- Cross-encoder reranking (deferred from prior review)
- Temporal validity on facts (valid_at/invalid_at — valuable but deferred to reduce scope)
- Change Streams for reactive extraction (requires replica set, deferred)

## Approach Chosen

**Option A: Extend `writeEventAndProject()` directly** — add sync extraction calls after event write + chunk projection. Simplest path, follows existing standalone-function pattern.

Research validation: Across Mem0, Zep/Graphiti, Letta, LangMem, Cognee — no production system does rule-based extraction. All use LLM. ClawMongo's sync rule-based approach is a unique competitive advantage: zero latency cost vs 2-15s for competitors.

## Architecture

### Two-Layer Architecture Contract (formalized)

```
Layer 1: Heart/Bootstrap (Markdown, read-only input)
  - AGENTS.md, SOUL.md, HEARTBEAT.md, BOOTSTRAP.md, IDENTITY.md
  - Operator-supplied guidance — never written by runtime
  - NOT memory. NOT a source of truth. Input config only.

Layer 2: Canonical MongoDB (runtime truth, all memory)
  - Events (canonical writes) → Derived collections (projections)
  - 8 retrieval lanes, all populated from MongoDB
  - The ONLY source of runtime memory
```

No third layer. No export layer. No MD/JSON mirrors.

### Extraction Pipeline (Sync, Rule-Based)

```
writeEventAndProject(event)
  ├── [existing] Write event to events collection
  ├── [existing] Project chunks from event
  │
  ├── [NEW] extractStructuredCandidates(event)    // try/catch wrapped
  │   └── Pattern-based fact extraction
  │       - Preference detection ("I prefer/like/hate X")
  │       - Identity assertions ("I am a X", "My name is X")
  │       - Intent/plan detection ("I want to X", "Remind me to X")
  │       - Relationship markers ("my wife X", "works at X")
  │       - Fact-worthiness scoring (threshold filter)
  │       └── Write to structured_mem collection
  │
  ├── [NEW] extractAndUpsertEntities(event)       // try/catch wrapped
  │   └── Rule-based entity extraction
  │       - Proper noun detection via regex
  │       - Pronoun resolution from context
  │       - Known pattern matching (names, orgs, locations)
  │       - Relation extraction between co-mentioned entities
  │       └── Upsert to entities + relations collections
  │
  ├── [NEW] checkAutoEpisodeTriggers(agentId)     // try/catch wrapped
  │   └── Multi-signal trigger check
  │       - Event count threshold (configurable, default 15)
  │       - Time gap detection (>30min since last event)
  │       - Session end signal
  │       └── If triggered: materializeEpisode()
  │
  └── [NEW] updateLaneCoverage(agentId)           // try/catch wrapped
      └── Atomic $inc on per-agent coverage doc
```

### Error Isolation Pattern (Universal Best Practice)

```typescript
// Event write MUST succeed. Extraction MUST NOT block.
const writeResult = await writeEventToMongo(event); // critical path

// Each extraction step independently wrapped
try {
  await extractStructuredCandidates(db, prefix, event);
} catch (err) {
  log.warn("Structured extraction failed", { err, eventId });
}

try {
  await extractAndUpsertEntities(db, prefix, event);
} catch (err) {
  log.warn("Entity extraction failed", { err, eventId });
}

try {
  await checkAutoEpisodeTriggers(db, prefix, agentId);
} catch (err) {
  log.warn("Episode trigger check failed", { err, eventId });
}
```

## Components

### 1. Extraction Wiring (`mongodb-manager.ts` or `mongodb-events.ts`)

Wire 3 extraction calls into `writeEventAndProject()` after existing event write + chunk projection. Each call wrapped in independent try/catch.

### 2. Structured Candidate Extraction (`mongodb-derived-memory.ts`)

`extractStructuredCandidatesFromEvent()` already exists but is never called. Wire it in. May need minor signature adjustments to accept the event object directly from `writeEventAndProject()`.

### 3. Entity Extraction (`mongodb-graph.ts`)

`extractAndUpsertEntities()` already exists but is never called. Wire it in. Rule-based extraction using regex patterns (already implemented in Enhancement Phase 4).

### 4. Episode Trigger Check (`mongodb-episodes.ts`)

`checkAutoEpisodeTriggers()` already exists but is never called. Wire it in. Uses event count + time window + rate limiting (already implemented in Enhancement Phase 5).

### 5. Lane Coverage Tracking (NEW: `mongodb-lane-coverage.ts`)

New lightweight module. Per-agent document tracking which lanes have data and when they were last updated. Atomic `$inc` on every extraction write.

### 6. Planner Coverage Awareness (`mongodb-retrieval-planner.ts`)

Modify `planRetrieval()` to accept lane coverage data. Skip lanes known to be empty. Report coverage in search metadata.

### 7. System Prompt Update (`system-prompt.ts`)

Update the MongoDB Memory Integration section to be honest about:

- What's automatic (extraction happens on every event)
- What requires explicit action (`memory_write` for high-importance facts)
- Lane coverage visibility

### 8. Provenance Fields (on extracted documents)

Every extracted fact/entity includes:

- `sourceEventId` — which event triggered extraction
- `extractionMethod` — `"rule_based"` (this wave) or `"agent_explicit"` (memory_write)
- `extractedAt` — timestamp
- `confidence` — 1.0 for rule-based, agent-specified for explicit

## Data Flow

```
User/Agent Turn
  │
  ▼
writeEventAndProject()
  │
  ├──► events collection (canonical)
  ├──► chunks collection (v1 bridge)
  │
  ├──► structured_mem collection (extracted facts)      ← NEW WIRE
  ├──► entities collection (extracted entities)          ← NEW WIRE
  ├──► relations collection (extracted relations)        ← NEW WIRE
  ├──► episodes collection (materialized when triggered) ← NEW WIRE
  └──► lane_coverage collection (per-agent counters)     ← NEW

Agent calls memory_search(query)
  │
  ▼
planRetrieval(query, laneCoverage)  ← ENHANCED: reads coverage
  │
  ├──► raw-window   (events)        ✓ always has data
  ├──► hybrid       (chunks)        ✓ always has data
  ├──► structured   (facts)         ✓ NOW populated by extraction
  ├──► active-critical (high-salience facts) ✓ subset of structured
  ├──► kb           (reference docs) ✓ if KB ingested
  ├──► episodic     (episode summaries) ✓ NOW populated by triggers
  ├──► procedural   (procedures)    ✓ populated by extraction patterns
  └──► graph        (entity expansion) ✓ NOW populated by extraction
```

## Error Handling

| Failure Mode                 | Impact                                      | Handling                   |
| ---------------------------- | ------------------------------------------- | -------------------------- |
| Event write fails            | CRITICAL — data loss                        | Propagate error to caller  |
| Structured extraction fails  | LOW — facts not extracted for this event    | log.warn, continue         |
| Entity extraction fails      | LOW — entities not extracted for this event | log.warn, continue         |
| Episode trigger fails        | LOW — episode delayed until next trigger    | log.warn, continue         |
| Lane coverage update fails   | NEGLIGIBLE — stale coverage counts          | log.warn, continue         |
| Planner reads stale coverage | LOW — queries empty lane, gets no results   | Fallback to backstop paths |

## Testing Strategy

### Unit Tests

- `extractStructuredCandidatesFromEvent()` with various event content patterns
- `extractAndUpsertEntities()` called from writeEventAndProject context
- `checkAutoEpisodeTriggers()` threshold/timing behavior
- Lane coverage update atomicity
- Planner skips empty lanes when coverage data available
- Error isolation: each extraction failure doesn't affect others

### Integration Tests

- `writeEventAndProject()` end-to-end: event + chunks + structured + entities + episode check
- Retrieval planner with real coverage data

### E2E Tests (production-readiness.e2e.test.ts new phases)

- Phase 19: Extraction pipeline — write events, verify derived data appears in structured_mem/entities/relations
- Phase 20: Lane coverage — verify planner uses coverage data, skips empty lanes
- Phase 21: Episode auto-materialization — write N events, verify episode created

## Observability

- `log.warn` on every extraction failure (existing pattern)
- Lane coverage document queryable for debugging (`db.lane_coverage.find({agentId: "..."})`)
- Extraction provenance fields enable tracing back to source events

## Questions Resolved

- Q: Sync or async extraction? A: Sync rule-based (user chose, research validated — unique advantage)
- Q: What's out of scope? A: User wants comprehensive — all lanes live, planner honest, prompt updated
- Q: Need file export layer? A: No — confirmed unnecessary by code analysis
- Q: LLM in hot path? A: No — rule-based only this wave (research: all competitors use LLM, our rule-based approach is unique)
- Q: Episode trigger strategy? A: Multi-signal (event count + time gap + session end) — matches existing `checkAutoEpisodeTriggers()`
- Q: Error handling? A: Universal best practice — extraction failures never block writes (6/6 systems agree)
