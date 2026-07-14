# Task Creator G0b Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` task by task.

**Goal:** Admit and grade public-repository commit-echo tasks without a Rebench source row while leaving the existing SWE generator and posting policy unchanged.

## Global constraints

- Base: Task Creator PR #1485 plus the public-repo and generalized-capsule design documents.
- New public-repository evaluator environments are Linux/amd64 and digest-pinned.
- Builder input never includes `fixCommit`, gold-patch data, or test-patch content.
- Public-repo rows use `swe-rebench-v2-minted-pool.v2` and `rowHashVersion: 2`; v1 remains readable.
- V2 row hashes use only public task/row fields and environment bindings; they exclude gold patches and `hf_dataset`/`hf_split`.
- No generator selection, quota, escrow, claim, or `MechAdapter.postTask` behavior change.
- `EVAL_SEMANTICS_VERSION` remains `4`.
- All feature behavior is TDD: a focused test must fail before production code is added.

### Task 1: Reconcile specifications and make evaluator enable durable

- Reconcile the parent, capsule, and public-repo designs: use `EnvironmentRecipeResolver` for discovery, reserve `SandboxProvider` for later runtime work, distinguish solver from evaluator environments, use per-input rights references, and state that G1 is out of scope.
- Update loop-heartbeat expectation/comment from seven/eight to nine.
- Pin upstream SWE-rebench commit `c71902a8cf8d2b725f63d51f199f4d3e56f68d2d`; version and apply a bundle that adds empirical actual-result fields plus `vitest-json.v1`; persist bundle/parser metadata and self-test it on enable.

### Task 2: Environment contracts, recipes, and publication policy

- Add strict schemas and canonical hashing for `EnvironmentBuildRequestV1`, `EnvironmentBuildRecipeV1`, `TaskEnvironmentSpecV1`, rights evidence, command specs, parser identity, and EIP-191 attestation.
- Add explicit resolver selection with no malformed-output fallthrough; unsupported repos become `awaiting_input`.
- Add GitHub public/license verification, Apache-2.0/MIT default policy, approved image policy, scanner/SBOM interfaces, and explicit recipes for Jinn mono and unjs/destr.

### Task 3: Isolated Docker environment build and artifact publication

- Implement a Linux/amd64 Buildx builder with no registry credentials in the build context; checkout, install, smoke, clean-HEAD verification, SBOM/secret scan, outer-controller push, digest resolution, IPFS artifact upload, and EIP-191 attestation.
- Use the plan's fixed Node 22 and Node 20 image digests and default GHCR repository.

### Task 4: V2 minted artifacts, public row hashes, and evaluator recheck

- Add v1/v2 minted-artifact parsing and store migration with immutable CID routing per version.
- Preserve candidate language, add public v2 row hash, propagate environment references through routing, vetted-pool admission, and evaluator recheck.
- Fail closed without a verdict on environment, parser, image, platform, or public-row drift.

### Task 5: Candidate tests, empirical-evidence reuse, and durable harvest jobs

- Carry test patch, test paths, and language from commit mining; use the bootstrap path for explicit recipes and retain legacy Rebench backing otherwise.
- Persist and validate bound before/after evidence; reuse it only on exact bindings, else rerun admission.
- Migrate harvest state to persisted jobs, cursor-before-processing safety, idempotency keys, retry/awaiting/quarantine dispositions, and resume behavior.

### Task 6: Jinn and portable-repository proofs

- Add hermetic factory/integration coverage using Jinn PR #1458 (`5b76bade…`, base `c7701007…`) and unjs/destr PR #94 (`d9ba16d7…`, base `37210516…`).
- Prove Jinn oracle parity, v2 generator compatibility, local-registry build/pull, and deterministic Anvil delivery/evaluation; add live factory/network scripts and runbooks that require existing operator credentials rather than embedding them.

### Task 7: Full verification and branch review

- Run focused suites throughout, then `yarn typecheck`, `yarn test`, existing harvest E2E, and new public-repo E2E.
- Run broad diff review, remediate findings, and prepare a stacked `feat(task-creator)` PR targeting `next`.
