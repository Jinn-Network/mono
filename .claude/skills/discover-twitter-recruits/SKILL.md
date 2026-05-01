---
name: discover-twitter-recruits
description: Use when the user wants to find Twitter accounts to recruit into Jinn — operators or builders adjacent to OLAS, Pearl, Bittensor, Numerai, ERC-8004, agent verification, agent observability, agent evaluation, or prediction-tooling work. Triggers on "find people to talk to about Jinn", "who's posting about agent verification / olas / pearl / forecasting / bittensor / numerai / erc-8004", "discover Twitter recruits", "find more accounts like @yieldfreaks", "find more like silverarrow", or any variation that implies surfacing candidate accounts rather than engaging them. Also triggers when the user is at risk of drafting outreach to an account whose audience-fit has not been profile-checked. Out of scope: drafting reply text, planning engagement sequences, recommending follow-ups.
---

# Discover Twitter recruits

Find Twitter accounts that match the audience Jinn is recruiting. Output is a list of candidates with rationale and a reply-rate ranking. Engagement and outreach are explicitly out of scope.

## What this skill does

One mode: **discover**. The user names a topic, an audience description, or asks for "more like X"; the skill produces a triaged list. The skill does not draft outreach. If the user asks for that, defer — say so plainly and ask whether they want a separate engagement skill or this skill's output as input to one.

## The mental model in one paragraph

Discovery is an audience filter, not a language filter. The right question for every candidate is: *would this person plausibly run a Jinn solver, build adjacent tooling, contribute code, or boost the protocol with intellectual reach?* Thesis-shaped tweets from enterprise consultants, JS framework engineers, agent-memory tool vendors, or token-pumping crypto-AI shillers do not pass — even when their wording matches THESIS.md word-for-word. The signal is whether the account *ships verifiable artefacts in the right orbit*, not whether it talks the right way.

For the conversion criterion in detail, read `references/audience-profile.md`. For working and failed search vocabularies, read `references/search-strategy.md`. After every invocation that leads to outreach, append to `references/discovery-log.md`.

## When you run

Read `references/audience-profile.md` and `references/search-strategy.md` once at the start of a session. The audience profile defines the conversion bar; the search strategy defines the working `bird` CLI invocations and the anti-patterns to avoid. Both are short.

The skill assumes the `bird` CLI is available. If it is not, ask the user to install it and stop — this skill does not fall back to web search, because the failure mode is too easy (search engines surface high-reach tweets, which over-represents shills and large accounts).

## Discovery procedure

Apply in order. Stop early if the search consistently returns the wrong shape.

### Step 1 — Frame the audience

Before any search, write down (internally) the specific audience for this invocation. Defaults from `growth/CLAUDE.md`:

- *Priority 1*: ex-Bittensor subnet operators, OLAS Polystrat / Pearl operators, ERC-8004 registry builders, agent-verification / observability / evaluation-tooling builders.
- *Priority 2*: prediction-tool builders, Numerai-orbit forecasters, MiroFish-orbit quants, Polymarket bot operators.
- *Tier 3 — amplifiers*: builders with primitives-not-platforms instincts who repost rather than operate. Output as a separate tier.

If the user names a topic that does not map to any of the above, ask once which audience they are aiming at before searching. Wrong-audience candidates burn discovery budget.

### Step 2 — Search with builder vocabulary

Run a small batch of `bird search` queries using *builder-shaped* terms (audience-profile §1, search-strategy §2):

- Builder vocabulary: `agent registry`, `agent observability`, `agent benchmarking`, `evaluation framework`, `eval signal`, `ground truth`.
- Audience-name vocabulary: `olas pearl`, `olas mech operator`, `bittensor subnet operator`, `polymarket bot`, `prediction subnet`, `numinous`, `autoharness`.
- Cross-reference: replies to `@autonolas`, mentions of `@numinous_ai`, `@opentensor`, replies under specific a16z crypto threads.

Avoid the named anti-pattern queries (search-strategy §1) — they catch shills and bots, not builders.

### Step 3 — Profile-check each candidate

Before recommending any account, run all three:

- `bird user-tweets <handle>` — read the most recent ~5–10 tweets. Confirm a *posting pattern*, not a single tweet that happened to match. A real builder posts about their work over weeks; a shill posts identical-shape promotional content; a bot posts one-shot zingers with no thread engagement.
- `bird about <handle>` — sanity-check geographic and creation signals. Not a hard rule, but high signal when paired with red flags.
- Confirm a real artefact in the bio or recent posts: linked repo, dashboard, dataset, product, or paper. Pure takes-only accounts go to the *amplifiers* tier, not the main list.

### Step 4 — Bot/shill detection

Reject (do not recommend, do not amplify) any account matching these patterns:

- `🦞` sign-off — strong OpenClaw agent signal. Confirm by checking thread engagement: bots reply to no one.
- One-shot zinger pattern — every post is a contrarian-take fragment with no follow-up replies, no QTs of others, no conversation.
- Hashtag spam — `#AgenticAI #AI #ML #Web3` stacks indicate low-effort or automated posting.
- Marketing register — "we are so early", "this is a game changer", "the future is...", "bullish doesn't even cover it".
- Token-ticker preludes — posts that start with `$XYZ` or end with `CA: 0x...`.
- Identical-shape posts across many accounts — symptom of shill ring.

A candidate that fails any of these does not appear in the output, even if a single tweet was thesis-perfect. (Lesson logged in `references/discovery-log.md` from the `@gingersamurai` correction.)

### Step 5 — Output

Use the exact structure below. Order candidates by reply-rate probability — most likely to engage first.

## Output format

```
DISCOVERY: <one-line description of who was being looked for>

OPERATORS / BUILDERS / CONTRIBUTORS

N. @handle (Display Name)
- URL: <link to most recent on-thesis post>
- Who they are: <one sentence — actual product, role, or output>
- Recent on-thesis post: "<short verbatim quote>"
- Why they convert: <one sentence — operator / builder / contributor and why>
- Thesis link: <which section of THESIS.md or GROWTH.md they map to>
- Reply-rate signal: <engagement count on recent post / account size class / time-since-post>

[repeat for each candidate]

AMPLIFIERS (separate tier — boosters with reach, not operators)

N. @handle (Display Name)
- URL, Who they are, Recent post, Why they amplify, Reply-rate signal — same fields, different framing.

REPLY-RATE RANKING
1. @handle — <one-line reason this is the warmest first contact>
2. @handle — <reason>
...

SKIPPED (audit trail — candidates considered and rejected)
- @handle — <one-line reason: wrong audience / no real artefact / bot pattern / etc.>
- @handle — <reason>
...
```

Honesty rules:

- If only 3 candidates pass the bar, return 3 and say so. Do not pad.
- The SKIPPED section is mandatory — it preserves the audit trail and prevents the same wrong shapes from being re-recommended.
- The reply-rate ranking is a probability estimate, not a recommendation to outreach. The skill produces the list; the user (or a separate skill) decides what to do with it.

## Voice constraints

- British English.
- No emoji.
- Builder-to-builder vocabulary. "Ships X" not "leverages X". "Built Y" not "unlocks Y". Strip marketing register completely; if a sentence reads as if it could appear on a project's landing page, rewrite it.
- Plain prose; lists only where structure earns its keep.
- "Honest 3" beats "padded 5" — do not invent candidates to hit a target count.

## Calibration loop

After any invocation that leads to outreach, append to `references/discovery-log.md`:

- Candidate handle.
- Search query that surfaced them.
- Conversion rationale at time of recommendation.
- Outreach path (which post replied to, which question asked).
- Outcome: did they reply, what did they say, did they engage further.
- Lesson, if any: a tweak to `audience-profile.md` or `search-strategy.md`.

After 5–10 entries, review whether the audience profile or search vocabulary needs adjustment. The model is a starting point; the discovery log is what makes it Jinn's recruitment lattice rather than a generic Twitter-search guide.

## Two logs — calibration vs operational

This skill maintains two logs with distinct purposes:

- **`references/discovery-log.md`** — skill calibration evidence. Recommendation rationale + outcome + lesson, kept in repo so the skill learns over time. Anonymise where the lesson is generalisable. Update this file after any outreach attempt that produces a clear lesson.
- **`growth/.local/growth-log.md`** — operational state. Live thread state, drafts, pending replies, candidate handles in operational form. Gitignored. Updated by Oak and by `growth-watcher` / `growth-day` skills.

Do not write live operational state into `discovery-log.md`. Do not duplicate calibration lessons into `growth-log.md`. The boundary is sharp because the failure mode of conflating them is real — calibration evidence in the operational log produces noise; operational state in the calibration log produces leakage.

## Out of scope

This skill does not:

- Draft reply text or DM messages.
- Plan engagement sequences (first / second / third touch).
- Suggest off-platform contact paths.
- Recommend follow-ups after silence.
- Score posts for posting (that is `x-algorithm-grader`).
- Generate posts (that is a future content skill).

If the user wants any of the above, return the list and surface the boundary plainly. The discovery output is the input to those skills, not their replacement.

## Composing with other skills

- `x-algorithm-grader` — for grading the user's *own* drafts (not for grading candidates' posts; cluster fit is a different question for posts vs people).
- A future `x-engagement-planner` skill (not yet built) would consume the output of this skill and produce per-candidate first-touch sequences, second-touch contingencies, and reply-rate-aware cadence.

## Reference files

- `references/audience-profile.md` — the conversion criterion; who counts as a recruit, who does not, with one-line reasons for each excluded audience.
- `references/search-strategy.md` — concrete `bird` CLI invocations, working vocabularies, and named anti-patterns.
- `references/discovery-log.md` — empirical record of past discoveries, started from the @yieldfreaks / @ta_eis_eauton / @gingersamurai cases.

## Why this skill exists

Two recent successful recruitments (`@yieldfreaks`, builder of an agent-registry health dashboard; `@ta_eis_eauton` / Silverarrow, builder of an open-source agent-evaluation harness) shared a shape that was not visible until both had been found: small/medium accounts shipping verifiable tooling adjacent to verification, evaluation, or registry infra in the OLAS / Bittensor / Numerai orbits. Without this skill the next discovery attempt would default to thesis-language matching, which earlier in the same session produced a list of enterprise CIOs, JS framework devs, and an OpenClaw agent. Capturing the working filter as a skill makes the next round repeatable and prevents the regression.
