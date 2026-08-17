# `@jinn-network/trust-testing`

Fixtures and conformance kit for the Jinn Trust and Identity Layer v1
(`docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md`).

This first slice carries the cross-package **sealing algorithm-equivalence**
leg against `@jinn-network/evidence-protocol` (§16, program ruling §7.15):
`@jinn-network/trust-core` and `@jinn-network/evidence-protocol` must produce
byte-identical DSSE pre-authentication encodings and byte-identical
`recordDigest` values for the same already-serialized input bytes.
`evidence-protocol` exports no canonical-JSON serializer, so genuine
canonical-byte equivalence is asserted separately against
`@jinn-network/task-execution-protocol` once that package exists (gated
Task T17); this package's own key-order-sensitive fixture is pinned as a
`trust-core` self-consistency drift guard in the meantime.

Later tasks add the reusable in-memory `BindingResolver`/`AnchorResolver`/
`WitnessVerifier` fakes, the `describeTrustVerificationContract` conformance
battery, the §16 adversarial set, and the §13 walkthroughs.

See `docs/superpowers/plans/2026-07-28-trust-layer.md` for the implementation
plan.

## The anchor-evidence conformance kit

`src/anchor-kit/` carries the §11 kit of the [pluggable integrity providers
design](../../../docs/superpowers/specs/2026-08-17-pluggable-integrity-providers-design.md):
a test-only DER encoder built on `trust-core`'s reader primitives, a
deterministic RFC 3161 fixture authority that mints a valid `TimeStampToken` and
one named negative per §6.1 rule, OpenTimestamps proof builders (pending,
complete, fabricated, and the upgraded pair) with synthetic block headers as
verifier-side trust material, AnchorEvidence record helpers, and
`describeAnchorProofVerifierContract` -- the parameterized suite the first
provider implementations must go green against.

Kits precede implementations, so no verifier exists here yet. The suite's own
tests prove it discriminates: trivial verifiers that refuse everything, accept
everything, or call everything pending each fail on exactly the cases they
should. Scope is the proof level (§11 families 1, 2, 6, 7, 9, 10 and the RFC 3161
negative list); the families that need an authenticated bundle snapshot belong to
the `integrity-anchors` check (§8) and to its own kit.

`fixtures/anchor-kit-v1/` holds the only bytes that cannot be builders -- two
captured production tokens, their provenance, the cross-validation transcript
against an independent RFC 3161 implementation, and the canonical kit-minted
token that transcript describes. See that directory's `README.md`.
