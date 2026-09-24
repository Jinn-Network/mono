# @jinn-network/trust-core

I/O-free identity, key-binding, authorization, and trust-policy core for the
Jinn Trust and Identity Layer v1
(`docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md`).

This package has **no I/O and no Jinn dependencies**. Its only runtime
externals are `@noble/hashes`, `@noble/curves`, and `zod`. It defines record
schemas, sealing (an independent re-implementation of TEP §6.1 canonical
bytes), validators, policy-chain verification, ceremony content-match, and
the §7.5/§7.5a/§7.5b verification procedures written against injected
resolver/anchor interfaces (`src/interfaces.ts`) that `@jinn-network/trust-resolve`
implements with chain reads.

See `docs/superpowers/plans/2026-07-28-trust-layer.md` for the implementation
plan.

## Verification outcomes

`verifyEnvelopeBinding` returns a `VerificationOutcome`. `ok` is the only
success signal. `resolvedBinding` is attached whenever step 2 resolved
*something*, on failure as well as success — including the
`binding-not-resolved` failure produced when the resolver echoes a binding for
a different Agent IRI than the one claimed, where the outcome carries the
offending binding so the mismatch can be named. Never infer success from the
presence of `resolvedBinding`; read `ok`, and `reason` / `detail` on failure.
