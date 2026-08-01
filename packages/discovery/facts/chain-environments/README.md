# @jinn-network/record-discovery-facts-chain-environments

Facts profiles and record-fact recompute for two record kinds:
`chain-environment/1.0` and `crypto-environment/1.0`.

A leaf carries both edges — the discovery protocol and the tree that defines the kinds — so
discovery never imports a record-defining package and no record package imports discovery.

Facts are recomputed from a record's own sealed bytes. A card attached to re-serialized bytes
recomputes to nothing and reads as inconsistent.
