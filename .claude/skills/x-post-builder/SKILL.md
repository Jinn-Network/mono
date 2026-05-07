---
name: x-post-builder
description: Build a single X post or thread end-to-end in the user's voice — from idea source, through beat-by-beat elicitation, to scaffold, grader review, scheduling, and post-mortem. Use when the user wants help writing a tweet, building a post, drafting a thread, or shipping a piece of content for X. Triggers on "help me write a tweet", "build a post", "draft a thread", "I want to post about X", "turn this into a post", "ship something on X", "let's write a thread on X", "build me a post from THESIS". Composes with oak-content-strategy (ideation), x-algorithm-grader (review), and Typefully (scheduling). Calibrated for @oaksprout's voice and crypto+AI-infrastructure cluster. Use this skill for end-to-end post construction; use x-algorithm-grader to grade existing drafts; use oak-content-strategy for raw idea generation.
---

# X post builder

Build a single X post or thread end-to-end. Elicit the user's best ideas in their own phrasing, scaffold a draft, run it through the grader, schedule, and post-mortem. The skill orchestrates other skills; it does not replace them.

## Read first

- [`GROWTH.md`](../../../GROWTH.md) §3 — current target cluster + bridge model. The post should serve §3's pitch or move the cluster across the named gap.
- [`GROWTH.md`](../../../GROWTH.md) §5 — the four-function daily loop. Tag every post you build with which function it serves: **Teach** (public artefact on the bridge model — most posts), **Understand** (substantive reply that surfaces a methodology question), or **Engage** (named direct offer / public funnel-advancement).
- [`GROWTH.md`](../../../GROWTH.md) §6.1 — permanent will-not-chase rules. Posts that violate fear-bait, marketing register, retired framings, or founder framing fail this skill at the scaffold stage; do not pass them to the grader.
- [`GROWTH.md`](../../../GROWTH.md) §8 — channel canon. Posts must respect Premium-mandatory, reply-to-reply (build for follow-up), cluster-fit (write to §3 cluster), weekday cluster-peak window, constructive tone.

## Why this skill exists

Generating posts is easy. Posting in the user's voice — recognisable to the cluster — is the hard part. The failure mode of generic content tools is averaging: pulling phrasing toward the median viral tweet, which is the opposite of the edge. This skill is the inverse. It elicits the user's actual position in their actual phrasing, applies the algorithm grader as a check, and ships.

Calibrated for @oaksprout (British English, blunt, analytical, stress-tests by default) and the crypto+AI-infrastructure cluster.

## What this skill does

Six stages, with the grader callable at any point:

0. **Account state check** — cadence, dormancy. Can block.
1. **Source** — find the angle, optionally via `oak-content-strategy`.
2. **Pre-warm targets** — name 2–3 cluster operators whose take you'd actually want.
3. **Elicit beats** — one question per response, user's phrasing.
4. **Scaffold + user rewrite** — assemble in user's words; user revises; grader runs by default.
5. **Schedule decision** — thread vs delayed self-reply, pre-warm DMs, quote-extension drafted.
6. **Post-mortem** — 24–48h after publish; feeds calibration log.

Stages 1–6 run in order but are not strictly linear. The grader can be invoked between any two stages on demand.

## Composing with other skills

- `oak-content-strategy` — Stage 1, optional. Generates angles when the user doesn't have one.
- `x-algorithm-grader` — Stage 4 default; callable anywhere. Reviews drafts at any maturity.
- `discover-twitter-recruits` — Stage 2, optional. Finds candidate pre-warm targets if the user can't name them.
- Typefully MCP — Stage 5. Scheduling and draft management.

## Voice constraints

Same as `oak-content-strategy` and `x-algorithm-grader`:

- British English.
- No emoji.
- Plain prose; lists only where they earn their keep.
- Blunt, no filler, no soft closures.
- Stress-test by default — name the failure mode of each beat.
- **One question per response during elicitation.** Multiple questions overwhelm; the user answers only the first.
- **Refuse the next layer.** If the user pushes back ("no idea, just decide"), make the call and move on. Do not loop.

## Stage 0 — Account state check

Before drafting anything, ask:

> "When did you last post? What's your cadence over the last 14 days?"

Three states:

- **Active** (posted within 36h, ≥3 posts/week) — proceed.
- **Lapsed** (posted within 7d, <3 posts/week) — proceed but flag: today's post fights an elevated cold-start. Set realistic expectations in Stage 4 and Stage 6.
- **Dormant** (>7d gap, or first post after a long absence) — **block by default**. Tweepcred is in cold-start (model §8, §13). Recommend a 5–7 day ramp of smaller, lower-stakes posts before this one. Single-post obsession on a dormant account wastes the strongest material on the smallest test audience.

If the user overrides the block, proceed but explicitly cap the predicted-reach expectation. State the cap in writing so the post-mortem isn't read as a content failure when it's a Tweepcred floor.

## Stage 1 — Source

Two paths:

- **User has the angle.** Skip ahead. Confirm in one line: "Got it — building from [angle]."
- **User wants help finding an angle.** Invoke `oak-content-strategy`. Pull from `THESIS.md`, recent thinking, or current cluster conversations. Surface 3–5 candidate angles. Grade them with `x-algorithm-grader` if the user wants to compare. Pick one.

Do not move past Stage 1 without the angle named in one sentence.

## Stage 2 — Pre-warm targets

Ask:

> "Name 2–3 cluster operators whose take on this you'd actually want to read."

Two failure modes:

- **User can't name anyone.** The post probably isn't ready — if you can't picture who'd push back, the contestable claim isn't sharp enough. Either refine the angle (back to Stage 1) or invoke `discover-twitter-recruits` to surface candidates.
- **User names people whose engagement they want, not whose take.** That's pod behaviour. Push back: "What would they push back on?" If they can't answer, those aren't the right targets.

The pre-warm list shapes the draft. The post should be tuned to what those people would push back on. This is what keeps the post from being a lecture.

## Stage 3 — Elicit beats

Identify the structural shape of the post: 3–7 beats depending on length. Thread structure follows the same rule.

For each beat, ask **one question** that gets the user's phrasing. Reflect their words back before moving on.

### High-stakes voice beats — always elicit, never draft

- The opening (sets recognisable voice in the first line)
- The bet / stake (the user's position; must be in their voice)
- The closing line (memeable, quotable; user's phrasing)

### Structural beats — draft if the user is fatiguing

- Bridges between beats
- Transitions
- Pivots that just need to land logically

### Question patterns that work

- "If a friend at the pub asked you [the question], what would come out in one breath?"
- "In your own words — what's the one-sentence version?"
- "What's the gut version, your phrasing?"
- "Don't worry about elegance — give me the raw version and I'll work with the prose."

### Question patterns that fail

- "Should we say A or B?" (forces the user to do design work; leads to flooding)
- "Here are three options, which?" (menu sprawl)
- Multiple questions in one response (user answers only the first; rest is wasted)

### When the user gives more material than the post can hold

Name the structural fork ("you've given me three things; they split into A and B; which post are we writing?") and let the user choose. Do not choose for them on substance. **Do** choose for them on structure if they explicitly ask ("just make a choice").

## Stage 4 — Scaffold + user rewrite

Assemble the elicited beats into a full draft scaffold. Mark which lines are pure-user-language and which are draft additions.

```
**Scaffold (for your rewrite):**

[draft]

Structure: [beat 1] → [beat 2] → [beat 3] → [beat 4].
[Beat 1] and [beat 4] are your phrasing. The bridges between are draft — rewrite them.
```

Hand to the user. They rewrite in their voice. The rewrite is the input to the grader.

**Default grader invocation:** when the user returns the rewrite, run `x-algorithm-grader` against it. Surface results in three buckets:

- **Must-fix** — typos, hard kills, broken length zones.
- **Should think about** — ambiguities, mild tone risks, structural issues.
- **Gold** — what's working; do not change.

Do not smuggle voice changes into the grader's edits. The grader lifts the binding constraint only. If the user wants further voice work, return to Stage 3.

## Stage 5 — Schedule decision

Three sub-decisions, in order.

### 5a — Thread vs delayed self-reply

The +5 self-reply mechanism (model §10, §2) only fires from a separate post made minutes after the main, attached as a reply. Threads post sequentially as one connected unit; they don't fire the same engagement-velocity event.

Pick by goal:

- **Thread (single Typefully draft, multi-tweet)** — connection, dwell time. Use when the operational concretion is part of the same argument as the main post.
- **Delayed self-reply (two separate Typefully drafts; reply_to_url on the second set after the first publishes)** — fires the +5 mechanism. Use when the operational concretion is its own unit and you want maximum velocity lift.

Document the choice. Do not default to thread because it's easier to schedule.

### 5b — Pre-warm DMs

Send 15–30 minutes before the main post fires.

**Honest framing (asks for reaction, not boost):**

> "About to post a take on [angle]. Curious where you'd push back."

**Bad framing (parasitic):**

> "Posting in 15 min, would appreciate a like/RT."

The shifts: ask for their *reaction*, not their *action*; frame as the value *they* bring, not the favour *you're* asking; make it easy for them to say nothing.

If the post has already gone live and the user wants to pre-warm post-hoc, switch to past tense:

> "Just posted a take on [angle]. Curious where you'd push back."

Same logic, different timing.

### 5c — Quote-extension drafted, unscheduled

Draft a +30 quote-extension — the natural follow-up if signal lands. Save as an unscheduled Typefully draft. The user fires manually if the main post is rising at +30; otherwise it costs nothing to have ready.

## Stage 6 — Post-mortem

Run 24–48 hours after publish.

### 6a — Diagnosis

Invoke `x-algorithm-grader` in post-mortem mode. Compare predicted to observed.

**Distinguish four failure modes:**

- **Content failure** — predicted high, observed low, factor scores explain the gap. Edit applies.
- **Cold-start / Tweepcred** — observed reach matches the test-audience floor (~50–100 impressions) regardless of factor scores. Account dormancy is the cap, not the post.
- **Cadence drag** — recent posting velocity spike or 36h+ gap penalising current Tweepcred.
- **Cluster drift** — post used cluster vocabulary inconsistent with account's cluster fingerprint; out-of-network reach suppressed.

Be honest. If the diagnosis is account-level, say so explicitly. **Redirect from "rework the post" to "fix the cadence" when the diagnosis is cadence.** Telling the user to write better posts when the actual problem is dormancy wastes their effort and demoralises.

### 6b — Calibration

Append to `growth/skills/x-algorithm-grader/references/calibration-log.md` with:

- Post (first 80 chars or quote)
- Predicted score
- Observed reach (impressions, replies, reposts, likes, profile clicks)
- Diagnosis
- Confidence tier of the lift / shortfall

After ~10 logged posts, the grader's calibration step recommends multiplier adjustments. This is how the model becomes Oak's model rather than the generic 2026 model.

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

## Failure modes

- **Floods.** More than one question per response during elicitation. The user answers only the first; the rest waste tokens and slow the build.
- **Drafting the user's voice.** The skill should never draft the opening, the bet, or the closing line. Those are pure-user-language by rule.
- **Skipping Stage 0.** If the account is dormant, today's post fights from the floor. Confirm cadence before drafting.
- **Skipping Stage 2.** Without named pre-warm targets, the post is tuned for an imagined audience rather than a real one. Sharpens nothing.
- **Treating the grader as a stage.** It's a callable. Invoke when it's useful — not on a fixed schedule.
- **Treating post-mortems as content critique by default.** First check if the cause is account-level. The honest read often isn't "rework the post".
- **Theorising when the user wants forward motion.** When the user says "no idea, just decide", refuse the next layer of analysis and ship the choice.
- **Defaulting to thread because scheduling it is easier.** The +5 mechanism is a real lever. Trade it deliberately, not by accident.

## Reference files

(None yet. If patterns recur, break out:)

- `references/elicitation-patterns.md` — question forms that work / fail in the wild
- `references/pre-warm-templates.md` — DM framings by relationship type
- `references/schedule-decision-tree.md` — thread vs delayed by post intent

## Versioning

Calibrated as of 29 April 2026, against the algorithm model in `growth/skills/x-algorithm-grader/references/algorithm-model.md`. Re-validate this skill if:

- The grader's algorithm model is updated (re-check stages 4 and 6 against new multipliers).
- @oaksprout's account changes state (Premium tier, cluster, follower magnitude).
- The user's voice constraints in `growth/CLAUDE.md` or `BRAND.md` shift.

The skill is the orchestration. The voice and the algorithm model are the substrate.
