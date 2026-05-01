---
name: growth-watcher
description: Use to run a daily sweep across active recruitment threads — checks for replies from candidates Oak has engaged, fresh substantive posts from candidates not yet engaged, mentions of Oak by priority audiences, and on-thesis posts in cluster within the 30-min top-replies window. Triggers on "any recruitment news", "who replied", "watcher", "growth watcher", "morning recruit check", "any fresh posts I should reply to", "growth-day morning brief", "did anyone reply", "what's pending on X". Reads growth/.local/growth-log.md §3 (active threads) and growth/.local/jinn-warm-contacts.csv; writes daily alerts file growth/.local/watcher-YYYY-MM-DD.md and updates growth-log §3 thread statuses where new replies are detected.
---

# Growth watcher

Daily sweep for active recruitment threads. Cheap to run; high signal-to-noise because it only watches handles already in the growth log.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) §4 (the daily loop) — context for why this skill exists.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) §3 — active-thread handles to watch.
- [`growth/.local/jinn-warm-contacts.csv`](../../../growth/.local/jinn-warm-contacts.csv) segments F and G — additional handles to watch.

This skill operationalises GROWTH §4 *Understand* — surfacing the candidates worth engaging today.

## What this skill does

One mode: **sweep**. Pulls four signal types across the active-thread handles:
1. **Replies received** from candidates Oak has engaged.
2. **Fresh substantive posts** from candidates Oak hasn't yet engaged (or hasn't engaged recently).
3. **Mentions of Oak** by priority-audience accounts.
4. **On-thesis posts in cluster** that fall within the 30-min top-replies window.

Writes a single dated alerts file. Updates thread statuses in growth-log §3 where receipts are clear.

## When to run

- Weekday mornings, as part of the routine cycle that feeds `growth-day`.
- On-demand when Oak suspects a candidate may have replied.
- Skip on weekends unless cluster activity is high.

## Procedure

Apply in order.

### Step 1 — Build the watch list

Parse `growth/.local/growth-log.md` §3 for active-thread handles. Parse `growth/.local/jinn-warm-contacts.csv` for handles in segments F and G with status `High` or `High — warm`. Deduplicate.

If a handle is marked status `Dormant`, skip it.
If a handle is marked status `Closed` or `Reject-revisit`, skip it.

### Step 2 — Pull replies received

For each handle in the watch list, run:
```
bird user-tweets <handle> -n 12 --plain
```

Look for tweets that are replies to Oak (begin with `@tannedoaksprout`) or that quote-tweet Oak's posts. Extract the date, URL, and verbatim text.

Also run:
```
bird mentions -n 30 --plain
```
Filter to mentions from handles in the watch list within the last 24 hours.

### Step 3 — Pull fresh substantive posts

For each handle, identify posts within the last 24 hours that:
- Are not retweets,
- Have substantive content (>120 characters or attached media + caption),
- Are not auto-template / cron-repeat shapes (compare to the candidate's previous 7 days for repeat patterns).

If a post is fresh and substantive, flag it as a reply opportunity. Note timestamp.

### Step 4 — Detect cluster signals

Run:
```
bird home --following -n 30 --plain
```
Filter to posts from priority-audience accounts (defined in `cluster-model` SKILL.md or in growth-log §1 evidence). Flag any post that lands a clear gap-shape (uses Jinn-cluster vocabulary, names a structural problem the canonical THESIS addresses).

This is the "cold opportunity" bucket — candidates Oak hasn't engaged yet but who just posted something that matches the canonical bridge shapes (see `cluster-model/references/bridge-shapes.md`).

### Step 5 — Write the alerts file

Create `growth/.local/watcher-YYYY-MM-DD.md` with the structure below. Use today's UTC date for the filename.

If a section is empty, write `(none today)` — do not omit the section.

### Step 6 — Update growth-log §3 thread statuses

For each thread where a new reply was received, update the thread's `Status` field in growth-log §3:
- `PENDING` → `WARM` if the candidate replied with substance.
- `WARM` → `WARM, ongoing` if a follow-up reply landed.
- `WARM, ongoing` stays the same (just append the new date to the thread entry).

Do not modify other fields. Append a one-line dated note to the thread's status field rather than overwriting prior context.

### Step 7 — Auto-prune old watcher files

Delete `growth/.local/watcher-*.md` files older than 14 days:
```
find growth/.local -name 'watcher-*.md' -mtime +14 -delete
```

## Output format

The alerts file follows this structure exactly:

```markdown
# Watcher — YYYY-MM-DD

## Replies received (engage today)
- @handle — [URL] — [verbatim opening line of reply, ≤80 chars]
  - Status update: [PENDING → WARM, etc.]
  - Recommended action: [reply within Xh / monitor / escalate]

## Fresh substantive posts (engagement opportunities)
- @handle — [URL] — [topic in 5-10 words]
  - Posted: [Xh ago]
  - Bridge angle: [reference to bridge-shapes.md sub-pattern, or "needs cluster-model refresh"]

## Mentions of Oak (priority-audience)
- @handle — [URL] — [verbatim mention line, ≤100 chars]

## Cluster signals (cold opportunities)
- @handle — [URL] — [topic]
  - Why it matters: [one line]
  - Window: [posted Xh ago — top-replies window closes at HH:MM]

## Skipped from sweep
- @handle — reason (dormant / no fresh activity / re-route note)
```

## Voice constraints

- British English. No emoji. Concise, decision-shaped.
- "Recommended action" is one verb phrase, not a paragraph.
- If a section is empty, write `(none today)`. Do not editorialise about quiet days.
- Do not propose reply text — that is `x-post-builder`'s job.

## Composition

- **Inputs:** growth-log §3 active threads, warm-contacts CSV segments F/G, `bird` CLI.
- **Outputs:** `growth/.local/watcher-YYYY-MM-DD.md`, updated growth-log §3 statuses.
- **Consumed by:** `growth-day` (reads today's watcher file as the morning brief).

## What this skill does not do

- Draft reply text. (That is `x-post-builder` reply-grade mode.)
- Discover new candidates outside the existing watch list. (That is `discover-twitter-recruits`.)
- Decide priority order across the day's actions. (That is `growth-day`.)
