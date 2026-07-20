# #1899 Attribution Analyzer Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the offline attribution analyzer derive outcomes from authenticated canonical verdict envelopes joined exactly to marketplace attempt/verdict evidence, while hardening preregistration order, anchor immutability, and evidence resource bounds.

**Architecture:** The existing attribution receipt remains the experiment metadata carrier, but its outcome becomes a derived value from two authenticated `jinn.execution.v1` envelopes. Embedded marketplace rows constrain the immutable tuple, evidence hashes, and verdict-code consistency only; they never independently authenticate or determine the outcome. File loading uses bounded descriptor reads and an aggregate budget, and preregistration/runbook validation becomes deterministic and edit-aware.

**Tech Stack:** TypeScript 6, Zod v3/v4 compatibility, viem secp256k1 recovery through the existing execution-envelope authenticator, Vitest, Bash runbook checks.

## Global Constraints

- All verification is offline and read-only; do not contact production.
- Preserve #1843 as open and Human-owned.
- Do not weaken fail-closed behavior, no-peeking, or publication boundaries.
- Signed canonical envelopes determine `acceptedDiff`; embedded marketplace rows only constrain the exact tuple and evidence-hash join.
- Do not push, comment, ready, merge, or mutate GitHub/project state.

---

### Task 1: Seed-derived execution order

**Files:**
- Modify: `client/src/eval/attribution-instrument.ts`
- Modify: `client/test/eval/attribution-instrument.test.ts`

**Interfaces:**
- Produces: `deriveAttributionCellOrder(seed: string): readonly AutoloadState[]`
- Consumes: `AttributionPreregistrationSchema`

- [ ] **Step 1: Write failing parity/order tests**

Test that two known seeds cover `off,on` and `on,off`, and that reversing the
cells relative to the derived order fails schema parsing.

- [ ] **Step 2: Run the focused analyzer test**

Run: `yarn vitest run test/eval/attribution-instrument.test.ts`

Expected: FAIL because the derivation function/order refinement is absent.

- [ ] **Step 3: Implement SHA-256 parity order**

Hash the UTF-8 seed with SHA-256. Return `['off', 'on']` when
`digest[0] & 1 === 0`, otherwise `['on', 'off']`. In preregistration
`superRefine`, compare the exact cells order to this result and add a custom
issue on drift.

- [ ] **Step 4: Re-run the focused test**

Expected: PASS.

### Task 2: Canonical signed verdict grounding

**Files:**
- Modify: `client/src/eval/attribution-instrument.ts`
- Modify: `client/scripts/analyze-attribution-instrument.ts`
- Modify: `client/scripts/export-attribution-facts.ts`
- Modify: `client/test/eval/attribution-instrument.test.ts`
- Modify: `client/test/scripts/analyze-attribution-instrument.test.ts`

**Interfaces:**
- Consumes: `authenticateExecutionEnvelope(value, sourceName)`
- Produces: async `buildAttributionFacts(...)` and
  `analyzeAttributionInstrument(...)`

- [ ] **Step 1: Write failing authoritative-proof tests**

Create real signed SWE-rebench solution and verdict envelopes in fixtures. Add
one passing proof with:

```ts
marketplace: {
  attempt: {
    chainId, taskId, attemptIndex, requestId, operator,
    evidenceHash: solutionEnvelope.signature.hash,
  },
  verdict: {
    chainId, taskId, attemptIndex, verdictIndex, requestId, evaluator,
    verdictCode: acceptedDiff ? VerdictCode.Pass : VerdictCode.Fail,
    evidenceHash: verdictEnvelope.signature.hash,
  },
},
solutionEnvelope,
verdictEnvelope,
```

Add failures for arbitrary request refs, mismatched tuple members, mismatched
evidence hashes, participant Safe drift, signed payload/outcome tampering,
marketplace verdict-code disagreement, and signed score/`passed_match`
disagreement.

- [ ] **Step 2: Run focused tests and observe the current false acceptance**

Run both attribution test files. Expected: fabricated references/outcomes are
accepted or the new schema is unsupported.

- [ ] **Step 3: Replace receipt outcome input with authenticated derivation**

Parse the receipt metadata and embedded proof strictly. Authenticate both
envelopes with `authenticateExecutionEnvelope`. Require:

```ts
solution.task.requestId === attempt.requestId
verdict.task.requestId === verdictRow.requestId
solution.task.instanceId === receipt.instanceId
verdict.task.instanceId === receipt.instanceId
solution.participant.safeAddress === attempt.operator
verdict.participant.safeAddress === verdictRow.evaluator
attempt.(chainId, taskId, attemptIndex)
  === verdictRow.(chainId, taskId, attemptIndex)
attempt.evidenceHash === solution.signature.hash
verdictRow.evidenceHash === verdict.signature.hash
verdictRow.verdictCode
  === (signedVerdict.passed_match ? VerdictCode.Pass : VerdictCode.Fail)
```

Parse `verdict.payload` with `SweRebenchV2VerdictPayloadSchema`, require its
signed binary score and the embedded marketplace verdict code to agree with
`passed_match`, and return `passed_match` as the only `acceptedDiff` source.
The embedded row is only a consistency constraint, not an independent trust
root. Remove the operator-entered `acceptedDiff` field.

- [ ] **Step 4: Make exporter/analyzer CLIs await validation**

Convert their `main()` functions to async, await facts building/analysis, and
retain empty stdout plus nonzero exit on all failures.

- [ ] **Step 5: Run focused tests**

Expected: the valid joined proof passes and all fabricated/mismatched proofs
fail closed.

### Task 3: Truly bounded and aggregate-bounded evidence reads

**Files:**
- Modify: `client/scripts/attribution-files.ts`
- Modify: `client/test/scripts/analyze-attribution-instrument.test.ts`

**Interfaces:**
- Produces: `MAX_AGGREGATE_EVIDENCE_BYTES`
- Produces: bounded descriptor helper used by `readBoundedRegularFile`
- Extends: `readAttributionEvidenceBundle(path, maximumAggregateBytes?)`

- [ ] **Step 1: Write failing oversize, growth, and aggregate tests**

Use an initially oversized file for the stat gate. For deterministic growth,
open/stat a file, append a byte, then call the bounded descriptor helper and
expect a growth error. Use a small injected aggregate budget to prove the
loader rejects before reading another file beyond the remaining budget.

- [ ] **Step 2: Run focused CLI tests**

Expected: current `readFileSync` implementation lacks deterministic growth and
aggregate enforcement.

- [ ] **Step 3: Implement bounded descriptor reads**

Use `readSync` into a buffer no larger than `initialStatSize + 1`, reject any
read beyond the initial stat size, and return only the bytes read. Preserve
`O_NOFOLLOW` and regular-file checks.

- [ ] **Step 4: Enforce aggregate budget during manifest traversal**

Track accumulated evidence bytes. Pass `min(perFileCap, remainingBudget)` to
each bounded read and reject before allocation when no budget remains.

- [ ] **Step 5: Run focused tests**

Expected: initial oversize, growth, and aggregate overflow all fail.

### Task 4: Runbook anchor edit and order verification

**Files:**
- Modify: `docs/runbooks/stage2-attribution-instrument.md`
- Modify: `client/test/scripts/analyze-attribution-instrument.test.ts`

**Interfaces:**
- Consumes: the SHA-256 parity order contract from Task 1.

- [ ] **Step 1: Write failing static/executable runbook checks**

Extract every Bash block and keep `bash -n`. Assert every `.created_at`
verification path also fetches `.updated_at` and tests exact equality. Assert
the runbook derives cell order from `executionOrderSeed` rather than declaring
the array order authoritative.

- [ ] **Step 2: Run the runbook test**

Expected: FAIL because updated timestamps and seed derivation are absent.

- [ ] **Step 3: Update anchor creation and every `verify()` copy**

Fetch the remote `updated_at`, require it equals the remote `created_at`, and
retain the pre-window test. Add the seed hash parity command, compare the
derived order to preregistration cells before anchoring, and describe the
runner proof/envelope requirements accurately.

- [ ] **Step 4: Re-run the runbook test and extracted Bash**

Expected: PASS.

### Task 5: Full verification, security audit, and local commit

**Files:**
- Review all files changed by Tasks 1–4.

- [ ] **Step 1: Run focused tests**

Run both attribution test files and any envelope-authentication tests imported
by the implementation.

- [ ] **Step 2: Run typecheck and build**

Run `yarn typecheck` and `yarn build` from `client/`.

- [ ] **Step 3: Run Bash extraction and diff checks**

Run the static runbook test, `git diff --check`, and inspect exact changed
files.

- [ ] **Step 4: Perform proportional security self-review**

Check that no row/ref alone determines the outcome, both signatures and
evidence hashes are verified, all tuple comparisons are exact, paths remain
non-following and aggregate-bounded, and no network/write path was introduced.

- [ ] **Step 5: Commit locally**

Commit with a conventional message and `Refs #1899`; verify the worktree is
clean. Do not push or mutate GitHub/project state.
