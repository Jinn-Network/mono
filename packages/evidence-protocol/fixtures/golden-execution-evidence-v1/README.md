# Golden Execution Evidence v1 fixture

This synthetic fixture is the complete target counterpart to the source-backed Autopilot issue
#1697 fixture. It demonstrates the information a producer must capture to assemble a structurally
complete Jinn Execution Evidence record, a conforming public derivative, and later Result
Evaluation and Execution Verification claims.

The fixture is synthetic: its task, repository, execution, marketplace references, actors, and
hosted-model deployment are examples. No historical execution is asserted. The artifact bytes,
digests, record relationships, and DSSE signatures are real and mechanically verifiable.

The execution models an operator implementing deterministic slug normalization. It includes:

- the exact Task and all materially consumed repository and knowledge inputs;
- the Executor Agent and every producer-controlled Runtime Specification component;
- a precise descriptor for an opaque hosted model;
- the observed Execution environment, native trace, resource measurements, in-run evidence, and
  exact Result;
- external task-marketplace task and attempt references that remain outside the protocol's
  ownership boundary;
- a later Result Evaluation over the exact Task and Result bytes; and
- a later Execution Verification over the sealed execution metadata.

The `public/` record retains the same Execution ID and exact Task, Result, Runtime Specification,
and native-trace commitments. The exact private trace bytes are intentionally unavailable. A
separately identified scrubbed trace records its source mapping and scrub activity, policy,
completion time, and disposition counts. The scrub receipt commits to the private source record
but does not contain the public metadata digest, which would be circular.

The top-level `ro-crate-metadata.json` is a generic, non-normative download bundle. It is not a
fourth Jinn record family. The independently sealed Execution Evidence record is
`execution/ro-crate-metadata.json`; its conforming public derivative is
`public/ro-crate-metadata.json`. The two DSSE envelopes are append-only claims; neither mutates
either execution record. The private Execution Verification is not transferred to the public
metadata.

The opaque hosted model is identified, but its provider-controlled implementation is not bundled.
That limits independent reproducibility without making the execution evidence structurally
incomplete.

This local normative fixture uses the profile URI reserved by the packaged specification. It must
not be presented as an externally published conformance claim until that URI resolves to the
published profile.

## Publication check

The public derivative demonstrates the required structure independently of the current
application scrubber. It publishes unchanged safe Task and Result bytes, withholds the exact
private native trace, and publishes a separately content-bound redacted trace. Cryptographic
claims are not rewritten or copied into the derivative.

This fixture is not authorization to publish real user data. Publication policy, consent, and the
application scrubber remain outside protocol conformance.
