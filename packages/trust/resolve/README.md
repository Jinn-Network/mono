# @jinn-network/trust-resolve

RPC-dependent chain-fact resolvers for the Jinn Trust and Identity Layer v1
(`docs/superpowers/specs/2026-07-27-trust-and-identity-layer-design.md`).

This package implements the injected interface types `@jinn-network/trust-core`
defines (`ChainFactResolver`, `WitnessVerifier`, `AnchorResolver`,
`BindingResolver`) with real chain reads: ERC-721 `ownerOf`, ERC-8004
`getAgentWallet`-at-block (promoting `client/src/erc8004/publisher-safe-resolver.ts`),
EIP-1271 witness verification with archive re-execution fallback (§7.2a),
anchor lookups, and the §7.3 at-time binding resolution composition. It is
the RPC package of the trust tree -- `viem` and node network I/O are
expected here (they are banned everywhere else in `packages/trust/`).

`createBindingResolver` does not resolve a binding whose ceremony nothing has
verified: `@jinn-network/trust-core` takes a resolved binding as the resolver's
word for the ceremony legs that need I/O. It verifies `eoa` offline and runs the
`agentId` composition leg itself. `safe`, `oidc-machine` and `github-human`
bindings resolve only when the host passes `verifyHostedCeremony`. A record
that does not resolve still counts when deciding which binding came first: it
may be the true genesis.

`recordSignedByItsKey` is required, because this package has no DSSE verifier of
its own. A record its key never signed does not resolve and cannot win a conflict
over the key. Ceremony evidence that cannot be read is a failed ceremony. A
stored entry that is not a key binding never resolves and gives no authority, but
if its anchors can be read it still counts when deciding which binding came first.

A resolve that could not find out is not a refusal. `resolveBinding` answers `null`
when nothing resolves, and throws when a store, an anchor read, the registry or a
`verifyHostedCeremony` leg failed, so a caller can tell the two apart. Both fail
closed. A leg must answer `false` for a record it cannot read: a store may hold
anything, and a throw reads as an outage. `createWitnessVerifier` does the same: an
archive read that fails throws, and a contract that reverts is an answer.

See `docs/superpowers/plans/2026-07-28-trust-layer.md` for the implementation
plan.
