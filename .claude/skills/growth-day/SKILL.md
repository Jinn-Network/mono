---
name: growth-day
description: Daily aggregator + guidance surface for Jinn growth work — reads GROWTH.md (§3 target cluster, §4 GTM sequence, §5 daily loop, §7 metrics, §8 channel canon, §9 sprint discipline) plus operational state, surfaces sprint progress, yesterday's loop compliance against the four §5 functions (Understand / Teach / Engage / Refine), today's top-3 *guidance* actions tagged by §5 function, ready-to-advance warm-list rows, watcher heads-up, drift flags. Not a dispatcher — does not invoke action skills (x-post-builder, discover-twitter-recruits, growth-refine); Oak invokes those from the brief. May refresh stale read-only feeds (cluster-model, growth-watcher, twitter-strategy) as input to aggregation. Triggers on "growth day", "morning growth standup", "what should I do today for growth", "daily growth check", "what's pending", "start of day jinn", "let's plan today's growth work", "growth check-in", "what's next on growth". Reads growth/.local/growth-log.md (§6 active sprint, §3 active threads, §5 yesterday's plan), growth/.local/jinn-warm-contacts.csv, today's growth/.local/watcher-*.md if present. Refuses to produce a top-3 if no active sprint is in growth-log §6 (fail-loud, references GROWTH §9 for sprint shape). Updates growth-log §5 with today's plan and §6 with daily progress.
---

# Growth day

The daily aggregator + guidance surface. Run by Oak each day at the start of the deep block. Reads canonical strategy and operational state; surfaces sprint progress, loop compliance, the day's top-3 actions tagged by which GROWTH §5 function they serve, and drift flags. Not a dispatcher — Oak picks and invokes from the brief.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) §3 (current target cluster + bridge model — re-anchor every run), §4 (GTM sequence — phase-transition triggers feed drift flags), §5 (the four-function daily loop — Understand / Teach / Engage / Refine — what loop compliance is computed against), §6 (will-not-chase rules), §7 (metrics — what to surface), §8 (channel canon — what to flag drift against), §9 (sprint discipline — sprint shape the active block is parsed against).
- [`THESIS.md`](../../../THESIS.md) — what teaches the right operators to self-identify.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) — full operational state. §6 holds the active sprint (parsed against GROWTH §9 fields); §7 archives sprint postmortems.
- [`growth/.local/jinn-warm-contacts.csv`](../../../growth/.local/jinn-warm-contacts.csv) — warm list with cadence; expects columns `rung` (cold / touched / warm / hot / frozen), `last_touch_date`, `next_move`, `next_move_due` alongside the existing fields.
- `growth/.local/watcher-YYYY-MM-DD.md` for today, if it exists.

This skill aggregates state and surfaces guidance for the GROWTH §5 daily loop. It does not redefine canonical claims; canon lives in GROWTH.md and amendments go through `growth-refine`.

## Sprint precondition (fail-loud)

This skill refuses to produce a top-3 unless an active sprint is declared in growth-log §6. The canonical shape of a sprint lives in GROWTH §9 (cluster from §3, time-boxed window, declared inputs, thresholds, decision rule, mandatory postmortem). No sprint = no daily plan; the structure forces the user to either declare a sprint or explicitly take a rest day. See Step 1.5 below for the check, and "Failure modes" for the fail-loud message shape (which quotes the §9 sprint-block template).

## Cluster gate (every candidate filtered against current GROWTH §3 cluster)

After the sprint precondition passes, every candidate that enters Tier A or Tier B must pass a cluster-fit check against the active sprint's cluster (which must reference GROWTH §3). The gate runs over four data sources, each with a defined behaviour:

- **warm-contacts CSV.** Rows whose `cluster` column matches the active sprint's cluster pass; rows whose `cluster` is a retired or out-of-scope cluster are dropped (surfaced once in `OUT-OF-CLUSTER (frozen by sprint pivot)` for visibility, never as actionable). Rows with empty `cluster` (legacy) surface in `CLUSTER UNKNOWN — review` and never as actionable Tier A.
- **growth-log §2 bridge angles.** Each entry carries an inline `cluster:` tag. Filter by current cluster.
- **growth-log §3 active threads.** Each thread carries a cluster tag. Filter by current cluster.
- **today's watcher file.** Watcher emits a *raw* candidate handle list with cluster *suggestions*. growth-day re-classifies each handle against the *current* GROWTH §3 cluster definition at brief-construction time (the watcher's classification may have been written under a different sprint).

When a candidate fails the gate, log it under `Considered, dropped:` with a one-line cluster-mismatch reason. Never invent a Tier A action from an out-of-cluster row to fill the slot.

## Sprint-pivot freeze (run once per pivot, in Step 0)

Every run, compare the active sprint's cluster (growth-log §6) against the previous sprint's cluster (the most recent §7 postmortem entry). If they differ, the cluster has pivoted and operational state from the prior cluster needs freezing:

1. **CSV rows.** Any row whose `cluster` matches the *prior* sprint's cluster and whose `rung` is not already `frozen` should be set to `rung=frozen` with `frozen_reason=sprint-N-cluster-retired-YYYY-MM-DD`. Also clear `next_move_due` so they do not surface as ready-to-advance.
2. **growth-log §2 angles.** Add an `**ARCHIVED YYYY-MM-DD; out of current cluster**` annotation to entries tagged with the prior cluster. Do not delete; the angles re-enter scope if the cluster ever rotates back.
3. **growth-log §3 threads.** Annotate prior-cluster threads as historical-context-only; they no longer appear in HEADS-UP as actionable.

The freeze is idempotent (safe to re-run; only applies state changes when the prior-cluster rows are still un-frozen). Skip if the active sprint's cluster equals the prior sprint's cluster.

## Warm-contacts ladder

The CSV models a four-rung ladder plus a parking state:

| Rung      | Definition                                                            | Typical next move                                          |
|-----------|-----------------------------------------------------------------------|------------------------------------------------------------|
| `cold`    | Identified candidate, no prior interaction.                           | First substantive reply on a recent post.                  |
| `touched` | One substantive exchange landed.                                      | Second reply OR named-mention in a teach/bridge post.      |
| `warm`    | Multi-turn back-and-forth; recognises Oak.                            | DM with one specific artifact OR co-thinking post.         |
| `hot`     | DMed back, on a call, in Telegram, or asked about Jinn directly.      | Direct offer (call, beta, working session, intro).         |
| `frozen`  | Out-of-cluster or decayed; do not advance.                            | None — review at sprint boundary only.                     |

`next_move` is free text describing the actual move; `next_move_due` is the date by which the move should ship. Growth-day's "Ready to advance" section surfaces rows where `next_move_due ≤ today`.

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
2. `growth/.local/growth-log.md` — full file, especially §6 (active sprint block), §3 (active threads), §5 (yesterday's plan; look for the most recent `### YYYY-MM-DD plan` sub-heading inside §5), §1 (cluster snapshot date).
3. `growth/.local/jinn-warm-contacts.csv` — pay attention to `rung`, `next_move`, `next_move_due`, `last_touch_date`, and the legacy `Status / Next action` and `Prior context` fields. Build the "ready to advance" queue here: rows where `next_move_due ≤ today` and `rung ∈ {cold, touched, warm, hot}`.
4. Today's `growth/.local/watcher-YYYY-MM-DD.md` if it exists. If it does not, mark the watcher feed as missing.

### Step 1.5 — Sprint precondition (fail-loud)

Inspect §6 of `growth-log.md`. An *active* sprint block has all of: a cluster name, a window with `start_date` ≤ today ≤ `end_date`, an inputs target, and thresholds.

- If §6 is missing entirely, or contains no sprint block, or the most recent sprint's `end_date` is in the past with no successor: **stop here**. Emit the fail-loud message (see Failure modes) and do NOT continue to Steps 2–6. The user must either declare a new sprint or explicitly mark a rest day in §6.
- If §6 contains an active sprint, parse: cluster, window, inputs target (as a list of countable items, e.g. "6 teach posts", "1 bridge post"), thresholds. Compute progress so far against the inputs target by counting matching entries from §5 daily plans within the sprint window. This becomes the SPRINT section of the brief.

### Step 1.6 — Sprint/canon alignment lint

The active sprint block (§6) must be aligned with GROWTH canon. Two checks:

**Check A — cluster definition match.** §6's cluster definition must be a verbatim restatement (or stricter sub-segment) of GROWTH §3's current target cluster. If §6 declares a different cluster handle than §3, this is a canon-cluster mismatch and must be resolved by spec proposal (tighten §3) or sprint-block revision (re-state §6 to match §3) before the daily loop produces top-3 work.

**Check B — vertical/cluster alignment.** If §6 names a vertical (a specific SolverNet, benchmark, or task class — e.g. "swe-rebench v2", "AlpacaEval-live", "math-bench") *or* a vertical-instance pitch (e.g. "help collectively train a swe-rebench v2 harness"), the natural recruit base of that vertical must fit inside GROWTH §3's cluster definition. If §3's cluster is broader than the vertical implies, the warm-list and discovery output will silently include out-of-vertical candidates — exactly the failure mode that produced today's stale top-3 on 2026-05-07 PM (full forensic in `spec/2026-05-07-growth-cluster-tightening-coding-agents.md`).

The check is a judgement call, not a string match. Read §6's vertical, read §3's cluster definition, ask: *would a typical contributor to the §6 vertical see themselves in the §3 cluster description?* If the answer is "yes obviously" — pass. If it requires squinting — surface as drift. If the answer is "no, the §3 description is too broad / too narrow / wrong shape" — fail loud.

**Behaviour on detected misalignment:**

- **Day 1 of detected mismatch:** surface in HEADS-UP with text *"CANON-CLUSTER/VERTICAL MISMATCH: Sprint §6 [cluster=X | vertical=Y] does not align with GROWTH §3 [cluster=Z]. Resolve by spec proposal (tighten §3) or sprint-block revision (re-state §6). Resolves Day 2 if unfixed."* Continue to produce top-3 (with the warning) so the operator has time to act.
- **Day 2+ of unresolved mismatch:** fail loud. Block top-3 production. Emit the same text marked `BLOCKED — alignment unresolved`. The operator must land a spec proposal or revise §6 before another daily-loop run.

This step prevents a class of silent failure where the cluster gate filters correctly against §3 but §3 itself is misaligned with operational state. The forcing function is the same as Step 1.5: structural mismatch must surface, not accumulate.

### Step 2 — Yesterday's loop check (against GROWTH §5)

Compare yesterday's plan in growth-log §5 against what actually shipped, using these signals. Buckets follow GROWTH §5's four-function loop: Understand / Teach / Engage / Refine.

**Important: `bird user-tweets` excludes replies by default in bird ≥0.8.0.** It returns originals, retweets, and self-threads but not @-prefixed replies. To detect replies you must use `bird search` with the `filter:replies` operator. Run both queries:

- **Understand** (replies): `bird search "from:tannedoaksprout filter:replies" -n 20 --plain`
  - Look for substantive replies dated yesterday (UTC). One-word acknowledgements ("nice", "agreed") do not count; replies that pose a methodology question, surface a constraint, or extend the other person's argument do count.
  - Mark `[done]` if ≥1 substantive reply lands. List up to 4 reply URLs and the handle replied to in the brief.
- **Teach** (originals + threads): `bird user-tweets tannedoaksprout -n 10 --plain`
  - Look for non-RT tweets dated yesterday (UTC). A self-thread counts as one Teach. Posts on the §3 bridge model (canonical pitch, methodology question shape) carry the most weight.
  - Mark `[done]` if ≥1 original lands. Mark `[skipped — surface to today]` if §5 scheduled a thread that never posted.
- **Engage** (funnel advancement): warm-list activity (CSV updates dated yesterday, `next_move_due` rows that closed), public direct-offer posts, named recruit calls/DMs Oak has logged. Synchronous DM / Telegram / voice activity remains invisible from public data — for those, only Oak's logged updates to the CSV count. Mark `[done]` / `[skipped]` / `[unchecked]`.
- **Refine** (canon-amendment work): did `growth-refine` run yesterday, or was a refine proposal applied via PR? Mark `[done]` / `[no run]`. Refine is light-cadence; a `[no run]` result is not a violation, only data.

If §5 has no entry for yesterday (skill is being run for the first time, or yesterday was skipped), mark each bucket `[no plan]` and skip the compliance check — but still run the `bird` queries and surface what you find as informational notes ("yesterday's actuals: 4 replies, 0 originals") so today's plan has signal.

### Step 3 — Compute today's top-3 actions, ranked by leverage

Walk the tiers in order and collect candidate actions; do not skip a tier. Each candidate must already be specific (handle, URL, draft pointer) by the time it enters the list — if you can't name the target, it's not a candidate yet.

**Tier A — ship today (verb: post, reply, send):**
- A1. **Top-replies window reply.** From today's watcher file §1, any reply opportunity inside the GROWTH §8 reply window (30-min after a priority-audience post). Action shape: *"[Understand] Reply to @<handle>'s <topic> (<URL>): <one-line angle>. Draft via x-post-builder."*
- A2. **Sprint-input cadence catch-up.** If the active sprint (parsed against GROWTH §9 fields) is behind on its declared inputs target — e.g. on a 3/wk teach pace, today is Wednesday and only 1 teach has shipped — the catch-up post is Tier A. Sprint cadence is the forcing function for the sprint to mean anything. Action shape: *"[Teach] Post the missing <teach | bridge> for <cluster>: <one-line hook>. Draft via x-post-builder, score via x-algorithm-grader before posting."*
- A3. **Bridge post.** Bridge angle from `growth-log.md` §2, only if today is Tue/Wed/Thu and the GROWTH §8 cluster-peak window 09:00–14:00 (Oak's local time) is still open. Action shape: *"[Teach] Post the <cluster> bridge: <one-line hook>. Draft via x-post-builder, score via x-algorithm-grader before posting."*
- A4. **Ready-to-advance warm contact.** From `jinn-warm-contacts.csv`: row whose `next_move_due` is today or overdue and `rung ∈ {cold, touched, warm, hot}`. Prioritise rows whose `rung` activity aligns with the active sprint's cluster (GROWTH §3) — those are the ladder moves the sprint is supposed to produce. Action shape: *"[Engage] Advance @<handle> (rung X→Y): <next_move from CSV>."*
- A5. **Legacy overdue warm-list contact.** Fallback when `next_move_due` is blank (rows on the legacy schema). From `jinn-warm-contacts.csv`: High priority and last contact >7 days ago, OR Medium priority and >14 days. Action shape: *"[Engage] DM @<handle>: <next action from CSV>."*

**Tier B — schedule today, ship later this week (verb: draft, schedule, prepare):**
- B1. **Methodology question** on a candidate's fresh substantive post from watcher §2. Action shape: *"[Understand] Draft a methodology question on @<handle>'s post (<URL>): <angle>. Reply tomorrow."*
- B2. **Discovery round** if the last `discover-twitter-recruits` run is >14 days old. Action shape: *"[Understand] Run discover-twitter-recruits to refresh candidate pool (last run YYYY-MM-DD)."*
- B3. **Feed refresh** if cluster-model snapshot is >7 days old or twitter-strategy is >7 days old. Action shape: *"[Understand] Run cluster-model to refresh §1 (last sampled YYYY-MM-DD)."*
- B4. **Teach draft** if today's Teach has no candidate angle. Pull a thread or essay seed from today's Understand replies, recent watcher signals, or a `THESIS.md` section that has not been taught publicly yet. Action shape: *"[Teach] Draft Monday Teach off <source>: <one-line hook>."*
- B5. **Refine run** if `growth-refine` has not run in >30 days. Action shape: *"[Refine] Run growth-refine to surface drift candidates against GROWTH.md (last run YYYY-MM-DD)."*

**Tier C — defer unless deep-block has slack (verb: ping, audit):**
- C1. Stewardship pings to segment E in warm contacts.
- C2. DeFiLlama / parking-lot integrations.
- C3. Inbound triage for unanswered DMs >7 days old.

**Selection rule.** Take Tier A first, then Tier B to fill, then Tier C — every candidate must pass the cluster gate above. Aim for three; never fewer than two. If Tier A is empty after the cluster gate (common on Mondays before watcher runs, on weekends, and on day-1 of a new sprint after a cluster pivot), the brief is allowed to be all Tier B — but say so explicitly: *"All Tier B today — no in-cluster Tier A candidates."* Never invent a Tier A action to fill the slot, and never bypass the cluster gate to do it.

**Empty-in-cluster fallback (sprint pivot or cold cluster).** If the cluster gate empties Tier A *and* the active sprint is in its first week *and* the warm-contacts CSV contains zero in-cluster rows on rung ∈ {touched, warm, hot}, this is a cluster-bootstrap state. Emit a **bootstrap top-3** instead of the normal one:

```
TODAY (top-3 — cluster-bootstrap mode)
  No in-cluster Tier A candidates. Sprint #N day M — warm-list contains 0 in-cluster rows above `cold`.

  1. [Understand] Run discover-twitter-recruits with target=<GROWTH §3 cluster> to populate warm-list with first-touch candidates.
  2. [Teach] Draft Sprint #N first Teach off the GROWTH §3 bridge model (canonical pitch + the bridge claim). Score before posting.
  3. [Refine] Run growth-refine to baseline drift candidates against the (possibly recently restructured) GROWTH.md.
```

This is the failure mode that hit on 2026-05-06: warm-contacts CSV inherited from prior sprint, all rows out-of-cluster, normal top-3 silently surfaced stale rows. The bootstrap output names the state plainly so the user can act on it.

**Weekend / strategy-session mode.** If running on Sat or Sun, prefer Tier B actions that *prepare Monday's Tier A*: feed refreshes, draft Teach posts, reconcile warm-contacts cadence, plan discovery rounds. Posting on weekends is allowed but not the goal. Mark the brief header `(Saturday — weekly strategy session)` or `(Sunday — weekly strategy session)`.

**Cold-start mode.** If `growth/.local/` was just created and §1/§2/§3 are empty, the top-3 must be: (1) bootstrap the missing state (cluster-model, warm-contacts reconcile), (2) one Teach draft to keep the discipline alive, (3) schedule the rest of the feed routines. Do not pretend to compute Tier A from missing data.

Each action that lands in the brief must answer: **who, what, where the draft lives.** "Reply to TreebeardAI's architecture follow-up: draft in growth-log §3" passes. "Engage Treebeard if you have time" fails — rewrite or drop it.

### Step 4 — Read drift flags from twitter-strategy and channel-canon

Use the `twitter-strategy` state after Step 0. If Step 0 refreshed it or `growth/.local/twitter-strategy-last-run.md` is still within the last 7 days, incorporate the top-3 drift flags as a separate section. Twitter-strategy already separates GROWTH §6.1 permanent-rule violations from §6.2 tactical-deferral surfacing and §8 channel-canon drift — surface each distinctly in the DRIFT section. If twitter-strategy is missing, stale, or failed to refresh, mark the DRIFT section as unavailable and surface the feed failure in HEADS-UP.

Additionally, if any of the following surface from a one-shot inspection of recent state, add them as DRIFT entries:
- A GROWTH §4 phase-transition trigger has been met (e.g. external operator count crossed §7's headline threshold — propose declaring the next phase via `growth-refine`).
- `growth-refine` has not run in >30 days (already a Tier B candidate per Step 3 B5; surface the staleness here too if it persists).

### Step 5 — Write the brief to a dated file, then emit a short pointer in chat

The full brief is verbose and hard to scan inline. Write the full brief to `growth/.local/growth-day-YYYY-MM-DD.md` (gitignored under `.local/`) and emit only a 6–10 line pointer summary in chat:

```
GROWTH DAY — YYYY-MM-DD — written to growth/.local/growth-day-YYYY-MM-DD.md

Sprint: <cluster> day N of M, inputs <T/T target>
Yesterday: U/T/E/R = <done/skipped/no plan> per bucket
Today's top-3:
  1. [Tier · §5-function] <one-liner>
  2. ...
  3. ...
Heads-up: <count>; Drift: <count>
```

The file contains the full brief in the *Output format* below. The chat pointer exists so the user can decide whether to open the file; the file is the readable copy.

If `growth/.local/growth-day-YYYY-MM-DD.md` already exists for today (re-run case), overwrite it. Do not append.

After writing the brief file, prune old briefs: delete any `growth/.local/growth-day-*.md` whose date is more than 14 days before today. Match the watcher's retention policy.

### Step 6 — Update growth-log §5 with today's plan, and §6 with sprint progress

Append today's plan to growth-log §5 with this shape:
```
### YYYY-MM-DD plan
1. [action 1 — exact handle / URL / draft]
2. [action 2 — exact handle / URL / draft]
3. [action 3 — exact handle / URL / draft]

Heads-up: [count] from watcher; drift flags: [count from twitter-strategy].
```

Append today's progress to growth-log §6 *Daily progress* sub-section under the active sprint, with this shape:
```
- YYYY-MM-DD — Inputs: <teach: N/target>, <reply cascades: N/target>, <bridge: N/target>. Rungs advanced: <handle (X→Y), …>. Inbound: <mentions/quotes>. Notes: <one line>.
```

Daily progress accumulates across the sprint window; the sprint-end postmortem reads this sub-section to compute final input/threshold attainment. This is what tomorrow's `growth-day` invocation will compare against.

## Output format

The full brief written to `growth/.local/growth-day-YYYY-MM-DD.md` follows this exact shape. The chat-side message is the short pointer in Step 5, not this template.

```
GROWTH DAY — YYYY-MM-DD

SPRINT — <cluster name> — day N of M
  Inputs:   teach <done>/<target>, reply-cascades <done>/<target>, bridge <done>/<target>
  Thresholds (informational, evaluated at sprint end):
    - <threshold 1>: <current state>
    - <threshold 2>: <current state>
  Window: <start> → <end>; postmortem due <end>.

YESTERDAY (loop check, GROWTH §5)
  Understand   [done / skipped / no plan]   [URL or note]
  Teach        [done / skipped / no plan]   [URL or note]
  Engage       [done / skipped / no plan]   [name or note]
  Refine       [done / no run]              [proposal-id or note]

TODAY (top-3, ranked by leverage)
  1. [Tier A — single sentence imperative — handle / URL / draft pointer]
  2. [...]
  3. [...]

READY TO ADVANCE (warm-list rows with next_move_due ≤ today)
  - @handle (rung X → Y) — <next_move text> — due YYYY-MM-DD
  (or) (none — queue clear)

HEADS-UP (from today's watcher)
  [list of items needing attention now — replies received, top-replies windows still open]
  (or) (none today — watcher quiet)

DRIFT (from latest twitter-strategy if <7 days old)
  [list of drift flags]
  (or) (no recent twitter-strategy run — consider running it this week)

WRITTEN TO: growth/.local/growth-day-YYYY-MM-DD.md (this file); growth/.local/growth-log.md §5 (today's plan), §6 (daily progress)
```

## Voice constraints

- British English. No emoji. Plain prose. Decision-shaped.
- Each action is one sentence with one verb. *"Reply to TreebeardAI's architecture follow-up: [draft pointer in §3]"*, not *"Consider engaging Treebeard if you have time"*.
- If yesterday's plan was skipped two days running, surface that as a drift flag in the heads-up section.
- Do not editorialise about Oak's productivity. The skill reports; it does not coach.

## Composition

- **Inputs:** canonical docs, growth-log, warm-contacts CSV, today's watcher file, latest twitter-strategy output (if recent).
- **Outputs:** chat brief, updated growth-log §5 (today's plan) and §6 (sprint daily progress).
- **Consumes:** `growth-watcher` outputs, `cluster-model` outputs, `twitter-strategy` outputs.
- **Auto-invokes stale feed routines** in Step 0: `cluster-model`, `growth-watcher`, `twitter-strategy`. Action routines (`x-post-builder`, `discover-twitter-recruits`) remain Oak-driven from the brief's recommendations.

## What this skill does not do

- Run *action* routines (`x-post-builder`, `discover-twitter-recruits`). Those have side-effects in the world (publish posts, change recruit lists) and require Oak's explicit invocation from the brief.
- *Feed* routines (`cluster-model`, `growth-watcher`, `twitter-strategy`) are auto-invoked in Step 0 when stale. They are read-only refreshes of the data plane.
- Draft reply text or posts. (That is `x-post-builder`.)
- Score posts. (That is `x-algorithm-grader`.)
- Make recruitment decisions. (Oak picks the actions; this skill ranks options.)

## Failure modes to handle gracefully

- **No active sprint in §6 (fail-loud).** Stop after Step 1.5. The canonical sprint shape is in GROWTH §9; quote it in the message. Emit exactly:
  ```
  GROWTH DAY — YYYY-MM-DD — BLOCKED

  No active sprint in growth-log §6.

  Either:
    1. Declare a sprint by appending a §6 sprint block per the GROWTH §9 shape, then re-run growth-day.
    2. Mark today an explicit rest day by appending under §6: `- YYYY-MM-DD — rest day, no sprint.`

  Sprint block template (per GROWTH §9):
    ### Sprint #N — <cluster name from GROWTH §3 or sub-segment thereof>
    - Window: YYYY-MM-DD → YYYY-MM-DD
    - Cluster definition: <verbatim, must reference GROWTH §3>
    - Inputs target: <countable items, e.g. 6 teach posts, reply cascade after each, 1 bridge post>
    - Thresholds: <e.g. 2 Tier-A warm rung, 1 inbound mention/quote, bonus 1 hot rung>
    - Decision rule: <hit ≥1 → double down; hit 0 → postmortem + pivot; postmortem either way>
  ```
  Do NOT proceed to compute a top-3, do NOT write to §5, do NOT auto-create a sprint. The fail-loud is the structural forcing function.
- **Watcher file missing for today.** Note: `[watcher not run today — consider running growth-watcher first]`. Continue with the rest of the brief using only growth-log state.
- **Growth-log §5 missing yesterday's plan.** Mark each loop bucket `[no plan]` and skip the compliance check. Still propose today's top-3.
- **Warm-contacts CSV missing.** Note: `[warm contacts not available — direct-offer compliance unchecked]`. Continue with what's readable.
- **Warm-contacts CSV present but missing rung columns.** Note: `[warm contacts on legacy schema — ready-to-advance unavailable, falling back to Status/Next-action heuristic]`. Continue.
- **No active threads in §3.** Note: `[no active threads — propose discovery round]` and surface a `discover-twitter-recruits` invocation as a Tier B action.
- **Sprint window has ended (end_date < today) and no postmortem in §7.** Emit a HEADS-UP item: `[Sprint #N ended YYYY-MM-DD — postmortem overdue. Write to §7 before declaring sprint #N+1.]` Treat the sprint as inactive (fail-loud) until the postmortem is written.
- **Feed routine fails mid-run** (Step 0). Continue with whatever stale state exists. Surface in HEADS-UP as `[<feed> failed: <one-line cause>]`. Do not retry automatically.
- **Skip-feeds override.** If Oak's invocation prompt contains "skip feeds" or "feeds already fresh", skip Step 0 entirely and proceed to Step 1.
