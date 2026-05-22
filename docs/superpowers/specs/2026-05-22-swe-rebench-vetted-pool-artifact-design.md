# SWE-Rebench V2 Vetted Pool Artifact Design

Issue: #478
Date: 2026-05-22
Status: implementation target for `feat/478-vetted-pool`

## Decision

The swe-rebench-v2 launcher owns expensive vetting. It exports the local
`validated-pool.json` scorable entries into a canonical JSON artifact, pins that
artifact to IPFS, and publishes a SolverNet-scoped mutable pointer for the
current launch. The generator and evaluators consume that published pool; they
do not run gold-patch validation on the posting or grading hot path.

## Artifact

The pool artifact contains only entries admitted as `scorable: true` for the
current `evalSemanticsVersion`. Each entry includes the instance id and the
grading substrate metadata already recorded by validation: `rowHash`,
`imageName`, `imageDigest`, `upstreamEvalCommit`, `reason`, and `checkedAt`.

The artifact hash is `sha256:` over the artifact's RFC 8785 canonical JSON. This
hash is included in the pointer and lets consumers verify that the IPFS body
matches the launcher's advertised pool.

## Pointer

Metadata key:

```text
solvernet-artifact:<manifestCid>:swe-rebench-v2-vetted-pool
```

Pointer payload:

```json
{
  "schemaVersion": "solvernet.artifact-ref.v1",
  "manifestCid": "<SolverNet manifest CID>",
  "artifactType": "swe-rebench-v2-vetted-pool.v1",
  "artifactCid": "<IPFS CID>",
  "artifactHash": "sha256:<canonical artifact hash>",
  "evalSemanticsVersion": "<version>",
  "publishedAt": "<ISO timestamp>"
}
```

The intended durable read path is the existing ERC-8004 metadata/indexer
plumbing keyed by the metadata key above. For this branch's current testnet
acceptance path, the launcher also stamps the full pointer into each posted
task's eligibility. That gives evaluators a deterministic direct pointer even
before indexer support for generic SolverNet artifacts is complete.

## Runtime Rules

- `validate-pool` remains the producer of local admission facts.
- The launcher generator exports and publishes the scorable subset when it has
  local admission data but no current publication ref.
- The generator selects candidates only from the published artifact's scorable
  ids and stamps the pointer into posted task eligibility.
- The evaluator requires launcher-posted tasks to carry a pool pointer, fetches
  and verifies that artifact, and admits only instances present in it.
- Evaluators trust the launcher's vetting. They may still check the task is in
  the artifact and, when available, that the artifact hash matches, but they do
  not independently re-run gold-patch validation.
- Legacy tasks without a pool pointer may continue using the prior local
  `validated-pool.json` admission path so old in-flight tasks do not break.

## Non-Goals

This branch does not implement broad indexer discovery for generic artifact
metadata. The task-stamped pointer is the working end-to-end path; the metadata
key and payload are specified so a follow-up can make the indexer-backed lookup
the default read path without changing task semantics.
