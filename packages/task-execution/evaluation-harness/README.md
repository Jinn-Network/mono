# `@jinn-network/task-execution-evaluation-harness`

This package is the evaluator-facing remainder of the superseded Evaluation Runner design. It
defines evaluator adapters and registrations, runs an `evaluation-task/1.0` workspace, builds the
unsigned Result Evaluation Evidence payload, and supplies a pure launcher for host registration.

Evaluation remains an ordinary Task Execution Protocol Attempt. The local backend owns custody,
journaling, cancellation, recovery, harvest, evidence capture, and Delivery sealing. Hosts add the
evaluation launcher to their assembly configuration; the assembly never imports this package.

The evaluator adapter returns only method-neutral conclusion data. Task and Result subjects,
EvaluationSpec identity, evaluation method, and evaluator identity remain harness- or
registration-owned. Operational failure produces no verdict.

The runtime consumes the provisioned `task.sealed`, `dispatch-context.json`,
`evaluation-spec.json`, subject Task, subject Delivery, and subject Result files from `input/`.
It verifies the evaluation-task and subject-Task specification crosswalk before invoking one
host-compatible registration. Deterministic parser identities must be present in the deployment
allowlist; verdict rules are accepted only in the closed declarative vocabulary.

The spawned CLI loads registrations and the parser allowlist only from the host-selected
`JINN_ATTEMPT_EVALUATION_DEPLOYMENT_MODULE`.

**Amended 2026-08-04 (`25924bd4a`): this harness does not sign.** The runtime builds the
Result Evaluation Evidence payload (`buildResultEvaluationPayload`) and publishes it
**unsigned** to `out/verdict`. The launcher grants no `secretForwards` (`src/launcher.ts`), so
the sandbox never holds signing key material, and the host-side composition layer refuses any
grant on the evaluator-sealed input. Signing happens on the **host**: it re-serializes the
unsigned statement, confirms the reserialized bytes are byte-identical to what the sandbox
wrote (`client/src/daemon/native-evaluator-composition.ts`, fail-closed on mismatch), and only
then seals a DSSE envelope with the evaluator Agent's key. `src/sign.ts` (the in-executor
`secrets/`-file DSSE signer) and its exported `makeSecretsSigner` are unused by this flow; see
the local-execution-backend design §10.4 for the full reversal rationale.
