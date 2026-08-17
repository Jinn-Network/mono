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
one named negative per §6.1 rule, OpenTimestamps proof builders with synthetic
block headers as verifier-side trust material, AnchorEvidence record helpers, and
`describeAnchorProofVerifierContract` -- the parameterized suite the first
provider implementations must go green against.

Kits precede implementations, so no verifier exists here yet. The suite's own
tests prove it discriminates: trivial verifiers that refuse everything, accept
everything, or call everything pending each fail on exactly the cases they
should. Scope is the proof level (§11 families 1, 2, 6, 7, 9, 10 and the RFC 3161
negative list); the families that need an authenticated bundle snapshot belong to
the `integrity-anchors` check (§8) and to its own kit.

The OpenTimestamps builders cover the shapes a real proof has, not only the
simple ones: a **forked** proof (the digest branches, one branch chain-complete
and one still a calendar promise -- what an upgraded multi-calendar stamp looks
like), a node carrying **two calendar promises**, a complete proof attesting to a
height the verifier has no header for, the fabricated-attestation case, and the
pending/complete upgraded pair. Attestation and operation ordering follows the
reference implementation exactly -- attestations by class tag then by URI string
or numeric height, operations by tag then argument bytes -- because a proof the
reference tooling reserializes differently is a proof whose carried bytes are not
the bytes anyone else computes.

`fixtures/anchor-kit-v1/` holds the only bytes that cannot be builders -- two
captured production tokens, their provenance, the cross-validation transcript
against an independent RFC 3161 implementation, and the canonical kit-minted
token that transcript describes. See that directory's `README.md`.

### Recorded finding 7 -- a v1 signing-certificate attribute is not, by itself, a defect

`fixtures/anchor-kit-v1/token-digicert.der` carries **both**
`id-smime-aa-signingCertificate` (the v1 attribute, whose ESSCertID hash is SHA-1
by definition) **and** `id-smime-aa-signingCertificateV2`, and the kit expects
that token `present`. So the rule the kit enforces for §6.1 rule 6 is precise
about which half matters:

> A `SigningCertificateV2` attribute must be present and must bind an embedded
> certificate. A v1 `SigningCertificate` attribute carried *alongside* it is
> ignored -- its SHA-1 hash is never a comparison the profile makes.

What refuses is the *absence* of a binding V2 attribute, which is why the
negative fixture is named `signingCertificateV1InsteadOfV2`. A rule engine that
refused any token carrying a v1 attribute would reject conformant production
output from a major public authority.

The kit pins both directions: that negative, and a positive variant whose
`ESSCertIDv2` states its DEFAULT SHA-256 `hashAlgorithm` explicitly rather than
omitting it as DER prescribes. Producers emit both encodings and the attribute
binds the same certificate under the same digest either way, so refusing one
would enforce an encoding preference rather than the rule.
