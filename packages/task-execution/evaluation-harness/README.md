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
