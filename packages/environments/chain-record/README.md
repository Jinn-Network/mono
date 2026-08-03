# @jinn-network/chain-environment-record

> Phase C maturity: experimental and publication disabled. Fixtures are exact-record evidence,
> not an approved public compatibility promise; graduation requires approved identity semantics
> and an external packed consumer.

Two sealed record kinds:

- `https://jinn.network/records/chain-environment/1.0` — one sandboxed chain world: a pinned
  simulator runtime, an optional source anchor, a state materialization with its closure and
  fidelity classes, ordered digest-pinned fixtures, the determinism controls, the agent-facing
  capability envelope, and the verification contract.
- `https://jinn.network/records/crypto-environment/1.0` — the composite a task references: one
  chain world, zero or more information worlds, pinned service runtimes, and the composition
  block that binds origin routing, precedence, the miss policy, the endpoint allowlist, and the
  request budget.

Both are sealed once: I-JSON, RFC 8785 JCS applied exactly once, sha256 over those exact bytes
as identity, `sha256:`-prefixed in record bodies. Both are unsigned — attribution arrives through
signed discovery announcements and through attestations, never at the record layer.

These documents state what a world **is**. They make no claim that any world works, reproduces,
or corresponds to a public chain beyond the fidelity class they declare; those claims live in
separately published attestations and are bounded there.

The boundary of a sealed world is the committed slice. A `closed-state` instance has no fork
backend at all, so state outside that slice does not error — it reads as empty, the same way on
every run. What the slice bounds is fidelity, not repeatability: an execution path that wanders
outside it meets empty accounts. A record never says "Ethereum mainnet at block N" when it
contains a slice; it says exactly what the slice holds, and the coverage census says how much
of that is proven against the declared anchor root versus declared as fixture content.

This package has no Jinn runtime dependency and holds no ports. Sealing is re-implemented here
rather than imported; cross-package equivalence is proven by test-only fixtures.
