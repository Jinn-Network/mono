# Discovery log — empirical record

> **Two logs.** This file holds skill calibration evidence (recommendation rationale + outcome + lesson, in-repo, durable). Live operational state — current threads, drafts, pending replies — lives in `growth/.local/growth-log.md` (gitignored). Do not duplicate. See `SKILL.md` *Two logs* subsection for the boundary.

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

## 2026-05-01 — `@TreebeardAI` (Outcome: pending)

**Search query.** Pass B `bird search "ERC-8004 -filter:replies lang:en"` (n=30).

**Who they are.** US-based; ships an independent rating product for ERC-8004 + Virtuals agents. Public methodology, *"no token, no payment from rated entities"*. Crawls 14 chains. Posts daily.

**Conversion rationale at recommendation.** Closest @yieldfreaks-shape candidate in this round. Public post: *".@coinbase shipped AgentKit. @CoinbaseDev shipped x402. Same team, full agent-economy stack: identity, capability, payment. The one missing layer: independent rating. That's the lane that didn't get filled in-house, on purpose. Ratings have to come from outside the platform."* Functional adjacency to Jinn evaluator role with stake. Priority 1 (operators / builders / contributors).

**Outreach path.** TBD. Bridge shape: methodology question on *why ratings must come from outside the platform — what's the stake structure that makes "from outside" credible vs decorative?*

**Outcome.** *Pending.*

**Lesson (provisional).** A candidate publicly *naming the gap* Jinn fills is the strongest recruit signal short of running the client. Searches that surface "missing layer" / "outside the platform" claims are higher-yield than vocabulary-only searches.

---

## 2026-05-01 — `@tracememcom` (Outcome: pending)

**Search query.** Pass B `bird search "agent observability -filter:replies lang:en min_faves:1"` (n=25). Substance surfaced via grep over the corpus, not the top of search.

**Who they are.** Ireland-based; builds decision-enforcement + policy layer for agents. *"Agents submit reason-bound envelopes for real-time policy evaluation, have zero direct keys, and every outcome is sealed in an immutable DecisionDB."*

**Conversion rationale at recommendation.** Builds the *enforcement before execution* counterpart to Jinn's *outcome attestation after execution*. Tamper-evident DecisionDB is one step from on-chain attestation. Priority 1 (builders).

**Outreach path.** TBD. Bridge shape: *your reason-bound envelope is enforcement before execution; we're building the outcome-attestation counterpart after execution — same primitive, opposite end.*

**Outcome.** *Pending.*

**Lesson (provisional).** Enterprise-AI register (Gartner/McKinsey citations, #AIGovernance hashtags) does not automatically disqualify if the underlying model is structurally aligned. The bridge has to translate from "EU AI Act compliance" framing to "permissionless economic accountability" — a different translation than the crypto-cluster bridge.

---

## 2026-05-01 — `@Maxibtc2009` (Outcome: pending)

**Search query.** Pass B `bird search "ERC-8004 -filter:replies lang:en"` (n=30).

**Who they are.** North America-based; builds Observer Protocol — *"verification infrastructure for the agentic economy"*. Ships weekly Agentic Terminal digest (e.g. *"89,451 ERC-8004 agents. $27.2M x402 cumulative volume"*).

**Conversion rationale at recommendation.** Framing — *"Cost to automate: exponentially decaying. Cost to verify: biologically bottlenecked. Result: explosive nominal output, decaying trust."* — is Jinn's argument in different vocabulary. Tracks the same metrics Oak tracks. Priority 1 (builders).

**Caveat at recommendation.** Posts repeat verbatim across days (Buffer-style scheduled repost pattern). Not a bot, but reply rate likely lower than originality suggests.

**Outreach path.** TBD. Bridge shape: *"verify is the bottleneck" is the right framing — what's your model for the economic primitive that makes verifiers honest? Independent attestation needs stake.*

**Outcome.** *Pending.*

**Lesson (provisional).** Cron-pattern repost behaviour is a yellow flag, not a hard kill. The §4 detection rules should distinguish "identical-shape posts across many *accounts*" (shill ring — hard kill) from "identical posts across many *days* on one account" (scheduling tool — caveat, verify reply rate before escalation).

---

## 2026-05-01 — `@Vtrivedy10` (Outcome: pending)

**Search query.** Pass B `bird search "agent eval harness -filter:replies lang:en"` (n=25).

**Who they are.** US-based; works on Deep Agents at LangChain. Ships methodology essays on agent harness engineering, evals, RL, model-harness-task fit.

**Conversion rationale at recommendation.** Inner loop (mutate → benchmark → keep winner) — same Silverarrow / autoharness shape that converted last round. Jinn provides the outer loop (independent evaluator, ground truth, economic reward). Priority 1 (contributors).

**Outreach path.** TBD. Bridge shape: *your model-harness-task fit framing assumes the harness owner sets the task distribution — what changes when the task distribution comes from external creators with stake?*

**Outcome.** *Pending.*

**Lesson (provisional).** AI-cluster builders working on the agent inner loop are systematically positioned to recognise Jinn's outer-loop framing. The Silverarrow precedent suggests this is a repeatable conversion pattern, not a one-off.

---

## 2026-05-01 — `@VictorVL_EN` (Tier 3 amplifier — Outcome: pending)

**Search query.** Pass C `bird search "numinous SN6 -filter:replies lang:en"` (n=25).

**Who they are.** France-based; ships *Bittensor Ecosystem Highlights of the Week* — weekly digest tagging every active subnet, operator, and partnership. Wrote *The Ultimate X Playbook for Subnet Owners*.

**Conversion rationale at recommendation.** Tier 3 amplifier (per audience-profile §2.3). Will not run a node, but weekly direct contact with the entire Bittensor subnet operator long tail — the priority-2 audience. If he covers Jinn once, every active subnet operator sees it. Methodology-respectful curator, not a hype account.

**Outreach path.** TBD. Approach by being worthy of inclusion in his weekly digest, then a French-builder methodology DM. Not a direct ask.

**Outcome.** *Pending.*

**Lesson (provisional).** Tier 3 amplifiers whose audience *is* operators are higher-leverage than mega-account amplifiers whose audience is mixed. Future search vocabulary should explicitly include "weekly digest" / "ecosystem update" curators in priority audiences.

---

## 2026-05-01 — Skipped notable rejects

Captured here so future rounds do not re-recommend them.

- **`@helixaxyz`** — REJECT. Token-shill (`$CRED`) pattern with thesis-perfect tweet camouflage. *"Helixa's oracle tracks trust... ERC-8004 reputation"* surrounded by *"Builders Cabal accepts $CRED holders"* and pump-style RTs. The @gingersamurai lesson generalises: one perfect tweet does not outweigh the surrounding §4 pattern.
- **`@TheTaoDesk`** — REJECT. Auto-generated alpha-signal dashboard with hashtag-stack + emoji-stack + sales-CTA pattern. Tooling-as-a-service for $TAO traders, not a builder.
- **`@bittingthembits`** — REJECT for recruit list. Substantive Bittensor analysis, but register is $TAO price-pump-shaped (*"ONCE YOU SEE THE MATH, YOU CAN'T UNSEE IT 👀"*, "We are the Tom Lee's").
- **`@tohohotw`** — REJECT. Pearl operator security tweets surfaced him, but full feed is airdrop-farmer pattern (NEAR Legion, BASE quest, Robinhood Chain daily-GM).
- **`@tsunami_0x`** — REJECT. Auto-templated OLAS Mech stats with ☴ + pirate-themed copy. Bot/auto-poster.

**Cross-cutting lesson from this round.** Searches that target audience-name vocabulary (*olas pearl*, *bittensor subnet operator*, *ERC-8004*) over-surface OLAS / Bittensor *marketing-quest* accounts and *signal-bot* accounts. Future passes should layer a post-filter that rejects accounts where >40% of recent posts contain `$<TICKER>`, hashtag stacks of 3+, or "🚨" prefix. The §4 detection list should be promoted into a programmatic filter, not just a human-eyeball heuristic.

---

## How to add an entry

Append using the same shape: search query, who they are, conversion rationale, outreach path, outcome (or pending), lesson (if any). Date at the top.

After 5–10 entries, scan the lessons column. Patterns that recur (e.g. "first-touch question must not be answerable from the README") should be promoted into `audience-profile.md` or `search-strategy.md`.
