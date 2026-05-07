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

## 2026-05-05 — `@matlabulous` / Jo-fai (Joe) Chow (Outcome: pending)

**Search query.** Operator-first-person Numerai vocabulary: `bird search "\"my numerai\" OR \"submitted my signal\" OR \"my NMR stake\" -filter:replies lang:en"` (n=25).

**Who they are.** Numerai *Pending Master* tournament participant since 2020. Self-described: *"$NMR skin in the game since 2020 — still here, still staking, still earning... still training and improving my Numerai models."* Organises Numerai community meetups (Prague 2023, DeAI Day Tokyo 2026). Heavy retweeter of NumeraiCoE content; connected to but not on the Council of Elders. Senior community-bridge node.

**Conversion rationale at recommendation.** Exactly the participant-shape recruit Sprint #1 wants: skin in someone else's protocol (Numerai), multi-year, real model + real stake. Bridge value high — if he engages, his peers (Lingster888, Numeroo, CoE-adjacent submitters) see it. Priority 2 (Numerai-orbit). Caveat: his current feed leans more curator/organiser than active-modeller; treat as P2 with amplifier upside, not pure builder.

**Outreach path.** TBD by Oak. Bridge shape candidate: methodology question on *what True Contribution doesn't capture* — TC measures unique alpha vs the meta-model, but the meta-model itself is constructed inside Numerai. The question Jinn answers is *what happens when the meta-model evaluator and the data provider are the same entity, and how does that change the design of evaluator-with-stake systems for outcome-scoring beyond stocks*. The question must be answerable only by someone who has staked through the V1→V2→TC transitions.

**Outcome.** *Pending.*

**Lesson (provisional).** Operator-first-person vocabulary (`"my numerai"`, `"submitted my signal"`, `"my NMR stake"`) is the right Numerai-side filter. Caught real participants without surfacing the @numerai / @NumeraiCoE official accounts (which are out-of-scope per the new founders/core-team exclusion).

---

## 2026-05-05 — `@MattiasLamotte` (Outcome: pending)

**Search query.** Same Numerai operator-first-person query as `@matlabulous` (n=25). Surfaced via 2023 *"My Numerai Signals rankings have plummeted since the default rank shifted to True Contribution"* post.

**Who they are.** Multi-year Numerai Signals participant. Ships *BetaForesight* — a publicly-named model with ongoing methodology updates. Currently testing an LSTM regression layer for the directional classifier; previously analysed the V2-dataset depreciation impact on his correlation/TC scores. Tried building a market-neutral long-short strategy on top of his own Numerai rankings.

**Conversion rationale at recommendation.** Real ML-researcher voice on Numerai-substantive posts. Public OSS performance metrics (CWMM, APCWNM, TC). Ships own model with public name. Engages with @numerai / @richardcraib in replies. Priority 2 (Numerai-orbit forecasters per audience-profile §2.2). Top reply-rate signal of this round's two recruit picks.

**Outreach path.** TBD by Oak. Bridge shape candidate: methodology question on his BetaForesight LSTM directional-classifier *bearish/bullish mean-reversion stuck state* — specifically, what happens to the stuck-state when the eval signal comes from outside the model (independent evaluator with stake) vs inside the model (self-graded OSS performance window). Not answerable from his README; engages his stated current problem.

**Outcome.** *Pending.*

**Lesson (provisional).** *Mixed feeds (heavy political RTs alongside on-thesis builder posts) are not a §4 reject signal* — political-RT-side and builder-side coexist in the same account; the methodology question only has to land on the builder-side identity. Distinguishes from `@CoreyJMcDonald` shape (one TaoScout plug surrounded by 100% culture-war RTs — not a real builder identity at all) vs `@MattiasLamotte` (regular substantive BetaForesight builds *plus* unrelated political RTs — a real builder with a side identity). The decisive signal is whether the on-thesis posts are themselves substantive and recurring, not whether they're surrounded by off-thesis content.

---

## 2026-05-05 — `@aventurine_eth` (Skipped: amplifier audience overlaps the protocol's own audience)

**Surfaced via.** Same Numerai query as `@matlabulous` and `@MattiasLamotte`.

**Why skipped (Oak's call).** Sells Numerai prediction files via NumerBay (so technically a participant), but the X-feed is dominated by NumeraiCoE retweets + Art Blocks / NFT amplification. The amplifier-shape concern: *his audience IS Numerai's audience*. Amplifying Jinn through him would not extend reach to operators outside the Numerai loyalist circle — same audience would just see the message twice. Different from a true cross-cluster amplifier (e.g. `@VictorVL_EN` reaches Bittensor operators, not OLAS loyalists).

**Lesson.** Audience-overlap is a Tier 3 disqualifier even when the candidate is a real participant. The amplifier value is in *audience extension*, not *audience reinforcement*. Future amplifier triage: ask *whose audience does this amplifier reach that the candidate's home protocol does not already reach?* If the answer is "the same audience", the amplifier is structurally redundant. Add to `audience-profile.md` §3 if pattern recurs.

---

## 2026-05-05 — `@danielderedev` / Dx (Outcome: pending)

**Search query.** Polymarket-bot vocabulary surfaced him as a substantive commenter on an unrelated thread; profile-check then revealed sustained Bittensor mechanism-design essays. Specifically: `bird search "polymarket bot OR ..."` returned his post on execution-vs-forecasting alpha; subsequent `bird user-tweets danielderedev` confirmed the Ridges SN62 architecture post and the Numinous SN6 architecture post.

**Who they are.** Bittensor participant-observer (Nigeria-based per `bird about`, with `Location accurate: No` flag). Multi-paragraph essayist on subnet mechanism design. Names *Ridges SN62* as a software-engineering execution market with the agent_main(input) → patch contract, Harbor sandbox, verifier-scores-result inner loop. Names *Numinous SN6* explicitly because it scores the agent itself, not the output. Frames TAO as monetising intelligence vs Bitcoin monetising security. Distinguishes execution alpha from forecasting alpha: *"the prediction stack is unbundling — forecasting gets cheaper, resolution gets more important, execution gets more profitable."* Self-describes using *"Cody inside real workflows for infra, security, research, prompt systems, code execution"* — operator-user, not subnet-team.

**Conversion rationale at recommendation.** Exactly the participant-shape recruit Sprint #1 wants — Bittensor operator-user (not on any subnet team), thinks in mechanism-design terms, names the same primitives Jinn names. The bridge from his current "subnets like Ridges are worth watching" stance to Jinn is one step, not five. Priority 1 (Bittensor operator/contributor).

**Outreach path.** TBD by Oak. Bridge shape candidate: extend-his-argument-one-step on the prediction-stack unbundling — *forecasting cheap, resolution important, execution profitable*. Methodology question: where in his three-layer split does the *evaluator's* stake sit, and what changes about resolution-market design when the resolver is themselves slashable on the resolution. Not answerable from any subnet's README; engages the layer he's already named but not yet stake-priced.

**Outcome.** *Pending.*

**Lesson (provisional).** Substantive Bittensor commentators do not surface under operator-first-person vocabulary (`"my miner on SN46"` yielded zero useful candidates). They surface as *substantive mid-thread commenters* on adjacent topics — @danielderedev was discovered on a Polymarket-bot search via his post distinguishing execution from forecasting alpha, then validated via `user-tweets`. Future Bittensor passes: pair subnet name + mechanism vocabulary (*"Numinous Brier"*, *"Ridges patch"*, *"Yuma weights"*) rather than operator-first-person. Update `search-strategy.md` §2 accordingly.

**Caveat noted at recommendation.** `bird about` reports `Location accurate: No`. Could be VPN or location-misset. Not a hard kill given substantive multi-paragraph essay shape, but watch for inconsistencies in any reply. Score on content, not geography.

---

## How to add an entry

Append using the same shape: search query, who they are, conversion rationale, outreach path, outcome (or pending), lesson (if any). Date at the top.

After 5–10 entries, scan the lessons column. Patterns that recur (e.g. "first-touch question must not be answerable from the README") should be promoted into `audience-profile.md` or `search-strategy.md`.

---

## 2026-05-04 — Update on prior PENDING entries

- **`@Vtrivedy10`.** First-touch reply 2026-05-01 received Viv's reply same day ("what does this look like?? there's def gains from adjusting the harness to the task dist, open harnesses make this easier", 44 views). Re-engaged 2026-05-04 with the three-gap framing (access ≠ market: demand signal / funding / runtime trust). Coined memetic line "access ≠ market" in the process. **Status: DELIVERED** — watching for follow-up. Likely follow-up: "what does the funding mechanism look like concretely?" or "who issues the runtime trust signal?"
- **`@Maxibtc2009` (Observer Protocol).** Cron-pattern caveat held for the @Maxibtc2009 personal handle, but the Observer Protocol project handle (@Obsrver_Prtcl) replied substantively to Oak's methodology question on the @boydcohen thread on 2026-05-03. Re-engaged 2026-05-04 with Tier-2 issuer-verification methodology question (Sybil-Tier-2 attack vector). **Status: DELIVERED via project handle** — watching. Lesson: when a candidate has a personal handle (cron-shape) AND a project handle (substantive), engage the project handle for methodology questions.
- **`@TreebeardAI`.** Verified counterpart, explicit invitation to feedback received 2026-05-01 with methodology page link. Engaged 2026-05-04 with recomputability-as-2008-shape framing after reading the methodology page end-to-end. **Status: DELIVERED** — high-probability substantive reply expected. Watch paths: (a) "auditable under NDA closes the gap" → 2008-shape rebuttal, (b) "canary catches drift" → drift ≠ recomputability, (c) they ship something.

---

## 2026-05-04 — `@askdrvoyage` (Voyage Health) (Outcome: pending)

**Search query.** Cluster-model 2026-05-04 cumulative evidence (ai-cluster §1, originally surfaced via Oak's reading); cross-checked via `bird search "shadow eval OR shadow evaluation agent -filter:replies lang:en"` (n=30) and `bird search "shared evals OR portable evals OR eval sharing -filter:replies lang:en"`.

**Who they are.** US-based; runs vertical AI in veterinary clinical workflows ("Voyage Health"). Real eval rig — calibration set, abstain heads, failure-mode taxonomy. Coined "the harness *is* the moat" on 2026-05-03. Posts substantive operational content multiple times per week; QT-engages with other operators (paulg, EXM7777, amix3k).

**Conversion rationale at recommendation.** Functional adjacency to Jinn evaluator role at the vertical-AI layer. Already running their own eval pipeline; would understand a portable / multiplayer extension immediately. Priority 1 (operators / builders / contributors).

**Outreach path.** Public reply to his 2026-05-04 "static test sets pass once and rot, shadow-eval is the cadence" post. Methodology question: shadow-eval is private to one rig — two vertical-AI teams pooling shadow-eval, moat erosion or compounding? Where's the line between sharing failure-mode taxonomy and giving up the harness moat?

**Outcome.** *Pending.*

**Lesson (provisional).** Vertical-AI builders who already articulate the harness-as-moat thesis are pre-positioned to recognise the multiplayer extension. The bridge here is "harness moat at one rig vs at the network" — a one-step extension of their own thinking, not a frame change. Calibration evidence (Silverarrow / autoharness, yieldfreaks): inner-loop builders convert at higher rate than thought-leadership accounts.

---

## 2026-05-04 — `@pkyanam` (Preetham Kyanam) (Outcome: pending — soft)

**Search query.** Builder vocabulary `bird search "agent eval harness -filter:replies lang:en"` (n=30).

**Who they are.** US-based; builds Brainbase (agent memory product); shipped a Neo4j backend for @GarryTan's GBrain on 2026-05-03 (25/25 integration tests). Posted "if you're shipping agent memory without a labeled eval harness, you're flying blind" with concrete MRR numbers (v3 0.73, v7 0.75, v10 0.74) and the line "feelings are bad search metrics."

**Conversion rationale at recommendation.** Real builder; ships product with quantitative eval discipline. Priority 1 (builders) — soft. Mixed-cluster feed (GTAVI RTs, @sama replies, builder posts) but on-thesis posts are sharp and unguarded.

**Outreach path.** Reply to his 2026-05-01 "feelings are bad search metrics" post. Methodology question: is the harness signal portable across teams running similar agents, or does eval rot map directly to harness-config drift?

**Outcome.** *Pending — not yet contacted.*

**Lesson (provisional).** Mixed-cluster feeds (general builder + occasional thesis-shaped posts) need sharper bridge-question filtering than single-thesis feeds. Don't expect his audience to QT-amplify; expect his eyes only. Reply-rate signal lower than dedicated-thesis accounts.

---

## 2026-05-04 — `@AbbieTyrell01` (Tier 3 amplifier, yellow content-broadcaster pattern)

**Search query.** Builder vocabulary `bird search "evaluation framework agent -filter:replies lang:en"` (n=30).

**Who they are.** US-based account posting daily as "X days as a production AI agent" — multi-paragraph operational diary covering 8 agents, 37 SKILL.md files, 571-file knowledge graph, 8-category eval framework, 340+ regression cases from production, 65k+ interaction ledger entries. Detailed and technically substantive content. Bio explicitly states "production AI agent."

**Conversion rationale at recommendation.** YELLOW per `audience-profile.md` §3 (cron / scheduled-broadcaster pattern). The agent itself is presented as the protagonist; the human operator is uncredited in the recent feed. Re-route recommendation: **find the human operator** — if surfaced, this becomes Priority 1 (real production eval framework at scale). Until then: amplifier-only.

**Outreach path.** Not yet contacted. Future option: methodology question on a specific operational claim (e.g. the 37 SKILL.md → 8-category eval mapping, or the 3-day distillation cycles).

**Outcome.** *Pending — not yet contacted.*

**Lesson (provisional).** "Production-AI-agent-as-broadcaster" is a new pattern distinct from the @Maxibtc2009 cron-content pattern. There the project markets itself; here the agent is presented as the protagonist itself. Worth a separate `audience-profile.md` §3 note: deeply technical content from agent-narrated accounts needs human-operator surfacing before recruit recommendation.

---

## 2026-05-04 — Skipped notable rejects

- **`@jjfleagle` (Jason Fleagle).** REJECT — enterprise-AI-consultant register. The "keep evals portable across providers" line surfaced him; full feed is VMware renewals, "AI readiness" PDFs, cloud migration, and CIO-buyer framing. Canonical @JohnCarbrey shape per `audience-profile.md` §3. Audience is corporate buyers, not protocol contributors.
- **`@TheSebBlack`.** REJECT for recruit list (possible amplifier). Sharp shadow-eval post ("mirror 1-5% of live traffic into a shadow eval pipeline") but full feed is VC/founder-advisor narrative ($30M ARR founders, anthropic comp at $900B, term sheets, Series A pivots). Won't run a node; could amplify if a thesis-shaped post crosses his desk, but not a recruit.
- **`@willleebuilds`.** REJECT for recruit list (yellow zinger pattern). Posted the source "leaderboards rank the wrong layer" line that anchored Oak's 2026-05-04 Teach post. Profile-check: 8 of 8 most recent posts are single-message hot takes, 0 likes / 0 retweets / 0 replies on most posts, no QT-engagement, no replies-to-others. Bot-shaped or cron-content-agent shape per §4. **NB: Oak still replied** as anchor citation rather than pre-warm — the source post matters as a reference point even if the account doesn't convert. Lesson: not all reply targets are recruit candidates; some are thread anchors.

**Cross-cutting lesson from this round.** AI-cluster *eval / harness* vocabulary (~2026-05-04) cleanly splits into three audiences:
  1. **Real builders** shipping eval-disciplined products (askdrvoyage, pkyanam) — Priority 1, the recruit pool.
  2. **Institutional / vendor accounts** (braintrust, arizeai, allen_ai, langchain) — amplifiers, not operators.
  3. **Thought-leadership / VC-narrative accounts** (TheSebBlack, jjfleagle, willleebuilds) — skip the recruit list.

The three are linguistically similar in any given tweet; only profile-check resolves them. The §7 post-filter catches some patterns but not all — VC-narrative accounts have 0% token-ticker prelude rate yet still fail the recruit bar. Profile-check (§3) remains mandatory and cannot be replaced by linguistic filters alone.
