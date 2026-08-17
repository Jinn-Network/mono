# @jinn-network/chain-environment-verification

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

Executes the closed-state protocol against a sealed chain environment record, or the
archive-dependent observation protocol, and produces an in-toto Statement inside a DSSE
envelope. Also exports the public runtime surface — materializer, probe executor, script
replayer — for consumers that want to materialize or replay a world without running any
protocol at all.

## What the attestation claims, exactly

`outcome: "closed-reproducible"` means **K fresh materializations under blackhole produced identical canonical observations**, and nothing beyond that sentence. It does not speak to
task solvability, grader discrimination, protocol security, market realism, source-chain
fidelity beyond the class the record declares, provider longevity, cross-runtime equivalence,
or safety outside the sandbox. Those claims have other owners.

`outcome: "archive-observed"` is the weaker sibling: *at the recorded time, the named
providers supplied state consistent with the declared anchor and produced these observations.*
It says nothing about offline reproducibility, provider retention, or durable-supply
eligibility, and marketplace supply advertised as re-verifiable evidence must reference a
`closed-state` record instead.

Every other outcome in the closed vocabulary is a negative fact, signed and published as a
first-class attestation.

## The anchor bound

EIP-1186 proofs bind the committed subset to the **declared** anchor root. That the declared
root is the canonical chain's root at that block is a separate trust step: the attestation
records `anchor.authenticity` as `declared` unless the record commits a header-proof artifact,
in which case it records `header-proven`. Nothing here asserts correspondence with a public
chain that the record itself does not carry evidence for.

## The boundary of the world

A sealed instance has no fork backend. State outside the committed slice does not error — it
reads as empty, on every run. What the slice bounds is fidelity, not repeatability. The record
never claims a whole chain when it carries a slice, and neither does this package.

## Closure has two evidence modes

- **fork-backend-refusal** — the runtime is configured with a fork backend, so the protocol
  provokes an upstream read and requires a loud refusal. An attempt that succeeds is
  `offline-dependency-detected`.
- **sealed-boundary** — the instance has no fork backend, so no attempt is possible and the
  absence of errors evidences nothing. Closure is evidenced instead by the boundary rule
  (out-of-slice reads return empty), by every loaded resource appearing in the resolution log,
  and by cross-run observation equality.

## Ports

Everything that touches the world is injected: `runtime` (materializer + probe executor),
`artifactStore` (`getArtifact` / `putArtifact`), `signer` (a `DsseSigner` function — this
package never sees key bytes), `clock`, and the host-declared `verifier` toolchain identity.
`createAnvilMaterializer` takes an injected process host, RPC transport, workspace, and
artifact source; this package spawns no process and opens no socket. Pass
`supportedControls` from [`ANVIL-CAVEATS.md`](./ANVIL-CAVEATS.md) — the list is measured,
not assumed — so step 3 never attests to a determinism control the launch line did not apply.

## Digest forms

Scalar digest fields are `sha256:<64 lowercase hex>`. in-toto DigestSet values — subjects and
ResourceDescriptors — are **bare** hex. `toDigestSet` / `fromDigestSet` are the only sanctioned
crossings; the schemas reject each other's form.

## Composite attestations do not substitute for component attestations

A `scope: "composite"` attestation covers what exists only in combination — routing has no
collisions, the whole world boots offline, the K-run observation spans both planes. It does not
cover the chain world or any information world on its own; `requiresComponentAttestations`
lists the component records whose own attestations a consumer must additionally obtain.
