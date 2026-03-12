# Issue Comment Drafts

Strategic comments on 3-4 high-impact issues to draw attention to PR #19028.

---

## Comment on #16844 (WAL stale snapshot — 50% result loss)

**Issue**: https://github.com/openclaw/openclaw/issues/16844

---

I've been hitting this too — 50% of my queries return nothing because of the stale WAL snapshot. The "delete and re-add" workaround is painful.

I just opened **PR #19028** with a MongoDB backend that sidesteps this entire class of bugs. MongoDB doesn't use WAL — it uses WiredTiger's MVCC model with snapshot isolation, so stale reads aren't possible in the same way.

If you're looking for a workaround while this SQLite issue gets fixed upstream, the MongoDB backend might help. It's a drop-in alternative (same API, just external storage instead of local SQLite).

Link: https://github.com/openclaw/openclaw/pull/19028

---

## Comment on #17854 (QMD loads 2.1GB per query)

**Issue**: https://github.com/openclaw/openclaw/issues/17854

---

This is brutal. QMD loading a 2.1GB GGUF model on every query is a killer, especially with the 4s vs 15s timeout mismatch.

I ran into this and ended up building a MongoDB backend with **Atlas Vector Search** instead of QMD. Key differences:

- **No sidecar process** — MongoDB driver only, no QMD dependency
- **Automated embeddings** — Voyage AI via API (no local GGUF loading)
- **Sub-300ms queries** — vs 15s QMD timeouts
- **Pre-computed embeddings** — indexed on write, not computed at query time

Just opened **PR #19028** with this backend. It's an alternative path for users who want external storage + vector search without the QMD resource footprint.

Link: https://github.com/openclaw/openclaw/pull/19028

Would love feedback on whether this aligns with the roadmap or if you'd prefer to fix QMD instead.

---

## Comment on #15226 (FTS AND-join returns empty)

**Issue**: https://github.com/openclaw/openclaw/issues/15226

---

I hit this exact bug — multi-token queries return nothing because of the AND-join scoring.

In **PR #19028** (MongoDB backend), I fixed this with **OR-join + RRF scoring**:

- FTS finds documents matching ANY token (not ALL)
- Vector search finds semantically similar documents
- RRF (Reciprocal Rank Fusion) merges results by rank position
- Final score = (RRF _ weight) + (relevance _ weight)

Result: Multi-token queries like "react component lifecycle" now return results even if not all tokens match, and semantic relevance boosts quality.

This pattern is portable to SQLite FTS5 too — the key is switching from AND-join to OR-join and adding rank-based scoring.

Link: https://github.com/openclaw/openclaw/pull/19028

---

## Comment on #11480 (Memory lost on container restart)

**Issue**: https://github.com/openclaw/openclaw/issues/11480

---

This is one of the biggest pain points for Docker users. Bind-mounts are fragile, and local SQLite inside the container is lost on restart.

I just opened **PR #19028** with a MongoDB backend that solves this at the architecture level:

- **External storage** — MongoDB lives outside the container (Atlas or local instance)
- **Survives any lifecycle event** — restart, reinstall, container deletion
- **Multi-instance capable** — multiple containers can share the same MongoDB instance
- **Change Streams** — real-time sync across instances

This is the same pattern AWS/GCP use for stateful services — separate compute from storage. OpenClaw containers become stateless, MongoDB handles persistence.

Link: https://github.com/openclaw/openclaw/pull/19028

If you're blocked by bind-mount issues, this might be a good workaround while the local-first path gets hardened.

---

**Strategy:**

1. Comment on #16844 and #17854 first (highest pain, most urgent)
2. Wait 24-48 hours, see if maintainers respond
3. Then comment on #15226 and #11480 to broaden visibility
4. Don't spam — one thoughtful comment per issue, wait for engagement
