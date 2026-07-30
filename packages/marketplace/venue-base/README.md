# @jinn-network/marketplace-venue-base

The tier-3 chain-adapter tree for the canonical Base venue: the production plugs — a chunked,
hash-verified log source; a single Safe broadcaster implementing the named Defender-relayer
profile; the claim, settlement and lifecycle writers; the finality and delivery waiters; a
durable posting-intent store; and projector-backed observe — that fill every venue-facing port
the merged stack declares but never implements. Every port takes an injected viem `WalletClient`:
the package holds no keystore, no key-loading code and no key material, ever
(signer-injection only).

See the design: `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §6.1.
Implementation plan: `docs/superpowers/plans/2026-07-30-marketplace-venue-base.md`.
