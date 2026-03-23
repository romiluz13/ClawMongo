# Web Research: Company OS and AI Agent Runtime UIs

## Execution

- Preferred backend: websearch+webfetch
- Allowed fallbacks: webfetch-only
- Research round: 1

## Sources Used

- WebFetch on 18 URLs (primary source, Bright Data unavailable)
- Bright Data: unavailable (not configured in this environment)

## Research Quality

- Status: COMPLETE
- Quality level: high
- Backend mode: webfetch-only

---

## Part 1: What is "Company OS"?

### Definition

"Company OS" (Company Operating System) refers to a unified platform that acts as the operating layer for an entire company — managing workflows, agents, data, communications, and decision-making in one coherent interface, analogous to how an OS manages resources on a computer.

The term draws from the computer OS metaphor: just as macOS/Windows manages memory, processes, and I/O for applications, a Company OS manages agents, data flows, tools, and human decisions for an organization.

### Canonical Example: Dust.tt

Dust.tt uses this language explicitly. Their homepage states they are **"The Operating System for AI Agents"** and describes their platform as "core building blocks for AI to connect your team's knowledge and workflows."

Key Dust features:

- Manage a fleet of specialized AI agents per team/function
- Connect to cross-silo data (Slack, Notion, Confluence, GitHub)
- No-code agent deployment
- Model-agnostic (GPT, Claude, Gemini)
- Autonomous multi-tool problem solving (search + data analysis + web navigation)

### Other Products Using This Concept

| Product     | Positioning                                                    | Key Idea                                                 |
| ----------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| **Dust.tt** | "OS for AI Agents"                                             | Fleet management + cross-silo data connectors            |
| **Notion**  | "AI workspace"                                                 | Agents embedded in docs/wikis + custom agents            |
| **Linear**  | "Purpose-built system where teams and agents operate together" | Issue tracking as coordination substrate for humans + AI |
| **Retool**  | "Build internal software better, with AI"                      | Internal tooling + AI agent creation layer               |
| **n8n**     | "AI-native workflow automation"                                | LangChain-based agent workflows + 400+ integrations      |

### How Company OS Differs from Traditional SaaS Dashboards

| Traditional SaaS          | Company OS                             |
| ------------------------- | -------------------------------------- |
| Static data views         | Live, agentic data processing          |
| Per-tool login            | Unified identity + permissions         |
| Human does all actions    | Agents execute on behalf of humans     |
| Tool-by-tool integrations | Cross-silo data fabric                 |
| Notification-driven       | Event/interrupt-driven agent loops     |
| CRUD forms                | Natural language interfaces            |
| Reactive (report on past) | Proactive (agents take future actions) |

### The Linear Philosophy (Most Articulate Non-AI Example)

Linear articulates this most clearly for developer tooling: "AI is fundamentally changing how products get built... the increased capability requires better coordination and clarity... a purpose-built system where teams and agents operate together in a shared, structured environment."

This is the essence of Company OS: **structured substrate where humans and agents co-work**.

---

## Part 2: Best Open Source UIs for AI Agent Runtimes

### 1. Open WebUI (74k+ stars)

**URL:** github.com/open-webui/open-webui
**Stack:** SvelteKit + Python backend
**Best for:** Replacing ChatGPT UI with full self-hosted parity

Key features:

- Multi-model simultaneous conversations
- RAG with 9 vector DB options + 15+ web search providers
- RBAC with LDAP/AD + SCIM 2.0
- Native Python function calling with code editor
- Model Builder for custom agent/character creation
- Pipelines framework (plugin architecture)
- OpenTelemetry observability
- PWA for offline mobile access
- Voice/video with multiple speech providers

**Verdict:** Best "drop-in ChatGPT replacement" with enterprise features. Very polished, very extensible.

---

### 2. Lobe Chat (74.1k stars)

**URL:** github.com/lobehub/lobe-chat
**Stack:** Next.js + Drizzle ORM + Zustand + pnpm monorepo
**Best for:** Modern, beautiful agent-first chat UI

Key features:

- Agents as the Unit of Work (not conversations)
- Multi-agent collaboration and Agent Groups
- MCP marketplace with 10,000+ skills (one-click install)
- Chain of Thought visualization
- Branching conversation trees
- "White-Box Memory" — structured, editable agent memory
- Scheduled agent runs (cron-style)
- Workspace + Project + Team organization
- Desktop app (alongside web)
- PWA + mobile adaptation

**Verdict:** The most visually impressive open-source agent chat UI. Modern React patterns, very close to a "Company OS" vision.

---

### 3. LibreChat (34.8k stars)

**URL:** github.com/danny-avila/LibreChat
**Stack:** TypeScript + Node.js + React
**Best for:** Maximum provider compatibility + code execution

Key features:

- All major providers (Anthropic, OpenAI, Azure, Google, AWS Bedrock, Ollama)
- Sandboxed Code Interpreter (multiple languages)
- LibreChat Agents marketplace
- MCP tool integration
- Resumable streams (reconnects dropped responses)
- Voice input/output
- 30+ languages
- Multi-user OAuth2 + LDAP auth
- Docker + Kubernetes deployment

**Verdict:** Best "batteries included" self-hosted AI chat. Strong for developer teams needing code execution.

---

### 4. LangGraph Studio

**URL:** docs.langchain.com/langsmith/studio
**Stack:** Desktop app (Apple Silicon first) + LangSmith backend
**Best for:** Agent debugging and development iteration

Key features:

- Graph visualization of agent architecture
- Real-time execution streaming
- Debug mode: step-by-step walkthrough
- State modification mid-execution
- Time-travel debugging (rewind agent state)
- Node replay without full restart
- Two modes: Graph mode (developer) + Chat mode (business user)
- Thread management + long-term memory
- Prompt engineering panel
- Experiment runner over datasets

**Verdict:** Best developer IDE experience for agent graphs. Not a product UI — a dev tool. The gold standard for "what agent debugging should look like."

---

### 5. Dify (134k stars — most starred)

**URL:** github.com/langgenius/dify
**Stack:** Python backend + React frontend
**Best for:** Full LLMOps lifecycle with visual workflow builder

Key features:

- Visual workflow builder (drag-and-drop)
- Multi-model support (GPT, Mistral, Llama3, all OpenAI-compatible)
- RAG pipeline with multi-format document ingestion
- 50+ built-in tools for agents (Google Search, DALL-E, Stable Diffusion, etc.)
- ReAct and function-calling agent frameworks
- LLMOps: monitoring and optimization from production data
- Observability integrations (Langfuse, Opik, Arize Phoenix)
- Full API for enterprise integration
- Docker Compose quick start

**Verdict:** Most complete open-source "build + deploy + monitor" platform. Closest to Retool but for AI workflows.

---

### 6. Flowise (51k+ stars)

**URL:** github.com/FlowiseAI/Flowise
**Stack:** Node.js + React
**Best for:** Low-code visual agent building

Key features:

- Drag-and-drop agent/workflow builder
- LangChain + OpenAI integrations
- Multi-agent system support
- RAG support
- Broad cloud deployment options (AWS, Azure, GCP, etc.)

**Verdict:** Simpler than Dify, easier entry point. Less LLMOps, more prototyping.

---

### 7. n8n (100k+ stars)

**URL:** github.com/n8n-io/n8n
**Stack:** TypeScript + Vue.js
**Best for:** Workflow automation with AI agent nodes

Key features:

- "AI-native platform" built on LangChain
- 400+ integrations + 900+ templates
- Code flexibility (JavaScript/Python inside nodes)
- Self-hosting with fair-code license
- SSO + advanced permissions + air-gapped deployments
- Agent nodes within broader automation workflows

**Verdict:** Best if agent work is one piece of larger automation. Not agent-first but extremely powerful for enterprise automation.

---

### 8. AutoGen Studio (Microsoft)

**URL:** github.com/microsoft/autogen
**Stack:** Python + React
**Best for:** Rapid multi-agent prototyping without code

Key features:

- No-code GUI for multi-agent workflows
- Group chat mechanism for agent teams
- Skill enhancement per agent
- Session management
- SQLite/PostgreSQL/MySQL backend
- AutoGen Bench for performance evaluation
- Console UI for real-time streaming

**Verdict:** Best for Microsoft/Python-native teams. Under active development (v0.4 rewrite underway).

---

### 9. LangChain Agent Inbox

**URL:** github.com/langchain-ai/agent-inbox
**Stack:** React + LangGraph backend
**Best for:** Human-in-the-loop approval interfaces

Key features:

- Interrupt management UI (Accept / Edit / Respond / Ignore)
- Per-interrupt configuration (which actions to allow)
- Connects to LangGraph deployments
- Hosted version at dev.agentinbox.ai
- Structured interrupt schema

**Verdict:** Purpose-built for the HITL pattern. Not a full UI but a critical component for safe autonomous agents.

---

### 10. OpenHands / All-Hands (formerly OpenDevin)

**URL:** github.com/All-Hands-AI/OpenHands
**Stack:** Python + React SPA + REST API
**Best for:** Autonomous software engineering agents

Key features:

- SDK + CLI + Local GUI + Cloud + Enterprise
- 77.6 SWEBench score (near-SOTA)
- RBAC + multi-user support
- Slack, Jira, Linear integrations (cloud)
- REST API + React SPA interface
- MIT core, source-available enterprise

**Verdict:** Best open-source coding agent with a UI. Real production-grade software engineering automation.

---

### 11. ElizaOS (formerly ai16z)

**URL:** github.com/elizaOS/eliza
**Stack:** TypeScript + Tauri (desktop)
**Best for:** Social/conversational agents with rich integrations

Key features:

- Web dashboard for managing agents, groups, conversations
- CLI for scaffolding and management
- Desktop app (Tauri — cross-platform)
- REST API
- Discord, Telegram, Farcaster connectors
- Plugin architecture
- RAG support
- Multi-model (OpenAI, Gemini, Anthropic, Llama, Grok)
- Agent group orchestration

**Verdict:** Best for social/community agents. The dashboard is unusually polished for the category.

---

## Part 3: Observability / LLMOps Layer

### Langfuse (23.6k stars)

**URL:** github.com/langfuse/langfuse
**Best for:** Full LLM engineering lifecycle visibility

Key features:

- Distributed tracing (OpenTelemetry-based)
- Prompt version management + LLM Playground
- LLM-as-a-judge evaluation
- User feedback collection
- Manual annotation workflows
- Dataset management + experiments
- Cost / latency / quality dashboards
- Session tracking (multi-turn conversations as units)
- Agent graphs in UI (complex workflow visualization)
- Self-hosted (Docker / K8s / Terraform) + cloud
- MIT licensed (except enterprise folder)
- Integrates with: CrewAI, AutoGen, LangChain, LlamaIndex, Vercel AI SDK

**Verdict:** The most complete open-source LLMOps platform. Every agent runtime should integrate this.

---

### Helicone (open source)

**Best for:** AI gateway + observability combined

Key features:

- Unified dashboard across all LLM providers
- Token-level cost analysis
- Rate limiting + load balancing (gateway layer)
- Caching + failover
- Hallucination / abuse alerts
- Sub-1ms latency overhead
- SOC 2 Type II

**Verdict:** Best if you need both routing and observability in one tool. More ops-focused than Langfuse.

---

## Part 4: Key Features of a Foundation UI for Company OS

Based on analysis of all the above platforms, a "foundation UI" for an agent runtime should include:

### Tier 1: Must-Have (Table Stakes)

1. **Conversation interface** — Streaming, markdown, code blocks, syntax highlighting
2. **Tool call visualization** — Show which tool was called, with what args, and the result
3. **Agent state display** — Current agent, current task, current context
4. **Multi-model switching** — Switch LLM provider/model per conversation
5. **File/attachment handling** — Upload files, reference them in context
6. **Search across history** — Semantic or full-text search of past conversations

### Tier 2: Core Agent Runtime Features

7. **Memory management panel** — View, edit, delete long-term memories
8. **Context window display** — Show what's in context, token count, truncation warnings
9. **Agent selection / routing** — Switch between specialized agents
10. **Thread management** — Multiple parallel conversations, fork a thread
11. **Human-in-the-loop interrupts** — Approve/reject/edit agent actions before execution
12. **Code execution output** — REPL-style output with stdout/stderr

### Tier 3: Power Features (Differentiation)

13. **Graph visualization** — Visual agent flow (LangGraph Studio style)
14. **Time-travel / replay** — Step back to a previous state, replay from there
15. **State inspection** — Inspect agent's internal state at any step
16. **Evaluation / scoring** — Rate responses, build eval datasets
17. **Prompt management** — Version-controlled prompts with playground
18. **Multi-agent coordination panel** — See multiple agents running in parallel
19. **Task queue** — Async tasks with progress, can be paused/resumed
20. **Team/workspace** — Shared conversations, agent configs, permissions

### Tier 4: Enterprise / Company OS Features

21. **RBAC** — Role-based access (who can use which agents)
22. **Audit trail** — Who did what, when, which agent
23. **Cost tracking** — Per-user, per-team, per-agent token costs
24. **SSO / LDAP** — Enterprise auth
25. **API-first** — Everything accessible programmatically
26. **Webhook / event bus** — Trigger agents from external events
27. **Integrations panel** — Configure data sources (Slack, Notion, GitHub, etc.)

---

## Part 5: Recommended Tech Stack for Building Such a UI

### Frontend

| Layer         | Recommendation              | Rationale                                               |
| ------------- | --------------------------- | ------------------------------------------------------- |
| Framework     | **Next.js 15 (App Router)** | SSR + streaming, used by Lobe Chat                      |
| UI Components | **shadcn/ui + Radix**       | Headless, accessible, composable                        |
| Styling       | **Tailwind CSS**            | Utility-first, fast iteration                           |
| State         | **Zustand** + **Jotai**     | Lobe Chat pattern; Zustand for global, Jotai for atomic |
| Data fetching | **TanStack Query**          | Cache + background refetch for agent state              |
| AI streaming  | **Vercel AI SDK**           | Best-in-class streaming + tool call handling            |
| Graphs        | **React Flow / XYFlow**     | LangGraph Studio uses this for graph viz                |
| Markdown      | **react-markdown + Shiki**  | Streaming-safe, syntax highlighting                     |
| Monorepo      | **pnpm + Turborepo**        | Same pattern as Lobe Chat                               |

### Backend / Runtime

| Layer         | Recommendation                           | Rationale                                         |
| ------------- | ---------------------------------------- | ------------------------------------------------- |
| Runtime       | **Node.js 22 / Bun**                     | TypeScript-native, fast                           |
| API           | **Hono** or **tRPC**                     | Type-safe, edge-compatible                        |
| Observability | **Langfuse** (self-hosted)               | Full LLMOps without vendor lock-in                |
| Auth          | **Clerk** or **Auth.js**                 | SSO + RBAC with minimal setup                     |
| DB            | **MongoDB**                              | Document model maps cleanly to agent memory/state |
| Realtime      | **Server-Sent Events** or **WebSockets** | For streaming agent output                        |
| Queue         | **BullMQ** (Redis)                       | For async/background agent tasks                  |

### Architecture Pattern: "Agent Inbox + Runtime Dashboard"

The highest-leverage architecture combines:

1. **Left sidebar**: Agent/workspace selector + thread list (LibreChat/Lobe Chat pattern)
2. **Center**: Streaming chat with tool call cards inline (Vercel AI SDK pattern)
3. **Right panel**: Context inspector — current memory, tool state, token usage
4. **Bottom drawer**: Task queue — async jobs, their status, replay controls
5. **Top bar**: Model selector, agent switcher, cost meter
6. **Overlay**: LangGraph Studio-style graph view (toggle)

### What Changed the Recommendation

The key insight from researching these platforms: **LangGraph Studio's graph view + Agent Inbox's interrupt pattern + Lobe Chat's agent-centric UX** are the three design patterns worth stealing. Most existing UIs are either conversation-first (too chat-app-like) or workflow-first (too no-code drag-drop). The gap is a **developer-grade, agent-native UI** that treats agents as long-running processes with state, not as stateless chat endpoints.

---

## Part 6: Competitive Positioning

### "Company OS for Developers" Quadrant

```
                  More opinionated (fixed workflows)
                           |
                 Dify      |    n8n
                 Flowise   |    Zapier AI
                           |
  Agent-focused ----------+---------- Workflow-focused
                           |
                 LangGraph |    Retool
                 Studio    |    Appsmith
                           |
                  More flexible (build anything)
```

The **sweet spot for a developer Company OS**: Agent-focused + flexible enough to extend. Closest to LangGraph Studio but with a production-facing UI (not just a dev tool).

### Gaps in the Market

1. **No open-source Dust.tt**: There's no fully open-source "fleet management for multiple specialized agents" UI with cross-tool data connectors.
2. **No unified agent + observability**: Every team runs Langfuse separately from their chat UI. An integrated experience (like Cursor has for traces) doesn't exist OSS.
3. **No developer-grade HITL**: Agent Inbox is narrow (LangGraph only). A generic interrupt/approval UI for any agent runtime is missing.
4. **No agent memory inspector**: White-box memory (Lobe Chat) exists but not with proper CRUD + semantic search over long-term memory.

---

## Key Findings

- "Company OS" is an explicit positioning used by Dust.tt, and implicitly by Linear, Notion, and Retool — it means a unified platform where agents + humans share structured workflows, not just a dashboard
- Lobe Chat (74.1k stars, Next.js) is the closest open-source UI to the Company OS vision with agent-centric design, MCP marketplace, scheduled runs, and white-box memory
- Open WebUI (74k stars) is the most polished self-hosted LLM interface with enterprise features, but less agent-centric
- Dify (134k stars) is the most feature-complete LLMOps platform combining build + deploy + monitor
- LangGraph Studio defines the gold standard for agent debugging UX (graph viz, time-travel, state inspection)
- Langfuse is the best open-source observability layer and should be integrated into any Company OS
- The missing OSS product: a developer-grade, agent-native UI combining LangGraph-style graph views, Lobe Chat's agent management, Langfuse's observability, and Agent Inbox's HITL pattern in one coherent interface

## What Changed the Recommendation

**Lobe Chat's "Agents as the Unit of Work" pattern** is the single highest-signal architectural insight. Every other platform treats chat as the primary unit (messages, threads). Lobe Chat inverts this: agents are the unit, conversations are ephemeral. For a Company OS, this is the right mental model — you manage a fleet of agents, each with persistent memory, scheduled runs, and toolkits, and conversations are just one interaction modality.

## Gotchas / Warnings

- LangGraph Studio is **desktop-only** (Apple Silicon), not a web app — not directly forkable for a web UI
- Open WebUI uses SvelteKit (not React/Next.js), so forking it means adopting Svelte
- Dify's license is **not fully MIT** — check Apache 2.0 restrictions for commercial use
- n8n uses **fair-code license** (not OSI-approved) — cannot use commercially without a license
- LibreChat is MIT but the codebase is very large; harder to use as a foundation than Lobe Chat
- AutoGen Studio is under active rewrite (v0.4 API changes) — pinning a version before forking is critical
- ElizaOS (elizaOS/eliza) had license controversy in 2024 — check current license status before commercial use

## References

- https://github.com/open-webui/open-webui
- https://github.com/lobehub/lobe-chat
- https://github.com/danny-avila/LibreChat
- https://github.com/langgenius/dify
- https://github.com/FlowiseAI/Flowise
- https://github.com/n8n-io/n8n
- https://github.com/microsoft/autogen
- https://github.com/langchain-ai/agent-inbox
- https://github.com/All-Hands-AI/OpenHands
- https://github.com/elizaOS/eliza
- https://github.com/langfuse/langfuse
- https://helicone.ai
- https://dust.tt
- https://retool.com
- https://linear.app
- https://blog.langchain.com/langgraph-studio-the-first-agent-ide/
- https://docs.langchain.com/langsmith/studio

---

Web research complete.
