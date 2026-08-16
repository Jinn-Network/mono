# `@jinn-network/execution-evidence-builder`

An I/O-free builder for one Jinn Execution Evidence v1 record.

`buildExecutionEvidence(input)` accepts exact, already-content-addressed task,
runtime, result, and trace descriptors. It deterministically constructs the
RO-Crate bytes and refuses output that does not conform to Evidence Protocol
v1. It does not observe an execution, read a filesystem, publish evidence, or
claim prospective capture timing.
