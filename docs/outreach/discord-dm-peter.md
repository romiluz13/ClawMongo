# Discord DM to Peter (@steipete)

**Subject**: MongoDB backend PR — focused, addresses 12+ issues

---

Hey Peter! 👋

I'm the guy who opened that massive 96-file MongoDB PR that you probably saw and immediately wanted to close 😅

Good news: I took the feedback to heart and **completely restructured it**. The new PR is focused, clean, and maps to real upstream pain:

**PR #19028** — https://github.com/openclaw/openclaw/pull/19028

**What it is:**

- External memory backend alternative (MongoDB)
- ~27 files, just the core foundation
- ACID transactions, Atlas Vector Search, hybrid scoring
- Survives container restarts, multi-instance capable

**What pain it solves:**

- #16844 — 50% query result loss (WAL stale snapshot bug)
- #17854 — QMD loads 2.1GB per query, hits 15s timeout every time
- #11480/#11565 — Data loss on container restart (bind-mount hell)
- #15226/#16021 — AND-join FTS returns empty results (we use OR-join + RRF)
- #13440 — Multi-instance can't share memory (MongoDB native)
- #15093 — Users asking for database backends (this is the MongoDB variant)

I did research on competitors (PostgreSQL PR was closed for SQL injection, Qdrant is 95 lines proposal-only) — this is the only complete implementation addressing the full stack.

I know you're busy, but would mean a lot if you could take a look or nudge it toward the right reviewers. Happy to answer questions or refine further based on feedback.

Thanks!
Rom

---

**Why this works:**

- Opens with humor (acknowledges the massive PR mistake)
- Shows accountability (took feedback, restructured completely)
- Leads with BDFL concerns (focused, clean, maps to real pain)
- Direct issue mapping with 12+ references
- Shows competitive analysis (not just "I built a thing")
- Respects his time ("nudge it toward the right reviewers")
