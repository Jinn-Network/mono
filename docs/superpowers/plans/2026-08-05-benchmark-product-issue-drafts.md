# Standalone Benchmarking Product — Draft Issue Bodies (M0/M1)

Companion to `2026-08-05-standalone-benchmarking-product-program.md` §7. This
session has no issue-mutation authority; these drafts are triage-complete so an
authorized session can file them verbatim. One draft per work packet. Issue
Type = the work shape. All issues depend on the `integration/evidence-v1`
lineage (NOT `next`); the required base is stated per issue. Drafts frame
problems and acceptance; implementation choices live in the program plan and
the product design spec, cited rather than restated. M2–M5 drafts are appended
at their wave boundaries.

---

## Draft 1 — BP-00 · `design` · Product design spec for the standalone benchmarking product

**Context.** The Tier 2/3 benchmarking platform is implemented
(`@jinn-network/benchmarking-*`), and its design explicitly reserves the
product layer for Tier 4 (application design §2, §17.4; plan line "the
composing CLI is a tier-4 product (OUT)"). A separately branded product
charter (v0.2, 2026-08-05) fixes customer, scope, and posture. No catalog
authority document exists for a benchmarking product package.

**Impact.** Without a dated design spec there is no authority document for the
catalog entry, and product decisions live only in session context.

**Acceptance criteria (binary).**
- [ ] `docs/superpowers/specs/2026-08-05-benchmark-product-design.md` exists,
      header-complete per spec conventions, status `draft`.
- [ ] States the consumption contract (exact platform packages + verified
      exports; no deep imports; no record redefinition; no `core`/`sdk`).
- [ ] Defines the product state machine, audit journal, and two-surface
      (library+CLI / GUI) parity commitment.
- [ ] Carries the assurance-preset → platform-primitive mapping and the venue
      honesty tables.
- [ ] Proposes no tier 1–3 change, record kind, or protocol amendment.

**Dependencies / base.** `integration/evidence-v1` ≥ `ad33f1d0d`.

**Non-goals.** No implementation, no catalog edit, no branding decisions
beyond the placeholder posture.

---

## Draft 2 — BP-01 · `feat` · Register and scaffold `packages/benchmark-product/core`

**Context.** The product needs a Tier 4 tree registered in
`architecture/platform-packages.v1.json` with the standard guard trio and its
own CI gate before any domain code lands (guards ship with packages, not
after — platform architecture §3).

**Impact.** Without registration + guards, product code would sit outside the
executable architecture and could silently violate the tier boundary.

**Acceptance criteria (binary).**
- [ ] `packages/benchmark-product/core` builds: `yarn install --immutable &&
      yarn typecheck && yarn test && yarn build && yarn pack:smoke` all green.
- [ ] Catalog entry (tier 4, product, experimental, transitional-or-private,
      publishPolicy never) added; release-group `expectedPackageCount` bumped;
      gate `benchmark-product-ci` defined and workflow present.
- [ ] `node .github/scripts/generate-architecture.mjs --check` green;
      platform-catalog + architecture-control `node --test` suites green.
- [ ] `.github/scripts/benchmark-product-{package-inventory,source-boundaries,packed-types}.test.mjs`
      exist and pass; the source-boundary guard is allow-list style with
      positive controls (imports actually exercised).
- [ ] Nothing under tiers 1–3 references the new tree.

**Dependencies / base.** Draft 1 (spec is the authority document). Base:
integration head after BP-00.

**Non-goals.** No domain logic, no CLI verbs beyond a version stub, no web
app, no publishing.

---

## Draft 3 — BP-10 · `feat` · Product workspace, draft model, lifecycle, audit journal, authority v1

**Context.** The product owns mutable drafts and previews; the platform owns
sealed records (charter §11). Nothing implements a draft/lock/run product
state machine today (verified 2026-08-05: no lock/preview/assurance-preset
code in the repo).

**Impact.** This is the single state machine both surfaces (agent CLI, later
GUI) must share; without it every later packet has no spine.

**Acceptance criteria (binary).**
- [ ] File-based workspace with atomic writes; mutable draft documents
      (task-set ref, arms, evaluation choice, assurance preset, policy,
      budget) validated with typed errors.
- [ ] Lifecycle: draft → quoted → locked → running → closed → reported, with
      preview as a non-contaminating side path; illegal transitions rejected.
- [ ] Append-only JSONL audit journal; every consequential operation appends
      an attributed entry (principal, action, input digest, outcome).
- [ ] Authority v1: named principals (sponsor, delegated agent), per-operation
      approval policy enforced at the operations boundary; honest scope note
      that v1 is local-process policy, not hosted multi-tenant auth.
- [ ] TDD evidence: failing tests precede implementation in packet history.

**Dependencies / base.** Draft 2. **Non-goals.** No execution, no GUI, no
network, no SQLite.

---

## Draft 4 — BP-11 · `feat` · Task intake: bundled sample, SWE-bench-shaped import, arm definition

**Context.** The charter journey starts "sample or import" (§7). The platform
provides `importSweBench` / `defineBenchmark` / `importInspectEvals`
(`benchmarking-interop`) and sealed Task + EvaluationSpec machinery; the
product owns the intake journey.

**Acceptance criteria (binary).**
- [ ] From an empty workspace, a bundled sample produces a draft with a sealed
      Benchmark (≥ 2 items) and ≥ 2 arms without network access.
- [ ] SWE-bench-shaped rows import to a sealed Benchmark via public interop
      exports only.
- [ ] Arm definition accepts the profiles run-pinning vocabulary; an
      `inspect` operation shows the exact pinning per arm and the evaluation
      digest per task.
- [ ] Invalid intake (duplicate items, missing evaluation) fails with typed
      errors mapping to the platform's named checks.

**Dependencies / base.** Draft 3. **Non-goals.** No task authoring studio; no
Inspect-solver sealing beyond what interop supports; no marketplace posting.

---

## Draft 5 — BP-12 · `feat` · Official run path on the local venue: lock, launch, watch, assemble, account

**Context.** Lock = sealing the Run record (identity is pre-registration —
application design §7.2). The platform provides `planRun`, `quoteRun`,
`launchAndWatch`, `assembleMatrix`, `localAssemblyPorts`;
`policy-optimization/src/execute.ts` is the composition precedent.

**Acceptance criteria (binary).**
- [ ] Lock seals the Run and refuses further draft mutation of that run.
- [ ] A real 2-arm run executes end-to-end on the local execution backend
      (real launcher, no mocks presented as production behavior).
- [ ] The Matrix accounts every expected cell; results JSON surfaces all six
      outcome states, attrition, completeness, and per-cell digests.
- [ ] Interruption resumes (cell idempotency); the run never restarts silently.
- [ ] Venue honesty: the local run's guarantee limits (no pre-registration
      proof against the owner) appear in the machine-readable results.

**Dependencies / base.** Drafts 3, 4. **Non-goals.** No marketplace venue; no
report production; no cancellation UX (M2 depth).

---

## Draft 6 — BP-13 · `feat` · Report production, claim package, and the skeptic's verify

**Context.** `produceReport`/`verifyReport` (aggregate) and `verifyMatrix`
(run) exist as library functions; their composition is explicitly reserved for
Tier 4. The durable output is a distribution-ready claim package (charter §2).

**Acceptance criteria (binary).**
- [ ] A sealed, DSSE-signed Report is produced from the Matrix via the
      registered method registry; `disclosures` carried whole.
- [ ] A machine-readable claim package links report/matrix/run/benchmark
      digests, preserves scope + limitations, and never hides missing cells,
      conflicts, or adverse results.
- [ ] `verify` composes matrix re-derivation + report recompute + signature
      verification; exits nonzero naming the failed check on any tampering.
- [ ] Dissenting verdicts remain visible in report + claim package.

**Dependencies / base.** Draft 5. **Non-goals.** No HTML report surface (M4);
no badges/share assets (M4); no publication hosting.

---

## Draft 7 — BP-14 · `test` · Agent-surface CLI end-to-end walking skeleton

**Context.** Agent-native parity is a fixed decision: the CLI (with `--json`
everywhere) is the complete agent surface for M1; a cold agent must complete
sample → arms → evaluation → lock → run → results → report → verify without a
GUI.

**Acceptance criteria (binary).**
- [ ] One scripted e2e drives the full lifecycle through CLI verbs only, all
      outputs machine-readable, and passes in CI.
- [ ] At least one recorded run used a real launcher on the local backend;
      its artifacts are preserved as evidence.
- [ ] Every operation available in the library is reachable via a CLI verb
      (asserted by a coverage test), and no CLI verb bypasses the operations
      boundary.
- [ ] Typed error envelopes on every failure path exercised by the e2e.

**Dependencies / base.** Drafts 3–6. **Non-goals.** No GUI, no MCP, no
performance tuning.
