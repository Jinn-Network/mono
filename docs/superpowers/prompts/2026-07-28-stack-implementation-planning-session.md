# Session prompt: stack stocktake, planning, and full implementation (workflow-orchestrated)

Copy everything below the line into a fresh Claude Code session running on **Fable** (the
coordinator model). The session uses multi-agent workflows; model tiering for all delegated
work is part of the brief.

---

You are coordinating the **stocktake, implementation planning, and full implementation** of the
Jinn protocol stack: everything that is designed but not yet implemented. The session runs the
whole arc — inventory → reconciliation → plans → my approval of the program → phased
implementation to green, working, reviewed code. One approval gate before code starts; after
that you run phases autonomously and report at phase boundaries.

**I explicitly opt in to multi-agent workflow orchestration for this session, for both the
planning and the implementation.** You (Fable) are the coordinating agent: you own all
conclusions, synthesis, sequencing decisions, and everything presented to me. All delegated
execution uses cheaper models:

- **opus** — reading/inventory lanes, plan drafting, plan reviews, and **code review** of every
  implementation unit (high effort for reviews);
- **sonnet** — all code implementation;
- **haiku** — mechanical work only (file-existence checks, link checks, greps, CI-guard list
  edits, table cross-checks).

Never paste subagent reports at me; reconcile and speak in your own voice. During planning,
when a material decision is mine, ask **one question at a time** with context and implications.
During implementation, do not stop to ask about anything a design or plan already settles;
stop only for genuine blockers or design contradictions. Surface conflicts between approved
documents as findings — never silently resolve them.

## Ground truth and where everything lives

Work from a **new git worktree** cut from `origin/integration/evidence-v1` (head `3650ac65e`
or later; branch `claude/stack-implementation`). That branch is the integration point: the
complete evidence substrate is merged there (38 PRs, 11 packages under `packages/evidence/`)
and all design documents are present on it. All work targets `integration/evidence-v1`, not
`next`; a single merge PR promotes to `next` at the end (see
`docs/superpowers/specs/2026-07-27-evidence-application-layer-index.md` §5). Read `CLAUDE.md`
and `docs/engineering/handbook.md` first. Use `superpowers:writing-plans` for plans and
`superpowers:test-driven-development` discipline for code; conformance kits and fixtures come
before the implementations they test, everywhere.

## The stack, current status by layer

Read the referenced documents before planning. All paths are on the worktree.

**Implemented (consume, do not re-plan):**
- Evidence substrate — `packages/evidence/*`. Architecture:
  `docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md`. The packaged profile is
  authoritative over the protocol design doc where they differ.

**Designed with existing implementation plans (validate; amend where the stack designs changed
the picture; then implement):**
- Three evidence application capabilities — designs
  `docs/superpowers/specs/2026-07-26-{execution-evidence-capture, evidence-retrieval,
  evidence-contribution}-design.md`, plans under `docs/superpowers/plans/2026-07-27-*`, index
  `docs/superpowers/specs/2026-07-27-evidence-application-layer-index.md`.

**The Evaluation Runner is NOT a fourth capability to implement — do not build it.** Its
design's host-orchestration half (durable jobs, leases, checkpoint store, recovery ladder,
`EvaluationReceiptV1`, its event vocabulary, the execution-provider abstraction) is
**superseded** by the Local Execution Backend, which does all of that generically (backend
design §10.4 and §17 hold the exact disposition). Implementing any of it again is forbidden
duplication. What is implemented instead, as a work item **inside the local-backend phase**:
the evaluator-adapter contract and registration types (its design §10/§11), and a thin
**evaluation harness** — launcher-invokable, running an evaluation-profile Task as an ordinary
attempt: materials come pre-verified from the workspace `input/` (the provisioner replaces the
runner's material resolver), the registered adapter runs, the already-implemented
`attestation-issuer` package signs the Result Evaluation, and the signed Statement lands in
`out/` as the Delivery payload. Recovery, cancellation, idempotency, and receipts are all
inherited from the backend. Session deliverables: supersede (not amend) the old
evaluation-runner plan with a note pointing at the replacement work item, amend the design's
status header per the backend design's disposition, and reconcile the application-layer index
entry.

**Designed, no implementation plans — plan AND implement here (the core of the program):**
- `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (TEP) —
  `task-execution/{protocol, backend, testing}`; the conformance kit precedes all bindings.
- `docs/superpowers/specs/2026-07-27-task-profiles-and-evaluation-specs-design.md` —
  profiles package; evaluation-as-task.
- `docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md` —
  `trust/{core, resolve, testing}`; sealing re-implemented per package with cross-package
  equivalence fixtures (the established precedent).
- `docs/superpowers/specs/2026-07-27-record-discovery-protocol-design.md` —
  `discovery/{protocol, serve, client, testing}` + `discovery/facts/*` leaves; the evidence
  discovery contracts conform under the pinned projection in its §11. (The marketplace
  projector — "projector #1" — waits on the marketplace-binding design; implement the
  protocol/serve/client/kit and the published-source wrapper for the evidence journal.)
- `docs/superpowers/specs/2026-07-27-local-execution-backend-design.md` —
  `task-execution/backend-local/{supervisor, workspace, launchers, assembly}`; internal
  sequence per its §18 (supervisor+kit → workspace+launchers → assembly+TEP-kit-green →
  Autopilot adoption); Autopilot is the first adopter. The daemon engine carve waits on the
  marketplace-binding design — out of scope.

**Not designed — do NOT plan or implement; record as pending design sessions:**
- Marketplace binding (chain/mech translation, projector #1, daemon TaskEngine carve).
- Benchmarking application.
- Migration-mechanics specs for daemon/Autopilot cutovers beyond what the Autopilot adoption
  in the local-backend design explicitly covers.

## Rules the program must respect

1. Dependency direction is frozen: applications → discovery → TEP + Evidence → trust. Record
   protocols never import discovery; the backend imports evidence *contracts* only (bindings
   injected by hosts); `discovery/facts/*` leaves are the only place a discovery edge and a
   record-kind edge meet. Kits precede implementations; a layer's kit must be green before
   dependents build on it.
2. Package scope names across the five stack designs are **working titles** — settle final
   names during planning (one naming pass; one question to me if genuinely open), then use
   them consistently everywhere.
3. New package trees need the same executable-architecture guards the evidence tree has
   (inventory/source-boundary/packed-types scripts + CI workflow, per
   `docs/superpowers/specs/2026-07-25-evidence-layer-architecture.md` §5) — plan and build
   the guard wiring with the packages, not after.
4. Designs are law. A planning- or implementation-time discovery that a design is wrong or
   ambiguous is a **finding surfaced to me** with a proposed disposition — never a silent
   patch. Small clarifications may be recorded as dated addendum notes in the plan documents.
5. Review discipline — **per design, not per unit** (per-unit review would drown the token
   budget): when a component's implementation is complete, one independent opus review
   (high effort) checks the whole component against its design document — design conformance,
   correctness, and an adversarial pass over its frozen interfaces — and its findings are
   fixed before dependents build on it. One **overall program review** runs at the end across
   the integrated whole. Between those, correctness is carried by the automated gates of
   rule 6 (tests, kits, guards — cheap, not model reviews). I review at phase boundaries,
   not per PR. Nothing merges to `integration/evidence-v1` without my explicit approval.
6. Verification before completion, every unit: typecheck, tests, the relevant conformance
   kit, and the CI guards — evidence-style, run locally. Never report a phase done without
   the outputs to show for it.
7. Stack-wide notes to absorb: the UTF-16 canonical string-ordering rule (evidence PR #2226)
   applies wherever sealed bytes are produced; the TEP `capacity-exhausted` error-category
   question and media-type/IANA registration are recorded follow-ups, not blockers.

## Program shape (adapt as the material demands)

**Phase 0 — inventory and reconciliation** (opus lanes; haiku cross-checks): per-layer lanes
reading design + plan + code, extracting deliverables, dependency edges, existing-plan
validity, follow-ups. Reconcile into a dependency DAG, a status table, and the critical path.
Present; take my questions.

**Phase 1 — plans** (opus drafts; opus reviews): per-component implementation plans under
`docs/superpowers/plans/2026-07-28-*`, the three evaluation-runner amendments, and a master
program document (`docs/superpowers/plans/2026-07-28-stack-implementation-program.md`) with
sequencing, PR-train structure, review/verification gates, and the model policy. Architecture
+ feasibility reviews; resolve blockers. **Present the program to me for approval. Code starts
only on my explicit yes.**

**Phase 2..N — implementation** (sonnet builds; opus reviews per completed design, per rule 5;
haiku mechanical), in dependency
order — the DAG will refine this, but the expected shape is: TEP protocol + kit alongside
trust core; then profiles; then discovery protocol/serve/client + facts leaves + the evidence
journal published-source wrapper; then the local backend in its §18 order through
assembly-with-TEP-kit-green, **including the evaluation harness** (adapter contract +
attestation-issuer composition — see the Evaluation Runner disposition above; no standalone
runner package exists); then the three evidence applications; then Autopilot adoption. Each
phase ends with all
tests/kits/guards green on the session branch, the completed components' design reviews done
and their findings resolved, and a phase report to me: what shipped, review findings and
dispositions, anything surfaced for my decision.

**Final** — everything green on the session branch, the **overall program review** (opus, high
effort: cross-component integration, dependency-rule conformance, anything the per-design
reviews couldn't see), a full-program verification pass, and a single summary with the merge
proposal for `integration/evidence-v1`. I do the final gate.

Begin with Phase 0.
