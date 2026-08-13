# Truthful Inspect OCI isolation accounting — 2026-08-12

This is the sanitized, credential-free correction proof for the Benchmark
Product's Inspect OCI venue. It corrects the isolation-accounting defect
recorded in issue #2586 without making a new OpenAI request or changing the
previously proven provider integration.

## Result

- **OCI lifecycle: PASS.** The real pinned Inspect worker and fake Responses
  broker completed selection, preview, quote, lock, official launch,
  collection, reporting, workspace verification, publication, source-workspace
  deletion, and detached verification.
- **Truthful isolation accounting: PASS.** The sealed Run admitted
  `oci-container`; the configured venue inventory was
  `unrestricted` plus `oci-container`; both expected cells therefore recorded
  isolation as `unverifiable`, never `match`.
- **Consistent disclosure: PASS.** Results, Report limitations, Report
  disclosure counts, the claim package, workspace verification, and detached
  verification all used the Run-derived multi-policy wording and counted two
  isolation-unverifiable cells.
- **Negative recomputation: PASS.** Replacing one OCI cell's isolation result
  with `match`, resealing that Matrix, and pointing the workspace at it was
  rejected at `matrix-rederivation` with a typed `record-integrity` error.
- **Native artifacts: PASS.** Inspect `0.3.255`'s public `read_eval_log()` API
  accepted both genuine `.eval` files, and `inspect view bundle` generated a
  viewer with networking disabled.

## Pinned environment and implementation

- Canonical base: `e9db60afae72ac47d221a2e688b9c3da81ad2087`
- Branch under proof: `codex/truthful-inspect-isolation`
- Worker image ID:
  `sha256:9d48cf72b0660fb9ce0d674e83f68885db9b135640a3bd5f10e57dd98b840046`
- Platform: `linux/amd64`
- Python: `3.11.9`
- Inspect AI: `0.3.255`
- Inspect Evals: `0.16.0`
- OpenAI Python SDK: `2.53.0`
- Docker client/server: `28.5.1`; API: `1.51`
- Isolation-derivation source SHA-256:
  `4c1352d6d789b51e6aa8f9f4ec3d93d8a5ac683a5fe47cb1d7a7cc5fd4b47d45`
- Matrix-assembly source SHA-256:
  `49b2de2ba8fe487dc087667597356517c6c07daf77ea22aec75d8b3a293e7055`
- Venue-honesty source SHA-256:
  `e4fd6a7fa7d3c15435fcfe0d260aea86ff80b03dba13d390a98e1a5704c41e2d`
- Claim-consistency source SHA-256:
  `6e09c9b1fbdf7fcce28dfb8c630ecbf14da5b76df5c7721292514818e89073c5`

The proof ran the repository's unmodified
`hermetic_eval.py@broker_isolation_eval` fixture through the public Inspect
`ModelAPI` extension. Two arms, `luna-none` and `luna-low`, received
deterministic fake Responses bodies for the exact locked model name. This
exercised native transcript creation and the complete product evidence path
without an external provider call or reusable credential.

## Corrected evidence observations

The detached proof bundle had identity
`8f8e1cdd8b6fb0640b8e5defdffba984e2d6e8adaef8ea64d4fa50b3725c4077`.
Its principal record identities were:

- Run: `e48b4dc70bc3f79be2b06308716269315ccdb76b1471770080b86e0bc4aa0e65`
- Matrix: `0ffe39471b78b8f70d6268cade9b9cd6a32de3c397f908632ed36b2d308e3eff`
- Report: `98b1156dcef6b11bc9935dbd920da416da2e94bf316f5a9ed8e124057d536065`
- Report envelope:
  `5431c204dd568142dc17761427a948b67cc096da44b939185cf79ba867450e33`
- Claim package:
  `02ac92d2394b0978c4d351c1b0b0a94f47944b3f3de2e980801b2b99c5f9aea5`
- Sealed runtime selection:
  `f2b396e92fed035d39a3ae237669cb448e4fe1d1e1b04037aa70ac4163e3e440`

The Matrix was complete with two expected and two judged cells. Its isolation
values were exactly `unverifiable`, `unverifiable`. The Report's isolation
counts were `match: 0`, `mismatch: 0`, `unverifiable: 2`. The claim package
reported the same count and disclosed:

> The isolation axis is unverifiable: this configured venue admits both
> unrestricted and OCI-container execution, so its multi-policy inventory
> cannot establish containment from admission alone.

After the originating workspace was deleted, the detached bundle passed all
six checks: manifest, evidence closure, trust, Matrix re-derivation, Report
verification, and claim consistency. Native log SHA-256 identities were
`77170ba5f5c9a08feaef6d391eda20ed94d8c76bbeed724d1651898bf1edc822`
and `d96eaf817d569c4b24354ad3f2551334bc5e8ae39381fe08b6311f9fd1051500`.

## Compatibility observation

The current native and local-Python regression paths preserve the documented
singleton `unrestricted` inventory and its vacuous isolation `match`. The
committed 2026-08-10 credential-free Inspect bundle still contains four such
historical `match` values and the original byte-exact singleton wording.

That old bundle does not pass the current portable verifier for an unrelated,
pre-existing reason: it predates the now-required sealed Inspect runtime
selection artifact and fails closed at `evidence-closure`. This correction did
not weaken that requirement or rewrite historical evidence. Current detached
bundles include the sealed selection and pass verification as shown above.

## Sanitized verification commands

```bash
docker build --platform linux/amd64 \
  --tag jinn-inspect-worker:0.3.255-isolation-proof \
  packages/benchmark-product/core/src/runtime/inspect

JINN_INSPECT_OCI_IMAGE=sha256:9d48cf72b0660fb9ce0d674e83f68885db9b135640a3bd5f10e57dd98b840046 \
JINN_INSPECT_OCI_DATASET_CACHE=/absolute/path/to/empty-test-cache \
JINN_DOCKER_PATH=/absolute/path/to/docker \
yarn vitest run \
  src/runtime/inspect/broker.integration.test.ts \
  src/runtime/inspect/oci.integration.test.ts

colophon bundle verify --bundle /path/to/copied-bundle --json
```

The OCI integration suite passed five tests. No provider credential or network
request was used. The generated viewer, detached bundle, temporary workspace,
empty dataset cache, fake-provider response, sentinel, and transient Docker
resources were removed after recording these sanitized identities and
observations. None is a repository artifact.

## Claim limits

This proof establishes truthful accounting and recomputation, not positive
per-cell containment evidence. OCI task execution remains an operational
boundary, while the Jinn isolation axis is `unverifiable` until a future slice
defines trustworthy per-cell evidence. The score remains
`same-execution-scorer`, not independent evaluation. The real Luna calls and
native-log observations remain documented in the
[2026-08-11 proof and erratum](./2026-08-11-inspect-luna-broker.md).
