# GROWTH

**What this doc is / is not.** This is the canonical statement of how Jinn grows: who we are recruiting, the GTM sequence we work through, the daily loop that does the recruiting, the channel canon and sprint discipline that govern execution, and what we will explicitly not chase. It is not a campaign log, an asset library, or a tactical playbook — those live in [`growth/`](growth/) and become this doc's working appendix. It is also not the thesis (see [`THESIS.md`](THESIS.md)) or the voice canon (see [`BRAND.md`](BRAND.md)); growth derives from both and does not restate them.

## 1. The bet

Growth is recruiting, not reach. The early-stage objective is to convince a small number of legitimate, relevant people of Jinn's legitimacy — and the signal of that conviction is that they run a client. One respected operator running on testnet is worth more than broad awareness. Legitimacy is the scarce resource; reach is downstream of it.

This inverts the default crypto growth shape. We are not building a megaphone. We are recruiting a network.

## 2. The bottleneck

The bottleneck is operator count, not code. The full loop — create → solve → evaluate → claim — runs end-to-end on testnet. Mainnet is gated on enough independent, identifiable, technically credible people running the client on testnet. The headline metric in §7 carries the count.

A founder-only network at mainnet launch would concentrate JINN on two addresses and break the no-pre-mine commitment that the protocol is built around. The operator gate is a structural constraint on launch, not a marketing target.

## 3. Target recruit

One named target cluster at a time, with a canonical pitch and a bridge model — *how this cluster currently thinks vs how Jinn frames the same problem*. Updated as we learn. When the target changes, this section is rewritten via a spec proposal and the prior content is moved to `growth/.local/growth-log.md` §1 as a dated archival entry. Do not delete history when this section is rewritten.

*During PMF search, §3 records our current bet on cluster, pitch, and bridge. Bet rotation is the rewrite-and-archive flow already specified above — the spec-proposal flow is the velocity governor, not a claim that the bet is settled. Read this section as "this is what we're testing right now," not "this is who Jinn is for."*

### Current target cluster: open-source coding agent contributors

People who maintain or actively contribute to **open-source coding agents** — agents that take a task description and modify a codebase to fulfil it — shipping their harness publicly, alone or in small teams, with day-to-day work (issue triage, regression hunting, capability extension) that would benefit from pooling attempts with others on the same task class.

Concrete project anchors: Aider, OpenHands / All Hands AI, SWE-agent, Continue, Cline, Sweep, Agentless, gpt-engineer, smol-ai, Open Interpreter, Codename Goose, Devon AI, Roo Code, plus adjacent active OSS coding agents not yet enumerated. Active SWE-bench / swe-rebench leaderboard contributors and their associated researcher-builder accounts also fall inside the cluster.

The functional boundary: they ship verifiable coding-agent artefacts (the harness repo, evaluation tooling, leaderboard runs, PR test suites) at the harness layer, and have day-to-day work that would benefit from pooling attempts with others on the same task class.

The ethos boundary, equally load-bearing: they are open to identifying publicly with a decentralised project. The token is not foregrounded but it is not hidden — recruits who can't accept that filter themselves out, and that filter is the right shape for §1's legitimacy bet (see §6.1).

Eval-as-research practitioners at institutional labs (METR, Apollo, AISI external, academic eval groups, frontier-lab evals teams) are *not* the recruit pool. They overlap technically but face structural recruit friction (public token-association is reputationally costly in their professional context) that pitch quality cannot move. They may flow in via teach-loop overflow once visible adoption develops, but the loop is not organised around them.

### The pitch

> *"This is a public-good network for agentic training data. People shipping agentic projects pool their real work into shared SolverNets — others attempt the same tasks, evaluators verify, the corpus accrues to everyone. It's coordinated via a token because there is no central operator; participation is how stake accrues."*

> *"The first SolverNet is **swe-rebench v2** — a rolling-refresh program-repair benchmark on real GitHub issues. People who ship coding agents pool their attempts on the same task stream; evaluators verify with docker-grade test gates; the corpus accrues. Help collectively train a swe-rebench v2 harness."*

The umbrella generalises (other SolverNets will follow); the instance gives the cluster a concrete surface to recognise. swe-rebench v2 is *locked* as the operational launch SolverNet per [DR-2026-05-07-h](log/decisions/2026-05-07-swe-rebench-v2-as-operational-launch-solvernet.md) — see §7 for the rationale and the trace-harvester sequencing. Real usage of Jinn on the contributor's own coding-agent work is the conversion shape. The corpus of coding-agent runs that accumulates publicly is the public good. Talk about the work the network does and the artefacts that accrue; let participation imply ownership rather than leading with it.

### Bridge model

**Frame this cluster currently holds.** People shipping coding agents iterate against their own private eval signal — their tests, their dogfooding, their personal sense of whether the agent is good. The eval-as-research clusters they look up to publish *static* benchmarks (SWE-bench, SWE-bench Verified, swe-rebench v1) that snapshot capability at a point in time. Private eval against the team's own dogfooding is starting to be named as the right cadence, but it stays private — the maintaining team eats the cost and keeps the signal. The contributor's own iteration loop is structurally solo: their harness, their issue triage, their PR test suite, their corpus.

**Frame Jinn offers.** The eval-signal is a coordination primitive, not a private artefact. When a SolverNet exists for a task class the contributor actually cares about, others attempt the same tasks; their solutions enter the contributor's decision space and the contributor's enter theirs. Static benchmarks are the snapshot; this is the stream — public, attributable, stake-backed. The harness around the model becomes the substrate of a network, not the moat of a maintaining team.

**The bridge.** The methodology question that moves a cluster member across the gap, in the shape that has worked in past first-touches: *static benchmarks are last year's coding agents; live eval against rolling fresh GitHub issues is a coordination problem nobody owns. What does it look like to run the harness you already have alongside others doing the same work — and who pays for the task stream?* The question must not be answerable from their own README, post, or pinned thread.

## 4. GTM sequence

Three phases. Each phase has a transition trigger; phase changes ratchet — we do not regress.

### Phase 1 — Open-source coding agent contributors (current)

Recruit operators, contributors, evaluators among people already shipping in the open-source coding-agent space. Pitch is §3 above. Channel is X plus the cluster's habitual surfaces (GitHub, the few cluster-shaping accounts, OSS coding-agent project communities, SWE-bench / swe-rebench leaderboard contributor pool). The cluster is product-pitch-receptive, not ethos-pitch-receptive — the token is downstream of the work. Phase 2 transition trigger: a meaningful number of testnet operators from this cluster, swe-rebench v2 SolverNet (and successors) running with attempts from multiple operators, and visible adoption signal — the cluster's own audience pattern-matching to running-network rather than to-be-launched.

*The cluster name was tightened from "AI builders" on 2026-05-07 morning (see `spec/2026-05-07-growth-niche-and-pitch-pmf-search.md`), then tightened again from "open-source agentic project contributors" on 2026-05-07 afternoon (see `spec/2026-05-07-growth-cluster-tightening-coding-agents.md`) because Sprint #3's vertical commitment to swe-rebench v2 implied a tighter recruit base than the morning's broader §3 named. The harness-layer functional boundary and the §6.1 token-tolerance ethos are unchanged across both tightenings.*

### Phase 2 — Domain professionals (provisional)

Bankers, consultants, lawyers, and other white-collar professionals whose work is being benchmarked. Provisional because it is benchmark-coupled — if the SolverNet of focus changes, this phase's audience shifts. Pitch shape: *contribute aligned with your interests, not your firm's*. Brand-risk gate: the pitch must be agency-framed (skin-in-the-game on whether AI can do your job), not displacement-framed (anxiety about being replaced). [BRAND.md](BRAND.md) §1's *lead from structure, not from fear* and §6.1's no-fear-bait rule both apply. §6.1's token-tolerance rule also applies; the brand-risk gate is necessary but not sufficient — a future spec will revisit Phase 2's recruit shape under the §6.1 lens. Phase 3 transition trigger: visible adoption in Phase 1 + 2.

### Phase 3 — Crypto-native operators

DeFi / mech-design fluent participants who pattern-match adoption signal rather than ethos pitch. Pitch shape: *this network is actually shipping; here's how to plug in*. The cluster does not lead — it follows visible adoption. Earlier outreach attempts (Sprint #1 retired 2026-05-06; see §6.2) confirmed that pitching this cluster from inside crypto vocabulary, before adoption is visible, runs into sub-segment tribalism (Bittensor people are Bittensor people, not "crypto operators") and into differentiation that is too fine-grained for the cluster to weigh. The trigger for Phase 3 work converges with the §2 mainnet decision-gate.

## 5. The daily loop

Recruiting is a daily practice, organised into four functions. Each function names the skill(s) that operationalise it.

### Understand — `cluster-model`

Identify audience-matched people; maintain the bridge model in §3 by sampling fresh evidence from the target cluster. The skill writes Frame / Evidence / Gap to `growth/.local/growth-log.md` §1; bridge-model promotions to GROWTH §3 happen via the Refine function below, not direct write.

### Teach — `x-post-builder` + `x-algorithm-grader`

Take the bridge model in §3 and produce content — threads, essays, replies, recorded walkthroughs — that names the gap and offers Jinn's frame as the next step in the cluster's own argument. One public artefact per working day on the thesis. The compounding asset: when the thesis is taught publicly, the right operators self-identify and inbound. If only one action fits in the day, it is this one. `x-algorithm-grader` scores drafts against §8 channel canon before posting.

### Engage — `discover-twitter-recruits` (find), `growth-watcher` (track), warm-contacts CSV (advance), DMs / calls / intros (Oak-driven)

Create funnel paths that progressively pull people down: first contact → reply → DM → call → operator → contributor. The four-rung warm-contacts ladder (cold / touched / warm / hot, plus parking) holds the funnel state per individual. Public offer cadence can be more frequent than direct offers; direct offers to the named warm list are weekly, not daily.

The closing structure when an operator is engaged: objective → why important → blockers → three ways in (full operator, light operator, advisory steward) → walk through plan. Read the specs, run the client, open a PR or an issue.

### Refine — `growth-refine`

Track and analyse the loop itself. Propose diff-shaped amendments to GROWTH.md, skill files, or the loop's structure when accumulated evidence drifts from canon. The skill produces *proposals*, never edits canonical files; Oak applies via PRs (with a spec proposal for canonical changes). Cadence: ad-hoc, suggested every sprint postmortem, surfaced as a Tier B action by `growth-day` when a refine has not run in over thirty days.

## 6. What we will not chase

The negative space is doing as much work as the positive plan.

### 6.1 Permanent rules

These do not move without a spec proposal that argues against the rule itself.

**No fear-bait, empowerment-bait, or marketing register.** Operators we want to recruit pattern-match those instantly and discount the rest. The thesis carries its own weight; defensive framing inverts the architecture of the argument. (See [`BRAND.md`](BRAND.md) §1.)

**No fake scarcity.** Urgency comes from real protocol mechanics — the operator gate, the design window before mainnet, contracts cut on a real schedule. Never invented.

**No founder framing.** Oak and Ritsu are early network stewards, with the same token access as the next operator, earned through the same mechanism. We do not pitch from a separate status to the reader.

**No mercenary-launch tells.** No VC, no pre-sale, no team keys, no allocation. Communicated plainly because it is a real differentiator, not because it is a slogan.

**No clusters whose professional context makes token-association reputationally costly.** Some technically-aligned audiences (institutional eval-research labs, frontier-lab safety teams, regulated-industry employees) cannot publicly associate with a decentralised project without professional friction. Recruiting from those clusters means betting on individuals who quietly identify against their employer's posture; conversion friction dominates, and the recruits we land carry reputational caveats that undermine §1's legitimacy bet. Token-tolerance is a structural recruit qualifier, not a marketing problem.

**No external phase names.** *Phase 0 / Phase 1a / Phase 1b* are internal engineering vocabulary. External framing is *testnet live, mainnet gated on operator set*.

**No retired framings.** *Own What You Know*, *become a founder*, *your AI's experience is worth something*, *desired obsolescence*, *launch a token*. All previously tried, all retired. Do not revive without a proposal.

**No broad cold outbound.** Quality of targets over quantity. A list of warm contacts is not pumped for daily contact; it is worked weekly and supplemented by inbound from public teaching.

### 6.2 Tactical deferrals

These are not chased *yet*. They may move into permanent rules or get unblocked as conditions change; promotion either way is a deliberate decision, not drift.

- **Phase 2 / Phase 3 audiences** — see §4. Domain professionals and crypto-native operators are sequenced behind Phase 1 adoption, not abandoned.
- **Sprint #1 — jinn-adjacent crypto cluster** — retired 2026-05-06 after the postmortem in `growth/.local/growth-log.md` §7. Reasons: the cluster is tribal at sub-segment (Bittensor / Numerai / Allora are their own communities, not a coherent "crypto operators" pool), and differentiation from those projects is too fine-grained to articulate from inside crypto vocabulary. Reconsidered when Phase 3 conditions trigger.
- **Launcher audience** (non-technical domain experts authoring agents around their expertise) — parked until product surface supports them.
- **Telegram community management, ads, content calendars, podcast tour, partnerships** — not bad ideas, just not first.

## 7. Metrics

One headline metric at a time.

**Headline: external testnet operators.** Independent, identifiable, technically credible people running the client. Target ~10 before mainnet. This is the §2 bottleneck made measurable.

**Supporting metrics, in order of signal strength:**

- **swe-rebench v2 SolverNet runs** — coding-agent runs against swe-rebench v2 (rolling-refresh program-repair benchmark on real GitHub issues, monthly task refresh, docker-grade test gates). Locked 2026-05-07 as the **operational launch SolverNet** per [DR-2026-05-07-h](log/decisions/2026-05-07-swe-rebench-v2-as-operational-launch-solvernet.md), reinforcing the §3 tightening to coding agents (see `spec/2026-05-07-growth-cluster-tightening-coding-agents.md`). Three reasons each load-bearing: (i) monthly task refresh structurally mitigates memorisation in a way no static benchmark we considered (SWE-bench, GAIA, HumanEval, AgentBench) can; (ii) the `task generator → solver → docker eval → settlement` shape doubles as scaffolding for the next SolverNet — the trace-harvester / session-derived surface (sidecar per [#103](https://github.com/Jinn-Network/mono/discussions/103)) — so effort compounds rather than fragmenting; (iii) external task source (HuggingFace) + external evaluator (`eval.py` in Docker) means swe-rebench v2 ships without an operator-side capture surface, ~14 weeks shorter time-to-launch. The trace-harvester / telemetry-collector + session-derived SolverNet (`spec/2026-05-07-telemetry-collector-and-task-generator.md`) sequences *after* swe-rebench v2 demonstrates the operational launch shape; the open question of whether swe-rebench v2's task generator can be parameterised to also consume capture envelopes — fully subsuming the trace-harvester's task-generator into a multi-source variant — is tracked in DR-2026-05-07-h.
- **Contributors** — PRs, issues, forks from non-team. Independent technical engagement is a stronger signal than passive node-running.
- **Inbound interest** — DMs, applications, unsolicited mentions from the §3 target cluster. Lagging indicator of public teaching.

When the SolverNet of focus changes, this section is the canonical site of that change; downstream skills derive their default vocabulary from here.

We do not optimise for follower counts, vanity reach, or any metric that does not put a client in the hands of someone whose opinion moves others.

## 8. Channel canon

X is the primary channel. Five direction-only claims govern how the loop operates on it. Numerics and tactical heuristics live in [`x-algorithm-grader/references/`](.claude/skills/x-algorithm-grader/references/); this section is the direction those numerics point in. Changes to §8 require a spec proposal; numerics recalibrate freely.

- **Premium is mandatory.** Non-Premium accounts have effective zero-distribution on link posts and substantial throttling on text posts. The cost of Premium is trivial relative to the cost of operating without it.
- **Reply-to-reply is the engine.** The single dominant signal is the author replying back to a reply. Every reply received from someone in the target cluster is replied to; conversations beat broadcasts.
- **Cluster-fit dominates first-impression distribution.** A post that does not fit the cluster's interest graph gets buried before the engagement-quality score has a chance to rescue it. Posts are written to cluster, not to general audience.
- **Weekday cluster-peak is the priority window.** Tue / Wed / Thu, 09:00–14:00 Oak-local. First-impression distribution is concentrated in this window for the §3 target cluster.
- **Constructive-tone overlay is real.** Negative / combative / rage-bait content is suppressed regardless of engagement. The §6.1 *lead from structure, not from fear* rule is also load-bearing for distribution, not just brand.

## 9. Sprint discipline

One sprint at a time. A sprint is the unit of focus that the daily loop ladders into.

A sprint declaration must contain:

- **Cluster** — must reference §3's current target (or a sub-segment of it). Sprints do not introduce new clusters; that is a §3 change requiring a spec proposal.
- **Window** — `start_date → end_date`, time-boxed. Typical span 1–2 weeks.
- **Inputs target** — countable items (e.g. *6 teach posts*, *reply cascades after each*, *1 bridge post*).
- **Thresholds** — outcomes that determine the decision rule below. Examples: *2 Tier-A contacts at WARM rung*, *1 inbound mention from a Tier-A account*.
- **Decision rule** — what happens at sprint end based on threshold attainment (typical: *hit ≥1 → double down; hit 0 → postmortem and pivot*).
- **Mandatory postmortem** — written to `growth/.local/growth-log.md` §7 at sprint end, regardless of pass / fail. The postmortem is the forcing function; sprints without postmortems do not count.

Sprints live in `growth/.local/growth-log.md` §6 (active block + daily progress) and §7 (postmortem archive). `growth-day` reads §6 to compute progress against this section's fields and fails loud if no active sprint is declared.

## 10. Where the long-form lives

[`growth/`](growth/) is this doc's working appendix. Strategy notes, channel experiments, copy drafts, campaign tracking, and tooling all live there. When growth/ contradicts this doc, this doc wins; when growth/ extends it, the extension stays in growth/ unless it is load-bearing enough to be promoted into this doc via a canonical-doc PR.

Bootstrap reference points inside `growth/`:

- [`growth/docs/thesis-mechanistic (1).md`](growth/docs/thesis-mechanistic%20(1).md) and [`growth/docs/thesis-narrative.md`](growth/docs/thesis-narrative.md) — long-form thesis pieces sourcing teach-content
- [`growth/docs/2026-04-24-intro-to-jinn.md`](growth/docs/2026-04-24-intro-to-jinn.md) — canonical intro doc; lead reference for outreach

Skills under [`.claude/skills/`](.claude/skills/) implement the techniques behind §5's daily loop. They are the operational form of the disciplines in §5 — invoked in-session, not just documented.

- **Understand** — [`cluster-model/`](.claude/skills/cluster-model/) refines the bridge model in §3 against fresh evidence.
- **Understand** — [`discover-twitter-recruits/`](.claude/skills/discover-twitter-recruits/) surfaces candidate accounts inside the §3 target cluster.
- **Teach** — [`x-post-builder/`](.claude/skills/x-post-builder/) drafts content; [`x-algorithm-grader/`](.claude/skills/x-algorithm-grader/) scores against §8.
- **Engage** — [`growth-watcher/`](.claude/skills/growth-watcher/) tracks active threads and surfaces cluster signals.
- **Refine** — [`growth-refine/`](.claude/skills/growth-refine/) proposes amendments to this doc and to the skills.
- **Aggregator** — [`growth-day/`](.claude/skills/growth-day/) reads this doc and operational state, surfaces the day's top-3 actions tagged by §5 function, fails loud if §9 is empty.
- **Account-level review** — [`twitter-strategy/`](.claude/skills/twitter-strategy/) computes drift between this doc's targets and X-account actuals over 7d / 30d windows.

Each skill names which sections of this doc it reads. Skills do not redefine canonical claims; when a skill's reference content drifts from canon, the fix is a refine proposal, not a skill-side restatement.

Changes to this document require a linked [GitHub Discussion](https://github.com/Jinn-Network/mono/discussions) and CODEOWNERS approval, per [`spec/2026-04-28-canonical-docs.md`](spec/2026-04-28-canonical-docs.md).
