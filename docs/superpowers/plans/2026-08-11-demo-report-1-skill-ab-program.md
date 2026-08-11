# Demo Report #1 — Skill-Efficacy A/B: Scoping and Execution Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans per packet. Stage-0 recon packets each produce a seam report + a filed issue; each Stage-1 engineering packet then gets its own task-level implementation plan (superpowers:writing-plans) written by its implementer from that recon — this program plan deliberately does not fake line-level precision it does not have.

**Goal:** Publish the product's first demo report — a pre-registered, replicated A/B answering "does adding a skill improve agent performance on a fixed task class?" — through the real product machinery, to a standard the evals community cannot fault on method.

**Architecture:** Two parallel streams converging on a lock: an engineering stream that completes the product's existing venue seams (no deviation, no demo-special pipeline), and a method stream that designs, red-teams, and pre-registers the eval. Nothing official runs until the glue e2e gate is green and the method survives adversarial review.

**Tech Stack:** `packages/benchmark-product` (product + venue), `packages/task-execution` (launchers, evaluator adapters), `packages/benchmarking` (interop, aggregate/method registry), container grading via the Docker runtime currently homed in `client/`.

## Global Constraints

- **Consumption contract holds** (benchmark-product design §3): public package exports only; no deep imports; no copied platform code; **no product-implemented statistics** — every number in the report comes from a named `BENCHMARKING_METHOD_REGISTRY` method.
- **No new record kinds; no tier-1–3 semantics changes.** Venue work generalizes registration/wiring through existing seams only.
- **§8.1 must-not-imply list** binds every report surface and derived asset; §7.1 self-run venue disclosure appears in the product and the report.
- **Previews are disclosed rehearsals** (§7.2): every preview is logged and disclosed in the official report's limitations.
- **Lock is real:** after the Run record seals, no method change, no task swap, no replicate top-up. If the method is wrong post-lock, the run publishes as-is with the flaw disclosed, or is abandoned with the abandonment disclosed — never silently redone. (One re-lock is permitted BEFORE any official cell has executed, disclosed in the report.)
- **Pristine bar, operationalized:** every criticism a hostile evals-community reader could raise must have either a design answer or an explicit limitation line. The red-team packet (E3) enforces this; its findings register is part of the report bundle.
- **No rename dependency:** the report ships under the current working brand; naming is a separate decision (operator-gated) and blocks nothing here.

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
Recommended frame: **mechanism vs mechanism, not vendor vs vendor** — the live public argument is "AGENTS.md-style flat instructions vs skills," so the cleanest low-blast design is: *same agent, same tasks; arm A = instruction content delivered as a skill; arm B = identical content delivered as flat AGENTS.md; (arm C = neither, as baseline).* No third-party author gets embarrassed; the mechanism is what's measured. Alternative (higher pull, higher blast): a widely-used public skill on/off. Decision recorded in the method doc with the blast rationale. Content of the instruction material must be public and licensed.

### E2 — Power analysis from rehearsal variance
Disclosed previews (§7.2) estimate per-task run-to-run variance → choose replicates N and slate size so the design detects a pre-declared minimum effect (e.g. Δ pass-rate ≥ X points) with the registry method's interval. **The MDE is declared before the official run and printed in the report** — an underpowered null must be reportable as "we cannot detect effects smaller than X," never quietly reframed. All previews logged; count + timestamps disclosed.

### E3 — Adversarial method review (the pristine gate)
Red-team agents attack the frozen-draft method before lock: contamination/leakage, skill-content confounds (does the skill smuggle task hints?), harness/version drift between arms, grader validity, denominator games, stopping-rule ambiguity, prompt-injection surface in tasks. Every finding → fix or explicit limitation. The findings register ships in the report bundle. Operator (Ritsu) signs the method before lock.

### E4 — Public pre-registration (recommended, operator's call)
Before the official run: publish the locked method summary + Run record digest publicly and invite critique. The registered-report move — maximal credibility, and the pre-registration *is* content for the ecosystem-embedding channel. Risk: public commitment to a run that could hit infra trouble; mitigated by P5 being green first and by honest `runOutcome` accounting if trouble happens anyway.

### E5 — Official run → report → publication
Official run on the merged product (canary). Report via the registry method; limitations include: self-run venue disclosure, preview/rehearsal disclosure, MDE, contamination note, red-team register reference. §8.1 checklist pass on report + every derived asset. Claim package published on the public surface; cold-DM wave opens against it.

## Verification gates (in order, none skippable)

1. R1–R5 seam reports committed; issues filed.
2. P5 e2e green (glue done).
3. E2 power numbers declared; E3 red-team register closed; operator method sign-off.
4. Lock (Run record sealed). Public pre-registration if E4 approved.
5. Official run complete; `verifyMatrix` + `verifyReport` green; §8.1 checklist pass.
6. Publication.

## Timeline (working estimate, not a promise)

Day 1: Stage-0 recon fans out. Days 2–10: P1→P2→P3 (+P4). Days 3–9 parallel: E1 draft, E2 previews (on P5's micro-slate as soon as P1/P2 land), E3 red-team. Day ~10–12: P5 green → lock → (pre-registration) → official run. Day ~12–14: report, verification, publication.

## Ownership

Agents: all recon, all engineering packets, red-team, report assembly. Operator: E1 frame decision, method sign-off at lock, E4 call, publication approval. Program tracking: each packet is a GitHub issue; this document is the program spine.
