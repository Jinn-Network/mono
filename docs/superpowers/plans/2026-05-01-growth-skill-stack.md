# Growth Skill Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four-skill stack that operationalises Jinn's recruitment loop — `cluster-model` (market thought-modelling), `growth-watcher` (daily alert sweep), `twitter-strategy` (account-level activity vs GROWTH targets), and `growth-day` (the manual daily orchestrator). Plus follow-on edits to `discover-twitter-recruits` (promote round-of-2026-05-01 lessons into canon) and `x-post-builder` (add a `bridge-post` mode).

**Architecture:** Three tiers. **Tier 1** is the strategy lens (`twitter-strategy`, on-demand). **Tier 2** is the routines that write to `growth/.local/growth-log.md` — `cluster-model`, `growth-watcher`, plus the existing `discover-twitter-recruits`, `x-algorithm-grader`, `x-post-builder`. **Tier 3** is `growth-day`, the manual orchestrator that reads everything Tier 2 has produced + `growth/.local/jinn-warm-contacts.csv` and surfaces the day's three highest-leverage actions to Oak. Each skill points at canonical docs (`GROWTH.md`, `THESIS.md`, `BRAND.md`) rather than restating them.

**Tech Stack:** Markdown skills under `.claude/skills/<name>/SKILL.md`. No code, no framework. Skills compose via documented Skill-tool invocation. Data plane: `growth/.local/growth-log.md` (operational state, gitignored), `growth/.local/jinn-warm-contacts.csv` (warm list, gitignored), `growth/.local/watcher-YYYY-MM-DD.md` (daily alerts, gitignored). Skills read external state via the `bird` CLI (already installed at `/opt/homebrew/bin/bird`).

---

## File Structure

**Create:**
- `.claude/skills/cluster-model/SKILL.md`
- `.claude/skills/cluster-model/references/bridge-shapes.md`
- `.claude/skills/growth-watcher/SKILL.md`
- `.claude/skills/twitter-strategy/SKILL.md`
- `.claude/skills/growth-day/SKILL.md`

**Modify:**
- `.claude/skills/discover-twitter-recruits/SKILL.md` (add Two-logs subsection + cross-references)
- `.claude/skills/discover-twitter-recruits/references/audience-profile.md` (add §3 token-pump-with-substance subtype, §4 cron-vs-shill distinction, new §6 canonical first-touch bridge)
- `.claude/skills/discover-twitter-recruits/references/search-strategy.md` (add §1 audience-name-vocab anti-pattern + §7 programmatic post-filter)
- `.claude/skills/x-post-builder/SKILL.md` (add `bridge-post` mode)

**Reference (already in place, no edits this plan):**
- `growth/.local/growth-log.md`
- `growth/.local/jinn-warm-contacts.csv`
- `GROWTH.md`, `THESIS.md`, `BRAND.md`

**Decomposition rationale.** Each skill is one file with one responsibility. `cluster-model` gets a `references/bridge-shapes.md` because the canonical bridge sub-patterns by cluster are rich enough to be loaded on demand rather than embedded in the skill body. `growth-watcher`, `twitter-strategy`, and `growth-day` are single-file because their procedures are short. The `discover-twitter-recruits` edits are split into three files because that's where the existing structure puts each concern.

**Build order rationale.** `cluster-model` first (no deps; closest to today's session). `growth-watcher` second (small, high-value, no deps). `twitter-strategy` third (lens; doesn't depend on others). `growth-day` last (orchestrator; references the other three). The `discover-twitter-recruits` and `x-post-builder` edits are bundled at the end as a single canon-promotion task.

---

## Task 1: cluster-model SKILL.md

**Files:**
- Create: `.claude/skills/cluster-model/SKILL.md`

- [ ] **Step 1: Verify the parent directory does not yet exist**

Run: `ls -la .claude/skills/cluster-model 2>&1`
Expected: `ls: .claude/skills/cluster-model: No such file or directory`

If it exists, stop and confirm with the user before continuing.

- [ ] **Step 2: Create directory**

Run: `mkdir -p .claude/skills/cluster-model/references`
Expected: no output, exit 0.

- [ ] **Step 3: Write SKILL.md**

Write file `.claude/skills/cluster-model/SKILL.md`:

````markdown
---
name: cluster-model
description: Use to refine thought-models of the AI / crypto / AI×crypto clusters Jinn recruits from, identify gaps to the canonical THESIS frame, and output bridge angles for both broadcast posts and per-individual replies. Triggers on "what does the X cluster think", "build a cluster model", "find bridges to cluster Y", "where does our thinking diverge from the AI cluster", "update the cluster snapshot", "what bridges have we got", "refresh the market model". Reads canonical docs (THESIS, BRAND, GROWTH); writes cluster snapshots and bridge angles to growth/.local/growth-log.md sections 1 and 2. Composes upstream of discover-twitter-recruits (refines vocabulary) and x-post-builder bridge-post mode (consumes angles produced here).
---

# Cluster model

Refine per-cluster thought-models with verbatim evidence. Identify gaps to Jinn's canonical frame. Propose bridge angles for broadcast and per-individual outreach.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) — the recruiting bet and what we will not chase.
- [`THESIS.md`](../../../THESIS.md) — the canonical structural argument.
- [`BRAND.md`](../../../BRAND.md) — voice and headless-brand posture.
- [`growth/.local/growth-log.md`](../../../growth/.local/growth-log.md) §1 — current cluster snapshot.
- [`references/bridge-shapes.md`](references/bridge-shapes.md) — canonical sub-patterns by cluster.

This skill operationalises the recruitment loop articulated 2026-05-01: *continuously refine a model of how the market is thinking about decentralised agentic AI; look for opportunities to bridge clusters and individuals over to our way of thinking; out of that, source individual recruits, and speak to parts of the existing audience in a way that will resonate*. Do not redefine GROWTH-level claims here.

## What this skill does

One mode: **refresh**. Pulls fresh evidence per cluster, compares against last snapshot, identifies deltas, proposes bridge angles. Writes the result back to the growth log.

Three target clusters (canonical, do not invent new ones without a proposal):
- **AI** — AI-capability builders. Coordination treated as research/cryptography problem, not protocol-economic.
- **Crypto** — DeFi / mechanism-design fluent. Treats AI as productivity tool, not participant class.
- **AI × crypto** — agent-economy operators. Already shipping at one specific layer (identity / payment / execution / eval); often miss the outer-loop-with-stake.

## Mental model in one paragraph

The map is more valuable than the candidate list. Cluster thought-models are precipitates of recurring frames in cluster-shaping voices' public posts. The gap to Jinn is what those voices haven't said yet — the next move in their argument that lands in our frame. Bridge angles are the questions or claims that move them across that gap without naming Jinn. The pattern, observed across 5 successful first-touches by 2026-05-01: methodology question that engages a specific gap they've already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.

## When to run

- Weekly, as part of the routine cycle that feeds `growth-day`.
- Ad-hoc when a cluster shifts (a16z drops a manifesto, OpenAI ships agent platform, major operator rebalances).
- Before drafting a `bridge-post` (consumed by `x-post-builder` bridge-post mode).

## Procedure

Apply in order. Stop early if no new evidence since last snapshot.

### Step 1 — Read the current snapshot

Read `growth/.local/growth-log.md` §1. Note last-snapshot date per cluster.

### Step 2 — Pull fresh evidence per cluster

Use `bird user-tweets <handle> -n 20 --plain` for 3–5 cluster-shaping voices per cluster. Default voices (update as the cluster shifts):

- **AI:** `@iamtrask`, `@plasticlabs`, `@Vtrivedy10`, `@karpathy`, `@DarioAmodei` (use sparingly — too big).
- **Crypto:** `@newmichwill`, `@gdog97_`, `@cburniske`, `@Mona_El_Isa`.
- **AI × crypto:** `@DavideCrapis`, `@TreebeardAI`, `@boydcohen`, `@yieldfreaks`, `@ta_eis_eauton`.

For each voice, extract: recurring frames, named gaps, vocabulary they use, vocabulary they avoid, recent shifts in stance.

### Step 3 — Update cluster snapshot

For each cluster, update growth-log §1 with:
- **Frame:** one-paragraph current snapshot of how the cluster is thinking.
- **Evidence:** verbatim quotes with handle, date, URL.
- **Gap to Jinn:** what they haven't said yet that lands in our frame.

If the snapshot for that cluster is unchanged since last run, mark it `(no change since YYYY-MM-DD)` and skip.

### Step 4 — Identify bridge angles

For each cluster, propose 1–3 bridge angles. Each angle has:
- **Form:** broadcast post OR per-individual methodology question.
- **Claim:** the contestable claim or question that makes the bridge.
- **Target:** which voices in the cluster the bridge is calibrated for.
- **Sub-pattern reference:** which of `references/bridge-shapes.md`'s sub-patterns this instance applies.

### Step 5 — Write the deltas to growth-log §2

Append a dated entry to growth-log §2 (Bridge experiments). Honesty rules: if a bridge angle didn't change since last run, mark it `(carry over from YYYY-MM-DD)`. If a bridge angle was tried and failed, log the failure with the lesson.

### Step 6 — Recommend handoff

If a bridge angle is broadcast-shaped, note: "→ pass to `x-post-builder` bridge-post mode."
If a bridge angle is per-individual, note: "→ candidate handles for next `discover-twitter-recruits` round."

## Output format

Output the delta inline in chat (cluster-by-cluster), then write the structured update to the growth log. Both forms must be honest about what changed and what didn't.

```
CLUSTER MODEL — refresh dated YYYY-MM-DD

AI
  Frame change since last snapshot: [one line, or "no change"]
  New evidence: [up to 3 bullets with handle + verbatim quote + URL]
  Gap to Jinn: [unchanged / refined]
  New bridge angles: [up to 3]

CRYPTO
  [same shape]

AI × CRYPTO
  [same shape]

WRITTEN TO: growth/.local/growth-log.md §1, §2
HANDOFFS:
  - bridge-post candidates: [list]
  - next discovery target handles: [list]
```

## Voice constraints

- British English. No emoji. Plain prose.
- Builder-to-builder vocabulary. Strip marketing register.
- "Carry over from YYYY-MM-DD" is more useful than rewriting unchanged content.
- If a bridge angle has no evidence to back it, do not propose it.

## What this skill does not do

- Draft the broadcast post. (Hand off to `x-post-builder` bridge-post mode.)
- Profile-check candidates or run discovery. (Hand off to `discover-twitter-recruits`.)
- Score posts for reach. (That is `x-algorithm-grader`.)

## Composition

- **Inputs:** canonical docs, growth-log §1 prior snapshot, fresh `bird user-tweets` data.
- **Outputs:** updated growth-log §1, §2; bridge-angle handoffs.
- **Upstream of:** `discover-twitter-recruits` (cluster vocabulary feeds search), `x-post-builder` bridge-post mode (angles → drafts), `growth-day` (surfaces angles for today's actions).
````

- [ ] **Step 4: Verify file structure**

Run: `head -3 .claude/skills/cluster-model/SKILL.md && echo "---" && wc -l .claude/skills/cluster-model/SKILL.md`
Expected: first 3 lines show frontmatter (`---`, `name: cluster-model`, `description: ...`); line count ~115.

- [ ] **Step 5: Verify frontmatter is parseable**

Run: `awk '/^---$/{i++; if(i==2) exit} i==1' .claude/skills/cluster-model/SKILL.md | head -10`
Expected: opening `---`, then `name: cluster-model`, then a single-line `description:` field. No syntax errors.

- [ ] **Step 6: Smoke-test by invoking via Skill tool**

In a fresh Claude Code session (or via `claude -p`), trigger the skill with a phrase matching the description: *"build a cluster model"* or *"what does the AI cluster think"*. Verify the skill loads its body. Confirm the description triggers reliably.

If smoke test fails (description doesn't trigger), iterate the description string until it does.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/cluster-model/SKILL.md
git commit -m "feat(skills): add cluster-model skill scaffold"
```

---

## Task 2: cluster-model bridge-shapes reference

**Files:**
- Create: `.claude/skills/cluster-model/references/bridge-shapes.md`

- [ ] **Step 1: Write the reference**

Write file `.claude/skills/cluster-model/references/bridge-shapes.md`:

````markdown
# Bridge shapes — canonical sub-patterns by cluster

Companion to the `cluster-model` skill. Distilled from successful first-touches as of 2026-05-01. Read once when proposing bridge angles; treat as a starting point, not a rulebook.

## The canonical shape (cross-cluster)

> Methodology question that engages a specific gap the candidate has already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.

The question must not be answerable from the candidate's own README, post, or pinned thread. Proves you actually engaged with the work. The reply gives the candidate room to push back; if they push back with substance, you have a thread.

## Sub-pattern 1 — AI cluster: flip the eval economics

**Latent assumption to surface:** the harness owner sets the task distribution.
**Bridge claim:** what changes when the task distribution comes from external creators with stake — i.e. evals are paid for by the people whose outcomes are being verified, not by the harness owner?

**Evidence this lands:** `@Vtrivedy10` (LangChain Deep Agents) reply 2026-05-01 received this question; awaiting response. `@ta_eis_eauton` (Silverarrow / autoharness) responded warmly to a methodology question on tau2 deltas, then cross-linked Vtrivedy10 — confirms cluster.

**When to use:** AI-cluster builders shipping evals, harness, or self-improvement infra. Skip for AI-safety-realist accounts (Leopold-shape) — different worldview, this bridge does not land.

## Sub-pattern 2 — Crypto cluster: agents-as-participants in mech-design

**Latent assumption to surface:** participants are LP / trader / arbitrageur / borrower.
**Bridge claim:** the mech-design discipline you apply to liquidations / oracle design / vault curation maps cleanly to a participant class you don't yet model — agents delivering verified outcomes for stake. Same mechanism, new participant.

**Evidence this lands:** unverified — no successful crypto-cluster first-touch in the discovery log yet. Best target shape: `@newmichwill` ("Free markets clean up bad loans permissionlessly") — claim-and-evaluate loop is structurally identical to outcome-attestation. Use methodology language he already speaks.

**When to use:** crypto-cluster builders ranking high on mech-design fluency. Skip for $TICKER-leading accounts.

## Sub-pattern 3 — AI × crypto cluster: layer-as-scaffolding

**Latent assumption to surface:** the layer they ship is the endgame.
**Bridge claim:** identity / payment / execution / eval are scaffolding for the layer that hasn't shipped — the outer loop with stake that ties them together.

**Evidence this lands:** `@TreebeardAI` reply 2026-05-01 ("Agreed re rating from the outside. What's the best architecture for this though? Easily routed around when there's no skin in the game") — accepts the structural claim, asks them to extend it. `@yieldfreaks` (AHM) Apr 28-29 conversation — methodology question on cross-registry double-counting earned peer-recognition reply.

**When to use:** AI × crypto builders shipping at a specific layer (registry, payments, eval). Most fertile cluster.

## Sub-pattern 4 — Bitcoin-maxi-adjacent: trust-score adversarial mechanism

**Latent assumption to surface:** the trust score is robust because the rest of the stack (DID, attestations, delegation) is.
**Bridge claim:** the trust score is the load-bearing piece; what stops it collapsing when both sides of a transaction can self-attest? Stake on the verifier, reputation history, or external rater outside the platform?

**Evidence this lands:** `@boydcohen` (Observer Protocol / Mexico / Lightning) — reply drafted 2026-05-01, not yet sent. Multi-rail framing avoids ETH-tribal vocabulary. Bitcoin-maxi-adjacent is a real subtype of AI × crypto; bridge through cross-rail framing not Ethereum.

**When to use:** AI × crypto builders with explicit Bitcoin / Lightning / multi-rail commitments. Vocabulary discipline matters.

## Sub-pattern 5 — Enterprise-AI register: deferred until human surfaces

**Latent assumption:** none recoverable without re-routing.
**Bridge claim:** N/A — when the org account speaks in McKinsey / Gartner / EU AI Act register, the bridge has to wait until a human builder behind the org posts in their own voice.

**Evidence this lands:** `@tracememcom` deferred 2026-05-01 for exactly this reason. Substance was real (decision envelopes, immutable DecisionDB) but org-account register was unrecoverable.

**When to use:** never directly. Re-route trigger: a human builder behind the org surfaces with a substance post in their own voice. Re-evaluate only then.

## Sub-pattern 6 — Bot/cron-pattern: re-route to operator

**Latent assumption:** none — the entity is not a recruit.
**Bridge claim:** N/A — but the cron-pattern poster usually points at a real human operator if you check who tags them or who they're contributing to.

**Evidence this lands:** `@Maxibtc2009` (cron-repeating Observer Protocol content-agent) → `@boydcohen` re-route, 2026-05-01. The Apr 3 OpenWallet hackathon submission tagged `@boydcohen` and `@HalseyHuth` — surfaced the human.

**When to use:** when a candidate post is substantive but the account is bot-shaped. Always profile-check the project tags / co-builders before deciding to skip.

## How to update this file

Add a new sub-pattern when a successful first-touch produces a reusable shape across two or more candidates. Each sub-pattern needs: latent assumption, bridge claim, evidence, when-to-use. Remove a sub-pattern only if it is empirically falsified across three or more attempts.
````

- [ ] **Step 2: Verify file**

Run: `wc -l .claude/skills/cluster-model/references/bridge-shapes.md && grep -c '^## Sub-pattern' .claude/skills/cluster-model/references/bridge-shapes.md`
Expected: ~70 lines; 6 sub-patterns.

- [ ] **Step 3: Verify cross-references resolve**

Run: `grep -E '^\[.*\]' .claude/skills/cluster-model/SKILL.md | head -10`
Expected: links to GROWTH.md, THESIS.md, BRAND.md, growth-log, bridge-shapes.md all visible. No broken paths.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/cluster-model/references/bridge-shapes.md
git commit -m "feat(skills): add bridge-shapes reference for cluster-model"
```

---

## Task 3: growth-watcher SKILL.md

**Files:**
- Create: `.claude/skills/growth-watcher/SKILL.md`

- [ ] **Step 1: Create directory**

Run: `mkdir -p .claude/skills/growth-watcher`
Expected: no output.

- [ ] **Step 2: Write SKILL.md**

Write file `.claude/skills/growth-watcher/SKILL.md`:

````markdown
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
````

- [ ] **Step 3: Verify file**

Run: `head -3 .claude/skills/growth-watcher/SKILL.md && wc -l .claude/skills/growth-watcher/SKILL.md`
Expected: frontmatter starts cleanly; line count ~110.

- [ ] **Step 4: Smoke-test the description**

Trigger the skill with one of: *"any recruitment news"*, *"who replied"*, *"morning recruit check"*. Verify it loads.

- [ ] **Step 5: Sanity-check the procedure manually**

Without running the skill, walk through the procedure on today's growth-log §3:
1. Confirm you can list the active-thread handles (yieldfreaks, ta_eis_eauton, TreebeardAI, Vtrivedy10, boydcohen).
2. Confirm `bird user-tweets yieldfreaks -n 5 --plain` returns recognisable structured output.
3. Confirm the watcher-output filename pattern is unambiguous: `growth/.local/watcher-2026-05-01.md`.

If any step fails, iterate the procedure section until it is unambiguous.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/growth-watcher/SKILL.md
git commit -m "feat(skills): add growth-watcher daily sweep skill"
```

---

## Task 4: twitter-strategy SKILL.md

**Files:**
- Create: `.claude/skills/twitter-strategy/SKILL.md`

- [ ] **Step 1: Create directory**

Run: `mkdir -p .claude/skills/twitter-strategy`
Expected: no output.

- [ ] **Step 2: Write SKILL.md**

Write file `.claude/skills/twitter-strategy/SKILL.md`:

````markdown
---
name: twitter-strategy
description: Use to analyse Oak's X account activity vs GROWTH.md targets and surface drift flags — post cadence, engagement patterns, who's replying, reply rate from priority audiences, reach drift, voice drift. Triggers on "how am I doing on X", "twitter strategy review", "am I on track", "GROWTH metrics check", "is the teach loop holding", "account-level review", "weekly X review", "is the strategy working", "are we on track for mainnet operator gate". Reads canonical docs (GROWTH, THESIS, BRAND); writes the review inline in chat. Distinct from x-algorithm-grader (per-post grading) — this is account-level over a 7-day or 30-day window.
---

# Twitter strategy

Account-level activity vs GROWTH targets. Not per-post grading. Catches drift between what Oak is doing on X and what the GROWTH bet calls for.

## Read first
- [`GROWTH.md`](../../../GROWTH.md) — the bet (§1), the daily loop (§4), what we will not chase (§5), the metrics (§6).
- [`THESIS.md`](../../../THESIS.md) — the structural argument the teach loop is supposed to teach.
- [`BRAND.md`](../../../BRAND.md) — voice canon. *"Lead from structure, not from fear."*

This skill points at GROWTH; it does not restate it.

## What this skill does

One mode: **review**. Three windows by default — last 7 days, last 30 days, and rolling. Outputs drift flags per GROWTH §4 loop bucket and per §6 metric.

## When to run

- Weekly, ideally Sunday evening or Monday morning before the Teach loop fires.
- On-demand when drift is suspected (engagement dropped, voice slipped, reply rate fell off).
- Before any strategic change to the daily loop.

## Procedure

### Step 1 — Pull account activity

Run:
```
bird user-tweets tannedoaksprout -n 100 --plain > /tmp/oak-recent-30d.txt
bird mentions -n 100 --plain > /tmp/oak-mentions-30d.txt
```

If a thirty-day window includes pages, paginate using `--cursor`.

### Step 2 — Bucket posts by GROWTH §4 loop

Classify each original post (not retweet) into one of the four buckets:
- **Teach** — public artefact on the thesis. Threads, essays, talks, recorded walkthroughs.
- **Understand** — listening reply on someone else's substantive post.
- **Direct offer** — explicit testnet operator slot ask.
- **Interact** — synchronous DM-style exchange. Mostly invisible from public-only data; treat as `[unknown — out of scope for this skill]`.

Quote tweets are Teach if the QT itself adds substance; otherwise Interact. Replies are Understand by default; reclassify to Teach if the reply is a substantive standalone artefact.

### Step 3 — Compute targets vs actuals

GROWTH §4 implicit targets:
- **Teach:** ≥1 per working day. Compute: count(Teach posts) / working days in window.
- **Understand:** ≥1 per working day.
- **Direct offer:** weekly cadence to warm list. Cross-check against `growth/.local/jinn-warm-contacts.csv` last-contact dates if present.

GROWTH §6 metrics:
- **External testnet operators** — surface count if known (manual input — out of scope here).
- **Inbound interest** — count DMs / unsolicited mentions from priority audiences in window. Use mentions corpus.

### Step 4 — Detect §5 violations

Scan posts in window for:
- *Fear-bait, empowerment-bait, or marketing register.* Heuristic: posts containing "the future is", "we are so early", "this changes everything", "bullish doesn't even cover it", "if you don't do X you'll miss Y", or scare quotes around opponents. Flag each as a candidate violation; do not auto-fail without context.
- *Retired framings.* Heuristic: literal substring match against `Own What You Know`, `become a founder`, `your AI's experience is worth something`, `desired obsolescence`, `launch a token`. Flag.
- *Founder framing.* Posts that pitch from a separate-status position to the reader. Heuristic: posts using "we" referring to Oak + Ritsu without including the reader.

### Step 5 — Detect engagement drift

For each Teach post in the 30-day window, record reach (impressions if visible, replies, QTs). Compare to baseline (median of the prior 30 days, or absolute baseline ~10k impressions for a healthy Teach post in this cluster).

Flag drift in either direction:
- **Falling reach + same voice** → cluster shifting; refresh `cluster-model`.
- **Rising reach + voice drift** → recruiting wrong audience; re-anchor against BRAND.md.

### Step 6 — Output

Print the structured review (format below) inline in chat. Do not write to disk — this skill is a lens, not a state file.

If `growth-day` invokes this skill, the review feeds the day's drift flag.

## Output format

```
TWITTER STRATEGY REVIEW — YYYY-MM-DD (window: 7d / 30d)

§4 LOOP — actuals vs target
  Teach          [N posts]  vs target ≥5/wk      [PASS / DRIFT]
  Understand     [N replies] vs target ≥5/wk     [PASS / DRIFT]
  Direct offer   [N asks]   vs target ≥1/wk      [PASS / DRIFT]
  Interact       [unknown — out of scope]

§5 VIOLATIONS
  [N flagged] — [list each with URL + heuristic match]
  (or) (none in window)

§6 METRICS
  External operators (manual)     [if known]
  Inbound interest (mentions)     [N from priority audiences]
  Cluster signal (RTs, QTs)       [N priority-audience boosts]

ENGAGEMENT DRIFT
  Recent Teach post reach         [median impressions, replies, QTs]
  Trend                           [stable / falling / rising]
  Likely cause                    [voice / cluster / neither]

DRIFT FLAGS (top-3 surface for growth-day)
  1. [single sentence with action]
  2. [single sentence with action]
  3. [single sentence with action]
```

## Voice constraints

- British English. No emoji. Plain prose. Decision-shaped.
- "DRIFT" and "PASS" labels only — do not editorialise pass/fail.
- Action sentences are imperatives: *"Ship one Teach post on outcome mining today"*, not *"Consider posting more"*.
- If a metric is genuinely unknowable from public data, say so: `[unknown — out of scope]`. Do not invent.

## Composition

- **Inputs:** canonical docs (GROWTH, THESIS, BRAND), `bird` CLI.
- **Outputs:** chat review.
- **Consumed by:** `growth-day` (incorporates drift flags into the day's brief).

## What this skill does not do

- Grade a specific draft. (That is `x-algorithm-grader`.)
- Generate posts. (That is `oak-content-strategy` or `x-post-builder`.)
- Modify GROWTH.md. (Changes to canonical docs go through `spec/2026-04-28-canonical-docs.md` proposal flow.)
````

- [ ] **Step 3: Verify file**

Run: `head -3 .claude/skills/twitter-strategy/SKILL.md && wc -l .claude/skills/twitter-strategy/SKILL.md`
Expected: frontmatter starts cleanly; line count ~115.

- [ ] **Step 4: Smoke-test the description**

Trigger with: *"how am I doing on X"*, *"weekly X review"*, *"GROWTH metrics check"*. Verify the skill loads.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/twitter-strategy/SKILL.md
git commit -m "feat(skills): add twitter-strategy account-level review skill"
```

---

## Task 5: growth-day SKILL.md

**Files:**
- Create: `.claude/skills/growth-day/SKILL.md`

- [ ] **Step 1: Create directory**

Run: `mkdir -p .claude/skills/growth-day`
Expected: no output.

- [ ] **Step 2: Write SKILL.md**

Write file `.claude/skills/growth-day/SKILL.md`:

````markdown
---
name: growth-day
description: Daily orchestrator for Jinn growth work — bundles outputs from cluster-model, growth-watcher, and discover-twitter-recruits, checks GROWTH.md §4 daily-loop discipline (Teach / Understand / Direct offer / Interact), reads warm-contacts cadence, and surfaces 3 ranked actions for the day. Triggers on "growth day", "morning growth standup", "what should I do today for growth", "daily growth check", "what's pending", "start of day jinn", "let's plan today's growth work", "growth check-in", "what's next on growth". Reads growth/.local/growth-log.md, growth/.local/jinn-warm-contacts.csv, today's growth/.local/watcher-*.md if present, last cluster-model snapshot. Output is a chat briefing with 4 fixed sections — yesterday's loop check, today's top-3 actions, heads-up alerts, drift flags. Updates growth-log §5 with today's plan.
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

### Step 1 — Read state

Read in order:
1. `GROWTH.md` (re-anchor every run; cheap and prevents drift).
2. `growth/.local/growth-log.md` — full file, especially §3 (active threads), §5 (yesterday's plan), §1 (cluster snapshot date).
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
## YYYY-MM-DD plan
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
- **Does not auto-invoke:** other skills. Oak invokes them on-demand based on the brief's recommendations.

## What this skill does not do

- Run the routines (`cluster-model`, `growth-watcher`, `twitter-strategy`, `discover-twitter-recruits`). Oak runs those separately.
- Draft reply text or posts. (That is `x-post-builder`.)
- Score posts. (That is `x-algorithm-grader`.)
- Make recruitment decisions. (Oak picks the actions; this skill ranks options.)

## Failure modes to handle gracefully

- **Watcher file missing for today.** Note: `[watcher not run today — consider running growth-watcher first]`. Continue with the rest of the brief using only growth-log state.
- **Growth-log §5 missing yesterday's plan.** Mark each loop bucket `[no plan]` and skip the compliance check. Still propose today's top-3.
- **Warm-contacts CSV missing.** Note: `[warm contacts not available — direct-offer compliance unchecked]`. Continue with what's readable.
- **No active threads in §3.** Note: `[no active threads — propose discovery round]` and surface a `discover-twitter-recruits` invocation as a Tier B action.
````

- [ ] **Step 3: Verify file**

Run: `head -3 .claude/skills/growth-day/SKILL.md && wc -l .claude/skills/growth-day/SKILL.md`
Expected: frontmatter starts cleanly; line count ~150.

- [ ] **Step 4: Smoke-test the description**

Trigger with one of: *"growth day"*, *"what should I do today for growth"*, *"daily growth check"*. Verify the skill loads.

- [ ] **Step 5: Dry-run the procedure manually on today's state**

Without running the skill, walk through:
1. Read `growth/.local/growth-log.md` §5 — confirm yesterday's plan was captured (it wasn't yet, on first run; that's fine — handle gracefully per Failure modes).
2. Read `growth/.local/jinn-warm-contacts.csv` — confirm Status / Next action fields are populated.
3. Confirm today's watcher file's expected path: `growth/.local/watcher-2026-05-01.md`. If it doesn't exist, that's expected on first run.
4. Compute today's top-3 manually using the leverage ranking. Confirm the heuristic produces a sensible list given the current growth-log state.

If any step is unclear, iterate the procedure section.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/growth-day/SKILL.md
git commit -m "feat(skills): add growth-day daily orchestrator skill"
```

---

## Task 6: discover-twitter-recruits canon promotions

**Files:**
- Modify: `.claude/skills/discover-twitter-recruits/SKILL.md` (add Two-logs subsection)
- Modify: `.claude/skills/discover-twitter-recruits/references/audience-profile.md` (add §3 token-pump-with-substance subtype, §4 cron-vs-shill distinction, new §6 canonical first-touch bridge)
- Modify: `.claude/skills/discover-twitter-recruits/references/search-strategy.md` (add §1 audience-name-vocab anti-pattern + new §7 programmatic post-filter)

- [ ] **Step 1: Read existing files**

Read these three files into context to understand current structure:
- `.claude/skills/discover-twitter-recruits/SKILL.md`
- `.claude/skills/discover-twitter-recruits/references/audience-profile.md`
- `.claude/skills/discover-twitter-recruits/references/search-strategy.md`

Note section numbering and cross-reference patterns.

- [ ] **Step 2: Add Two-logs subsection to SKILL.md**

Find the section "## Calibration loop" in `.claude/skills/discover-twitter-recruits/SKILL.md`. Insert this new subsection immediately after that section's closing paragraph:

````markdown
## Two logs — calibration vs operational

This skill maintains two logs with distinct purposes:

- **`references/discovery-log.md`** — skill calibration evidence. Recommendation rationale + outcome + lesson, kept in repo so the skill learns over time. Anonymise where the lesson is generalisable. Update this file after any outreach attempt that produces a clear lesson.
- **`growth/.local/growth-log.md`** — operational state. Live thread state, drafts, pending replies, candidate handles in operational form. Gitignored. Updated by Oak and by `growth-watcher` / `growth-day` skills.

Do not write live operational state into `discovery-log.md`. Do not duplicate calibration lessons into `growth-log.md`. The boundary is sharp because the failure mode of conflating them is real — calibration evidence in the operational log produces noise; operational state in the calibration log produces leakage.
````

Run to verify:
```
grep -n 'Two logs' .claude/skills/discover-twitter-recruits/SKILL.md
```
Expected: one match.

- [ ] **Step 3: Add token-pump-with-substance subtype to audience-profile.md §3**

Open `.claude/skills/discover-twitter-recruits/references/audience-profile.md`. Locate the table under `## §3. Out-of-scope audiences`. Insert this new row at the bottom of the table (before the `## §4` heading or wherever the table ends):

```
| Real-product-with-token-pump | An account ships a thesis-aligned product (registry, oracle, eval tool) but the surrounding feed is `$TICKER` shilling, gated-by-token-holding social engineering, or pump-style RTs. The product does not outweigh the §4 patterns. The @gingersamurai lesson generalises: profile-check the *whole feed*, not the on-thesis tweet. Example failure: `@helixaxyz` (real ERC-8004 reputation oracle + heavy `$CRED` shilling). |
```

Run to verify:
```
grep -n 'Real-product-with-token-pump' .claude/skills/discover-twitter-recruits/references/audience-profile.md
```
Expected: one match.

- [ ] **Step 4: Add cron-vs-shill distinction to audience-profile.md §4**

Locate the bot/shill detection list under `## §4. Defining traits of real recruits` (or whichever §4 heading bot-detection lives under in the current file — confirm via `grep -n '§4' references/audience-profile.md`). Append this new row to the detection table or list:

```
| Same content posted multiple days from one account (cron / scheduled repost pattern) | YELLOW — likely a content-agent or scheduling tool, not a shill ring. Not a hard kill. Profile-check for a human operator behind the project (look for tags / co-builders / hackathon submissions). Re-route recommendation to the human if found. Distinct from shill-ring (identical content across many accounts on the same day = HARD kill). Example: `@Maxibtc2009` (cron content-agent for Observer Protocol; re-routed to `@boydcohen`). |
```

Run to verify:
```
grep -n 'cron / scheduled' .claude/skills/discover-twitter-recruits/references/audience-profile.md
```
Expected: one match.

- [ ] **Step 5: Add §6 canonical first-touch bridge to audience-profile.md**

Append this new section at the end of `audience-profile.md`:

````markdown

## §6. The canonical first-touch bridge

All successful first-touch outreach in this skill's calibration history follows the same shape:

> Methodology question that engages a specific gap the candidate has already named, asking them to extend their thinking one step further toward the Jinn frame, without naming Jinn.

Sub-patterns by cluster (full detail in `cluster-model/references/bridge-shapes.md`):

- **AI cluster:** flip the eval economics — task distribution from external creators with stake.
- **Crypto cluster:** agents-as-participants in mech-design they already understand.
- **AI × crypto cluster:** name the layer they ship as scaffolding for the outer loop with stake.
- **Bitcoin-maxi-adjacent:** trust-score adversarial mechanism design (stake / reputation / external rater).

The question must not be answerable from the candidate's own README, post, or pinned thread. Proves you actually engaged with the work.

Calibration evidence (2026-04-29 to 2026-05-01):
- `@yieldfreaks` — peer-recognition reply within 5 hours.
- `@ta_eis_eauton` (Silverarrow) — warm reply, cross-linked to `@Vtrivedy10`.
- `@TreebeardAI`, `@Vtrivedy10`, `@boydcohen` — outreach in flight; pending outcomes will refine the sub-patterns.

Do not skip this section when proposing a first-touch reply. If the proposed question fails the not-answerable-from-README test, rework it.
````

Run to verify:
```
grep -n '§6. The canonical first-touch bridge' .claude/skills/discover-twitter-recruits/references/audience-profile.md
```
Expected: one match.

- [ ] **Step 6: Add audience-name-vocab anti-pattern to search-strategy.md §1**

Locate `## §1.` (the anti-pattern section) in `.claude/skills/discover-twitter-recruits/references/search-strategy.md`. Append this new row to the anti-pattern table:

```
| `bird search "olas pearl"` / `bird search "bittensor subnet operator"` (audience-name vocabulary, no post-filter) | Surfaces marketing-quest accounts (NEAR Legion, BASE quest, daily-GM-on-Robinhood-Chain pattern) and signal-bots before real builders. The vocabulary is correct; the lack of post-filter is the bug. Always combine audience-name vocabulary with the post-filter in §7. |
```

Run to verify:
```
grep -n 'marketing-quest accounts' .claude/skills/discover-twitter-recruits/references/search-strategy.md
```
Expected: one match.

- [ ] **Step 7: Add §7 programmatic post-filter to search-strategy.md**

Append this new section at the end of `search-strategy.md`:

````markdown

## §7. Programmatic post-filter (audience-name vocabulary)

When `bird search` over audience-name vocabulary returns >25 results, apply this post-filter before profile-checking. The filter is heuristic; tune as needed.

**Reject the candidate if any of the following hold across their last ~12 posts:**

- **Token-ticker prelude rate ≥ 40%.** Posts beginning with `$XXX` or containing `CA: 0x...`. Heuristic regex: `^\$[A-Z]{2,6}\b` or `\bCA:\s*0x[a-fA-F0-9]{8,}` over the candidate's recent timeline.
- **Hashtag-stack rate ≥ 30%.** Posts containing 3+ consecutive hashtags (`#X #Y #Z`) or posts where hashtags are >25% of the post's word count.
- **🚨-prefix or all-caps-screaming pattern ≥ 30%.** Posts starting with `🚨`, `BREAKING`, `ATTENTION`, or 5+ consecutive uppercase words.
- **Marketing-register density ≥ 25%.** Posts containing any of: `we are so early`, `this is a game changer`, `the future is`, `you don't want to miss`, `bullish doesn't even cover it`, `next 100x`, `gem unlock`, `alpha leak`. Combined match.

**Do not auto-reject** if a candidate's recent timeline has 0–2 of these patterns alongside substantive builder posts. Use judgement; the filter is a triage aid, not a verdict.

**Confirmed examples of the filter working** (2026-05-01 round):
- `@bittingthembits` — substantive Bittensor analysis but >40% token-ticker prelude rate ($TAO leading); rejected for recruit list.
- `@TheTaoDesk` — auto-generated alpha alerts, hashtag-stack ≥40%, 🚨-prefix ≥40%; rejected.
- `@maxbettorwinnor` / `@bollaks101` / `@DkingYooo18516` — all rejected via this filter pattern.

**The filter must run before profile-checking deeper.** Saves discovery time on candidates who would have failed §3 anyway.
````

Run to verify:
```
grep -n '§7. Programmatic post-filter' .claude/skills/discover-twitter-recruits/references/search-strategy.md
```
Expected: one match.

- [ ] **Step 8: Verify the discovery-log structural note**

Read `.claude/skills/discover-twitter-recruits/references/discovery-log.md` first lines. If the file does not yet have a header note pointing at the operational growth log, add it at the top of the file (immediately after the title):

```markdown
> **Two logs.** This file holds skill calibration evidence (recommendation rationale + outcome + lesson, in-repo, durable). Live operational state — current threads, drafts, pending replies — lives in `growth/.local/growth-log.md` (gitignored). Do not duplicate. See `SKILL.md` *Two logs* subsection for the boundary.
```

Run to verify:
```
head -5 .claude/skills/discover-twitter-recruits/references/discovery-log.md
```
Expected: title visible, then the two-logs note.

- [ ] **Step 9: Commit**

```bash
git add .claude/skills/discover-twitter-recruits/
git commit -m "feat(skills): promote 2026-05-01 calibration lessons into discover-twitter-recruits canon"
```

---

## Task 7: x-post-builder bridge-post mode

**Files:**
- Modify: `.claude/skills/x-post-builder/SKILL.md` (add `bridge-post` mode)

- [ ] **Step 1: Read existing file**

Read `.claude/skills/x-post-builder/SKILL.md` to confirm current structure (modes, voice, composition).

- [ ] **Step 2: Locate the modes section**

Run: `grep -n -E '^##|^###' .claude/skills/x-post-builder/SKILL.md`
Expected: section headings listed; identify where modes are described.

- [ ] **Step 3: Add bridge-post mode section**

After the existing modes section (or where modes-by-input-type are documented), add the following:

````markdown
## Mode: bridge-post

A bridge post is a 3-tweet thread that names a structural gap several candidates are independently shipping toward, framed so each candidate sees their own work and a shared frame. Different from an original-thesis post (closed argument) and from a reaction (responds to one external trigger).

### Inputs

- A bridge angle from `cluster-model` skill output (growth-log §2 entry, dated, with form=broadcast).
- 2–4 candidate handles whose work the post should name. Pulled from growth-log §3 active threads or §1 cluster snapshot.
- Voice anchor: `BRAND.md` *Lead from structure, not from fear*. The bridge post leads from the gap and the construction, never from the antagonist.

### Output structure

Three tweets:

**Tweet 1 — gap-name (240–259 chars, sweet zone, 1.2× algo multiplier).**
- Format: *"X is shipped (project A). Y is shipped (project B). Z is shipped (project C). What hasn't shipped: [the gap]. The binding constraint isn't [obvious wrong answer]. It's [the actual gap, claim-shaped]."*
- Voice: declarative, plain-prose, no emoji.
- Author-reply trap: closing claim is contestable.

**Tweet 2 — layer-map (240–259 chars).**
- Format: *"What's already in place, partial: [layer 1 work] ([candidate A]). [Layer 2 work] ([candidate B]). [Layer 3 work] ([candidate C]). [Layer 4 work] ([candidate D]). None alone closes the loop."*
- Names projects (not handles, except where the project handle and the operator handle differ — then prefer the operator handle).
- Each candidate sees their own work credited accurately.

**Tweet 3 — tie-claim (71–100 chars, sweet zone, 1.3× algo multiplier).**
- Format: *"[The unifying principle] is what ties them together — and it's the layer that hasn't shipped."*
- Short, sharp, contestable.

### Procedure

1. **Read the bridge angle.** From `cluster-model` output or growth-log §2.
2. **Confirm 2–4 candidates whose work the layers map to.** Pull from growth-log §3.
3. **Draft tweet 1** in the gap-name shape. Constrain to 240–259 chars.
4. **Draft tweet 2** in the layer-map shape. Each candidate gets one mention.
5. **Draft tweet 3** in the tie-claim shape. Constrain to 71–100 chars.
6. **Hand off to `x-algorithm-grader`** for binding-constraint check and single-edit recommendation.
7. **If grader returns score ≥0.7**, output the thread for scheduling (Typefully or manual). Otherwise apply the grader's edit and re-grade.
8. **Schedule for cluster-peak window:** Tue–Thu 09:00–14:00 target-tz.

### Worked example (2026-05-01)

Bridge angle: *"the outer loop with stake is the layer that hasn't shipped."* Candidates: `@TreebeardAI`, `@tracememcom`, `@boydcohen` / Observer Protocol, `@Vtrivedy10` / LangChain Deep Agents.

Tweet 1: *"The agent economy has identity (ERC-8004), payment (x402), and execution (PoAA). What it doesn't have, deployed end-to-end: independent outcome verification with stake. The binding constraint isn't a smarter model. It's a verification loop with skin in the game."*

Tweet 2: *"What's already in place, partial: rating from outside the platform (Treebeard). Enforcement before execution (TraceMem). Post-execution verification (Observer Protocol). Eval-harness inner loops (LangChain Deep Agents). None alone closes the loop."*

Tweet 3: *"The outer loop with stake is what ties them together — and it's the layer that hasn't shipped."*

### Voice constraints (mode-specific)

In addition to general x-post-builder voice constraints:

- **Do not @-tag the candidates** in the post. Naming the project (or the operator's first name + product) is sufficient and avoids fishing-for-attention register.
- **Each candidate sees their own work named accurately.** If you can't credit accurately, leave them out.
- **Avoid framing the bridge as competition.** The post says "none alone closes the loop", not "we have what they don't".
- **Do not name Jinn.** The bridge is a frame, not a pitch. Jinn is the unstated implication — readers who want to act on it find Oak's other posts.

### Composition

- **Inputs:** `cluster-model` output (bridge angle), growth-log §3 (candidates).
- **Outputs:** 3-tweet draft thread + scheduled post (manual handoff to Typefully).
- **Hand-off:** `x-algorithm-grader` runs between drafting and scheduling.
- **Consumed by:** `growth-day` (surfaces ready bridge posts as Tier A actions).
````

- [ ] **Step 4: Verify the addition**

Run: `grep -n '## Mode: bridge-post' .claude/skills/x-post-builder/SKILL.md`
Expected: one match.

Run: `grep -c -E '^### ' .claude/skills/x-post-builder/SKILL.md`
Expected: increased from previous count by ~5 (input, output, procedure, example, voice, composition subsections).

- [ ] **Step 5: Smoke-test the new mode**

In a fresh Claude Code session, trigger `x-post-builder` with: *"build me a bridge post"* or *"draft a bridge post from the cluster model"*. Verify the skill loads and the bridge-post mode is recognised in the body.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/x-post-builder/SKILL.md
git commit -m "feat(skills): add bridge-post mode to x-post-builder"
```

---

## Verification (after all tasks)

- [ ] **Step 1: Lint all new SKILL.md files for frontmatter parseability**

Run:
```
for f in .claude/skills/{cluster-model,growth-watcher,twitter-strategy,growth-day}/SKILL.md; do
  echo "=== $f ==="
  awk '/^---$/{i++; if(i==2) {print "frontmatter ends at line "NR; exit}; print NR": "$0; next} i==1{print NR": "$0}' "$f" | head -10
done
```
Expected: each file has a clean frontmatter with `name` and `description` fields, both single-line.

- [ ] **Step 2: Verify all cross-references resolve**

Run:
```
for f in .claude/skills/{cluster-model,growth-watcher,twitter-strategy,growth-day}/SKILL.md; do
  echo "=== $f ==="
  grep -oE '\[.*?\]\([^)]+\)' "$f" | grep -v 'http' | head -10
done
```

For each markdown link, verify the path resolves from the SKILL.md's location. Mark broken links and fix in the corresponding SKILL.md.

- [ ] **Step 3: End-to-end smoke test**

In a fresh Claude Code session, simulate one day's flow:
1. Invoke `cluster-model` — verify it loads.
2. Invoke `growth-watcher` — verify it loads, run dry against today's growth-log.
3. Invoke `twitter-strategy` — verify it loads.
4. Invoke `growth-day` — verify it loads, produces a brief.
5. Invoke `discover-twitter-recruits` — verify the Two-logs subsection is visible in the body.
6. Invoke `x-post-builder` with a bridge-post request — verify the new mode is recognised.

If any skill fails to load or the body is malformed, return to the corresponding task and fix.

- [ ] **Step 4: Final commit**

If any verification fixes were needed:
```bash
git add .claude/skills/
git commit -m "fix(skills): verification fixes from end-to-end smoke test"
```

If no fixes needed, skip this step.

- [ ] **Step 5: Optional — wire scheduled invocations**

Three of the four new skills are designed for scheduled execution:
- `cluster-model` — weekly (Sunday evening).
- `growth-watcher` — weekday mornings.
- `twitter-strategy` — weekly (Sunday evening).

Use the `schedule` skill or set up cron-style routines via the runtime's scheduling primitive. This is optional; manual invocation works equally well during the calibration period (first 2–3 weeks of use).

---

## Self-review checklist

Reviewed the plan against the spec discussed in the conversation:

- [x] **Cluster-model skill (Tier 2 routine).** Task 1 + Task 2 cover the SKILL.md and bridge-shapes reference.
- [x] **Growth-watcher skill (Tier 2 routine).** Task 3 covers the SKILL.md including the four signal types (replies received, fresh substantive, mentions, cluster signals).
- [x] **Twitter-strategy skill (Tier 1 lens).** Task 4 covers the SKILL.md including the GROWTH §4 / §5 / §6 buckets.
- [x] **Growth-day skill (Tier 3 orchestrator).** Task 5 covers the SKILL.md including the leverage-ranking heuristic (Tier A / B / C) and the 4-section output format.
- [x] **Discover-twitter-recruits canon promotions.** Task 6 covers Two-logs subsection + audience-profile §3 / §4 / §6 + search-strategy §1 anti-pattern + §7 post-filter + discovery-log header note.
- [x] **X-post-builder bridge-post mode.** Task 7 covers the new mode with worked example.
- [x] **Warm-contacts file lives at `growth/.local/jinn-warm-contacts.csv`** — already moved in the conversation; growth-day reads from there per the SKILL.md procedure.
- [x] **Watcher alerts surface as chat-only via growth-day** — confirmed in growth-day SKILL.md "What this skill does" + "Output format".

Placeholder scan: no TBD / TODO / "fill in" / "implement later" found. Each step has either concrete content or a concrete command.

Type / name consistency:
- `growth-log.md` referenced consistently as `growth/.local/growth-log.md`.
- Watcher file pattern consistent: `growth/.local/watcher-YYYY-MM-DD.md`.
- All skill names (`cluster-model`, `growth-watcher`, `twitter-strategy`, `growth-day`) consistent across all references.
- `bird` CLI commands consistent: `bird user-tweets`, `bird mentions`, `bird search`, `bird home`.

Spec coverage gaps: none identified.
