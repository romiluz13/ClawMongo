# GitHub Research: AI Agent Management UI Foundations

## Execution

- Preferred backend: octocode+web
- Allowed fallbacks: web-only
- Research round: 1

## Sources Used

- WebFetch: GitHub repository pages, raw source files, official docs
- Octocode MCP: unavailable (not connected in this session)
- Fallback: web-only research path used

## Research Quality

- Status: COMPLETE
- Quality level: medium
- Backend mode: web-only

---

## 1. Open WebUI (open-webui/open-webui)

### Metrics

- Stars: 128k | Forks: 18.1k | Commits: 15,761
- License: MIT
- Actively maintained

### Tech Stack

- **Frontend**: SvelteKit + TypeScript + Tailwind CSS + Vite
- **Backend**: Python + FastAPI + Socket.IO (WebSocket)
- **Database**: SQLite (default) or PostgreSQL
- **Real-time**: Socket.IO with Redis adapter for multi-node
- **Auth**: JWT, LDAP, SCIM 2.0, SSO, OAuth

### Architecture

SvelteKit file-based routing (`src/routes/(app)/`). Global state via Svelte writable stores (50+ stores covering chat, models, tools, user, settings, UI state). Backend is a FastAPI monolith with ~20 routers (chats, users, models, knowledge, tools, functions, memories, channels, auths, analytics, pipelines, ollama, openai, audio, images, retrieval, terminals). WebSocket layer is Socket.IO mounted at `/ws` with room-based event delivery (`user:{id}`) for streaming chat deltas, agent status, and collaborative editing (Yjs).

**Pipeline system**: Separate plugin server (port 9099) that acts as a middleware layer between the UI and any OpenAI-compatible backend. Pipelines are Python modules auto-discovered from a `/pipelines` directory. Two types: `Pipe` (full request handler) and `Filter` (pre/post processing). This enables: custom RAG, rate limiting, monitoring (Langfuse, Opik), content filtering, and arbitrary agent logic — all without modifying core.

**Key stores**:

- `models: Writable<Model[]>` — all available models
- `tools, skills, functions` — agent capabilities
- `socket` — the live Socket.IO connection
- `activeUserIds, activeChatIds` — collaborative presence
- `settings: Writable<Settings>` — 50+ config options per user

### Multi-model/Agent Management

- Simultaneous conversations across multiple models (one message, N responses)
- Model builder for custom agents with system prompts + tools
- RBAC: users, groups, permissions down to individual model access
- Admin analytics: message volume, token consumption, user activity

### Admin Features

- User + group management with granular permissions
- Bulk model management with filtering
- SCIM 2.0 provisioning
- Webhook integration
- 9 vector DB backends
- Cloud storage (S3, GCS, Azure Blob)
- OpenTelemetry observability

### Pros for OpenClaw UI Foundation

- Largest community (128k stars) — battle-tested at scale
- SvelteKit is extremely fast and lightweight
- Pipeline plugin system is directly analogous to OpenClaw extensions
- WebSocket architecture (Socket.IO + Redis) maps cleanly to OpenClaw's channel/gateway model
- RBAC + admin panel already built
- OpenAI-compatible API pass-through — can proxy OpenClaw's API

### Cons

- Svelte: smaller ecosystem than React/Next.js, fewer component libraries
- Python backend (FastAPI) — OpenClaw is Node.js/TypeScript; bridging adds latency
- Very chat-centric — agent flow visualization is missing
- No visual workflow editor
- The codebase is large and tightly coupled to Ollama/OpenAI paradigm

---

## 2. Dify (langgenius/dify)

### Metrics

- Stars: 134k | Forks: 20.9k | Commits: 9,532
- License: Apache 2.0
- Actively maintained

### Tech Stack

- **Frontend**: Next.js 14 (App Router) + React + TypeScript + Tailwind CSS
- **State management**: Jotai (atoms) + TanStack Query (server state) + Nuqs (URL state)
- **Backend**: Python (Flask/Celery)
- **Database**: PostgreSQL + Redis + Weaviate/Qdrant (vector)
- **Auth**: JWT, SSO, enterprise LDAP

### Architecture

Next.js App Router with route groups `(commonLayout)` for shared layouts. Provider stack (bottom to top): Jotai, ThemeProvider, NuqsAdapter, TanStack Query, I18n, Toast, GlobalPublicStore. The visual workflow canvas is a React-based node graph editor. Backend is Python (Flask) with Celery for async task execution.

**Workflow engine**: Visual canvas with typed node categories:

- LLM nodes (prompt + model selection)
- Tool nodes (web search, code, HTTP, etc.)
- Logic nodes (if/else, iteration, variable assignment)
- Agent nodes (ReAct, Function Calling)
- RAG nodes (knowledge retrieval)
- Output nodes (answer, end)

Nodes emit SSE events upstream to the UI for real-time execution tracing. Each workflow execution is tracked with a run ID and full state log.

**App types**: Chatbot, Agent, Workflow (batch), Chatflow (conversational workflow). Each type has a dedicated canvas experience.

### Multi-Agent Orchestration

- Visual multi-agent canvas: each agent is a node that can call tools or other agents
- Parallel branch execution with merge nodes
- Iteration nodes for loops over arrays
- Built-in error handling and retry logic per node

### What Makes It "Company OS"

- Workspace concept: projects/apps/teams all in one platform
- Prompt management with versioning
- Knowledge base management (document ingestion pipeline)
- API-first: every workflow/agent exposes a REST + SSE API automatically
- Observability integrated (Langfuse, Opik, Arize Phoenix)
- 50+ built-in tools + custom tool registry

### Pros for OpenClaw UI Foundation

- Next.js 14 App Router — modern React, great ecosystem
- Visual workflow canvas is exactly what "company OS" agents need
- Jotai + TanStack Query is a clean, scalable state pattern
- App Router SSR is good for admin dashboards
- API-first design mirrors OpenClaw's architecture

### Cons

- Python backend — mismatch with OpenClaw's Node.js stack
- Very complex codebase (~134k lines across backend + frontend)
- The canvas is tightly coupled to Dify's node type system (hard to reuse standalone)
- Requires Celery + Redis + PostgreSQL + vector DB — heavy infra
- License is Apache 2.0 but enterprise features are closed-source (Dify Cloud)

---

## 3. LangGraph / LangSmith Studio

### Metrics

- LangGraph repo: 27.2k stars | 4.7k forks
- LangSmith Studio: proprietary (not open source)
- LangGraph: Python 99.3%, MIT license

### Architecture

LangGraph is a **backend-only** Python framework. The visual "Studio" is part of LangSmith, which is a paid SaaS product — the UI source is not open source.

**What LangGraph provides for UI builders**:

- Graph state serialization (JSON-serializable state dicts)
- Streaming execution events via `astream_events()`
- Checkpoints stored in databases (Postgres, SQLite, MongoDB) for state replay
- Thread management API for multi-session agent runs
- Built-in interrupt/resume for human-in-the-loop

**LangGraph Server** (OSS): FastAPI server that exposes a REST + SSE API over LangGraph graphs. Endpoints: `POST /runs`, `GET /runs/{id}/stream`, `POST /threads`, `GET /threads/{id}/state`. This is the backend protocol that any UI can target.

### What Makes LangGraph Studio Relevant

- The Studio shows a live animated graph: nodes light up as they execute, edges show data flow
- State inspector panel: shows the current state dict at each step
- Interrupt points: the UI can pause a running graph and inject human input
- Time-travel: rewind execution to any checkpoint and replay from there

### Pros

- The protocol (LangGraph Server API) is clean and well-documented
- OpenClaw could implement a compatible API surface and get Studio-like visualization
- Streaming events model maps well to OpenClaw's streaming architecture

### Cons

- Studio UI itself is NOT open source — you cannot fork it
- LangGraph is Python-only; OpenClaw is TypeScript
- The visualization is graph-inspection, not management (no user admin, no channel config)
- LangSmith platform is SaaS-only (usage limits, pricing)

---

## 4. Flowise (FlowiseAI/Flowise)

### Metrics

- Stars: 51k | Forks: 24k | Commits: 3,435
- License: Apache 2.0
- Latest: v3.1.0 (March 2026)

### Tech Stack

- **Frontend**: React + TypeScript + Vite
- **Backend**: Node.js + Express.js
- **Monorepo**: pnpm + Turbo (5 packages: agentflow, api-documentation, components, server, ui)
- **Queue**: BullMQ + Redis (for async node execution)
- **API docs**: Auto-generated Swagger

### Architecture

Node.js monorepo. The server loads a `NodesPool` at startup — a registry of all available node types (LangChain tools, memory backends, LLM providers, etc.) compiled from the `components` package. When a user builds a flow in the UI and executes it, the server resolves the node graph, instantiates each node with its config, chains them, and streams results back via SSE.

The UI is a React canvas (ReactFlow-based) where users drag-and-drop node components to build chatflows or agentflows. Each node has a config panel. Flows are saved as JSON documents. API key management is built in (users can generate API keys to call their flows via REST).

**AgentFlow v2** (new in v3): Multi-agent support. Supervisor nodes can spawn sub-agents. Sequential and parallel execution patterns. Human-in-the-loop interrupts.

### Pros for OpenClaw UI Foundation

- **Node.js backend** — same runtime as OpenClaw, easy integration
- **React frontend** — largest ecosystem, most component libraries
- **ReactFlow canvas** — proven for agent flow visualization (can be extracted)
- Clean REST API: `/api/v1/` namespace, Swagger docs auto-generated
- BullMQ queue — maps well to OpenClaw's async agent task model
- Active community (51k stars) and recent v3 release

### Cons

- UI is tightly LangChain-coupled — node types are all LangChain primitives
- ReactFlow canvas is good for flow design but not for "management" (no real admin panel)
- No built-in multi-user auth / RBAC (only API keys)
- SSE for streaming (no WebSocket) — less real-time capability than Socket.IO
- Monorepo is complex; the components package is >300 LangChain nodes

---

## 5. n8n (n8n-io/n8n)

### Metrics

- Stars: 181k | Forks: 56k | Commits: 18,517
- License: Sustainable Use License (not fully open source)
- Most starred in this comparison

### Tech Stack

- **Frontend**: Vue 3 + TypeScript (91% TypeScript, 7% Vue)
- **Backend**: Node.js + TypeScript
- **Monorepo**: pnpm workspaces (packages: cli, core, workflow, frontend, nodes-base, @n8n/\*)
- **Queue**: Bull (Redis)
- **Database**: SQLite (default), PostgreSQL, MySQL

### Architecture

n8n is a general automation platform that added AI/agent capabilities. The workflow execution engine (`packages/workflow/src/workflow.ts`) is a graph traversal engine: it identifies trigger nodes as entry points, then walks the directed graph node-by-node, resolving each node's output as input to the next. Supports parallel branches, error paths, and disabled nodes.

The frontend is Vue 3 + a canvas editor (custom canvas, not ReactFlow). Each workflow is a JSON document with nodes and connections. The UI editor is in `packages/frontend/`. The backend CLI (`packages/cli/`) starts the Express server, registers webhooks, and manages execution queue.

**AI agent types** (via LangChain integration):

- Conversational Agent
- OpenAI Functions Agent
- ReAct Agent
- Plan and Execute Agent
- SQL Agent
- Tools Agent

Memory and vector store integrations are first-class nodes.

### Pros

- Largest community (181k stars) — extremely mature
- TypeScript throughout (frontend and backend)
- Most complete workflow orchestration primitives
- 400+ integrations and 900+ templates
- Excellent queue/scheduling/retry handling

### Cons

- **License**: Sustainable Use License — not MIT/Apache, commercial use restrictions
- Vue 3 frontend — less common for new projects vs React/Next.js
- General automation tool first, AI agent management second
- No purpose-built "agent management panel" (users/roles/RBAC is enterprise-only)
- Heavy: requires Redis + DB + separate queue worker for production
- Agent capabilities bolted on via LangChain nodes, not native

---

## 6. LibreChat (danny-avila/LibreChat)

### Metrics

- Stars: 34.8k | Forks: 7.1k | Contributors: 360+
- License: MIT

### Tech Stack

- **Frontend**: React + TypeScript
- **Backend**: Node.js + Express + TypeScript
- **Database**: MongoDB (primary!) + Redis
- **Monorepo**: Turbo + pnpm
- **Auth**: JWT, OAuth2, LDAP, email

### Architecture

LibreChat is the closest architectural match to OpenClaw: Node.js/TypeScript monorepo, MongoDB as primary database, React frontend, Express backend. It has a conversation forking model (branching chat history), resumable streams with Redis, and MCP (Model Context Protocol) server integration.

**Agent marketplace**: Users can create, share, and install community agents. Each agent has: system prompt, model selection, tools (web search, code interpreter, file analysis), and visibility (private/shared/public).

**MCP integration**: LibreChat supports connecting MCP servers directly, which is architecturally identical to OpenClaw's extension/plugin model.

### Pros for OpenClaw UI Foundation

- **MongoDB primary database** — direct match to ClawMongo architecture
- **Node.js + TypeScript** — same runtime as OpenClaw
- **React frontend** — large ecosystem
- MCP support — same protocol OpenClaw uses
- Conversation forking — useful for agent branching
- Multi-provider (Anthropic, OpenAI, Bedrock, etc.)
- MIT license — no restrictions

### Cons

- Chat-first, not agent-management-first (no visual workflow canvas)
- Agent "marketplace" is social/community feature, not enterprise orchestration
- No visual flow editor
- 34.8k stars — smaller community than Open WebUI/Dify/n8n
- The UI is consumer-chat aesthetic, not "company OS" dashboard

---

## Architecture Comparison Matrix

| Dimension       | Open WebUI     | Dify            | Flowise      | n8n             | LibreChat   |
| --------------- | -------------- | --------------- | ------------ | --------------- | ----------- |
| Stars           | 128k           | 134k            | 51k          | 181k            | 34.8k       |
| Frontend        | SvelteKit      | Next.js/React   | React        | Vue 3           | React       |
| Backend         | Python/FastAPI | Python/Flask    | Node.js      | Node.js/TS      | Node.js/TS  |
| DB              | SQLite/PG      | PG+Redis+Vector | SQLite/PG    | SQLite/PG       | **MongoDB** |
| License         | MIT            | Apache 2.0      | Apache 2.0   | Sustainable Use | MIT         |
| Real-time       | Socket.IO      | SSE             | SSE          | WebSocket       | Socket.IO   |
| Visual Canvas   | No             | Yes             | Yes          | Yes             | No          |
| RBAC/Admin      | Strong         | Strong          | Weak         | Enterprise-only | Medium      |
| Multi-agent     | Via pipelines  | Native canvas   | AgentFlow v2 | LangChain nodes | Via MCP     |
| Node.js backend | No             | No              | Yes          | Yes             | Yes         |
| MongoDB native  | No             | No              | No           | No              | Yes         |

---

## Real Implementations Found

1. **open-webui/open-webui** (`backend/open_webui/main.py`, `src/lib/stores/index.ts`, `backend/open_webui/socket/main.py`): Socket.IO WebSocket architecture with room-based delivery; SvelteKit stores pattern; 20-router FastAPI structure
2. **langgenius/dify** (`web/app/layout.tsx`, `web/app/(commonLayout)/apps/page.tsx`): Next.js App Router + Jotai + TanStack Query provider stack
3. **FlowiseAI/Flowise** (`packages/server/src/index.ts`): Express + NodesPool + BullMQ architecture
4. **n8n-io/n8n** (`packages/workflow/src/workflow.ts`): Graph traversal execution engine, trigger-first node resolution
5. **danny-avila/LibreChat**: MongoDB + Node.js + React + MCP — closest stack match to OpenClaw

---

## Code Patterns

### Open WebUI Socket.IO event pattern (Python)

```python
# backend/open_webui/socket/main.py
sio.emit("events", {
    "chat_id": chat_id,
    "message_id": message_id,
    "data": { "type": "chat:message:delta", "content": chunk }
}, to=f"user:{user_id}")
```

### Flowise Express + SSE pattern (Node.js)

```typescript
// packages/server/src/index.ts
this.app.use("/api/v1", flowiseApiV1Router);
// SSE streaming for flow execution results
```

### n8n Workflow execution entry point (TypeScript)

```typescript
// packages/workflow/src/workflow.ts
getStartNode(): INode | undefined {
  // 1. Find trigger nodes first
  // 2. Fall back to poll nodes
  // 3. Return first non-disabled node
}
```

### Dify provider stack (React/Next.js)

```tsx
// web/app/layout.tsx
<JotaiProvider>
  <ThemeProvider>
    <TanstackQueryInitializer>
      <I18nServerProvider locale={locale}>{children}</I18nServerProvider>
    </TanstackQueryInitializer>
  </ThemeProvider>
</JotaiProvider>
```

---

## Gotchas from Real Code

1. **Open WebUI Socket.IO**: Redis adapter required for multi-node deployments. Single-node uses in-memory store. Affects horizontal scaling design.
2. **Dify canvas**: The workflow canvas is tightly coupled to Dify's node type registry — extracting just the canvas for reuse is non-trivial (internal type system is deep).
3. **Flowise BullMQ**: Queue mode requires Redis; without it, node execution is synchronous in the main process. The `NodesPool` startup time grows with number of registered node types.
4. **n8n license**: The `n8n-io/n8n` license (Sustainable Use) prohibits using n8n to build a competing product or offer it as a hosted service. This blocks forking n8n as a base for OpenClaw UI.
5. **LibreChat MongoDB**: LibreChat uses Mongoose ORM. The schema is fixed to its conversation model — the existing collections won't map directly to ClawMongo's 22-collection schema without migration planning.
6. **Open WebUI pipelines**: Pipeline server runs on a separate port (9099). It acts as an OpenAI-compatible proxy. This is both a strength (easy to plug OpenClaw behind it) and a constraint (OpenClaw's streaming protocol must be OpenAI-compatible or a custom pipe is needed).
7. **Dify SSE vs WebSocket**: Dify uses SSE for workflow execution streaming, not WebSocket. This means no bidirectional communication during a run — human-in-the-loop interrupts are polled rather than pushed.

---

## What Changed the Recommendation

**The highest-signal finding**: LibreChat uses MongoDB as its primary database and Node.js/TypeScript throughout (matching OpenClaw's exact runtime stack). Its MCP integration mirrors OpenClaw's plugin model. However, LibreChat is consumer-chat-first and lacks visual agent orchestration. The winning pattern is: **use Open WebUI's architecture (Socket.IO + Redis rooms + plugin middleware layer) as the real-time foundation, but implement the frontend in Next.js/React (not Svelte) to match the broader TypeScript ecosystem — and skip the Python backend entirely in favor of a Node.js adapter that wraps OpenClaw's existing gateway API.**

The cleanest path is: **build a new Next.js frontend** that speaks to OpenClaw's existing Node.js gateway via WebSocket (Socket.IO or native WS), draw UI patterns from Open WebUI's admin panel + Dify's provider stack, and add a ReactFlow-based canvas (from Flowise) for visual agent/workflow design. This avoids the Python-backend mismatch of Open WebUI and Dify, the licensing issues of n8n, and the chat-only limitations of LibreChat.

---

## Recommendation

### Tier 1: Best Foundation

**Build new, draw from multiple sources**

Do not fork any single project. Instead:

1. **Framework**: Next.js 14 (App Router) + React + TypeScript + Tailwind CSS
   - Rationale: Same ecosystem as Dify (proven for AI management UIs), largest component library ecosystem, SSR for admin dashboards, App Router aligns with React Server Components for performance

2. **State management**: Jotai (atomic, Dify-proven) + TanStack Query (server state, standard)
   - Avoid Redux/Zustand for this scale; Jotai's atom model maps cleanly to per-agent/per-channel state

3. **Real-time**: Socket.IO client (matches Open WebUI's server architecture exactly)
   - Room-based: `channel:{id}`, `agent:{id}`, `user:{id}` for targeted delivery
   - OpenClaw's gateway already has Socket.IO or can add it cheaply

4. **Canvas (agent flow visualization)**: ReactFlow (used by Flowise, battle-tested)
   - Custom node types for: channel nodes, agent nodes, tool nodes, memory nodes
   - Edges show message routing

5. **Admin panel**: Draw from Open WebUI's admin panel design (user management, RBAC, analytics, channel status)

6. **Backend**: No new backend needed — Next.js API routes proxy to OpenClaw's existing gateway REST + WebSocket API

### Tier 2: If forking is required

**Fork LibreChat** — it is the only project with MongoDB + Node.js + TypeScript + MIT license + MCP support. Replace its consumer chat UI with an admin/management dashboard, add ReactFlow canvas, integrate directly with ClawMongo's collection schema.

### Tier 3: Quick prototype only

**Fork Open WebUI** — biggest community, best admin panel already built, Pipeline system maps to OpenClaw extensions. Requires either keeping Python backend (bridging cost) or replacing it with a Node.js proxy layer. Use SvelteKit if Svelte familiarity exists; otherwise adds a learning curve for contributors.

---

## References

- https://github.com/open-webui/open-webui (128k stars, SvelteKit + FastAPI)
- https://github.com/langgenius/dify (134k stars, Next.js + Python)
- https://github.com/FlowiseAI/Flowise (51k stars, React + Node.js)
- https://github.com/n8n-io/n8n (181k stars, Vue 3 + Node.js, Sustainable Use License)
- https://github.com/danny-avila/LibreChat (34.8k stars, React + Node.js + MongoDB, MIT)
- https://github.com/langchain-ai/langgraph (27.2k stars, Python backend, Studio is proprietary)
- https://docs.openwebui.com/features/
- https://docs.n8n.io/advanced-ai/

---

GitHub research complete.
