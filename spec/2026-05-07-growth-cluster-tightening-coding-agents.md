- **Date:** 2026-05-07
- **Author:** Oak (with Claude)
- **Status:** Proposal
- **Version:** 0.1

## Motivation

`spec/2026-05-07-growth-niche-and-pitch-pmf-search.md` (landed earlier today) tightened GROWTH §3 from "AI builders" to "open-source agentic project contributors" and replaced the benchmarks-as-pitch shape with public-good-training-data framing. Sprint #3 was declared in `growth-log` §6 the same day with a vertical commitment — **swe-rebench v2** as the SolverNet of focus and *"help collectively train a swe-rebench v2 harness"* as the cluster-recognisable pitch instance.

The vertical commitment exposes a residual gap in §3: *open-source agentic project contributors* is broader than the natural recruit base of swe-rebench v2. swe-rebench v2 is a program-repair benchmark on real GitHub issues — its recruit base is **open-source coding agent contributors**: people who maintain or contribute to coding agents shipping publicly (Aider, OpenHands / All Hands AI, SWE-agent, Continue, Cline, Sweep, Agentless, gpt-engineer, smol-ai, Open Interpreter, Codename Goose, Devon AI, Roo Code, and adjacent active OSS projects).

Three concrete failures fell out of the broader §3 today:

1. **The carry-over warm list went stale silently.** Five WARM rows inherited from Sprint #2 (askdrvoyage — vet-care vertical AI; Vtrivedy10 — LangChain Deep Agents; Obsrver_Prtcl — verification infrastructure; TreebeardAI — rating agency for agents; pkyanam — agent-memory product) all carry `cluster=ai-builders` (continuity-renamed to `oss-agent-contributors`). None of them are OSS coding agent contributors. `growth-day`'s cluster gate passed all five because the §3 handle is broad enough to cover them.

2. **Discovery is unanchored.** "Open-source agentic project contributors" doesn't have an obvious set of GitHub orgs, X accounts, or paper authors to anchor discovery against. "Open-source coding agent contributors" anchors immediately on the project list above and the SWE-bench / swe-rebench leaderboard contributor pool. The narrower cluster handle is operationally legible in a way the broader handle is not.

3. **`growth-day` had no canon-vertical alignment check.** The skill ran cluster-fit against §3 but had no way to detect that §6's vertical commitment implied a tighter cluster than §3 declared. The first sprint-input day (today) was wasted on stale carry-overs that shouldn't have surfaced as Tier A. A separate skill-side fix is sequenced alongside this spec — a Step 1.6 alignment lint in `growth-day` — so that a future vertical-specific sprint cannot silently produce stale top-3 candidates.

The fix is a single coherent §3 tightening: cluster name → "open-source coding agent contributors"; pitch's vertical instance → swe-rebench v2 harness as the cluster-recognisable surface; bridge model unchanged in shape but instantiated for coding agents specifically; §7 supporting metric pinned to swe-rebench v2 by name (this morning's spec sequenced this as a follow-up "if Sprint #3 produces signal" — instead, we pin now because the cluster-tightening forces it as a co-decision).

This is a tightening, not a pivot. The harness-layer functional boundary (§3) is unchanged. The ethos boundary (§6.1 token-tolerance) is unchanged. The bridge-model shape (private eval signal vs coordination primitive) is unchanged — only the examples instantiate to coding agents. The disposition preamble landed this morning still applies verbatim.

## What this proposal changes

### §3 cluster name and definition tighten from agentic to coding-agent

`Current target cluster: open-source agentic project contributors` becomes `Current target cluster: open-source coding agent contributors`.

The functional boundary stays at the harness layer. The cluster definition narrows: people who maintain or actively contribute to **open-source coding agents** — agents that take a task description and modify a codebase to fulfil it — shipping their harness publicly, alone or in small teams, with day-to-day work (issue triage, regression hunting, capability extension) that would benefit from pooling attempts with others on the same task class. Concrete project anchors: Aider, OpenHands, SWE-agent, Continue, Cline, Sweep, Agentless, gpt-engineer, smol-ai, Open Interpreter, Codename Goose, Devon AI, Roo Code, plus adjacent active OSS coding agents not yet enumerated.

The ethos boundary (token-tolerance per §6.1) is unchanged. Eval-as-research practitioners at institutional labs remain explicitly out of the recruit pool for the same reason as in this morning's spec.

### Pitch tightens to vertical instance

The umbrella pitch from this morning's spec is preserved verbatim — it remains the canonical statement of what Jinn is. A second paragraph is added naming the immediate vertical instance:

> *"The first SolverNet is **swe-rebench v2** — a rolling-refresh program-repair benchmark on real GitHub issues. People who ship coding agents pool their attempts on the same task stream; evaluators verify with docker-grade test gates; the corpus accrues. Help collectively train a swe-rebench v2 harness."*

The umbrella + instance shape is deliberate. The umbrella generalises (other SolverNets will follow); the instance gives the cluster a concrete surface to recognise. Both are needed.

### Bridge model: same shape, coding-agent examples

The Frame / Frame Jinn offers / Bridge structure stays. The examples in *Frame this cluster currently holds* tighten:

- The cluster's static benchmarks are now SWE-bench, SWE-bench Verified, swe-rebench v1 — already-public coding-agent benchmarks the cluster recognises. (The earlier broader list — GAIA, HumanEval, AgentBench — is replaced; AgentBench, HumanEval, etc. remain valid context but not the cluster-native examples.)
- The "shadow-eval against production traffic" reference becomes "private eval against the team's own dogfooding" — closer to how OSS coding agent maintainers actually iterate.
- The contributor's solo iteration loop is now "their harness, their issue triage, their PR test suite, their corpus" — the artefacts the cluster actually produces.

Frame Jinn offers is unchanged; only the *instance* of the SolverNet in the example tightens to swe-rebench v2.

The bridge methodology question tightens to:

> *static benchmarks are last year's coding agents; live eval against rolling fresh GitHub issues is a coordination problem nobody owns. What does it look like to run the harness you already have alongside others doing the same work — and who pays for the task stream?*

### §4 Phase 1 name update

`Phase 1 — Open-source agentic project contributors (current)` → `Phase 1 — Open-source coding agent contributors (current)`. One-line note: *the cluster handle was tightened from "open-source agentic project contributors" on 2026-05-07 (PM, same-day second tightening) because Sprint #3's vertical commitment to swe-rebench v2 implied a tighter recruit base than the morning §3 named. The harness-layer functional boundary and the §6.1 token-tolerance ethos are unchanged.*

### §7 supporting-metric pinning

Replace the current §7 placeholder block with the swe-rebench v2 pinning:

OLD: *"Live-eval SolverNet runs — agent runs against the SolverNet(s) of focus in the cluster-native vertical. The specific SolverNet(s) and vertical are named here once the operational test in the active sprint produces signal. Currently testing: cluster-native live OSS issues with test-gated resolution, sourced from AI / eval / agent OSS the cluster builds and uses."*

NEW: *"swe-rebench v2 SolverNet runs — coding-agent runs against swe-rebench v2 (rolling-refresh program-repair benchmark on real GitHub issues, monthly task refresh, docker-grade test gates). Pinned 2026-05-07 with the §3 tightening to coding agents. The SolverNet is the operational shape Sprint #3 stands up; subsequent SolverNets are additions, not replacements."*

This pins the vertical now rather than waiting for Sprint #3 signal. The cluster tightening forces it as a co-decision: an "open-source coding agent contributors" cluster without a named coding-agent SolverNet would be incoherent.

### §3 retired-cluster archive entry

The previous §3 ("open-source agentic project contributors", landed this morning) moves to `growth/.local/growth-log.md` §1 as a dated archival entry, alongside the prior "AI builders" entry. Same-day double-tightening is unusual but the archival flow is the same.

## What this proposal does *not* change

- §1 The bet (legitimacy as scarce resource — unchanged)
- §2 The bottleneck (operator count — unchanged)
- §3 disposition preamble (PMF-search bet framing — unchanged)
- §3 functional and ethos boundaries (harness layer + token-tolerance — unchanged; only the cluster instance tightens)
- §4 GTM sequence shape (Phase 2 / Phase 3 untouched)
- §5 Daily loop functions (Understand / Teach / Engage / Refine — unchanged)
- §6 What we will not chase (token-tolerance rule landed this morning — unchanged)
- §8 Channel canon (unchanged)
- §9 Sprint discipline shape (unchanged)
- The sequencing and approval gate from this morning's spec (canonical-doc rules per `spec/2026-04-28-canonical-docs.md` — unchanged)

The umbrella pitch from this morning's spec is unchanged. The vertical-instance second paragraph is additive.

The skill demotions and reference targets established in `spec/2026-05-06-growth-canonical-restructure.md` continue to hold.

## Concrete sprint impact (operational, not canonical)

Sprint #3 is **not** retired. Its declaration in `growth-log` §6 already names swe-rebench v2 as the vertical and the swe-rebench-instance pitch — this spec lifts those into canon, not the reverse. The sprint cluster-definition block in §6 is updated to reference the new §3 verbatim; window, inputs target, thresholds, and decision rule are unchanged.

The 5 WARM rows carried over from Sprint #2 (askdrvoyage, Vtrivedy10, Obsrver_Prtcl, TreebeardAI, pkyanam) are operationally frozen with `frozen_reason=sprint-3-cluster-tightened-2026-05-07` because they are out of the new §3 cluster. In-flight threads can complete naturally as Engage activity but do not count toward Sprint #3 thresholds. This is the sprint-pivot freeze (per `growth-day` SKILL §"Sprint-pivot freeze") applied with the cluster-handle change as the trigger.

`growth-day` SKILL gains a new Step 1.6 sprint/canon alignment lint, sequenced in the same PR. The skill-side change is not a canonical change; it is a hardening of the daily loop's failure mode against this morning's silent drift.

`discover-twitter-recruits` is invoked in the same change-set with target = open-source coding agent contributors, anchored on the project list above. The output populates the warm-list with first-touch candidates inside the new cluster.

## Risks and limitations

- **Same-day double tightening.** §3 was tightened this morning and is being tightened again this afternoon. The specific risk: it normalises rapid cluster handle churn during PMF search. Mitigation: today's two tightenings have a clear causal chain (the morning tightening's vertical commitment forced the afternoon's cluster tightening); the §3 disposition preamble explicitly says "this is what we're testing right now"; both retirements are archived in `growth-log` §1 with full rationale. The mechanic governs the velocity, and two same-day tightenings is the right cost of catching the mismatch on day-0 of a sprint.

- **The cluster handle is now narrow enough to feel exclusionary.** "Open-source coding agent contributors" excludes adjacent populations (eval-tooling builders, agent-observability tooling, RL-environment authors) that the morning's broader handle gestured at. The §3 disposition preamble already names §3 as a *current bet*; if Sprint #3 produces signal that the recruit base is broader than coding agents specifically, `growth-refine` proposes the next rotation. The narrower handle is the right shape *while we have a single SolverNet pinned*.

- **swe-rebench v2 supply assumption.** The spec assumes swe-rebench v2's monthly task refresh produces enough volume for early operator attempts. If month-one supply is thin, the pitch instance still holds (the cluster recognises the surface) but the SolverNet stand-up may need supplementation from generic SWE-live. This is an operational risk for Sprint #3, not a canonical one.

- **Within-month memorisation.** swe-rebench v2's rolling-refresh partially mitigates static-benchmark memorisation but does not eliminate it. Sprint #3's instrumentation (success-rate-per-task vs corpus-attempt-count, captured 2026-05-07 in `growth-log` §6) tests whether late-month attempts are *learning* or *retrieving*. If retrieval dominates, a follow-up spec revisits the SolverNet shape (e.g. opening source repos quarterly rather than monthly). The corpus-collapse insight from this morning's Sprint #2 postmortem still applies — we accept partial mitigation as the cost of a recognisable surface.

- **Skill-side step 1.6 has no NLP cluster-detection.** The proposed lint asks the operator to verify §3-§6 alignment at sprint declaration; it does not auto-detect mismatch from sprint vertical text. False negatives are possible (a future sprint vertical that looks aligned but isn't). Mitigation: the lint surfaces alignment as HEADS-UP every day until resolved; persistent mismatches escalate to BLOCKED. Operator-in-the-loop is the right shape because cluster-fit is a judgement call, not a string-match.

## Open questions

- **Should the umbrella pitch and the vertical instance be presented as one block in §3, or as two distinct blocks?** Proposed: two blocks. Block one is the umbrella ("public-good network for agentic training data..."), block two is the instance ("the first SolverNet is swe-rebench v2..."). When the next SolverNet pins, the instance block grows; the umbrella block stays. Open to a single-block presentation if it reads cleaner once written.

- **Does pinning the vertical to canon foreclose flexibility if Sprint #3 fails?** Proposed: no. §7's pinning text already says "subsequent SolverNets are additions, not replacements"; if swe-rebench v2 doesn't produce signal, a follow-up spec proposes a different anchor SolverNet (e.g. cluster-native SWE-live on AI / eval / agent OSS, which was the morning spec's placeholder). Pinning is operationally a stronger commitment than placeholder language; it is reversible by spec proposal, same as any other canonical change.

- **Is "open-source coding agent contributors" still the right handle in two weeks?** Proposed: revisit at Sprint #3 sprint-end postmortem. If the cluster's first-touches reveal a sharper self-naming ("autonomous SWE-agent maintainers", "code-agent harness builders", etc.), `growth-refine` proposes the rename.

## Sequencing

1. **This spec lands.** Approval gate per `spec/2026-04-28-canonical-docs.md`.
2. **GROWTH.md PR linked to this spec.** Updates §3 (cluster name + pitch instance + bridge examples), §4 Phase 1 name, §7 supporting-metric pin. Same PR includes:
   - `growth/.local/growth-log.md` updates: §1 archive of the prior "open-source agentic project contributors" cluster (verbatim text, dated, retirement note pointing to this spec); §6 Sprint #3 cluster-definition block synced to new §3.
   - `growth/.local/jinn-warm-contacts.csv` updates: 5 WARM rows frozen with `frozen_reason=sprint-3-cluster-tightened-2026-05-07`.
   - `.claude/skills/growth-day/SKILL.md` updates: Step 1.6 sprint/canon alignment lint added (operational hardening; non-canonical).
3. **Same change-set: invoke `discover-twitter-recruits`.** Target: open-source coding agent contributors, anchored on the project list. Output populates warm-list with first-touch candidates.
4. **Re-emit `growth-day` brief** with the tightened state. The brief is allowed to surface "all Tier B today — no in-cluster Tier A candidates" or the cluster-bootstrap top-3 if discovery returns zero in-cluster cold candidates the same day. The cluster gate is now load-bearing in the right way.

## Appendix: prior content for archival

The morning's §3 "open-source agentic project contributors" + pitch + bridge model paragraphs move to `growth/.local/growth-log.md` §1 as a second dated archival entry (2026-05-07 PM), labelled *"Prior §3 cluster, retired by `spec/2026-05-07-growth-cluster-tightening-coding-agents.md`."* Same retention rule applies — the morning's "AI builders" archive entry is unchanged.
