# `@jinn-network/evidence-derivation`

`evidence-derivation` is the side-effect-free, structure-aware transform from
exact private Execution Evidence bytes to a representation publishable under
the supplied exact policy. It validates protocol structure before scanning,
applies one content-bound policy, and never reads a repository, filesystem,
network, clock, environment, home directory, or host identity.

The operation has four outcomes:

- `publishable-unchanged` returns the byte-identical record and safe artifact
  bytes, so an existing exact-record Execution Verification remains
  applicable.
- `derived` returns new conforming metadata, retained or derived artifacts,
  and a scrub receipt with explicit claim-binding impact.
- `review-required` returns private findings but no publishable bytes.
- `withheld` returns stable content-free reasons and no publishable bytes.

## Exact no-I/O flow

The caller loads and supplies every exact byte, canonical policy, public-safe
implementation descriptor, and completion time:

```ts
import {
  createBuiltinDerivationDetectors,
  createEvidenceDeriver,
} from "@jinn-network/evidence-derivation";

const detectors = createBuiltinDerivationDetectors({
  privateConfiguration: {
    schemaVersion: "jinn.private-detector-configuration.v1",
    nonce: privateCommitmentNonce,
    knownIdentities,
    privateAllowlist,
  },
});
const deriver = createEvidenceDeriver({ detectors });

const outcome = await deriver.derive({
  sourceRecord: { reference, bytes: exactRecordBytes },
  sourceArtifacts: exactArtifacts,
  policyBytes: exactCanonicalPolicyBytes,
  scrubber: {
    agentId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    implementationDescriptorBytes: exactCanonicalImplementationBytes,
  },
  completedAt: "2026-07-26T00:00:00Z",
});
```

Signed Result Evaluation and Execution Verification envelopes are not accepted
as derivation records. A signed artifact is retained byte-for-byte or withheld;
it is never rewritten. A Result Evaluation remains applicable only to its
exact Task and Result subject digests. When either receives a derivative, the
package reports that evaluation transfer is broken and never substitutes the
derived entity into the historical role.

Built-in detectors declare `byte-stable` reproducibility. A future external
detector may declare `best-effort` only when the exact policy permits it; the
result is then honestly graded `content-addressed`, not byte-stable.

## Contract kits

Independent derivers and detector bindings can run the portable Vitest kits:

```ts
import {
  describeDerivationDetectorContract,
  describeEvidenceDeriverContract,
} from "@jinn-network/evidence-derivation/testing";

describeEvidenceDeriverContract((detectors) =>
  createMyDeriver({ detectors }),
);
describeDerivationDetectorContract(() => {
  const harness = createMyDetectorTestHarness();
  return {
    detector: harness.detector,
    ambientEffectCount: () => harness.ambientEffectCount(),
    retainedSurfaceCount: () => harness.retainedSurfaceCount(),
    cleanup: () => harness.cleanup(),
  };
}, fixtures);
```

The detector factory creates a fresh context for each contract case. Its
truthful test-only observers must report attempted ambient effects and retained
surface plaintext; the kit checks both before and after every detector call and
runs `cleanup` after each case. This provides conformance evidence, not a
JavaScript sandbox or proof against dishonest detector code. Applications must
inject only detectors they trust with private source text.

This package does not ship ML inference, a review queue, repository access,
publication, announcements, application wiring, or legacy cutover behavior.

See the packaged Evidence Profile
[§3.6, Capture and derivation provenance](https://github.com/Jinn-Network/mono/blob/main/packages/evidence/protocol/profiles/execution-evidence/v1/specification.md#36-capture-and-derivation-provenance),
the Evidence Protocol rationale for
[§6.8, Capture and derivation provenance](https://github.com/Jinn-Network/mono/blob/main/docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md#68-capture-and-derivation-provenance)
and
[§10, Scrubbing and public representation](https://github.com/Jinn-Network/mono/blob/main/docs/superpowers/specs/2026-07-23-jinn-execution-evidence-protocol-design.md#10-scrubbing-and-public-representation),
the derivation design's
[§10, Determinism and content addressing](https://github.com/Jinn-Network/mono/blob/main/docs/superpowers/specs/2026-07-26-evidence-derivation-design.md#10-determinism-and-content-addressing),
and its
[source audit](https://github.com/Jinn-Network/mono/blob/main/docs/superpowers/specs/2026-07-26-evidence-derivation-design.md#175-source-audit).
