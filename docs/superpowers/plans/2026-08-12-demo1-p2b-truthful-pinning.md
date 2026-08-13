# Demo-1 P2b — Truthful Run-Pinning Evidence

## Goal

Replace the benchmark product's synthetic `admission: { ready: true }` with the exact result of
the local backend's real `verifyRunPinning` gate. A dispatched cell earns `match` only when a
durable, digest-bound proof for its effective requirements is present; missing or rejected proof
remains `unverifiable`, while affirmative contradictory observations remain `mismatch`.

## Traced boundaries

1. `backend-local/assembly/src/pinning.ts` performs the launcher readiness and inventory check.
   Its result must name the canonical digest of the run-owned merged pinning map it checked.
2. `backend-local/assembly/src/backend.ts` accepts only after that check. It persists the result
   with the accepted Submission and exposes a read-only concrete-backend lookup keyed by the
   accepted Submission URI. The frozen generic `SubmissionAck` API is unchanged.
3. `benchmark-product/core/src/run/drive.ts` calls the real backend first. Only an accepted ack is
   stored/journaled. If the concrete proof lookup returns a result, its canonical bytes are put in
   the product CAS and its digest is recorded on the solve-side acceptance entry.
4. `benchmark-product/core/src/run/journal.ts` folds the current solve dispatch's proof reference
   without allowing evaluation submissions to overwrite it.
5. `benchmark-product/core/src/run/assembly-ports.ts` resolves and strictly parses those exact CAS
   bytes into `InScopeCell.evidenceRef`; its pinning port forwards that evidence and never creates
   an admission result.
6. `benchmark-product/core/src/bundle/{schema,materialize,verify}.ts` carries the proof bytes and
   reference through the deletion-portable bundle and reconstructs the same assembly input.
7. `benchmarking/local/src/pinning-bridge.ts` requires an exact `checkedRequirementsDigest` before
   an enforced axis can reach `match`. This independently prevents a bare readiness boolean from
   being treated as proof.

## Test-first cases

- Real matching proof: harness/model/loadout derive `match` and the prediction sample integration
  remains matched through the real backend-to-Matrix path.
- Missing evidence: an accepted/dispatched cell with no proof reference derives
  `unverifiable`, never `match`.
- Mismatched evidence: wrong checked-requirements digest remains `unverifiable`; an affirmative
  contradictory axis observation derives `mismatch`.
- Submit rejection: no `submission-accepted` journal entry or proof reference is emitted.
- Dispatched without proof: assembly and portable verification preserve non-match status.
- Evidence closure: bundle materialization includes every referenced proof byte; each proof names
  its exact accepted Submission, and cold verification rejects missing, malformed, mis-digested,
  cross-Submission, or unreachable proof.

## Gates

Run focused unit/integration tests for backend-local pinning and persistence, benchmark-local
pinning derivation, benchmark-product proxy/journal/assembly/bundle behavior, and the official
run-path prediction sample. Then run affected package typechecks/builds/tests and repository
architecture/source-boundary controls. Do not run Docker while the 40 GiB gate is unmet.
