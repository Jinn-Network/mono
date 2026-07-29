# `@jinn-network/task-execution-evaluation-harness`

This package is the evaluator-facing remainder of the superseded Evaluation Runner design. It
defines evaluator adapters and registrations, runs an `evaluation-task/1.0` workspace, signs the
Result Evaluation through Attestation Issuer, and supplies a pure launcher for host registration.

Evaluation remains an ordinary Task Execution Protocol Attempt. The local backend owns custody,
journaling, cancellation, recovery, harvest, evidence capture, and Delivery sealing. Hosts add the
evaluation launcher to their assembly configuration; the assembly never imports this package.

The evaluator adapter returns only method-neutral conclusion data. Task and Result subjects,
EvaluationSpec identity, evaluation method, evaluator identity, and signing authority remain
harness- or registration-owned. Operational failure produces no verdict.

The runtime consumes the provisioned `task.sealed`, `dispatch-context.json`,
`evaluation-spec.json`, subject Task, subject Delivery, and subject Result files from `input/`.
It verifies the evaluation-task and subject-Task specification crosswalk before invoking one
host-compatible registration. Deterministic parser identities must be present in the deployment
allowlist; verdict rules are accepted only in the closed declarative vocabulary.

The spawned CLI loads registrations and the parser allowlist only from the host-selected
`JINN_EVALUATION_DEPLOYMENT_MODULE`. A registration carries a signer filename, not key bytes;
`makeSecretsSigner` opens that file beneath `secrets/` only when Attestation Issuer requests a
signature. The prepared DSSE bytes are published unchanged as `out/verdict`.
