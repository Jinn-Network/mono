# @jinn-network/trust-observation

Class O (observation) and Class A (authority) receipt-container profile, plus
the `writeObservation()` atomic writer
(`docs/superpowers/specs/2026-08-04-headless-operator-rederivation-design.md` §7).

Lives next to `@jinn-network/trust-core`. Class A is a target-state profile,
not a present writer — DSSE-sealed authority receipts reuse trust-core once a
verifier exists.
