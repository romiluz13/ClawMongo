# PR #19028 Outreach Plan

All outreach materials for promoting the MongoDB backend PR upstream.

---

## Files in this directory:

1. **discord-dm-vignesh.md** — DM to Vignesh (@vignesh07), memory maintainer
2. **discord-dm-peter.md** — DM to Peter (@steipete), BDFL
3. **twitter-post.md** — 3 versions of X/Twitter post (technical, pain-focused, short)
4. **issue-comments.md** — Strategic comments for 4 high-impact issues

---

## Execution Order (recommended):

### Phase 1: Direct Outreach (Day 1)

1. **Discord DM to Vignesh** (memory maintainer — most important)
   - Morning US time (he's likely US-based based on GitHub activity)
   - Wait for response before proceeding

2. **Discord DM to Peter** (BDFL — architecture approval)
   - Same day, afternoon US time
   - Wait for response before going public

### Phase 2: Public Visibility (Day 2-3, after DMs sent)

3. **Twitter/X post** (use Version 2 — pain-focused)
   - Tag @steipete, @\_vgnsh, @openclaw
   - Post after DMs are sent so they're primed to respond
   - Ideal time: 9am-11am US Pacific (peak dev Twitter time)

4. **Issue comments** (pick 2 to start)
   - Comment on #16844 (WAL bug — most painful)
   - Comment on #17854 (QMD timeout — most urgent)
   - Wait 24-48 hours for engagement before commenting on others

### Phase 3: Broaden (Day 4-7, if no response)

5. **More issue comments** (if needed)
   - Comment on #15226 (FTS AND-join)
   - Comment on #11480 (container restart)

6. **Related PR engagement** (if needed)
   - Comment on #15093 (PostgreSQL request) — "MongoDB variant now available"
   - Comment on #13440 (pluggable memory stores) — "MongoDB implementation ready"

---

## Success Metrics:

- ✅ Vignesh or Peter responds on Discord (engagement)
- ✅ PR gets first human review (not just Greptile)
- ✅ Twitter post gets RT from @openclaw or maintainers
- ✅ Issue comments get responses from maintainers
- ✅ PR gets added to upstream milestone or project board

---

## Fallback Plan (if no response after 7 days):

1. Comment on Discussion #16586 (if discussions get re-enabled)
2. Ask in Discord #development channel (public, not DMs)
3. Ping on X/Twitter with "@steipete any thoughts on PR #19028?"
4. Wait another week, then focus on Track 2 (ClawMongo production-ready)

---

## Notes:

- **Don't spam** — One DM per person, one comment per issue, wait for engagement
- **Be patient** — Maintainers are volunteers, may take days/weeks to respond
- **Stay helpful** — Focus on pain points they care about, not our implementation pride
- **Respect their process** — If they say "needs work", listen and adapt
- **Have a backup** — Track 2 (ClawMongo production) is always available if upstream doesn't merge
