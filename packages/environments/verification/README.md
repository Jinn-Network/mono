# @jinn-network/environment-verification

Executes the K-run verification protocol against a sealed environment record and produces
an in-toto Statement inside a DSSE envelope.

## What the attestation claims, exactly

`result: "stable"` means **K consecutive runs of the record's declared test scope produced
identical outcome-sets under the declared controls**, and nothing more. Flaky-test rerun
studies show detection is asymptotic in the number of reruns, so no finite K settles the
question; K and the controls are recorded as facts, and grading them is the consumer's
trust policy. `result: "unstable"` records observed divergence. `result: "error"` records
an infrastructure failure with its stage and taxonomy-coded reason. All three are signed,
published, and equally first-class.

`baseline` is present for every non-`error` result, so an `unstable` attestation's baseline
is **run 0's observation** — one observation among divergent ones, not the environment's
outcome-set. `runs.outcomeSetDigest` follows the same convention. Reading a baseline off an
`unstable` attestation without also reading `failure.divergence` is reading past the claim.

The protocol exercises the **image** at `image.manifestDigest`. At reproducibility tier 0
it does not check that the image's workspace corresponds to `source.repo@source.commit`;
that binding is a declaration this protocol does not check (design §5.2).

## Ports

Everything that touches the world is injected: `containerRuntime` (pull by digest, run a
fresh container), `artifactStore` (`putArtifact`), `signer` (a `DsseSigner` object — this
package never sees key bytes), `clock`, and the host-declared `verifier` toolchain
identity. An `EvidenceRepository` adapts to `ArtifactStore` in three lines:

```ts
const artifactStore = {
  async putArtifact(bytes, options) {
    const receipt = await repository.putArtifact(bytes, options);
    return { digest: receipt.reference.digest, size: receipt.size };
  },
};
```

## Digest forms

Scalar digest fields are `sha256:<64 lowercase hex>`. in-toto DigestSet values — subjects
and ResourceDescriptors — are **bare** hex. `toDigestSet` / `fromDigestSet` are the only
sanctioned crossings; the schemas reject each other's form.
