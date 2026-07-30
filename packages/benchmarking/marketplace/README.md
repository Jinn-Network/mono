# @jinn-network/benchmarking-marketplace

The sole benchmarking package that imports marketplace binding and projector surfaces. It implements marketplace-backed `AssemblyPorts` for `@jinn-network/benchmarking-run`: anchored close boundary, projector-derived input scope, and settled/reported cost sourcing.

Attempt URIs are never derived here; they enter the Matrix only from authoritative observe/projector facts after the operator claim path. Pinning axes are honestly `unverifiable` until #2040/#2041 land.

See `docs/superpowers/plans/2026-07-28-benchmarking-application.md` M7 and program rulings §7.135–§7.144. Shipped-surface record: `docs/superpowers/specs/2026-07-28-benchmarking-implementation-addendum.md`.

## Coherent close assembly

When `marketplaceAssemblyPorts` receives `coherentClose`, callers must supply a frozen `authorityProjection` (`freezeAuthorityProjection` / `deriveAuthorityProjectionResolver`). InputScope and settled cost share that resolver exactly; mutable `eventsThroughAnchor` is rejected. Standalone assembly (no `coherentClose`) may pass `eventsThroughAnchor`; the factory derives the projection once internally.
