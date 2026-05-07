---
name: x-algorithm-grader
description: Grade and optimise X (Twitter) drafts and replies against the 2026 algorithm. Use whenever the user shares a tweet, thread, or reply draft and wants to score it, predict reach, lint it, optimise it, or know whether to post it. Triggers on "score this tweet", "grade this draft", "will this land", "predict reach for this", "should I post this", "optimise this for X", "lint this tweet", "is this reply worth sending", "what's wrong with this draft", "critique this thread", "improve this for the algorithm", "rate this post", or any draft pasted with apparent intent to post on X. Also triggers when the user asks why a recent post under-performed. Returns a structured score, the binding constraint, and the highest-leverage edit. Calibrated for @oaksprout's crypto+AI-infrastructure cluster. Use this skill for evaluation; use oak-content-strategy for generating content from scratch.
---

# X algorithm grader

Score X drafts against a working model of the 2026 X algorithm. Return a relative reach prediction, identify the binding constraint, and suggest the single highest-leverage edit.

## Read first

- [`GROWTH.md`](../../../GROWTH.md) §8 — channel canon. The five direction-only claims (Premium mandatory, reply-to-reply is the engine, cluster-fit dominates first-impression distribution, weekday cluster-peak window, constructive-tone overlay) are what this skill optimises *toward*. The numerics in `references/algorithm-model.md` and `references/scoring-tables.md` are the calibrated derivative — they evolve freely; §8 changes require a spec proposal.
- [`GROWTH.md`](../../../GROWTH.md) §3 — the current target cluster. Cluster-fit scoring uses §3's named cluster as the cluster the post is graded against.
- [`GROWTH.md`](../../../GROWTH.md) §6.1 — the *no fear-bait, no marketing register* permanent rule is also load-bearing for §8's constructive-tone overlay; flagged drafts should hit both checks.

## What this skill does

Three modes:

1. **Pre-publish grade** — for an original draft (tweet, thread, long-form post). Default mode.
2. **Reply grade** — for a candidate reply to someone else's tweet. Different model; different rubric.
3. **Post-mortem** — for a published post that under- or over-performed, explain which factor moved.

The skill is a grading skill, not a generator. If the user wants a draft from scratch, defer to `oak-content-strategy`. If the user wants both — generate then grade — use the other skill first, then run this on the output.

## The mental model in one paragraph

X distribution is a multiplicative function of: account reputation (Tweepcred), Premium status, cluster fit between the post and the viewer, format and length multipliers, tone overlay (Grok), and engagement quality in the first 30–60 minutes — minus penalty terms and any hard kills. The single dominant signal is "reply-to-reply": when the post's author replies back to a reply, that engagement event scores **+75 vs a baseline like**. Most other levers are amplifiers; the reply-back loop is the engine. A draft that closes the conversation forfeits 75x.

For the full model with confidence tiers per number, read `references/algorithm-model.md`. For numeric reference tables, read `references/scoring-tables.md`.

## When you run

Read `references/algorithm-model.md` once at the start of a grading session. Keep it loaded — every score below maps to a section in that doc. Cite the section number when explaining a decision.

For numeric multipliers (format, length, premium boost, etc.), read `references/scoring-tables.md` and apply the tabled values directly rather than inventing new ones.

## Scoring procedure

Apply this in order. Stop early if a hard kill fires.

### Step 1 — Hard kills (binary)

Refuse to grade further (recommend: do not post) if any of:

- External link in the main post (model §6). Recommend rewriting as tease + link in self-reply.
- Report-bait phrasing — medical claims, financial advice tone, harassment-adjacent language, ambiguous legal claims (model §3). One report can drop distribution to near zero.
- Spam-shaped repetition — near-duplicate of a post in the last 7 days, or part of a posting velocity spike of >5 in 60 minutes (model §14).
- Hashtag stuffing (>2 hashtags) or link shortener (bit.ly etc.).

For pre-publish, output a clear refusal and the specific fix. Do not score further until the kill is removed.

### Step 2 — Premium check (pass/warn)

If the user's account is non-Premium, output a WARN and note that the predicted reach score from this skill assumes Premium. Without Premium, multiply the final score by ~0.1–0.25 (model §7). The biggest lever is binary; flag it loudly.

If Premium status is unknown, ask once. Default assume Premium for @oaksprout unless told otherwise.

### Step 3 — Factor scores (each on 0.0–1.0)

For each factor, give a score, a one-line reason, and a section reference.

- **Cluster fit (model §9, scoring-tables §3).** Detect cluster vocabulary. @oaksprout sits at crypto+AI-infrastructure. Pure-crypto lexicon (token, alpha, ticker chasing) without AI angle = ~0.4. Pure-AI lexicon (RLHF, eval, fine-tune) without distribution/sovereignty angle = ~0.4. Bridging lexicon (agent, autonomy, distribution, sovereignty, training, outcomes, decentralised execution, dark talent, value capture) = 0.8–1.0.
- **Format (model §4, scoring-tables §1).** Look up format multiplier. Text 1.0; text+image 1.1–1.3; thread 7–12 tweets 1.5; native short video 0.7 rate / 1.5–2.0 reach; long-form Premium 1.2–1.5; poll 0.6–0.8.
- **Length (model §5, scoring-tables §2).** 71–100 chars: 1.3. 240–259: 1.2. 101–239: 1.0 (dead zone — flag). 260+ Premium long-form: 0.9–1.4 (variance).
- **Tone (model §11).** Constructive/specific: 1.1–1.2. Neutral/informational: 1.0. Combative/contemptuous: 0.5–0.8. Score the tone as the post will read, not as the user intends. Watch for second-person accusations, scare quotes, stacked rhetorical questions, and dismissals leading the post.
- **Author-reply trap (model §2).** This is the engine. Does the post invite a substantive reply that the user would actually want to reply *back* to? Open question, contestable claim, specific gap, or named tension = 0.8–1.0. Closes the conversation cleanly = 0.3–0.5. Pure broadcast (announcement with no hook) = 0.2.
- **Velocity plan (model §10).** Posting time vs cluster peak (Tue–Thu 09:00–14:00 target-tz)? Self-reply ready at +5 min? Pre-warm allies notified? If unknown, ask once and apply 0.7 as default; otherwise score 0.5 (no plan), 0.8 (partial), 1.0 (all three).
- **Penalties (model §14).** Stack any penalties detected: cross-platform watermark, link shortener, near-duplicate, hashtag stuffing, trending-hashtag drift, poor thread cohesion. Multiplier starts at 1.0 and drops by each penalty.

### Step 4 — Compute relative reach score

```
score = cluster_fit × format × length × tone × author_reply_trap × velocity × penalties
```

Premium multiplier and Tweepcred are account-level — fold them into a separate context line, not the per-draft score. Output the per-draft score on a 0.0–1.0 scale with the interpretation:

- **0.7+** — ship.
- **0.4–0.7** — fix the binding constraint, then ship.
- **0.0–0.4** — substantial rework needed. Identify two highest-impact factors.

### Step 5 — Identify binding constraint

The lowest factor score is the binding constraint. The skill's job is to lift *only* that factor. Compounding small lifts across all factors is usually a worse use of effort than one big lift on the binding constraint.

### Step 6 — Recommend the edit

One sentence. Concrete. The edit should plausibly lift the binding constraint factor by ≥0.3.

If the user asks for a rewritten version, produce one — in the user's voice (see voice constraints below), applying only the binding-constraint edit. Don't smuggle in other changes.

## Output format (pre-publish mode)

Always use this exact structure. The structure is the value — it forces the user to see the binding constraint.

```
HARD KILLS — PASS / FAIL
[If FAIL: specific reason and the fix. Stop here.]

PREMIUM — PASS / WARN
[If WARN: caveat the score]

FACTOR SCORES
  Cluster fit          0.X  | [one-line reason]                 | §9
  Format               0.X  | [format detected, multiplier]      | §4
  Length               0.X  | [chars, zone]                      | §5
  Tone                 0.X  | [tone detected]                    | §11
  Author-reply trap    0.X  | [opens / closes / broadcast]       | §2
  Velocity plan        0.X  | [time, self-reply, pre-warm]       | §10
  Penalties            0.X  | [stacked penalties]                | §14

RELATIVE REACH SCORE: 0.XX
  Interpretation: [ship / fix-then-ship / rework]

BINDING CONSTRAINT: [factor name] (0.X)
  [2-line explanation grounded in mechanism, not just rule]

EDIT
  [one-sentence concrete edit]

REWRITE (only if requested)
  [the rewritten draft, in the user's voice]
```

## Output format (reply mode)

Different rubric (model §16). Different output:

```
TARGET FIT
  Follower count       [X x your size — in/out of 2–10x lever range]
  Cluster overlap      [low / partial / high]
  Author engagement    [does the author reply to good replies?]

REPLY TIMING
  Original tweet age   [minutes — top-replies window <30min]
  Velocity            [rising / flat / dead]

REPLY SUBSTANCE
  Adds                [data / counter / extension / question / nothing]
  Refuses             [yes / no — "Great point!"-shaped agreement]

TONE
  [constructive / sycophantic / dismissive / combative]

+75 INVITATION
  [does the reply invite the original author to push back?]

VERDICT: send / edit / skip
EDIT (if not skip): [one-line concrete edit]
```

## Output format (post-mortem mode)

```
POST: [first 80 chars or a quote]
OBSERVED: [impressions / engagement vs baseline]
PREDICTED: [what the model would have scored]

DELTA EXPLANATION
  Most likely cause: [factor]
  Second cause: [factor]
  Confidence: [hard / reported / inferred / anecdotal]

UPDATE TO MODEL (if any): [tweak to apply going forward]
```

## Voice constraints

The skill's output text and any rewrites use:

- British English.
- No emoji.
- Plain prose; lists only where the structure earns its keep.
- Blunt, no filler, no soft closures.
- Strip jargon when the rewrite will go external. Keep insider lexicon when the post is for the cluster's regulars.
- Stress-test by default — name the failure mode of the post if shipped as-is.

## Honesty about confidence

Every numeric multiplier in this skill maps to a confidence tier in `references/algorithm-model.md`:

- HARD (Jan 2026 source code release): use the number as written.
- REPORTED (third-party studies): use the midpoint of the cited range.
- INFERRED (best-fit hypothesis): use the rough estimate but flag the prediction.
- ANECDOTAL (single source): use directionally only; never as the load-bearing reason for a recommendation.

When the binding constraint is supported only by INFERRED or ANECDOTAL evidence, say so in the EDIT line.

## Calibration loop (post-publish)

Whenever the user reports a published post's reach (impressions, engagements, follow-on growth), update an internal log in `references/calibration-log.md` (create if missing). After ~10 logged posts, suggest a recalibration: which factor multipliers are systematically wrong for *this* account?

This is how the skill stays accurate. The model is a starting point; the calibration log is what makes it Oak's model.

## Composing with other skills

- `x-post-builder` orchestrates ideation → drafting → grading → scheduling → post-mortem end-to-end. This skill is invoked at the rewrite stage by default, and can be called between any two stages on demand. Use `x-post-builder` for end-to-end post construction; use this skill for grading existing drafts.
- `oak-content-strategy` generates drafts; this skill grades them. Compose: generate → grade → edit → grade → ship.
- `brand-review` (marketing plugin) checks brand voice and unsubstantiated claims. Compose: brand-review → grade for algorithm fit.
- A future `x-reply-finder` skill (productionising `growth/prompts/find-open-twitter-convos-agentic-ai-gap.md`) will surface candidate replies; this skill grades them.

## Reference files

- `references/algorithm-model.md` — full mechanistic model with confidence tiers per claim. Read at session start. Section numbers cited throughout.
- `references/scoring-tables.md` — numeric multipliers (format, length, tone, penalties). Look up rather than reinvent.
- `references/calibration-log.md` — empirical track record (created on first use; updated when post-mortems are run).

## Why this skill exists

@oaksprout has a small account chasing a specific cluster (crypto+AI infrastructure) with an opinionated voice. Generic tools push the voice toward the median viral tweet, which is the opposite of the edge. This skill grades against the algorithm's known mechanics in @oaksprout's specific cluster, so the user can ship sharper, not blander. The model is calibrated as of 29 April 2026; the versioning section in `references/algorithm-model.md` says when to re-validate.
