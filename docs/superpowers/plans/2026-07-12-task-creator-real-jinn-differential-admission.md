# Task Creator Real Jinn Differential Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require and preserve repeated per-test-path causal evidence before an explicit-recipe public-repository commit echo can be admitted, then prove it with Jinn PR #1458's real test-bearing head.

**Architecture:** A new differential admission module owns canonical policy, receipts, path targeting, and receipt verification.  Harvesting creates a receipt from four Docker observations per test path and refuses legacy evidence; minted rows retain a receipt commitment; evaluator routing verifies that commitment before grading.  Existing v1 rows and all generator/economic behavior remain unchanged.

**Tech Stack:** TypeScript, Zod schemas, Vitest, Docker/Buildx evaluator images, IPFS artifacts, EIP-191 environment attestations, Hardhat/Anvil.

## Global Constraints

- The G0b public-repository substrate and Task Creator v0 designs remain authoritative; this work is an evidence-hardening amendment.
- `EVAL_SEMANTICS_VERSION` remains exactly `4`.
- `DifferentialAdmissionPolicyV2` requires exactly two broken and two fixed observations per executable test path, equal output within each side, at least one F2P per path, and globally unique raw assertion IDs.
- `DifferentialAdmissionReceiptV2` binds repo/base/fix, `goldPatchHash` only, `testPatchHash`, normalized paths, command hashes, observations, stable F2P/P2P, image/environment/parser/semantics, and `admissionPolicyVersion`.
- Hardened G0b admission never reuses V1 empirical evidence.  A mismatch, instability, missing F2P, duplicate ID, or non-discrimination quarantines; unsupported multi-template recipes become `awaiting_input`.
- Targeted commands accept repository-relative paths only: absolute, traversal, workspace-escaping, and unsafe command paths are rejected.
- The real Jinn source is base `ae8093a8848e70e581f46d66dcdb56789c0808a3`, fix `ef9608876511b4dff000cda1537ff7c1a227677d`, instance `Jinn-Network__mono__echo-ef9608876511`.
- Never check in a hand-authored or synthetic differential receipt.  A receipt is committed only after the Docker matrix writes and validates it from the pinned source.
- Do not change generator selection, synthetic quota, escrow, claim policy, task construction, posting, RepoLaunch, ALE, or evaluator grading semantics.
- Every behavior change follows TDD: record the focused failing test before production code, then re-run it green.

---

### Task 1: Differential receipt contract and targeted execution

**Files:**
- Create: `client/src/solver-types/_swe-rebench-v2-differential-admission.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-empirical-tests.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-harvest-state.ts`
- Test: `client/test/solver-types/swe-rebench-v2-differential-admission.test.ts`
- Test: `client/test/solver-types/swe-rebench-v2-empirical-tests.test.ts`

**Interfaces:**
- Produces `DifferentialAdmissionPolicyV2`, `DifferentialAdmissionReceiptV2`, `createDifferentialAdmissionReceiptV2`, `verifyDifferentialAdmissionReceiptV2`, and `targetRecipeCommandForTestPath`.
- Consumes trusted parser observation values and `TaskEnvironmentSpecV1`; later tasks consume the receipt verifier and canonical receipt hash.

- [ ] **Step 1: Write failing policy tests**

Add tests that create two equal observations for each broken/fixed side and assert a receipt contains command hashes and stable F2P/P2P.  Add one test each for unstable output, a path with no F2P, duplicate raw IDs across paths, and unsafe `../`, absolute, or workspace-escaping target paths.

- [ ] **Step 2: Run the focused tests red**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-differential-admission.test.ts`

Expected: the missing differential module or symbols cause the new tests to fail.

- [ ] **Step 3: Implement the smallest canonical contract**

Implement strict Zod schemas and canonical JSON hashing.  Model each side as an array of two parser observations; compare stable canonical forms; derive F2P/P2P from the stable observation; reject a raw identifier repeated by another path.  Produce only a gold patch hash, never gold contents.  Normalize a repo-relative path, remove the recipe workspace prefix, and append precisely one safe path argument to the sole targetable command template.

- [ ] **Step 4: Extend empirical execution with targeted runner support**

Expose a helper that receives a normalized path and runs the broken/fixed matrix twice with that path's command, returning raw observations needed by the receipt.  Leave the legacy one-before/one-after function behavior intact for v1 callers.

- [ ] **Step 5: Run focused tests green and commit**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-differential-admission.test.ts test/solver-types/swe-rebench-v2-empirical-tests.test.ts`

Expected: all tests pass.  Commit only the contract, runner support, and focused tests with `feat(task-creator): add differential admission receipts`.

### Task 2: Enforce hardened evidence through harvest, v2 pool, and evaluator

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-harvest.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-harvest-state.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-minted-pool.ts`
- Modify: `client/src/solver-types/_swe-rebench-v2-validated-pool.ts`
- Modify: `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts`
- Test: `client/test/solver-types/swe-rebench-v2-harvest.test.ts`
- Test: `client/test/solver-types/swe-rebench-v2-minted-pool.test.ts`
- Test: `client/test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`

**Interfaces:**
- Consumes Task 1 receipt schema and verifier.
- Produces v2 rows and vetted entries with a receipt CID/hash binding; evaluator rejects receipt, row, environment, parser, or semantic drift without a verdict.

- [ ] **Step 1: Write failing integration tests**

Add a public-repository harvest test that feeds an explicit recipe with two test paths and asserts four observations per path are required, V1 evidence does not satisfy the path, unsafe/multi-template recipes land in `awaiting_input`, and failed policy evaluation becomes quarantine.  Add a row/evaluator test proving a changed receipt hash or changed row/environment binding yields no verdict.

- [ ] **Step 2: Run focused tests red**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-harvest.test.ts test/solver-types/swe-rebench-v2-minted-pool.test.ts test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`

Expected: assertions fail because hardened receipt creation and verifier bindings do not yet exist in the flow.

- [ ] **Step 3: Wire differential admission into explicit-recipe harvest**

For an explicit recipe, select one targetable template and execute each candidate test path independently.  Persist the receipt and its canonical hash with its binding rather than permitting an old `BoundEmpiricalEvidenceV1` cache hit.  Use `awaiting_input` only for unsupported targeting and quarantine for observed policy failure.  Retain the legacy Rebench-backed path untouched.

- [ ] **Step 4: Bind and verify the receipt at mint and grade time**

Add optional-but-required-for-hardened-v2 receipt references to minted-pool/vetted-entry schemas.  On evaluation fetch the public receipt, hash it, verify its schema and row/environment/parser/semantics binding, and return the existing ungradeable/no-verdict result on drift or artifact failure.  Do not alter solver test execution or resolved grading rules.

- [ ] **Step 5: Run focused tests green and commit**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-harvest.test.ts test/solver-types/swe-rebench-v2-minted-pool.test.ts test/harnesses/impls/swe-rebench-v2-evaluator/harness.test.ts`

Expected: all tests pass.  Commit with `feat(task-creator): enforce differential admission evidence`.

### Task 3: Real Jinn source extraction and Docker receipt generation

**Files:**
- Modify: `client/src/solver-types/_swe-rebench-v2-commit-echo-git.ts`
- Modify: `client/src/task-creator/environment/recipes.ts`
- Create: `client/scripts/task-creator-jinn-differential-proof.ts`
- Modify: `client/package.json`
- Test: `client/test/solver-types/swe-rebench-v2-commit-echo-git.test.ts`
- Test: `client/test/task-creator/jinn-differential-proof.test.ts`

**Interfaces:**
- Consumes Tasks 1–2 receipt creator and targeted runner.
- Produces `yarn task-creator:jinn-differential-e2e`, which derives source patches from the exact commits, runs the Docker matrix, validates a receipt, writes it atomically, and optionally uploads the same bytes to IPFS.

- [ ] **Step 1: Write failing source/proof tests**

Add extraction fixtures for the exact Jinn base/fix pair and assert the code patch excludes the two named test files while the test patch and normalized test paths retain them.  Add proof-script unit coverage that rejects the stale docs-only merge SHA, requires both target paths, and refuses to write a receipt until a valid real-run result is returned.

- [ ] **Step 2: Run focused tests red**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-commit-echo-git.test.ts test/task-creator/jinn-differential-proof.test.ts`

Expected: the real-proof command and source guard are absent, so new assertions fail.

- [ ] **Step 3: Implement the reproducible Jinn proof command**

Pin the source constants in the script, derive commits and patches from Git, construct the pinned Jinn evaluator image, and run exactly 2×broken and 2×fixed targeted Vitest JSON invocations for each path.  Validate and atomically write the canonical sanitised receipt under a caller-provided output path; only after validation may an explicitly configured IPFS publisher upload those exact bytes.  The default command performs no external publication.

- [ ] **Step 4: Run unit tests green, then run the Docker proof**

Run: `cd client && yarn vitest run test/solver-types/swe-rebench-v2-commit-echo-git.test.ts test/task-creator/jinn-differential-proof.test.ts`

Expected: all unit tests pass.

Run: `cd client && yarn task-creator:jinn-differential-e2e --output ../tmp/jinn-differential-receipt.json`

Expected: Docker completes all eight targeted invocations, validates the receipt, and writes an artifact whose hash can be re-verified.  If this command cannot run because Docker, the pinned source, or an external dependency is unavailable, do not commit a receipt; record the exact blocker and continue with deterministic non-Docker coverage.

- [ ] **Step 5: Commit source/proof code and any genuinely generated receipt**

Commit the source guard, command, package script, and tests with `feat(task-creator): generate real Jinn differential receipts`.  Add a receipt to the same commit only when Step 4 produced and independently revalidated it.

### Task 4: Replace synthetic Jinn proof usage and make lifecycle checks receipt-bound

**Files:**
- Modify: `client/src/task-creator/proofs/public-repo-fixtures.ts`
- Modify: `client/src/task-creator/proofs/vitest-json-fixture.ts`
- Modify: `client/test/task-creator/public-repo-e2e.test.ts`
- Modify: `client/test/hermetic/public-repo-anvil-lifecycle.test.ts`
- Modify: `client/test/task-creator/public-repo-anvil-lifecycle.ts`
- Modify: `client/scripts/task-creator-public-repo-proof.ts`
- Modify: `client/scripts/task-creator-public-repo-network-proof.ts`
- Test: `client/test/task-creator/public-repo-e2e.test.ts`

**Interfaces:**
- Consumes Task 2 evaluator receipt binding and Task 3 generated-receipt verifier.
- Produces deterministic fixture names that describe parser-contract coverage, plus lifecycle proof that cannot call the Jinn record empirical without a verified receipt.

- [ ] **Step 1: Write failing fixture/lifecycle tests**

Add assertions that the old `5b76bade…` fixture is called parser-contract coverage rather than Jinn empirical proof; a Jinn proof row requires the exact real source commits and a verified receipt; and both local and Anvil lifecycle helpers reject a receipt hash/binding mismatch before task posting or verdict delivery.

- [ ] **Step 2: Run focused tests red**

Run: `cd client && yarn vitest run test/task-creator/public-repo-e2e.test.ts test/hermetic/public-repo-anvil-lifecycle.test.ts`

Expected: the fixtures still accept synthetic Jinn evidence and the new receipt requirement fails.

- [ ] **Step 3: Rebind proof fixtures and scripts**

Rename the stale Jinn fixture to generic parser-contract coverage.  Make the Jinn v2 proof builder consume the generated receipt path/CID/hash and verify it before constructing a vetted row.  Ensure local/Anvil scripts record task, environment, receipt, artifact, delivery, verdict, and corpus references while continuing to leave public testnet execution opt-in and operator-configured.

- [ ] **Step 4: Run focused tests green and commit**

Run: `cd client && yarn vitest run test/task-creator/public-repo-e2e.test.ts test/hermetic/public-repo-anvil-lifecycle.test.ts`

Expected: all tests pass.  Commit with `test(task-creator): bind public repo proof to differential receipt`.

### Task 5: Full verification, review, and operational handoff

**Files:**
- Modify: `docs/handoffs/2026-07-10-task-creator-rung1-plumbing-handoff.md`
- Modify: `client/package.json`
- Test: existing Task Creator suites

**Interfaces:**
- Consumes all prior tasks.
- Produces reproducible verification commands and an honest testnet runbook that requires three independently configured operators.

- [ ] **Step 1: Write the failing command/documentation assertions if supported**

Add or update command-list tests so the package script exists and documentation names the receipt prerequisite before testnet execution.  If the repository has no documentation-test harness, capture this as a manual review item and do not manufacture one.

- [ ] **Step 2: Run required verification**

Run, with the workspace's supported Node runtime:

`cd client && yarn typecheck`

`cd client && yarn test`

`cd client && yarn task-creator:harvest-e2e`

`cd client && yarn task-creator:public-repo-e2e`

`cd client && yarn task-creator:public-repo-anvil-e2e`

`cd client && yarn task-creator:jinn-differential-e2e --verify <generated-or-checked-in-receipt>`

Expected: each available command exits 0.  Report an unavailable Docker or public-testnet prerequisite as a blocker, never as an inferred pass.

- [ ] **Step 3: Perform task and whole-branch review, fix findings, and commit handoff updates**

Use the review package and fresh reviewers required by the agent workflow.  Update the handoff with actual receipt status, its canonical hash/CID if produced, all local/Anvil evidence, and the distinct-operator configuration required before public testnet use.  Commit only documentation and review-driven fixes with `docs(task-creator): record differential admission proof status`.
