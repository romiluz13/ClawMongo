# GitHub Research: OpenClaw Ecosystem

## Execution
- Preferred backend: web-only (no Octocode MCP available)
- Allowed fallbacks: WebFetch, local codebase reading
- Research round: 1

## Sources Used
- Local codebase (ClawMongo fork, synced 0 behind upstream as of 2026-03-22)
- GitHub web (openclaw/openclaw repo page, issues, pulse, forks, topics)
- npmjs.com (openclaw package)
- DeepWiki (openclaw/openclaw architectural analysis)
- GitHub competitor repos (AutoGPT, CrewAI)

## Research Quality
- Status: COMPLETE
- Quality level: high
- Backend mode: web-only
- Note: Local codebase is 0 commits behind upstream/main and 273 commits ahead, making it a reliable mirror of upstream + ClawMongo additions.

---

## 1. OpenClaw Repository Overview

**Repo:** github.com/openclaw/openclaw
**Tagline:** "Your own personal AI assistant. Any OS. Any Platform. The lobster way."

### Metrics (as of 2026-03-22)
| Metric | Value |
|--------|-------|
| Stars | 329,000 |
| Forks | 63,900 |
| Open issues | 8,756 |
| Commits (all time) | 20,918 |
| Security advisories | 288 |
| npm weekly downloads | 1,109,169 |
| npm package name | `openclaw` |
| Latest npm version | 2026.3.13 |
| License | MIT |
| Language | TypeScript (ESM) |
| Runtime | Node 24 (recommended) / Node 22.16+ |

### History / Name Evolution
Warelay -> Clawdbot -> Moltbot -> OpenClaw (from VISION.md). Backward-compat shims exist for clawdbot/moltbot naming.

### Maintainers (from CONTRIBUTING.md)
- **Peter Steinberger (@steipete)** -- Benevolent Dictator
- **Shadow (@thewilloftheshadow)** -- Discord, community moderation, ClawHub
- **Vignesh (@vignesh07)** -- Memory (QMD), TUI, IRC, Lobster
- **Jos (@joshp123)** -- Telegram, API, Nix
- **Ayaan Zaidi (@obviyus)** -- Telegram, Android
- **Tyler Yust (@tyler6204)** -- Agents/subagents, cron, BlueBubbles, macOS
- **Mariano Belinky (@mbelinky)** -- iOS, Security
- **Nimrod Gutman (@ngutman)** -- iOS, macOS
- **Vincent Koc (@vincentkoc)** -- Agents, Telemetry, Hooks, Security
- Plus 6+ additional domain maintainers covering CLI, plugins, Matrix, ACP, docs, and JS infra

---

## 2. npm Package Metadata

```json
{
  "name": "openclaw",
  "version": "2026.3.13",
  "description": "Personal AI assistant you run on your own devices...",
  "license": "MIT",
  "author": "steipete",
  "bin": { "openclaw": "openclaw.mjs" },
  "dependencies": 55,
  "weeklyDownloads": 1109169
}
```

ClawMongo fork publishes as `@romiluz/clawmongo` with dual bin entries (`clawmongo` + `openclaw` alias).

### Plugin SDK Surface (package.json exports)
The npm package exposes 35+ subpath exports under `./plugin-sdk/*`, including:
- Core: `./plugin-sdk`, `./plugin-sdk/core`, `./plugin-sdk/runtime`
- Channels: `./plugin-sdk/channel-setup`, `./plugin-sdk/channel-runtime`, `./plugin-sdk/channel-reply-pipeline`
- Providers: `./plugin-sdk/provider-setup`, `./plugin-sdk/self-hosted-provider-setup`
- Runtime: `./plugin-sdk/agent-runtime`, `./plugin-sdk/gateway-runtime`, `./plugin-sdk/cli-runtime`
- Security: `./plugin-sdk/security-runtime`, `./plugin-sdk/ssrf-runtime`
- Media: `./plugin-sdk/media-runtime`, `./plugin-sdk/speech-runtime`
- Other: `./plugin-sdk/sandbox`, `./plugin-sdk/routing`, `./plugin-sdk/hook-runtime`, `./plugin-sdk/acp-runtime`

This is one of the most comprehensive plugin SDK surfaces in the agent runtime space.

---

## 3. Extensions / Plugin Ecosystem

**Total extensions: 78 directories** under `extensions/`.

### By Category

**Channel Plugins (24 messaging platforms):**
WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, BlueBubbles, iMessage, IRC, Microsoft Teams, Matrix, Feishu/Lark, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon/Urbit, Twitch, Zalo, Zalo Personal, WebChat, plus voice-call and device-pair

**LLM/AI Provider Plugins (25+ providers):**
OpenAI, Anthropic, Anthropic Vertex, Google, Amazon Bedrock, Mistral, Ollama, OpenRouter, GitHub Copilot, Perplexity, xAI, Together, NVIDIA, Hugging Face, fal, MiniMax, Moonshot, BytePlus, Chutes, Venice, Volcengine, vLLM, SGLang, Qianfan, Kimi, Xiaomi, Model Studio, Kilocode, OpenCode, OpenCode Go, Z.AI, Copilot Proxy, Cloudflare AI Gateway, Vercel AI Gateway

**Speech / Media Plugins:**
ElevenLabs (speech), Microsoft (speech), talk-voice

**Tool / Utility Plugins:**
Brave (web search), Firecrawl (web scraping), Tavily (web search), lobster (typed workflow pipelines), diffs (diff viewer), llm-task (JSON-only LLM tasks), open-prose (VM skill pack)

**Infrastructure Plugins:**
diagnostics-otel (OpenTelemetry), openshell (sandbox backend), acpx (ACP runtime), memory-core (memory tools), thread-ownership, phone-control, synthetic

**Auth Plugins:**
google-antigravity-auth, openai-codex-auth, qwen-portal-auth

### Plugin Architecture
- Plugins register via `definePluginEntry()` with `OpenClawPluginApi`
- Plugins can register: tools, CLI commands, memory prompt sections, context engines
- Memory is a special "kind" slot (only one memory plugin active at a time)
- Distribution: npm packages or local extension loading
- Plugin marketplace support exists (Claude marketplace, ClawHub)
- MCP integration via external `mcporter` bridge (not built into core)

---

## 4. Memory Architecture (Upstream vs ClawMongo)

### Upstream OpenClaw Memory
- **Default backends:** `builtin` (SQLite) and `qmd` (Quick Markdown) for vector/hybrid search
- **QMD:** QmdMemoryManager -- Markdown-file-based memory with vector search via LanceDB
- **Memory plugin slot:** `memory-core` extension provides `memory_search`, `memory_get`, `kb_search`, `memory_write` tools
- VISION.md states: "Memory is a special plugin slot where only one memory plugin can be active at a time. Today we ship multiple memory options; over time we plan to converge on one recommended default path."
- Upstream recently pivoted toward QMD as the recommended backend

### ClawMongo Memory (Fork Additions, 273 commits ahead)
- **MongoDB-only:** Community mongod + mongot, Voyage AI autoEmbed
- **20 collections, 53 standard indexes, up to 8 MongoDB Search indexes**
- **Canonical events architecture:** events as single source of truth, everything else derived
- **8 retrieval paths:** active-critical, procedural, structured, raw-window, graph, episodic, kb, hybrid
- **Knowledge graph:** $graphLookup with bi-directional expansion
- **Episode materialization:** auto-triggers on session gaps or event count thresholds
- **Structured memory:** salience, temporal validity, state, provenance, revision tracking
- **Procedures:** versioned workflow artifacts with intent tags and ordered steps
- **Retrieval planner:** pure-function path scoring based on query analysis
- **1,632 lines** in mongodb-schema.ts alone

### Key Architectural Gap
Upstream treats memory as a file/Markdown concern. ClawMongo treats memory as a database-first concern with explicit write/read/audit semantics. The fork's memory system is materially more sophisticated than upstream's QMD or SQLite paths.

---

## 5. Onboarding Flow

**34 files** under `src/commands/onboard*.ts` covering:
- `onboard.ts` -- main entry, dispatches to interactive or non-interactive
- `onboard-interactive.ts` -- step-by-step wizard
- `onboard-non-interactive.ts` -- scripted/headless setup
- `onboard-channels.ts` -- channel configuration
- `onboard-config.ts` -- config file generation
- `onboard-hooks.ts` -- hook setup
- `onboard-skills.ts` -- skill enablement
- `onboard-search.ts` -- provider search/discovery
- `onboard-custom.ts` -- custom provider setup
- `onboard-remote.ts` -- remote gateway setup
- `onboard-helpers.ts` -- shared utilities
- `onboard-types.ts` -- type definitions

**Key features:**
- Interactive wizard (default) or `--non-interactive` for CI/automation
- `--install-daemon` flag installs launchd/systemd user service
- Auth choices: setup-token (Anthropic), openai-codex (OAuth), etc.
- `--accept-risk` required for non-interactive mode (security gate)
- Reset scopes: `config`, `config+creds+sessions`, `full`
- Cross-platform: macOS, Linux, Windows (WSL2 recommended)

---

## 6. Companion Apps

OpenClaw ships native apps under `apps/`:
- **macOS** -- SwiftUI, Sparkle updates, voice wake, menubar gateway
- **iOS** -- SwiftUI, voice wake, Observation framework
- **Android** -- Kotlin, dark theme, Talk speech, SMS/call log search
- **shared** -- cross-platform code

This is unusual for an agent runtime. Most competitors are CLI-only or web-only.

---

## 7. Community Activity Patterns

### Issue Categories (8,756 open)
1. Gateway stability during long-running operations
2. Cross-platform compatibility (Windows/Linux filesystem)
3. Multi-language/localization gaps
4. Third-party service integration reliability
5. Plugin dependency resolution
6. Memory/session stability (OOM, leaks)
7. Channel-specific bugs (Telegram, Discord, Matrix)

### Contributing Bar
- Bugs/small fixes: direct PR welcome
- New features: start a Discussion or Discord first
- Refactor-only PRs: not accepted unless maintainer-requested
- AI-generated code: welcomed, must be marked and tested
- CI requirements: `pnpm build && pnpm check && pnpm test`

### Recent Changelog Activity (Unreleased)
The unreleased changelog section shows 50+ entries, indicating very high development velocity. Recent additions include:
- Anthropic Vertex provider support
- `/btw` side-question command
- Pluggable sandbox backends (OpenShell)
- SSH sandbox backend
- Firecrawl/Tavily web search providers
- Claude/Codex/Cursor bundle compatibility
- Plugin marketplace support
- MiniMax, Xiaomi model updates
- Telegram topic auto-labeling
- Matrix bot-to-bot communication
- GPT-5.4-mini/nano forward-compat

---

## 8. Competitive Landscape

### Direct Competitors

| Project | Stars | Language | Focus | Memory | Channels |
|---------|-------|----------|-------|--------|----------|
| **OpenClaw** | 329K | TypeScript | Personal assistant, multi-channel | SQLite/QMD/pluggable | 24 messaging platforms |
| **AutoGPT** | 183K | Python/TS | Agent builder platform, low-code | PostgreSQL | Web UI only |
| **CrewAI** | 46.8K | Python | Multi-agent orchestration | Pluggable | None (library) |
| **LangChain** | ~90K | Python/JS | LLM framework/toolkit | Pluggable (100+ stores) | None (library) |

### What Makes OpenClaw Unique

1. **Multi-channel native:** 24 messaging platforms, all in one runtime. No other agent framework comes close. AutoGPT has a web UI. CrewAI has nothing. LangChain is a library.

2. **Self-hosted, single-user, privacy-first:** runs on your devices, local gateway binds to loopback. Not a SaaS platform.

3. **Native companion apps:** macOS, iOS, Android apps with voice wake, canvas, TUI. AutoGPT has a web builder. CrewAI has a cloud offering. Neither has native apps.

4. **25+ LLM providers:** provider plugins for essentially every major and niche LLM provider. Most frameworks support 5-10.

5. **Plugin SDK depth:** 35+ subpath exports, channel/provider/tool/memory/context-engine extension points. The plugin surface is production-grade, not a toy API.

6. **Active development velocity:** 20,918 commits, 50+ unreleased changelog entries, 15+ named maintainers. This is one of the most actively developed open-source agent projects.

7. **Security posture:** dedicated SECURITY.md, GHSA workflow, trust page, DM pairing policies, SSRF protection, secret-ref system, sandbox backends. Most agent frameworks treat security as an afterthought.

### Where OpenClaw is Weaker vs Competitors

1. **Multi-agent orchestration:** CrewAI's role-based crew/flow model is more sophisticated for multi-agent task decomposition. OpenClaw's multi-agent is per-workspace isolation, not collaborative crews.

2. **Workflow automation:** AutoGPT's visual builder is more accessible for non-developers. OpenClaw is terminal-first by design.

3. **Memory sophistication (upstream):** Upstream's QMD/SQLite memory is basic compared to what LangChain can plug into (100+ vector stores). ClawMongo addresses this gap with MongoDB-native memory.

4. **Python ecosystem:** CrewAI and LangChain have Python's AI/ML ecosystem advantage. OpenClaw's TypeScript choice trades ecosystem breadth for hackability and web-developer familiarity.

---

## 9. Other Forks / Variants

The fork network shows hundreds of forks, with several patterns:
- **Renamed forks:** `clawdbot`, `moltbot` appear dozens of times (legacy names)
- **Specialized forks:** `openclaw-meets-kiro`, `openclaw-msns`, `openclaw-westworld`, `openclaw-rust`
- **ClawMongo** (this fork): the only known MongoDB-native fork with 273 commits of divergence

No other fork appears to have the scope of architectural divergence that ClawMongo has with its MongoDB-first memory rewrite.

---

## 10. What Makes ClawMongo Differentiated from Upstream

| Dimension | Upstream OpenClaw | ClawMongo |
|-----------|-------------------|-----------|
| Memory backend | SQLite / QMD (Markdown + LanceDB) | MongoDB Community + mongot |
| Memory model | File-based, flat search | Event-sourced, 20 collections, 8 retrieval paths |
| Vector search | LanceDB local | Voyage AI autoEmbed via mongot (no app-side embedding code) |
| Knowledge graph | None | $graphLookup with entities/relations/bi-directional expansion |
| Episodes | None | Auto-materialized from event windows |
| Structured memory | Basic | Salience, temporal validity, state, provenance, revision tracking |
| Procedures | None | Versioned workflow artifacts with intent tags |
| Retrieval planning | Simple search | 8-path planner with query analysis |
| Operational visibility | Limited | Ingest runs, projection runs, relevance telemetry |
| Collections | ~2 | 20 |
| Indexes | Few | 53 standard + 8 search indexes |

---

## What Changed the Recommendation

**Highest-signal finding:** OpenClaw has 329K stars and 1.1M weekly npm downloads, making it one of the most popular open-source agent projects globally -- far larger than AutoGPT (183K stars) in star count and community size. The upstream project is actively developed with 15+ maintainers, 78 extensions, 24 messaging channels, and native apps for 3 platforms. However, upstream's memory system (QMD/SQLite) is the acknowledged weak point -- VISION.md explicitly states they plan to "converge on one recommended default path" for memory. ClawMongo's MongoDB-native memory architecture (20 collections, 8 retrieval paths, knowledge graph, episodes, procedures) fills the exact gap that upstream acknowledges but has not yet addressed. This positions ClawMongo not as a competing fork but as the production memory backend that OpenClaw needs.

## References
- https://github.com/openclaw/openclaw (329K stars)
- https://www.npmjs.com/package/openclaw (1.1M weekly downloads)
- https://deepwiki.com/openclaw/openclaw
- https://github.com/Significant-Gravitas/AutoGPT (183K stars)
- https://github.com/crewAIInc/crewAI (46.8K stars)
- https://docs.openclaw.ai
- Local: VISION.md, CONTRIBUTING.md, CHANGELOG.md, package.json
- Local: extensions/ (78 plugins), src/memory/ (MongoDB architecture), src/commands/onboard*.ts (34 files)

---
GitHub research complete.
