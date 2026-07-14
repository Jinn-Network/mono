# Task Creator real Jinn differential admission design

- **Version:** 0.1
- **Date:** 2026-07-12
- **Status:** approved
- **Parent:** [Task Creator public-repository substrate](2026-07-10-task-creator-public-repo-substrate-design.md)

## Purpose

G0b already proves that a public-repository commit echo can traverse the normal
minted SWE lane.  This amendment makes the first Jinn proof causal rather than a
parser fixture: admission must demonstrate repeatedly that the PR's own test
patch differentiates its base commit from its fix commit under the exact pinned
evaluator environment.

The proof input is Jinn PR #1458 at base
`ae8093a8848e70e581f46d66dcdb56789c0808a3` and fix
`ef9608876511b4dff000cda1537ff7c1a227677d`.  The old GitHub-generated merge
commit `5b76bade…` is documentation-only and remains only generic
parser-contract coverage; it is not evidence for this task.

## Admission policy and receipt

`DifferentialAdmissionPolicyV2` is the only policy for hardened explicit-recipe
G0b admission.  For every executable test path it requires exactly two broken
runs (base plus test patch plus empty solution) and two fixed runs (base plus
test patch plus gold solution).  All output within a side must be equal, every
path must contribute at least one F2P assertion, and raw assertion identifiers
may not occur in two paths.  A missing, unstable, duplicate, or
non-discriminating observation quarantines the candidate.

`DifferentialAdmissionReceiptV2` is canonical, public, and sanitised.  It binds
repository identity; base and fix commits; only the gold-patch hash; test-patch
hash; normalized test paths; per-path command hashes; every broken/fixed
observation; stable F2P/P2P sets; image, environment, parser, and evaluator
semantics identities; and `admissionPolicyVersion`.  It does not expose the gold
patch.  Its hash and IPFS CID are bound into the vetted v2 entry and checked by
the evaluator before a verdict is emitted.

Legacy V1 empirical evidence stays readable for legacy rows but cannot satisfy
this policy or be reused for a hardened G0b row.  `EVAL_SEMANTICS_VERSION`
remains `4`: the receipt strengthens evidence collection, not grading semantics.

## Targeted execution

The policy accepts one targetable test-command template.  The harvest flow
normalizes each repository-relative test path, strips the repository workspace
prefix when constructing command arguments, and rejects absolute paths,
traversal, and paths outside the workspace.  It executes every accepted path in a
separate invocation of trusted `vitest-json.v1`; the parser therefore need not
change to carry file provenance.  A recipe that needs several unrelated command
templates becomes `awaiting_input` rather than being silently generalized.

Empty-patch discrimination remains part of normal admission.  The repeated
broken/fixed proof is an additional bound evidence gate, not a substitute for it.

## Jinn evidence and proof boundary

The real Jinn candidate targets:

- `client/test/daemon/daemon-recovery-nonblocking.test.ts`
- `client/test/harnesses/engine/recovery.test.ts`

with the pinned Jinn evaluator recipe.  A Docker-backed command derives the
patches from the two exact commits, runs the per-path 2×broken/2×fixed matrix,
validates the receipt, and writes a canonical sanitised receipt only after the
real run succeeds.  The same bytes are published to IPFS; the checked-in receipt
is a proof artifact whose hash and bindings are verified in deterministic CI.
No hand-written or synthetic receipt can stand in for a Docker result.

The verified receipt drives local and Anvil task lifecycle tests.  A public
testnet run remains a later operational proof: it requires the receipt, local and
Anvil success, and distinct configured minter, solver, and evaluator operators.
Until then neither the implementation nor its documentation claims public-testnet
empirical success.

## Scope

This amendment deliberately does not add PR-range checks, mutation testing,
test-title extraction, RepoLaunch, automatic environment discovery, ALE, or any
generator, selection, quota, escrow, claim, task-construction, or posting-path
change.
