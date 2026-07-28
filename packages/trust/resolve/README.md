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

See `docs/superpowers/plans/2026-07-28-trust-layer.md` for the implementation
plan.
