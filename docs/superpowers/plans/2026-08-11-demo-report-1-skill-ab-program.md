# Demo Report #1 — Skill vs Native CLAUDE.md: Scoping and Execution Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans per packet. Stage-0 recon packets each produce a seam report + a filed issue; each Stage-1 engineering packet then gets its own task-level implementation plan (superpowers:writing-plans) written by its implementer from that recon — this program plan deliberately does not fake line-level precision it does not have.

**Goal:** Complete the product's first demo report — a pre-registered, replicated comparison asking whether the same instruction-body bytes perform differently when delivered as a Claude Code skill versus native root `CLAUDE.md`, with a true-no-file manipulation control — through a sealed, deletion-portable, independently recomputed report bundle. Network publication is a separate design and implementation program.

**Architecture:** Two parallel streams converging on a lock: an engineering stream that completes the product's existing venue seams (no deviation, no demo-special pipeline), and a method stream that designs, red-teams, and pre-registers the eval. Nothing official runs until the glue e2e gate is green and the method survives adversarial review.

**Tech Stack:** `packages/benchmark-product` (product + venue), `packages/task-execution` (launchers, evaluator adapters), `packages/benchmarking` (interop, aggregate/method registry), container grading via the Docker runtime currently homed in `client/`.

## Global Constraints

- **Consumption contract holds** (benchmark-product design §3): public package exports only; no deep imports; no copied platform code; **no product-implemented statistics** — every number in the report comes from a named `BENCHMARKING_METHOD_REGISTRY` method.
- **No new record kinds; no tier-1–3 semantics changes.** Venue work generalizes registration/wiring through existing seams only.
- **§8.1 must-not-imply list** binds every report surface and derived asset; §7.1 self-run venue disclosure appears in the product and the report.
- **Previews are disclosed rehearsals** (§7.2): every preview is logged and disclosed in the official report's limitations.
- **Lock is real:** after the Run record seals, no method change, no task swap, no replicate top-up. A pre-locked same-cell evaluation retry policy is not a top-up: when explicitly enabled it can re-grade the identical delivered patch after a machine-typed provider/transport outage, while preserving task, arm, replicate, solve dispatch, and patch bytes. If the method is wrong post-lock, the report closure is produced as-is with the flaw disclosed, or the run is abandoned with the abandonment disclosed — never silently redone. (One re-lock is permitted BEFORE any official cell has executed, disclosed in the report.)
- **Pristine bar, operationalized:** every criticism a hostile evals-community reader could raise must have either a design answer or an explicit limitation line. The red-team packet (E3) enforces this; its findings register is part of the report bundle.
- **No rename dependency:** the report ships under the current working brand; naming is a separate decision (operator-gated) and blocks nothing here.
- **Publication boundary (operator decision, 2026-08-12):** this program emits sealed Benchmark, Run, Matrix, and Report records, a locally immutable report bundle, cold-recompute evidence, and a publication handoff packet. It does **not** choose a public report origin, create a Record Discovery source, operate a mirror, add Explorer views, or claim the report is published. Those choices require their own design session.
- **Official cell ceiling (operator decision, 2026-08-12):** E2 selects the smallest defensible three-arm design that reaches 80% simulated power for the approximately 21 percentage-point A-versus-B target. The hard maximum is 600 official cells. The program never silently enlarges the run; if the target is unattainable, it seals and reports the strongest achieved sensitivity within the ceiling.
- **Model suitability gate (operator decision, 2026-08-12):** test `claude-haiku-4-5-20251001` at `high` effort on six disposable, distinct-repository, true-no-instruction tasks with two replicates each before any arm-effect rehearsal. The twelve cells are excluded from the E2 and official pools. Passing requires all cells accounted, at least ten valid grader outcomes, no model/authentication/launcher incompatibility, at most two timeout FAILs, and between two and ten passes inclusive. An infrastructure-only failure may receive one recorded retry; unresolved infrastructure makes the gate inconclusive. Failure or an inconclusive gate stops for operator review; there is no automatic Sonnet fallback.
- **Report copy (operator decision, 2026-08-12):** the full report states the candidate-minus-baseline estimate, interval, exact alpha `0.0500`, and paired task count. Badges, social cards, and share copy remain result-number-free and link relatively to the full report.
- **Native flat baseline (operator decision, 2026-08-13):** after P2 proved that Claude Code does not load `AGENTS.md`, Demo-1 changed arm B to the runtime's native root `CLAUDE.md`. The public AGENTS.md-versus-skills debate remains the motivation, but the measured claim and every result surface say Skill candidate minus CLAUDE.md baseline. This dated amendment preserves the stopped seam rather than rewriting it out of history.
- **Report framing (operator decision, 2026-08-13):** name the Vercel comparison and Hacker News objection directly and respectfully, characterize Demo-1 only as a controlled follow-up, and require E3 J7's independent arithmetic recomputation and source fact-check. This decides report framing without deciding or implementing network publication topology.

---

## Stage 0 — Scoping recon (parallel agents, ~1 day)

Each packet: read-only recon → seam report (committed under `docs/superpowers/plans/demo-report-1/` as `R<n>-<seam>.md`) → a filed `feat` issue with acceptance criteria for its Stage-1 packet. Recon reports must cite exact files/exports; issues frame problems + acceptance criteria, not solutions (repo rule 2).

### R1 — Venue generalization seam
**Question:** what exactly must change so the product venue registers non-prediction arms?
**Known facts (spike):** `packages/benchmark-product/core/src/venue/venue.ts` hardcodes prediction-forecast profile registration; quote-time coverage refuses other profiles.
**Deliverable:** the registration/coverage extension points, the profile-plumbing path for a SWE-bench-shaped task family, and the acceptance criteria for P1 (including: prediction-forecast behavior byte-stable — existing sample tests unchanged).

### R2 — Launcher arm seam
**Question:** what wires a coding-agent launcher (claude-code first) as a pinnable venue arm?
**Known facts:** launchers exist in `packages/task-execution/launchers` with `LauncherContract`; probes default `ready: false`; skill loading is an enforced pinning capability (`jinn.skill.v1`), effort is an enforced pinning key.
**Deliverable:** the probe/readiness contract, the exact pinning keys the A/B needs (skill on/off, model, effort, harness version), and P2 acceptance criteria (arm pinning must be `enforced`, not attested, for every axis the A/B varies or holds).

### R3 — Container-grading bridge seam
**Question:** how does the product venue execute container grading, given the swe-rebench adapter only *reads* grader reports and the Docker runtime lives in `client/` (`native-evaluator-container-runtime.ts`)?
**Deliverable:** the host-bridge port shape the venue needs, what (if anything) must be extracted vs invoked in place, disk/timeout envelope (respect `JINN_EVAL_DISK_FLOOR_GB`, the swe-rebench timeout envs), and P3 acceptance criteria. Flag loudly if this seam exceeds ~5 dev-days — it is the chain's highest-variance item.

### R4 — Statistics seam
**Question:** does `BENCHMARKING_METHOD_REGISTRY` contain a paired two-arm comparison method with uncertainty (paired difference + interval), or only `wilson@1` single-proportion?
**Known precedent:** capability-eval-v0's `paired.ts`/`wilson.ts` (PR #1416).
**Deliverable:** if missing, the registry-addition spec for a `paired-delta@1`-class method — implemented in `@jinn-network/benchmarking-aggregate` (platform side, its own review), never product-side. P4 acceptance criteria including method-registry versioning rules.

### R5 — Task-slate recon
**Question:** which SWE-bench-shaped slate can the A/B use? Constraints: importable via `importSweBench` (`SweRebenchRow` type), licensed for this use, recent enough to note contamination status honestly, sized for the power analysis (E2), runnable in containers at nominal compute.
**Deliverable:** 2–3 candidate slates with license, freshness, and per-task runtime estimates; exclusion rules proposed BEFORE anyone sees per-task results (e.g. infra-failure retry policy) so the lock can include them.

## Stage 1 — Engineering packets (sequenced by recon; target ~7–12 agent-dev-days total)

Dependency order: **P1 → P2 → P2b → P5** and **P3a → P3b → P5**, with **P4 → P4b → P5** parallel after R4. Each packet has its own issue, TDD, PR to the integration branch, and independent review per repo rules (no self-merge). Each implementer writes its task-level plan from the recon report before coding.

- **P1 — Venue generalization.** Non-prediction task profiles register and quote through the product venue. Gate: existing prediction sample byte-stable; new profile family admitted end-to-end in a kit test.
- **P2 — Launcher arm wiring.** claude-code launcher runs as a venue arm with enforced pinning on model / skill-load / effort / version axes. Gate: deterministic `SKILL.md` and native root `CLAUDE.md` generation from one literal `source.md`, byte-identical instruction bodies, symmetric materialization/exclusion, and normalized patches byte-identical to no-loadout controls.
- **P2b — Truthful pinning evidence.** Real submit-time admission evidence flows into Matrix derivation; missing or mismatching evidence never earns `match`.
- **P3a/P3b — Container-grading bridge.** P3a supplies the pinned OCI runtime; P3b adds the product dependency/boundary/build-order edge and emits a real SWE-rebench registration. Gate: sealed grading-material identities and a real graded verdict flow from container → adapter → sealed verdict → Matrix cell.
- **P4 — Paired-comparison registry method** (if R4 confirms absent). Gate: method registered + versioned in `benchmarking-aggregate` with its own tests; `produceReport`/`verifyReport` round-trip.
- **P4b — Method-aware presentation.** Interval-present, interval-withheld, and zero-pair lifecycle coverage; approved paired copy; compact assets number-free; Wilson public-bundle bytes unchanged.
- **P5 — End-to-end gate (the "glue done" bar).** Exactly 3 tasks × 2 arms × 2 replicates run import→quote→lock→launch→collect→report→verify and immutable local bundle emission with zero manual intervention. A fresh run begins at 60 GiB, carries a 16-GiB run-owned reserve toward a 44-GiB target/40-GiB hard floor, and may use one sealed evaluation-only retry for typed provider/transport unavailability without rerunning Claude. All 12 cells and real axis evidence are accounted, gold patches pass and empty patches fail, three repository clusters exercise clustered resampling, and no interval is emitted for this undersized plumbing slate. **No official demo run before P5 is green.**

## Stage 2 — Method stream (parallel with Stage 1; method work, not code)

### E1 — Comparison framing + skill selection
The frame is **mechanism vs mechanism, not vendor vs vendor** — the live public argument is "AGENTS.md-style flat instructions vs skills," while the bound Claude Code runtime natively loads `CLAUDE.md`, not `AGENTS.md`. The resolved comparison is: *same agent, same tasks; arm A = an instruction body delivered as a skill with its upstream routing frontmatter; arm B = that byte-identical instruction body delivered through native root `CLAUDE.md`; arm C = neither, as the manipulation baseline.* The total delivered text differs by the Skill's frontmatter, and every claim stays qualified to the instruction body. No third-party author is graded; the delivery mechanism is what is measured.

Before the first preview, pin the exact `anthropics/skills` source commit and inventory every candidate folder. Exclude the four source-available document skills and any candidate without a compatible per-folder license, upstream description, standalone usable instructions, or a sufficiently large grader-valid repository-work pool. Rank the survivors by the number of eligible tasks established without model execution, breaking ties lexicographically by repository path. Freeze the winner, full candidate list, rejection reasons, license, source bytes, deterministic transform, and all digests. If no candidate can support repository-disjoint suitability, rehearsal, and official pools, stop with the inventory; do not author replacement content or silently change sources.

**Pre-run freeze result (2026-08-13): STOP.** The exact source commit/tree and all 17 candidate folders are frozen in [`demo-report-1/E1-pre-run-freeze.md`](demo-report-1/E1-pre-run-freeze.md) and its canonical, independently recomputable machine artifact. No candidate currently has a complete grader-valid, outcome-blind task-evidence pool. Pre-E2 readiness requires the fixed suitability and rehearsal pools plus an objective five-task/two-repository official feasibility floor; exact power-derived official capacity is deliberately deferred to E2. The pre-E2 winner and official task order are then immutable: if E2 requires more capacity than the winner supports, stop with evidence rather than switch candidates using observed outcomes. No preview, model arm, Docker cell, E2 rehearsal, or official run is permitted from this inventory; resumption requires a new complete freeze from the same pinned source, not authored replacement content or a silent source switch.

Task eligibility is outcome-blind: verified image digest, gold-pass/empty-fail behavior in the real grader, compatible license posture, no instruction leakage, no pre-existing conflicting instruction file, and no content/gold-patch collision. Task selection, replicate scheduling, and interleaving use SHA-256-derived seeds recorded as resolved integers before lock.

### E2 — Power analysis from rehearsal variance
After the Haiku suitability gate passes, a disclosed rehearsal uses ten tasks from at least five repositories, five replicates, arms A/B/true-no-file C, plus an empty-loadout diagnostic condition. The rehearsal pool is repository-disjoint from both suitability and official pools. The empty-loadout diagnostic is accepted as structurally equivalent only if loader behavior and model-visible context are indistinguishable and the paired outcome interval is wholly within ±10 percentage points; it does not replace the operator-fixed official true-no-file C or make C's loadout axis verifiable. E2 estimates within-task variance, repository clustering, timeout behavior, and task correlation. It searches every feasible `tasks × replicates × 3 arms` design and selects the fewest cells reaching 80% simulated power for the pre-declared approximately 21 percentage-point A-versus-B effect; ties prefer more repositories, then more tasks, then fewer replicates. The hard ceiling is 600 official cells. If the target is unattainable, E2 chooses the strongest design within the ceiling and seals the achieved MDE as a limitation. The secondary `(A ∪ B) versus C` manipulation check receives its own achieved sensitivity and never changes primary sizing. **The achieved MDE is sealed before the official run and printed in the report** — an underpowered null is reported as "we cannot detect effects smaller than X," never quietly reframed. All previews are logged with counts and timestamps.

### E3 — Adversarial method review (the pristine gate)
Red-team agents attack the frozen-draft method before lock: contamination/leakage, skill-content confounds (does the skill smuggle task hints?), harness/version drift between arms, grader validity, denominator games, stopping-rule ambiguity, and the prompt-injection surface in tasks. Every design/pre-lock **disposition** must close before lock; every blocker-candidate and hard-pre-lock item is terminal. A terminal disposition may carry a separately named post-run guard whose evidence cannot exist yet, but the exact check and any limitation sentence are frozen before dispatch. Checks that compare a chosen value with sealed Benchmark/Run bytes, or verify the E4 witness over the exact sealed Run digest, execute in a distinct **post-lock, pre-dispatch** gate: their design choice closes pre-lock, their equality/ordering guard must pass after sealing, and no official cell may dispatch while any such guard is pending or failed. Operator (Ritsu) signs the exact method-document and attack-register digests before lock. After results, every remaining item and guard closes so all 76 register entries are terminal with zero open/noted dispositions and zero pending guards. The closed register ships in the report bundle.

### E4 — Independently ordered pre-registration anchor
After P5 is green and before the first official dispatch, a benchmark-product adapter wraps the existing generic IPFS/ERC-8004 manifest anchor. It commits to the exact Run digest, method-summary digest, grader-program digest, and source commit; a read-back proves the external timestamp precedes the first official cell. This is an ordering witness, not the network publication path, and it does not widen `@jinn-network/evidence-publication`.

### E5 — Official run → report → publication handoff
Seal the Benchmark and Run with the selected content, Haiku/high-effort runtime identity, exact tasks, arms, replicates, randomization, timeouts, retry and exclusion rules, estimator, alpha, bootstrap seed, MDE, grader program, parser, task images, build/source digests, and rehearsal disclosures. Run all official cells in seeded interleaved blocks. Timeouts and post-dispatch agent failures are FAIL; only pre-dispatch infrastructure failures may receive one recorded retry under the same cell identity. Never replace a task or add cells after lock.

Produce and verify Matrix and Report records through the selected registry method. The full report states the Skill candidate minus CLAUDE.md baseline estimate, interval, exact alpha `0.0500`, and paired task count. If the manipulation check fails, label the primary comparison uninformative about delivery mechanism. Limitations include the dated departure from the motivating AGENTS.md comparison, respectful Vercel/Hacker News framing, the self-run venue, attested-only integrity tier, rehearsal counts, achieved MDE, contamination and content audit, conflict of interest, timeout/retry accounting, seed and estimator sensitivity, and every closed E3 limitation. Every derived asset passes the §8.1 checklist; compact cards, badges, and share copy remain number-free and link relatively to the full report.

An independent verifier receives a clean environment containing only the sealed bundle, exact canary/package artifacts, public keys, and one-command verifier. It recomputes every reported number, interval, count, digest, and displayed claim byte-for-byte without the builder worktree, private workspace state, or execution credentials. The terminal handoff packet carries the Benchmark, Run, Matrix, Report, bundle, method, grader, and preregistration digests; CID, transaction hash, external timestamp, source commit, package versions, and key identifiers; complete artifact/media-type inventory and retention dependencies; cold-recompute transcript; and remaining publication-only checks. It explicitly leaves author-source identity/name, report origin, signed Record Discovery adapter, static mirror, Explorer ingestion/UI, key custody, errata policy, and live `spec.jinn.network` dependency unresolved. No public URL or network-discovery claim is made in this program.

## Verification gates (in order, none skippable)

1. R1–R5 seam reports committed; issues filed.
2. P5 e2e green (glue done).
3. E2 power numbers declared; all E3 pre-lock dispositions closed; operator signs the exact method and register digests.
4. Lock (Benchmark/Run records sealed); all E3 sealed-record equality guards and the externally ordered E4 anchor verified before first dispatch.
5. Official run complete; `verifyMatrix` + `verifyReport` green; §8.1 checklist pass.
6. Cold recomputation exact; publication handoff packet complete; network publication explicitly deferred.

## Timeline (working estimate, not a promise)

Day 1: Stage-0 recon fans out. Days 2–10: P1→P2→P2b, P3a→P3b, and P4→P4b. Days 3–9 parallel: E1 draft, model suitability, E2 rehearsals, E3 red-team. Day ~10–12: P5 green → lock → ordering anchor → official run. Day ~12–14: report, verification, cold recomputation, publication handoff.

## Ownership

Agents: all recon, all engineering packets, red-team, report assembly, and cold recomputation. Operator: E1 frame decision, model-failure escalation, method sign-off at lock, ordering-anchor authorization, and acceptance of the handoff packet. Network publication approval belongs to the separate publication-path program. Program tracking: each packet is a GitHub issue; this document is the program spine.
