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
design §12, amendment 2026-08-28). The v2 revisions add what v1 left out: the information
worlds a composite composes (v1 counted them without naming them), the service-runtime images
it pins, the capturer an information world pins, and every supersession pointer. A record's own
enumerated content — a captured corpus's entries — is not an outbound reference.
