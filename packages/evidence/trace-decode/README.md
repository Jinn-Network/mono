# @jinn-network/evidence-trace-decode

Format-keyed decoders that turn digest-bound native-trace bytes into the spans of a
Trajectory record.

Producers bind a native trace and declare the format it is in. This package is the other
half of that contract: given the bytes and the declared format IRI, it returns the spans,
a completeness verdict, and a document the Trajectory package can seal.

Two properties hold for every decoder in this package, and the conformance kit enforces
both:

- **Digest binding is fail-closed.** Bytes whose sha256 disagrees with the declared native
  trace digest are refused; a decoder never speaks about material it cannot prove it read.
- **Decoding is deterministic.** Per `(format IRI, decoder version)`, identical input bytes
  produce identical spans, an identical record, and an identical digest. No wall clock, no
  randomness. A decoder version bump produces *new* records; it never claims identity with
  records produced under a prior version.

Message content is not carried into spans. Each span points at the region of the
digest-bound source it was derived from, and consumers resolve content there.

See `../../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §7.1.
