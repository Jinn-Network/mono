# Phase C Capability Boundaries and Transitional Seam Convergence

- **Version:** 1.0
- **Date:** 2026-08-03
- **Status:** Ratified by the operator's explicit implementation instruction on 2026-08-03
- **Shape:** `architecture decision specification`
- **Decision record:** [DR-2026-08-03](../../../log/decisions/2026-08-03-phase-c-capability-boundaries.md)
  (decision 6 amended by [DR-2026-08-15](../../../log/decisions/2026-08-15-withdraw-task-supply-environment-publication-caste.md))
- **Depends on:** the ratified platform architecture (DR-2026-07-30), the implemented Phase B
  native vertical, and the exact-byte identities of Task Execution, Evidence and Record Discovery.

## 1. Purpose

Phase B proved the native requester, operator and evaluator product path. Phase C converges the
remaining duplicate operational seams without redesigning the protocols, product policy or exact
records. This specification assigns one owner to each capability and turns every compatibility
path into explicit Phase D input.

The operator default remains `legacy` throughout Phase C. A separate Phase D decision may change
the default only after an exact-head live closure receipt and measured zero legacy use.

## 2. Ratified ownership decisions

1. **Marketplace pipeline.** `@jinn-network/marketplace-pipeline` is not a permanent platform
   abstraction. Its claim predicates, caps, wiring and orchestration are legacy product policy.
   Phase C removes native consumers, freezes and deprecates the public surface, and moves the
   package to the independently published legacy release line. Phase D deletes it after its one
   explicit legacy composition reaches zero use.
2. **Backend preclaim.** Profile support, declared run-pinning inventory, requested isolation and
   backend preflight form one venue-neutral capability gate owned by
   `@jinn-network/task-execution-backend`. Claim desirability, spend, concurrency, deadlines,
   model, harness, credential and prioritisation remain tier-4 product policy.
3. **Requester posting.** No marketplace work-client package is created. The existing requester
   backend in marketplace binding becomes the single posting-operation authority by joining its
   requester scope to the existing posting WAL and canonical recovery.
4. **Discovery.** Record Discovery is the sole public discovery plane. Evidence discovery is the
   permanent local catalog/publication outbox; the evidence-journal source is a permanent
   local-to-public adapter. Generic durable signed-source append/recovery belongs in
   `record-discovery-serve` behind injected I/O ports.
5. **Task supply and environments.** No task-supply or environment package is ratified by
   first-party use alone. They are not a special publication caste (DR-2026-08-15): classify
   each package as sealed platform or implementations under the same candidate-canary bar as
   other platform packages. Task curation remains a projection, not a record family; do not
   extract it into Record Discovery facts until two real consumers prove that join.
6. **Settlement.** Solution and verdict settlement retain distinct product owners. No shared
   settlement package is introduced without two independent consumers proving the same
   venue-neutral lifecycle.
7. **Compatibility.** Every surviving compatibility path must name an owner, replacement,
   consumers, default, no-new-use guard, usage signal, migration, sunset condition and executable
   deletion test in a closed transition manifest before Phase C closes.

## 3. Marketplace pipeline transition contract

The only permitted production imports of `@jinn-network/marketplace-pipeline` are the checked-in
legacy client allowlist:

- `client/src/config/shape-v2.ts`
- `client/src/daemon/composition-root.ts`
- `client/src/daemon/engagement-ledger.ts`
- `client/src/daemon/work-loop.ts`

Native requester, discovery, solver and evaluator code must not import the package. The legacy
root export set is behavior-frozen; new exports and new consumers fail CI. Neutral preclaim
helpers move to task-execution-backend. Product discovery facts and mappings live in the client
and use `RECORD_KINDS.submission` as their canonical kind.

The pipeline is deleted only when the client no longer declares it, production imports and
invocations are zero, the native default has an exact-head closure receipt, and deletion tests
prove the old exports and fixtures are unreachable.

## 4. Transition-manifest contract

`architecture/transitions/transition-manifest.schema.json` is the closed machine format for
Phase D inputs. A manifest records at least:

- stable transition id, owning group and status;
- exact entry points, replacement and current consumers;
- current default mode and a no-new-use guard;
- an observable usage signal;
- migration instructions, a mechanical sunset condition and an executable deletion test;
- the target pull request or issue that removes the surface.

Unknown fields, empty lists, missing owners and non-repository entry points are invalid. C0 owns
the schema and validator; C9 owns the complete live Phase D manifest and usage instrumentation.

## 5. Boundary invariants

- Product policy crosses into reusable capabilities only as commands, exact sealed bytes and
  explicitly injected ports.
- One operation has one durable side-effect authority. Product caches never authorize a second
  broadcast or source-chain append.
- Original record bytes and digests never change during discovery translation or state migration.
- No wrapper-only package, umbrella SDK or source-relative cross-tree import is introduced.
- Existing legacy behavior remains test-frozen until its manifest sunset condition passes.
- Architecture, conformance, packed-consumer and exact-head hosted evidence bind the commit they
  tested; a later commit cannot reuse an earlier receipt.

## 6. Phase C implementation order

Shared authority is frozen first; capabilities land before consumer migrations; duplicate
mechanics are removed only after conformance and state migration pass; no-new-use guards land in
the same convergence. The final integration candidate retains the legacy default, passes hosted
and isolated packed acceptance, then runs one authorized Base Sepolia closure on the exact merged
SHA. Phase D owns the default flip and legacy deletion.
