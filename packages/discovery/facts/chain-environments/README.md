# @jinn-network/record-discovery-facts-chain-environments

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

Facts profiles and record-fact recompute for three record kinds:
`chain-environment/1.0`, `crypto-environment/1.0`, and `information-world/1.0`.

A leaf carries both edges — the discovery protocol and the tree that defines the kinds — so
discovery never imports a record-defining package and no record package imports discovery.

Facts are recomputed from a record's own sealed bytes. A card attached to re-serialized bytes
recomputes to nothing and reads as inconsistent.
