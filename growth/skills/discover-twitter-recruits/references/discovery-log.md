# Discovery log — empirical record

Append-only record of recruitments surfaced by the `discover-twitter-recruits` skill. Each entry tracks what was recommended, why, and what happened. After ~5–10 entries, review whether `audience-profile.md` or `search-strategy.md` need updating.

Confidence tiers: **OUTCOME** (verified — they replied or did not), **PENDING** (awaiting reply), **CORRECTION** (originally recommended, later rejected).

---

## 2026-04-29 — `@yieldfreaks` (Outcome: success)

**Search query.** Builder vocabulary: `bird search "agent registry OR \"agent observability\" OR \"agent index\" -filter:replies lang:en min_faves:3"`.

**Who they are.** UK-based builder of **AHM (Agent Health Monitor)** — a public dashboard scoring agent registries on health, grade, and zombie rate. Engages substantively with `@autonolas` (gets replied to). Quoted a16z crypto's "KYA — Know Your Agent" post as articulating a missing primitive.

**Conversion rationale at recommendation.** Functional adjacency to AHM's verification work; UK-based serious builder with a public dataset; engages with the right orbit. Priority 1 (operators / builders / contributors).

**Outreach path.** Public reply to AHM thread — methodology question about double-counting OLAS agents that are syndicated to ERC-8004. Treated as peer methodology engagement, no Jinn pitch.

**Outcome.** Replied within ~5 hours with a 4-tweet thread. Conceded the methodology issue, committed to ship two improvements (explicit metric label, cross-registry overlap stat), and threw a question back ("what's the actual Olas to ERC-8004 syndication ratio?"). Treated as peer, not stranger.

**Lesson.** Methodology engagement on a real artefact lands. The peer-recognition signal in his reply ("this is the kind of methodology question that should be answered on the AHM site, not in replies") is exactly the bar — substance about *his* work, not about Jinn.

---

## 2026-04-29 — `@ta_eis_eauton` / Silverarrow (Outcome: pending)

**Search query.** Builder vocabulary: `bird search "agent benchmarking OR \"agent evaluation\" framework -filter:replies lang:en min_faves:5"`.

**Who they are.** Switzerland-based open-source builder of **autoharness** (github.com/kayba-ai/autoharness) — a control-plane that mutates agent configurations (prompts, config, middleware, source) via Codex/Claude/templates, runs benchmarks, and keeps champions. Adapters: tau2_bench, pytest, hal, harbor, car_bench. Open-source; commercial managed-service layer at kayba.ai.

**Conversion rationale at recommendation.** autoharness is the inner loop (mutate → benchmark → keep winner); Jinn provides the outer loop (independent evaluator, ground truth, economic reward). His extension model means an "outcome-resolved markets" benchmark adapter could be implemented as a plugin without changing autoharness core. Numerai-orbit (replied to a thread including `@numerai`, `@CrowdCent`). Priority 1 (operators / builders / contributors).

**Outreach path.** Public reply to one of his autoharness posts: question about the tau2 deltas chart in the README — "from the changes that regressed, were any of those particularly surprising?" Builder-to-builder methodology question, no Jinn mention.

**Outcome.** *Pending at time of writing. Update on reply.*

**Lesson (provisional).** The right first-touch question on a candidate with a public dataset is one the README does *not* answer — proves you actually engaged with the work. Earlier draft of the same opener ("what's the eval signal?") would have been answered in the README and read as low effort.

---

## 2026-04-29 — `@gingersamurai` (Correction: removed from recommendations)

**Search query.** Functional vocabulary: `bird search "agent slashing OR economic penalty agent -filter:replies lang:en"`.

**Who they appeared to be.** Posted: *"ERC-8004 registers 45k AI agents with on-chain identity and reputation. Contrarian view: it optimises for human trust signals, not machine slashing. Economic penalties > registries. How to price agent misbehavior onchain?"* Read as a sharp ERC-8004 critique that mapped almost verbatim onto Jinn's outcome-attestation-with-stake argument.

**Initial recommendation rationale.** Critique aligned with thesis; UK location signal; substantive register on Bitcoin quantum risk and OpenClaw memory drift in adjacent posts.

**Why removed.** Profile-check on the second pass surfaced the `🦞` sign-off across nearly all posts, plus the one-shot-zinger pattern: every post a single contrarian fragment, no replies in his feed to others' substance, no thread engagement. Identified as an OpenClaw agent.

**Lesson.** Bot/shill detection (`search-strategy.md` §4) has to run *before* recommendation, not after. A perfect-language tweet from an account with no thread engagement is a near-certain bot signal; the `🦞` sign-off was the giveaway and would have caught it on the first pass had `user-tweets` been run before recommending.

This is the canonical correction case. Future discoveries that surface single-perfect-tweet accounts must run profile-check before they appear in any output, even SKIPPED.

---

## How to add an entry

Append using the same shape: search query, who they are, conversion rationale, outreach path, outcome (or pending), lesson (if any). Date at the top.

After 5–10 entries, scan the lessons column. Patterns that recur (e.g. "first-touch question must not be answerable from the README") should be promoted into `audience-profile.md` or `search-strategy.md`.
