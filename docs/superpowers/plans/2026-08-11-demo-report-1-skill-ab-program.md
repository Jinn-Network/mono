# Demo Report #1 — Skill-Efficacy A/B: Scoping and Execution Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans per packet. Stage-0 recon packets each produce a seam report + a filed issue; each Stage-1 engineering packet then gets its own task-level implementation plan (superpowers:writing-plans) written by its implementer from that recon — this program plan deliberately does not fake line-level precision it does not have.

**Goal:** Complete the product's first demo report — a pre-registered, replicated A/B answering "does adding a skill improve agent performance on a fixed task class?" — through a sealed, deletion-portable, independently recomputed report bundle. Network publication is a separate design and implementation program.

**Architecture:** Two parallel streams converging on a lock: an engineering stream that completes the product's existing venue seams (no deviation, no demo-special pipeline), and a method stream that designs, red-teams, and pre-registers the eval. Nothing official runs until the glue e2e gate is green and the method survives adversarial review.

**Tech Stack:** `packages/benchmark-product` (product + venue), `packages/task-execution` (launchers, evaluator adapters), `packages/benchmarking` (interop, aggregate/method registry), container grading via the Docker runtime currently homed in `client/`.

## Global Constraints

- **Consumption contract holds** (benchmark-product design §3): public package exports only; no deep imports; no copied platform code; **no product-implemented statistics** — every number in the report comes from a named `BENCHMARKING_METHOD_REGISTRY` method.
- **No new record kinds; no tier-1–3 semantics changes.** Venue work generalizes registration/wiring through existing seams only.
- **§8.1 must-not-imply list** binds every report surface and derived asset; §7.1 self-run venue disclosure appears in the product and the report.
- **Previews are disclosed rehearsals** (§7.2): every preview is logged and disclosed in the official report's limitations.
- **Lock is real:** after the Run record seals, no method change, no task swap, no replicate top-up. If the method is wrong post-lock, the report closure is produced as-is with the flaw disclosed, or the run is abandoned with the abandonment disclosed — never silently redone. (One re-lock is permitted BEFORE any official cell has executed, disclosed in the report.)
- **Pristine bar, operationalized:** every criticism a hostile evals-community reader could raise must have either a design answer or an explicit limitation line. The red-team packet (E3) enforces this; its findings register is part of the report bundle.
- **No rename dependency:** the report ships under the current working brand; naming is a separate decision (operator-gated) and blocks nothing here.
- **Publication boundary (operator decision, 2026-08-12):** this program emits sealed Benchmark, Run, Matrix, and Report records, a locally immutable report bundle, cold-recompute evidence, and a publication handoff packet. It does **not** choose a public report origin, create a Record Discovery source, operate a mirror, add Explorer views, or claim the report is published. Those choices require their own design session.
- **Official cell ceiling (operator decision, 2026-08-12):** E2 selects the smallest defensible three-arm design that reaches 80% simulated power for the approximately 21 percentage-point A-versus-B target. The hard maximum is 600 official cells. The program never silently enlarges the run; if the target is unattainable, it seals and reports the strongest achieved sensitivity within the ceiling.
- **Model suitability gate (operator decision, 2026-08-12):** test `claude-haiku-4-5-20251001` at `high` effort on six disposable, distinct-repository, true-no-instruction tasks with two replicates each before any arm-effect rehearsal. The twelve cells are excluded from the E2 and official pools. Passing requires all cells accounted, at least ten valid grader outcomes, no model/authentication/launcher incompatibility, at most two timeout FAILs, and between two and ten passes inclusive. One recorded retry is allowed only for a pre-dispatch infrastructure failure. Failure or an inconclusive gate stops for operator review; there is no automatic Sonnet fallback.
- **Report copy (operator decision, 2026-08-12):** the full report states the candidate-minus-baseline estimate, interval, exact alpha `0.0500`, and paired task count. Badges, social cards, and share copy remain result-number-free and link relatively to the full report.

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

Dependency order: **P1 → P2 → P3 → P5**, with **P4** parallel after R4. Each packet: own `feat` issue, TDD, PR to the integration branch, reviewed per repo rules (no self-merge). Each implementer writes their task-level plan from the recon report before coding.

- **P1 — Venue generalization.** Non-prediction task profiles register and quote through the product venue. Gate: existing prediction sample byte-stable; new profile family admitted end-to-end in a kit test.
- **P2 — Launcher arm wiring.** claude-code launcher runs as a venue arm with enforced pinning on model / skill-load / effort / version axes. Gate: two byte-identical-except-skill arms lock and dispatch; pinning verification reports `match` per axis.
- **P3 — Container-grading bridge.** Venue evaluation legs execute swe-rebench container grading via the bridge port. Gate: a real graded verdict flows from container → adapter → sealed verdict → Matrix cell.
- **P4 — Paired-comparison registry method** (if R4 confirms absent). Gate: method registered + versioned in `benchmarking-aggregate` with its own tests; `produceReport`/`verifyReport` round-trip.
- **P5 — End-to-end gate (the "glue done" bar).** A 2-arm × N-replicate micro-benchmark (2–3 tasks) runs draft→quote→lock→launch→collect→report→verify on the local venue with container grading, all cells accounted, `verify` green, zero manual intervention. **No official demo run before P5 is green.**

## Stage 2 — Method stream (parallel with Stage 1; method work, not code)

### E1 — Comparison framing + skill selection
The frame is **mechanism vs mechanism, not vendor vs vendor** — the live public argument is "AGENTS.md-style flat instructions vs skills," so the comparison is: *same agent, same tasks; arm A = instruction content delivered as a skill; arm B = byte-identical instruction content delivered as flat AGENTS.md; arm C = neither, as the manipulation baseline.* No third-party author is graded; the delivery mechanism is what is measured.

Before the first preview, pin the exact `anthropics/skills` source commit and inventory every candidate folder. Exclude the four source-available document skills and any candidate without a compatible per-folder license, upstream description, standalone usable instructions, or a sufficiently large grader-valid repository-work pool. Rank the survivors by the number of eligible tasks established without model execution, breaking ties lexicographically by repository path. Freeze the winner, full candidate list, rejection reasons, license, source bytes, deterministic transform, and all digests. If no candidate can support repository-disjoint suitability, rehearsal, and official pools, stop with the inventory; do not author replacement content or silently change sources.

Task eligibility is outcome-blind: verified image digest, gold-pass/empty-fail behavior in the real grader, compatible license posture, no instruction leakage, no pre-existing conflicting instruction file, and no content/gold-patch collision. Task selection, replicate scheduling, and interleaving use SHA-256-derived seeds recorded as resolved integers before lock.

### E2 — Power analysis from rehearsal variance
After the Haiku suitability gate passes, a disclosed rehearsal uses ten tasks from at least five repositories, five replicates, arms A/B/true-no-file C, plus an empty-loadout C condition. The rehearsal pool is repository-disjoint from both suitability and official pools. Empty-loadout C may replace true-no-file C only if loader behavior and model-visible context are structurally indistinguishable and the paired outcome interval is wholly within ±10 percentage points; otherwise the official design uses true no-file and marks its loadout axis unverifiable. E2 estimates within-task variance, repository clustering, timeout behavior, and task correlation. It searches every feasible `tasks × replicates × 3 arms` design and selects the fewest cells reaching 80% simulated power for the pre-declared approximately 21 percentage-point A-versus-B effect; ties prefer more repositories, then more tasks, then fewer replicates. The hard ceiling is 600 official cells. If the target is unattainable, E2 chooses the strongest design within the ceiling and seals the achieved MDE as a limitation. The secondary `(A ∪ B) versus C` manipulation check receives its own achieved sensitivity and never changes primary sizing. **The achieved MDE is sealed before the official run and printed in the report** — an underpowered null is reported as "we cannot detect effects smaller than X," never quietly reframed. All previews are logged with counts and timestamps.

### E3 — Adversarial method review (the pristine gate)
Red-team agents attack the frozen-draft method before lock: contamination/leakage, skill-content confounds (does the skill smuggle task hints?), harness/version drift between arms, grader validity, denominator games, stopping-rule ambiguity, and the prompt-injection surface in tasks. Every design/pre-lock item must close before lock; every blocker-candidate and hard-pre-lock item is terminal. Items that depend on results freeze their exact limitation sentence and post-run check before dispatch. Operator (Ritsu) signs the exact method-document and attack-register digests before lock. After results, every remaining item closes so all 76 register entries are terminal with zero open or noted statuses. The closed register ships in the report bundle.

### E4 — Independently ordered pre-registration anchor
After P5 is green and before the first official dispatch, a benchmark-product adapter wraps the existing generic IPFS/ERC-8004 manifest anchor. It commits to the exact Run digest, method-summary digest, grader-program digest, and source commit; a read-back proves the external timestamp precedes the first official cell. This is an ordering witness, not the network publication path, and it does not widen `@jinn-network/evidence-publication`.

### E5 — Official run → report → publication handoff
Seal the Benchmark and Run with the selected content, Haiku/high-effort runtime identity, exact tasks, arms, replicates, randomization, timeouts, retry and exclusion rules, estimator, alpha, bootstrap seed, MDE, grader program, parser, task images, build/source digests, and rehearsal disclosures. Run all official cells in seeded interleaved blocks. Timeouts and post-dispatch agent failures are FAIL; only pre-dispatch infrastructure failures may receive one recorded retry under the same cell identity. Never replace a task or add cells after lock.

Produce and verify Matrix and Report records through the selected registry method. The full report states the Skill candidate minus AGENTS.md baseline estimate, interval, exact alpha `0.0500`, and paired task count. If the manipulation check fails, label the primary comparison uninformative about delivery mechanism. Limitations include respectful Vercel/Hacker News framing, the self-run venue, attested-only integrity tier, rehearsal counts, achieved MDE, contamination and content audit, conflict of interest, timeout/retry accounting, seed and estimator sensitivity, and every closed E3 limitation. Every derived asset passes the §8.1 checklist; compact cards, badges, and share copy remain number-free and link relatively to the full report.

An independent verifier receives a clean environment containing only the sealed bundle, exact canary/package artifacts, public keys, and one-command verifier. It recomputes every reported number, interval, count, digest, and displayed claim byte-for-byte without the builder worktree, private workspace state, or execution credentials. The terminal handoff packet carries the Benchmark, Run, Matrix, Report, bundle, method, grader, and preregistration digests; CID, transaction hash, external timestamp, source commit, package versions, and key identifiers; complete artifact/media-type inventory and retention dependencies; cold-recompute transcript; and remaining publication-only checks. It explicitly leaves author-source identity/name, report origin, signed Record Discovery adapter, static mirror, Explorer ingestion/UI, key custody, errata policy, and live `spec.jinn.network` dependency unresolved. No public URL or network-discovery claim is made in this program.

## Verification gates (in order, none skippable)

1. R1–R5 seam reports committed; issues filed.
2. P5 e2e green (glue done).
3. E2 power numbers declared; E3 red-team register closed; operator method sign-off.
4. Lock (Run record sealed) and externally ordered E4 anchor verified before first dispatch.
5. Official run complete; `verifyMatrix` + `verifyReport` green; §8.1 checklist pass.
6. Cold recomputation exact; publication handoff packet complete; network publication explicitly deferred.

## Timeline (working estimate, not a promise)

Day 1: Stage-0 recon fans out. Days 2–10: P1→P2→P3 (+P4). Days 3–9 parallel: E1 draft, model suitability, E2 rehearsals, E3 red-team. Day ~10–12: P5 green → lock → ordering anchor → official run. Day ~12–14: report, verification, cold recomputation, publication handoff.

## Ownership

Agents: all recon, all engineering packets, red-team, report assembly, and cold recomputation. Operator: E1 frame decision, model-failure escalation, method sign-off at lock, ordering-anchor authorization, and acceptance of the handoff packet. Network publication approval belongs to the separate publication-path program. Program tracking: each packet is a GitHub issue; this document is the program spine.
