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

## What a revocation needs

A resolver lists every revocation that names a binding, whoever signed it, and a
revoked binding still resolves. Only §7.4b's authority decides whether one counts,
so a consumer that reads a resolved binding without the whole §7.5 procedure calls
`checkBindingRevocation`, and never reads `revocations` itself. `settlementJoinCheck`
applies the same rule to both legs, and requires the settlement leg to stand at the
envelope's time. Its `deps` and `checkBindingRevocation`'s need a resolver that
answers for every key of an Agent: a revoker's key is rarely in the family the binding
it revokes signs.

## What a ceremony does not show

Nothing here shows that a ceremony is current. A ceremony (§7.2) shows that an
account vouched a key for an Agent IRI. The content match covers those two, and the
account signs nothing about the record that relies on the ceremony. So a record's
`scope`, `validFrom` and `expiresAt` carry the word of the key being bound, not of
the account, and the bound §14 puts on a stolen key through `expiresAt` and `scope`
is only as strong as that.

The specification states no comparison for a ceremony's own times. §7.2 names the
content match and validity windows as the replay defense, rules out nonce tracking,
and lists expiration among the EOA ceremony's fields, but the window §7.5 step 4
checks is the record's, and no text says what to compare a ceremony's times with.
`verifyEnvelopeBinding` reads no time from a ceremony, whose evidence verifies offline
forever, and the native profile leaves expiration out. Two other rules in this area
cannot be checked here either. A revocation has no field for §7.4b's "fresh ceremony".
§7.4c's rule on a witness older than an owner change needs a chain fact and the
evidence's time, and neither reaches any interface here: `verifyHostedCeremony` is
handed only the record. So nothing applies that rule yet.
