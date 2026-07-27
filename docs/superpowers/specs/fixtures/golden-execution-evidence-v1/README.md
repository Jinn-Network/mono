# Golden Execution Evidence v1 fixture

This synthetic fixture is the complete target counterpart to the source-backed Autopilot issue
#1697 fixture. It demonstrates the information a producer must capture to assemble a structurally
complete Jinn Execution Evidence record, plus later Result Evaluation and Execution Verification
claims.

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

The top-level `ro-crate-metadata.json` is a generic, non-normative download bundle. It is not a
fourth Jinn record family. The independently sealed Execution Evidence record is
`execution/ro-crate-metadata.json`. The two DSSE envelopes are append-only claims; neither mutates
the execution record.

The opaque hosted model is identified, but its provider-controlled implementation is not bundled.
That limits independent reproducibility without making the execution evidence structurally
incomplete.

This local normative fixture uses the profile URI reserved by the protocol design. It must not be
presented as an externally published conformance claim until that URI resolves to the published
profile and the normative validator exists.

## Publication check

The fixture contains only synthetic public test material, but the current fail-closed scrubber
still rejects it with eleven findings: nine high-entropy findings and two email-shaped findings.
Expected DSSE payloads and signatures, Ed25519 public keys, the synthetic model identifier, and
two occurrences of `yarn@4.13.0` account for those findings.

These bytes must not be redacted: changing a signed envelope invalidates its signature. A
production publication path therefore needs structure-aware treatment for standard
cryptographic fields, public keys, package-manager versions, and declared technical identifiers.
Until that exists, this fixture is structurally complete protocol evidence but is not accepted by
the current scrub publication gate.
