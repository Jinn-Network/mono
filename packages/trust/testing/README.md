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
