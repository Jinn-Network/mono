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
bird user-tweets tannedoaksprout -n 200 --plain > /tmp/oak-recent-30d.txt
bird mentions -u tannedoaksprout -n 200 --plain > /tmp/oak-mentions-30d.txt
```

`-n` is a count, not a window. Post-filter both corpora to tweets with timestamp `>= now - 30 days`. If the earliest tweet in either corpus is still less than 30 days old after `-n 200`, paginate with `--cursor` until the cutoff is reached (cap at 5 pages).

### Step 2 — Bucket posts by GROWTH §4 loop

Classify each original post (not retweet) into one of the four buckets:
- **Teach** — public artefact on the thesis. Threads, essays, talks, recorded walkthroughs.
- **Understand** — listening reply on someone else's substantive post.
- **Direct offer** — explicit testnet operator slot ask.
- **Interact** — synchronous DM-style exchange. Mostly invisible from public-only data; treat as `[unknown — out of scope for this skill]`.

Quote tweets are Teach if the QT itself adds substance; otherwise Interact. Replies are Understand by default; reclassify to Teach if the reply is a substantive standalone artefact.

### Step 3 — Compute targets vs actuals

Derive the *actual* window from the corpus: `span_days = first_tweet_ts − last_tweet_ts` (in days, after the 30-day post-filter from Step 1). Working-day target = `span_days × 5/7`. Do not assume a literal 30d / 5-per-week — use the span the corpus actually covers.

GROWTH §4 implicit targets:
- **Teach:** ≥1 per working day. Compute: count(Teach posts) / (span_days × 5/7).
- **Understand:** ≥1 per working day. Same denominator.
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
