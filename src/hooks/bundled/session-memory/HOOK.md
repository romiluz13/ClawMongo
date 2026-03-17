---
name: session-memory
description: "Legacy bridge export: save recent session context to a workspace Markdown note when /new or /reset is issued"
homepage: https://docs.openclaw.ai/automation/hooks#session-memory
metadata:
  {
    "openclaw":
      {
        "emoji": "💾",
        "events": ["command:new", "command:reset"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Memory Hook

This bundled hook is a legacy bridge export. In ClawMongo, MongoDB is the
canonical runtime memory system. Enable this hook only if you explicitly want a
human-readable Markdown export in `memory/` when a session rotates.

It does not participate in MongoDB-backed runtime recall, structured memory,
graph, or episodic retrieval.

## What It Does

When you run `/new` or `/reset` to start a fresh session:

1. **Finds the previous session** - Uses the pre-reset session entry to locate the correct transcript
2. **Extracts conversation** - Reads the last N user/assistant messages from the session (default: 15, configurable)
3. **Generates descriptive slug** - Uses LLM to create a meaningful filename slug based on conversation content
4. **Exports a bridge note** - Creates a new file at `<workspace>/memory/YYYY-MM-DD-slug.md`

## Output Format

Bridge-note exports are created with the following format:

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

## Filename Examples

The LLM generates descriptive slugs based on your conversation:

- `2026-01-16-vendor-pitch.md` - Discussion about vendor evaluation
- `2026-01-16-api-design.md` - API architecture planning
- `2026-01-16-bug-fix.md` - Debugging session
- `2026-01-16-1430.md` - Fallback timestamp if slug generation fails

## Requirements

- **Config**: `workspace.dir` must be set (automatically configured during setup)

The hook uses your configured LLM provider to generate slugs, so it works with any provider (Anthropic, OpenAI, etc.).

## Important ClawMongo note

- MongoDB remains the canonical runtime memory system.
- Durable runtime facts, decisions, preferences, todos, people, projects, and architecture notes should go through `memory_write`, not this hook.
- `MEMORY.md` and `memory/*.md` remain human-authored bridge notes or optional exports only.

## Configuration

The hook supports optional configuration:

| Option     | Type   | Default | Description                                                     |
| ---------- | ------ | ------- | --------------------------------------------------------------- |
| `messages` | number | 15      | Number of user/assistant messages to include in the memory file |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": {
          "enabled": true,
          "messages": 25
        }
      }
    }
  }
}
```

The hook automatically:

- Uses your workspace directory (`~/.openclaw/workspace` by default)
- Uses your configured LLM for slug generation
- Falls back to timestamp slugs if LLM is unavailable

## Disabling

To disable this hook:

```bash
openclaw hooks disable session-memory
```

Or remove it from your config:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-memory": { "enabled": false }
      }
    }
  }
}
```
