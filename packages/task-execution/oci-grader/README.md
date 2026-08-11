# @jinn-network/task-execution-oci-grader

Host-owned OCI grader execution for the Jinn evaluation harness.

`@jinn-network/task-execution-evaluator-adapters` defines the `GraderReportSource`
port and deliberately never shells out. This package is one host-owned
implementation of that port: it runs a **digest-pinned** grader image with a
**digest-frozen** grader program bind-mounted read-only, and returns the single
canonical `{ report, log }` document the swe-rebench adapter parses.

It is the sibling of the package's own `containerGraderReportSource`, not a
replacement for it. The two differ in where the grading logic lives:

- `containerGraderReportSource` expects the grading logic to be baked into a
  per-instance image, so the image digest pre-commits the logic.
- This package mounts a fixed, separately-digested grader program into the
  unmodified upstream task image, so no per-instance image build and no
  container registry are required.

## Trust story

**Digest-pinned, verifiable from the sealed EvaluationSpec:** the task image
(`familyBlock.image`, refused unless it is an exact `sha256:` reference); the
grading parameters (`familyBlock.testMaterial`, re-verified against their
declared digest and re-checked as exact canonical JSON before use); the solver
patch (a digest-declared Result subject); the timeout (`familyBlock.timeout`,
the only deadline authority on this path).

**Build-pinned, NOT pre-committed by the specification:** the grader program
itself. `graderProgramDigest` is exported so a caller can freeze and publish it
at method-lock time and record it on every verdict, which binds a published
result to a specific grader even though the specification did not commit to it
in advance. Callers that need the grader logic under the specification's own
digest should bake it into a per-instance image and use
`containerGraderReportSource` instead.

## Never touches

The network (no `fetch`; only the container runtime reaches a registry), host
credentials or signer material (refused by path inspection before any mount),
evidence or trust packages, verdict signing (the caller seals verdicts).

## Authority

- `docs/superpowers/specs/2026-07-30-jinn-platform-architecture.md` (ratified)
- `docs/superpowers/specs/2026-07-27-task-execution-protocol-and-stack-design.md` (approved)
- `log/decisions/2026-07-30-platform-boundary-and-topology.md` (ratified)
