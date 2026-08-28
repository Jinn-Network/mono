# @jinn-network/record-discovery-facts-chain-environments

> Candidate in `implementations-v1`. Eligible for receipt-gated canary; that is not independent ratification.

Facts profiles and record-fact recompute for three record kinds:
`chain-environment/1.0`, `crypto-environment/1.0`, and `information-world/1.0`.

A leaf carries both edges — the discovery protocol and the tree that defines the kinds — so
discovery never imports a record-defining package and no record package imports discovery.

Facts are recomputed from a record's own sealed bytes. A card attached to re-serialized bytes
recomputes to nothing and reads as inconsistent.

## Join edges

Facts profiles must declare their kind's complete outbound-reference set (record-discovery
design §12, amendment 2026-08-28). The v2 revisions add what v1 left out. A chain world pins a
great deal by digest and named almost none of it: header proof, materializer, source proofs,
fixture-coverage manifest, fixture modules, tool-interface schemas, probe suite, observation
schema, baseline observation, comparator. The composite counted its information worlds without
naming them, and left its service-runtime images and miss-policy body unnamed. Every kind gains
its supersession pointer, and the information world its capturer.

A record's own enumerated content — a captured corpus's entries — is not an outbound reference.
