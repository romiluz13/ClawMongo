---
summary: "CLI reference for `openclaw memory` (status/index/search/relevance/smoke)"
read_when:
  - You want to index or search semantic memory
  - You’re debugging memory availability or indexing
title: "memory"
---

# `openclaw memory`

Manage semantic memory indexing and search.
Provided by the active memory plugin (default: `memory-core`; set `plugins.slots.memory = "none"` to disable).

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory status --deep --index --verbose
openclaw memory index
openclaw memory index --verbose
openclaw memory search "release checklist"
openclaw memory smoke
openclaw memory search --query "release checklist"
openclaw memory status --agent main
openclaw memory index --agent main --verbose
openclaw memory relevance explain --query "release checklist" --deep
openclaw memory relevance benchmark
openclaw memory relevance report --window 7d
openclaw memory relevance sample-rate
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents).
- `--verbose`: emit detailed logs during probes and indexing.

`memory search`:

- Query input: pass either positional `[query]` or `--query <text>`.
- If both are provided, `--query` wins.
- If neither is provided, the command exits with an error.

Notes:

- `memory status --deep` probes vector + embedding availability.
- `memory status --deep --index` runs a reindex if the store is dirty.
- `memory index --verbose` prints per-phase details (provider, model, sources, batch activity).
- `memory status` includes any extra paths configured via `memorySearch.extraPaths`.
- `memory smoke` validates MongoDB memory end-to-end (backend selection, sync, write/read, retrieval).

## Relevance Diagnostics

The MongoDB backend exposes explain-driven relevance diagnostics and telemetry.

- `openclaw memory relevance explain --query <text>`
  - Runs one retrieval query with explain capture and stores telemetry artifacts.
  - Use `--source all|memory|kb|structured` to focus one source.
  - Use `--deep` to include raw explain payloads in persisted artifacts.
- `openclaw memory relevance benchmark`
  - Executes the configured benchmark dataset and stores regression snapshots.
  - Override dataset with `--dataset <path>`.
- `openclaw memory relevance report`
  - Aggregates telemetry over a time window (`24h`, `7d`, or `<number><s|m|h|d>`).
- `openclaw memory relevance sample-rate`
  - Prints adaptive telemetry sampling state.

`openclaw memory status --deep` includes a `Relevance` block with:

- `enabled`
- `telemetry`
- `sample rate`
- `health`
- `last regression` (when available)
- `capabilities` (`textExplain`, `vectorExplain`, `fusionExplain`)
