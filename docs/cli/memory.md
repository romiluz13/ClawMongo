---
summary: "CLI reference for `openclaw memory` (status/index/search/relevance/smoke)"
read_when:
  - You want to inspect or index ClawMongo memory
  - You are debugging MongoDB memory health or retrieval
  - You want relevance diagnostics for the MongoDB memory backend
title: "memory"
---

# `openclaw memory`

Manage ClawMongo memory.

This CLI works with the MongoDB memory backend. In ClawMongo, MongoDB is the
only supported runtime memory backend.

Related:

- Memory concept: [Memory](/concepts/memory)
- Plugins: [Plugins](/tools/plugin)

## Examples

```bash
openclaw memory status
openclaw memory status --deep
openclaw memory status --deep --index
openclaw memory index
openclaw memory search "release checklist"
openclaw memory smoke
openclaw memory relevance explain --query "release checklist"
openclaw memory relevance benchmark
openclaw memory relevance report --window 7d
openclaw memory relevance sample-rate
```

## Options

Common:

- `--agent <id>`: scope to a single agent (default: all configured agents)
- `--verbose`: emit detailed logs during probes and indexing

`memory search`:

- pass either positional `[query]` or `--query <text>`
- if both are provided, `--query` wins
- if neither is provided, the command exits with an error

## Notes

- `memory status --deep` probes vector and embedding availability
- `memory status --deep --index` runs a reindex if the store is dirty
- `memory index --verbose` prints per-phase details including source coverage and search modes
- `memory status` includes extra paths configured via `agents.defaults.memorySearch.extraPaths`
- if memory secret fields are configured as SecretRefs, the CLI resolves them from the active gateway snapshot
- gateway version skew note: this command path requires a gateway that supports `secrets.resolve`
