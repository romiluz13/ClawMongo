# Discord DM to Vignesh (@vignesh07)

**Subject**: MongoDB memory backend — would love your input as memory maintainer

---

Hey Vignesh! 👋

I've been working on a MongoDB memory backend for OpenClaw (you might have seen Discussion #16586 or my old 96-file PR that I just closed). After feedback that the PR was way too big, I split it into a focused core PR:

**PR #19028** — https://github.com/openclaw/openclaw/pull/19028

It's ~27 files, just the backend foundation (no KB, no Docker, no wizard — those come later if this lands). The core features:

- **External persistence** — survives container restarts, reinstalls, bind-mount issues
- **ACID transactions** — withTransaction() wrappers on all sync operations
- **MongoDB Vector Search** — managed embeddings, sub-300ms queries (vs QMD's 15s timeouts)
- **Hybrid search** — OR-join + RRF scoring (fixes the AND-join FTS bugs in #16021/#15226)
- **Change Streams** — real-time sync for multi-instance setups

It's an alternative backend path, not a replacement for QMD — users who want local-first can keep SQLite, users who need external storage/ACID/vector search get MongoDB.

The PR addresses 12+ upstream issues (see comment in PR) including:

- #16844 (50% query result loss from WAL bug)
- #17854 (QMD loads 2.1GB per query, always times out)
- #11480/#11565 (data loss on container restart)
- #15226/#16021 (FTS AND-join returns empty results)

I'd love your feedback as the memory maintainer before Peter/other maintainers dive in. What matters most to you? Any red flags? I want to make sure this aligns with your vision for the memory subsystem.

Thanks!
Rom

---

**Why this works:**

- Respectful tone (asks for input, not approval)
- Leads with pain points, not implementation
- Shows I did the work (closed monolith, followed guidelines)
- Positions as complementary, not competitive with QMD
- Direct issue references for credibility
- Short enough to read on mobile
