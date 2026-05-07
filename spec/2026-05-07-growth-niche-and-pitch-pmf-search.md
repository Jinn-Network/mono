- **Date:** 2026-05-07
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

## Motivation

Two things surfaced in the 2026-05-07 Oak + Ritsu daily that the current `GROWTH.md` §3 cannot accommodate without rewriting.

**Benchmarks-as-pitch broke.** Sprint #2 (declared 2026-05-06, mid-flight) commits to *"we use Jinn to compete on public benchmarks; the product is — here's a way to bring your talent to training agentic AI as a public good."* Today's call diagnosed why the first half of that pitch can't carry the protocol's training-data shape: a static benchmark collapses learning. Once the corpus contains a successful solution to a benchmark task, every subsequent attempt has the dominant strategy of looking up the answer rather than re-deriving it. "Winning the benchmark" inverts the goal of an accumulating training corpus. The learning-and-corpus framing survives intact; the *competition framing on a static target* does not.

**The cluster name is identity-shaped where the recruit reality is usage-shaped.** "AI builders" was tightened in `spec/2026-05-06-growth-canonical-restructure.md` from prior framings, but the resulting list (eval-harness builders, agent-observability tooling builders, RL-environment authors, shadow-eval practitioners, public-benchmark contributors) drifts toward institutional eval-research practitioners — METR, Apollo, AISI external collaborators, frontier-lab evals teams — when read at face value. Two problems with that drift:

1. Those audiences face *structural* recruit friction independent of pitch quality. Public association with a token-coordinated network is reputationally costly in their professional context. Better pitching does not move that friction; better targeting does.
2. The §1 bet is *legitimacy via real use*, not via institutional blessing. Prime Intellect has the institutional blessing path; we don't need it. We need a small group that finds Jinn genuinely useful in their day-to-day work and grows passionate about it. That's a usage filter, not an identity filter.

The composite problem: §3 currently encourages outreach to a population with high reputational friction *and* low usage-fit, and pairs it with a pitch that today's call broke. The fix is a single coherent §3 rewrite: usage-shaped niche, token-tolerance as a structural qualifier, public-good-training-data pitch (no benchmark-competition frame), and a new bridge model anchored on *"benchmarks are static snapshots; live eval is a coordination problem nobody owns"* rather than *"leaderboards rank the wrong layer."*

A secondary observation that matters for §3's framing posture: the section is currently written as if it names settled canon, even though `Updated as we learn` and `When the target changes, this section is rewritten via a spec proposal` are both already present. During PMF search, §3 records a *bet*. Rotation is normal, not exceptional. A one-paragraph preamble making this explicit fixes the disposition without changing the mechanic.

## What this proposal changes

### §3 niche shifts from identity to usage

`Current target cluster: AI builders` becomes `Current target cluster: Open-source agentic project contributors`. The cluster is defined by *the work shape Jinn is actually useful to*, not by a job title. Concretely: people who ship agentic systems publicly, alone or in small teams, with real day-to-day tasks they're trying to solve in their own work — multi-agent framework authors, indie agent-app maintainers, OSS agent-tooling builders.

The functional boundary stays at the harness layer. The *ethos* boundary tightens to public shipping plus token-tolerance (see §6.1 addition below).

Eval-as-research practitioners at institutional labs are explicitly *not* the recruit pool. They overlap technically but face structural recruit friction; the new §3 names this rather than leaving it implicit.

### Pitch replacement

`We use Jinn to compete on public benchmarks. The product is — here's a way to bring your talent to training agentic AI as a public good.` becomes:

> *"This is a public-good network for agentic training data. People shipping agentic projects pool their real work into shared SolverNets — others attempt the same tasks, evaluators verify, the corpus accrues to everyone. It's coordinated via a token because there is no central operator; participation is how stake accrues."*

The token sits inside the mechanism description, not the headline, but it is plainly visible. Not foregrounded, not hidden.

### Bridge model replacement

The current `Frame this cluster currently holds` / `Frame Jinn offers` / `The bridge` paragraphs are rewritten end-to-end. The new bridge leads with *static benchmarks are last year's agents; live eval is a coordination problem nobody owns* — pointed at the **limit** of the cluster's existing work product (their private eval signal, their static benchmarks) rather than the **layer** of their work. Full text in §"Proposed §3 text" below.

### §3 preamble: PMF-search disposition

A one-paragraph preamble is added before `Current target cluster:`:

> *During PMF search, §3 records our current bet on cluster, pitch, and bridge. Bet rotation is the rewrite-and-archive flow already specified — the spec-proposal flow is the velocity governor, not a claim that the bet is settled. Read this section as "this is what we're testing right now," not "this is who Jinn is for."*

No mechanic change. Disposition change only.

### §6.1 addition: token-tolerance as structural qualifier

A new permanent rule:

> **No clusters whose professional context makes token-association reputationally costly.** Some technically-aligned audiences (institutional eval-research labs, frontier-lab safety teams, regulated-industry employees) cannot publicly associate with a decentralised project without professional friction. Recruiting from those clusters means betting on individuals who quietly identify against their employer's posture; conversion friction dominates, and the recruits we land carry reputational caveats that undermine §1's legitimacy bet. Token-tolerance is a structural recruit qualifier, not a marketing problem.

### §4 Phase 1 name update

`Phase 1 — AI builders (current)` → `Phase 1 — Open-source agentic project contributors (current)`. One-line note: *the cluster name was tightened from "AI builders" on 2026-05-07 because the broader name was identity-shaped where the recruit reality is usage-shaped, and because token-tolerance is a structural filter that the broader name did not encode.*

§4 Phase 2 ("domain professionals") description is *not* changed in this spec, but a flag is added: *§6.1's token-tolerance rule applies to Phase 2 as well; the brand-risk gate already named there is necessary but not sufficient.* A future spec will revisit Phase 2's recruit shape under the §6.1 lens.

### §7 Phase 1 transition trigger update

OLD: *"a meaningful number of testnet operators from this cluster, and at least one visible benchmark engagement that other clusters can pattern-match"*

NEW: *"a meaningful number of testnet operators from this cluster, at least one SolverNet running with attempts from multiple operators, and visible adoption signal — the cluster's own audience pattern-matching to running-network rather than to-be-launched"*

### §7 supporting-metric reshape

The `Benchmark-SolverNet runs` supporting metric is renamed and rescoped. Benchmarks-as-target is dropped; the metric tracks *live-eval SolverNet runs* in the cluster-native vertical to be selected operationally in Sprint #3 (see below).

NEW text: *"Live-eval SolverNet runs — agent runs against the SolverNet(s) of focus in the cluster-native vertical. The specific SolverNet(s) and vertical are named here once the operational test in Sprint #3 produces signal. Currently testing: **swe-rebench v2** — a rolling-refresh program-repair benchmark on real GitHub issues, with `task generator → solvers → docker eval → settlement` shape (the same shape doubles as setup for the next SolverNet, the sidecar / trace-harvester surface per #103). Tasks refresh monthly; within-month memorisation is partially mitigated (not eliminated) by the refresh cadence."*

The choice of swe-rebench v2 specifically (vs the broader "cluster-native SWE-live" category that this spec's earlier draft pointed at) was made operationally on 2026-05-07 by Ritsu and Oak after the canonical-changes-decision converged: rolling-refresh task pool dodges static-benchmark memorisation; existing infrastructure inheritance avoids designing a docker-eval pipeline from scratch; the `task generator → solvers → docker eval → settlement` shape composes forward into the next SolverNet (the sidecar idea filed in #103) so the engineering work double-counts. The §7 line above captures this as the *currently-testing* commitment without pinning swe-rebench v2 as the canonical SolverNet of focus — that promotion happens via follow-up spec only if Sprint #3 produces signal.

### Sprint #2 retirement, Sprint #3 declaration (operational, not canonical)

Sprint #2 (AI builders, public-benchmark pitch, declared 2026-05-06) is retired on 2026-05-07 with a postmortem in `growth-log` §7 — calibration retirement, not failure retirement. The pitch broke on the second day of the sprint window; cost-to-pivot is low. Sprint #3 is declared with the new §3 cluster + pitch + a vertical decision (cluster-native SWE-live as the operational test). These are operational writes to `growth/.local/growth-log.md`, not canonical changes — they happen in the same PR that lands GROWTH.md updates so the canonical and operational state ship together, but they do not require their own spec proposal.

## What this proposal does *not* change

- §1 The bet (legitimacy as scarce resource — load-bearing, unchanged)
- §2 The bottleneck (operator count — unchanged)
- §4 GTM sequence shape (just the Phase 1 niche definition tightens; Phase 2 / Phase 3 wait for separate work)
- §5 Daily loop functions (Understand / Teach / Engage / Refine — unchanged)
- §8 Channel canon (unchanged)
- §9 Sprint discipline shape (unchanged)
- The skills' canonical-doc relationships established in `spec/2026-05-06-growth-canonical-restructure.md` (unchanged)

The product-vertical bet (cluster-native SWE-live: live OSS issues with test-gated resolution, sourced from AI / eval / agent OSS the cluster itself builds and uses) is *implied* by §7's reshape but is *operationally tested* in Sprint #3, not promoted to canon in this spec. If Sprint #3 produces signal, a follow-up spec promotes the vertical to §7 by name. If it doesn't, the §7 placeholder absorbs the next test direction.

The "sidecar / pooled-shadow-eval" product idea that emerged in the 2026-05-07 daily and Telegram thread is product-surface ideation for a future plug-in surface (Phase A.2). It is *not* in scope for this spec; it is being captured separately as a GitHub Discussion in the Ideas category.

## Proposed §3 text (full replacement of "Current target cluster" through "The bridge")

> *During PMF search, §3 records our current bet on cluster, pitch, and bridge. Bet rotation is the rewrite-and-archive flow already specified — the spec-proposal flow is the velocity governor, not a claim that the bet is settled. Read this section as "this is what we're testing right now," not "this is who Jinn is for."*
>
> ### Current target cluster: open-source agentic project contributors
>
> People who contribute to agentic systems shipping publicly, alone or in small teams, with real day-to-day tasks they're trying to solve in their own work — multi-agent framework authors, indie agent-app maintainers, OSS agent-tooling builders.
>
> The functional boundary: they ship verifiable agentic artefacts (repos, demos, datasets) at the harness layer of agentic AI, and have day-to-day work that would benefit from pooling attempts with others on the same task class.
>
> The ethos boundary, equally load-bearing: they are open to identifying publicly with a decentralised project. The token is not foregrounded but it is not hidden — recruits who can't accept that filter themselves out, and that filter is the right shape for §1's legitimacy bet (see §6.1).
>
> Eval-as-research practitioners at institutional labs (METR, Apollo, AISI external, academic eval groups, frontier-lab evals teams) are *not* the recruit pool. They overlap technically but face structural recruit friction (public token-association is reputationally costly in their professional context) that pitch quality cannot move. They may flow in via teach-loop overflow once visible adoption develops, but the loop is not organised around them.
>
> ### The pitch
>
> > *"This is a public-good network for agentic training data. People shipping agentic projects pool their real work into shared SolverNets — others attempt the same tasks, evaluators verify, the corpus accrues to everyone. It's coordinated via a token because there is no central operator; participation is how stake accrues."*
>
> Real usage of Jinn on the contributor's own work is the conversion shape. The corpus of agent runs that accumulates publicly is the public good. Talk about the work the network does and the artefacts that accrue; let participation imply ownership rather than leading with it.
>
> ### Bridge model
>
> **Frame this cluster currently holds.** People contributing to agentic projects iterate against their own private eval signal — their tests, their qualitative checks, their personal sense of whether the agent is good. The eval-as-research clusters they look up to publish *static* benchmarks (SWE-bench, GAIA, HumanEval, AgentBench) that snapshot capability at a point in time. Continuous shadow-eval against production traffic is starting to be named as the right cadence, but it stays private — the deploying team eats the cost and keeps the signal. The contributor's own iteration loop is structurally solo: their harness, their tasks, their corpus.
>
> **Frame Jinn offers.** The eval-signal is a coordination primitive, not a private artefact. When a SolverNet exists for a task class the contributor actually cares about, others attempt the same tasks; their solutions enter the contributor's decision space and the contributor's enter theirs. Static benchmarks are the snapshot; this is the stream — public, attributable, stake-backed. The harness around the model becomes the substrate of a network, not the moat of a deploying team.
>
> **The bridge.** The methodology question that moves a cluster member across the gap, in the shape that has worked in past first-touches: *static benchmarks are last year's agents; live eval is a coordination problem nobody owns. What does it look like to run the harness you already have alongside others doing the same work — and who pays for the task stream?* The question must not be answerable from their own README, post, or pinned thread.

## Proposed §6.1 addition

Inserted after the existing rule list, ordered alongside the other permanent rules:

> **No clusters whose professional context makes token-association reputationally costly.** Some technically-aligned audiences (institutional eval-research labs, frontier-lab safety teams, regulated-industry employees) cannot publicly associate with a decentralised project without professional friction. Recruiting from those clusters means betting on individuals who quietly identify against their employer's posture; conversion friction dominates, and the recruits we land carry reputational caveats that undermine §1's legitimacy bet. Token-tolerance is a structural recruit qualifier, not a marketing problem.

## Proposed §7 supporting-metric replacement

Replace `Benchmark-SolverNet runs` block in §7 with:

> - **Live-eval SolverNet runs** — agent runs against the SolverNet(s) of focus in the cluster-native vertical. The specific SolverNet(s) and vertical are named here once the operational test in Sprint #3 produces signal. Currently testing: cluster-native live OSS issues with test-gated resolution, sourced from AI / eval / agent OSS the cluster builds and uses.

## Risks and limitations

- **Cluster-native task supply is small.** Filtering SWE-live to AI / eval / agent OSS may produce thin issue volume in month one. Mitigation handled operationally in Sprint #3: keep generic SWE-live as a fallback flavor; the SolverType / pipeline is the same, only the issue source changes. If Sprint #3 hits supply problems, the §7 placeholder absorbs the broader source.
- **Cluster name is unfamiliar.** "Open-source agentic project contributors" doesn't map to an existing self-identified group on X or GitHub. Mitigation: the niche is operationally legible (we know who fits when we see them); the cluster name is a doc-level handle, not a recruiting tagline. Posts and DMs use the bridge model's vocabulary, not the cluster label.
- **The token-tolerance rule reads as exclusionary.** It is — by design. The §1 bet says legitimacy is scarce and one respected operator beats broad awareness; spending recruit effort on individuals who can't publicly associate is anti-legitimacy. The doc-visible rule is the right shape because it forces the choice rather than letting it accumulate as ambiguity.
- **Disposition preamble could read as license to drift.** The "current bet" framing is meant to be honest about PMF search, not an excuse for shallow rotation. Mitigation: the rotation flow (rewrite + archive + spec proposal) is unchanged; the preamble names the disposition, the mechanic still governs the velocity.
- **Sprint #2 retirement at day 2.** Calibration retirements at day 2 risk normalising fast pivots that don't accumulate learning. Mitigation: the postmortem in `growth-log` §7 captures *why benchmarks-as-pitch broke*, not just *that we pivoted* — the learning is the broken pitch, which is durable evidence that competition-on-static-targets isn't the right pitch shape regardless of cluster.

## Open questions

- **Should the §3 preamble live at the top of GROWTH.md (whole-doc framing) instead of inside §3 (just-the-bet framing)?** Proposed: inside §3, because §1 / §2 / §4 / §5 / §8 / §9 are not bets — they're the bet *structure*. Putting the preamble at the top would imply the structure is a bet too. Open to argument.
- **Does the new pitch need to mention "decentralised" explicitly, or is "no central operator" sufficient?** Proposed: the current language ("coordinated via a token because there is no central operator") is enough — it names the property without leading with the loaded word. Recruits who care about the property will recognise it; recruits who pattern-match on the word are not the recruits we want.
- **Is "open-source agentic project contributors" the right cluster handle?** Proposed: yes, but if a sharper handle emerges from Sprint #3 (or from the cluster's own self-naming), `growth-refine` should propose the rename rather than cementing today's choice. The handle is intended to be revised as we learn what the recruits call themselves.

## Sequencing

1. **This spec lands.** Approval gate per `spec/2026-04-28-canonical-docs.md`.
2. **GROWTH.md PR linked to this spec.** Updates §3 (preamble + niche + pitch + bridge), §4 Phase 1 name, §6.1 addition, §7 transition trigger, §7 supporting-metric reshape. Nothing else.
3. **Same PR or immediate follow-up: operational state pivot in `growth/.local/growth-log.md`.** Sprint #2 retired with postmortem in §7; Sprint #3 declared in §6 with the new cluster + pitch + cluster-native SWE-live as the operational vertical test. `growth-log` §1 archives the prior §3 "AI builders" cluster snapshot, dated.
4. **Follow-up PR if Sprint #3 produces signal: §7 vertical pinning.** A short spec proposal naming the SolverNet of focus by name and updating §7's `Currently testing` line accordingly. If Sprint #3 doesn't produce signal, a different short spec proposal moves the §7 placeholder to the next test direction.

The skill demotions and reference targets established in `spec/2026-05-06-growth-canonical-restructure.md` continue to hold; no skill files change as a consequence of this spec, beyond their normal cluster-tagged reads of the new §3.

## Appendix: prior content for archival

The current §3 "Current target cluster: AI builders" + pitch + bridge model paragraphs move to `growth/.local/growth-log.md` §1 as a dated archival entry (2026-05-07), labelled *"Prior §3 cluster, retired by `spec/2026-05-07-growth-niche-and-pitch-pmf-search.md`."* Per §3's existing rule: do not delete history when this section is rewritten.

The Sprint #2 declaration in `growth-log` §6 moves to `growth-log` §7 as the Sprint #2 postmortem entry, with the cluster + pitch retirement reasoning above as the *what didn't work* section.
