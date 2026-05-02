---
name: growth-day
description: Daily orchestrator for Jinn growth work — bundles outputs from cluster-model, growth-watcher, and twitter-strategy, checks GROWTH.md §4 daily-loop discipline (Teach / Understand / Direct offer / Interact), reads warm-contacts cadence, and surfaces 3 ranked actions for the day. Triggers on "growth day", "morning growth standup", "what should I do today for growth", "daily growth check", "what's pending", "start of day jinn", "let's plan today's growth work", "growth check-in", "what's next on growth". Reads growth/.local/growth-log.md, growth/.local/jinn-warm-contacts.csv, today's growth/.local/watcher-*.md if present, last cluster-model snapshot. Output is a chat briefing with 4 fixed sections — yesterday's loop check, today's top-3 actions, heads-up alerts, drift flags. Updates growth-log §5 with today's plan.
---

# Growth day

The manual orchestrator. Run by Oak each day at the start of the deep block. Bundles the routine outputs and surfaces decisions.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) — the bet, the daily loop, what to chase, what to avoid.
- [`THESIS.md`](../../../THESIS.md) — what teaches the right operators to self-identify.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) — full operational state.
- [`growth/.local/jinn-warm-contacts.csv`](../../../growth/.local/jinn-warm-contacts.csv) — warm list with cadence.
- `growth/.local/watcher-YYYY-MM-DD.md` for today, if it exists.

This skill operationalises GROWTH §4 *Teach / Understand / Direct offer / Interact* as a daily decision aid. Do not redefine GROWTH-level claims here.

## What this skill does

One mode: **brief**. Reads the operational state, computes yesterday's compliance against the daily loop, surfaces today's three highest-leverage actions, flags anything from the watcher that needs attention now.

The skill does not act on Oak's behalf. Oak picks the actions. The skill writes the day's plan to growth-log §5 so tomorrow's run can compute compliance.

## When to run

- Once per day, ideally at the start of the deep block (Oak's deep block in his preferences).
- After `growth-watcher` has run for the day (today's watcher file exists).
- Skip on weekends unless cluster activity is high (per GROWTH §4: weekday cadence is canonical).

## Procedure

Note: Oak's posting handle is `@tannedoaksprout`. The display handle `@oaksprout` is canonical-display only and is not the live X account. Use `@tannedoaksprout` for all bird CLI calls.

### Step 0 — Freshness check + auto-invoke stale feeds

On weekday mornings, this skill ensures the three feed routines are fresh before producing the brief. Skip Step 0 entirely on weekends, or when Oak's invocation prompt includes a `skip feeds` instruction (e.g. running growth-day in the afternoon to refresh the brief without re-pulling everything).

Check each feed in this order; invoke via the Skill tool only if stale.

1. **`cluster-model` (weekly).** Read `growth/.local/growth-log.md` §1 and find the most recent `Sampled this run: YYYY-MM-DD` date across all three clusters. If that date is more than 7 days ago, invoke the `cluster-model` skill and wait for it to finish before continuing. Otherwise skip.

2. **`twitter-strategy` (weekly).** Check whether `growth/.local/twitter-strategy-last-run.md` exists with a timestamp within the last 7 days. If missing or stale, invoke the `twitter-strategy` skill and wait. Otherwise skip.

3. **`growth-watcher` (daily on weekdays).** Check whether `growth/.local/watcher-YYYY-MM-DD.md` exists for today's UTC date. If missing and today is Mon–Fri, invoke the `growth-watcher` skill and wait. Otherwise skip.

Order matters: `cluster-model` first because its output (§1 cluster snapshot) feeds `growth-watcher`'s "cluster signals" detection. `twitter-strategy` second because its drift flags feed Step 4 below. `growth-watcher` last because its output is the most time-sensitive and should reflect the freshest cluster snapshot.

If a feed invocation fails (network, bird auth, rate limit), continue to Step 1 with whatever state exists, and surface the failure in the HEADS-UP section of the output: `[<feed> failed to refresh — using stale data from YYYY-MM-DD]`. Do not retry automatically.

### Step 1 — Read state

Read in order:
1. `GROWTH.md` (re-anchor every run; cheap and prevents drift).
2. `growth/.local/growth-log.md` — full file, especially §3 (active threads), §5 (yesterday's plan; look for the most recent `### YYYY-MM-DD plan` sub-heading inside §5), §1 (cluster snapshot date).
3. `growth/.local/jinn-warm-contacts.csv` — pay attention to `Status / Next action` field and any last-contact dates inferable from `Prior context`.
4. Today's `growth/.local/watcher-YYYY-MM-DD.md` if it exists. If it does not, mark the watcher feed as missing.

### Step 2 — Yesterday's loop check

Compare yesterday's plan in growth-log §5 against what actually shipped, using these signals:
- **Teach:** did Oak's timeline gain a substantive original post yesterday? Use `bird user-tweets tannedoaksprout -n 5 --plain`. If yes, mark Teach `[done]`. If a thread was scheduled in §5 but no post landed, mark `[skipped — surface to today]`.
- **Understand:** did Oak reply substantively to a candidate post? Use `bird user-tweets tannedoaksprout -n 10 --plain` and look for replies (tweets starting with `@`).
- **Direct offer:** did the warm list see a contact? Update `Status / Next action` field per row.
- **Interact:** mostly invisible from public data; do not infer. Mark `[unknown]`.

If §5 has no entry for yesterday (skill is being run for the first time, or yesterday was skipped), mark each bucket `[no plan]` and skip the compliance check.

### Step 3 — Compute today's top-3 actions, ranked by leverage

The leverage ranking heuristic, in priority order (do not invent a different ranking):

**Tier A — high leverage, ship today:**
- Reply opportunity in the 30-min top-replies window from today's watcher file.
- Bridge post (from `cluster-model` handoff) ready to ship and Tue–Thu 09:00–14:00 cluster-peak window is open today.
- Warm-list contact whose `Next action` is overdue (>7 days since last contact for High priority, >14 days for Medium).

**Tier B — schedule:**
- Methodology question on a candidate's recent post (from watcher §2 fresh-substantive-posts).
- Discovery round in `discover-twitter-recruits` if the last round was >14 days ago.
- Cluster-model refresh if last snapshot is >7 days old.

**Tier C — defer unless deep-block has slack:**
- Stewardship pings (segment E in warm contacts).
- DeFiLlama / parking-lot integrations.

Pick three actions, one per Tier A item (or two from A and one from B if A has only two), to surface in the brief. Each action must be specific: handle, post URL where relevant, exact phrasing of the reply or post (or pointer to where the draft lives — growth-log §3 or §2).

### Step 4 — Read drift flags from twitter-strategy if available

If `twitter-strategy` was run within the last 7 days (no automated detection — Oak supplies the date), incorporate its top-3 drift flags as a separate section. Do not re-run `twitter-strategy` from this skill — invoking another skill from inside a skill should be done by Oak, not auto-chained.

### Step 5 — Output the brief

Print the brief inline in chat. Use the format below exactly. Each section earns its keep — do not omit, but do mark sections empty as `(none)`.

### Step 6 — Update growth-log §5 with today's plan

Append today's plan to growth-log §5 with this shape:
```
### YYYY-MM-DD plan
1. [action 1 — exact handle / URL / draft]
2. [action 2 — exact handle / URL / draft]
3. [action 3 — exact handle / URL / draft]

Heads-up: [count] from watcher; drift flags: [count from twitter-strategy].
```

This is what tomorrow's `growth-day` invocation will compare against.

## Output format

```
GROWTH DAY — YYYY-MM-DD

YESTERDAY (loop check)
  Teach           [done / skipped / no plan]    [URL or note]
  Understand      [done / skipped / no plan]    [URL or note]
  Direct offer    [done / skipped / no plan]    [name or note]
  Interact        [unknown — out of scope]

TODAY (top-3, ranked by leverage)
  1. [Tier A — single sentence imperative — handle / URL / draft pointer]
  2. [...]
  3. [...]

HEADS-UP (from today's watcher)
  [list of items needing attention now — replies received, top-replies windows still open]
  (or) (none today — watcher quiet)

DRIFT (from latest twitter-strategy if <7 days old)
  [list of drift flags]
  (or) (no recent twitter-strategy run — consider running it this week)

WRITTEN TO: growth/.local/growth-log.md §5
```

## Voice constraints

- British English. No emoji. Plain prose. Decision-shaped.
- Each action is one sentence with one verb. *"Reply to TreebeardAI's architecture follow-up: [draft pointer in §3]"*, not *"Consider engaging Treebeard if you have time"*.
- If yesterday's plan was skipped two days running, surface that as a drift flag in the heads-up section.
- Do not editorialise about Oak's productivity. The skill reports; it does not coach.

## Composition

- **Inputs:** canonical docs, growth-log, warm-contacts CSV, today's watcher file, latest twitter-strategy output (if recent).
- **Outputs:** chat brief, updated growth-log §5.
- **Consumes:** `growth-watcher` outputs, `cluster-model` outputs, `twitter-strategy` outputs.
- **Auto-invokes stale feed routines** in Step 0: `cluster-model`, `growth-watcher`, `twitter-strategy`. Action routines (`x-post-builder`, `discover-twitter-recruits`) remain Oak-driven from the brief's recommendations.

## What this skill does not do

- Run *action* routines (`x-post-builder`, `discover-twitter-recruits`). Those have side-effects in the world (publish posts, change recruit lists) and require Oak's explicit invocation from the brief.
- *Feed* routines (`cluster-model`, `growth-watcher`, `twitter-strategy`) are auto-invoked in Step 0 when stale. They are read-only refreshes of the data plane.
- Draft reply text or posts. (That is `x-post-builder`.)
- Score posts. (That is `x-algorithm-grader`.)
- Make recruitment decisions. (Oak picks the actions; this skill ranks options.)

## Failure modes to handle gracefully

- **Watcher file missing for today.** Note: `[watcher not run today — consider running growth-watcher first]`. Continue with the rest of the brief using only growth-log state.
- **Growth-log §5 missing yesterday's plan.** Mark each loop bucket `[no plan]` and skip the compliance check. Still propose today's top-3.
- **Warm-contacts CSV missing.** Note: `[warm contacts not available — direct-offer compliance unchecked]`. Continue with what's readable.
- **No active threads in §3.** Note: `[no active threads — propose discovery round]` and surface a `discover-twitter-recruits` invocation as a Tier B action.
- **Feed routine fails mid-run** (Step 0). Continue with whatever stale state exists. Surface in HEADS-UP as `[<feed> failed: <one-line cause>]`. Do not retry automatically.
- **Skip-feeds override.** If Oak's invocation prompt contains "skip feeds" or "feeds already fresh", skip Step 0 entirely and proceed to Step 1.
