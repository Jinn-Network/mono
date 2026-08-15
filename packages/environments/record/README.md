# @jinn-network/environment-record

> Phase C maturity: experimental and publication disabled. Transitive use in native-role closure
> is not ratification; an approved record-family decision and independent producers and consumers
> are required before compatibility is promised.

The sealed environment description record kind.

One record describes exactly one environment: one `(source, image, platform, invocations,
parser)` binding. The document is I-JSON, canonicalized once under RFC 8785 JCS, and the
sha256 of those exact bytes is the record's identity, written `sha256:<64 lowercase hex>`.
Sealed once, forever — there is no expiry field and no status field, and nothing in this
package ever rewrites a sealed record.

The record is sealed but **unsigned**. It carries no claim about whether the environment
works: that claim belongs to separately published verification attestations, which bind to
this record by digest, and which state bounded observations ("K consecutive runs of the
declared test scope produced identical outcome-sets under the declared controls") rather
than grades. A producer MAY additionally wrap the record in a DSSE envelope; consumers MUST
NOT require it.

`invocations.test` is the declared scope: two records over the same image with different
test scopes are different environments by identity, which is the point.

Digest discipline: every digest in the record body carries the `sha256:` prefix. In-toto
DigestSet subject values, by contrast, are bare hex — `bareHexDigest` converts, and the
conformance kit carries the confusion fixture.

Rejections at the sealing boundary come in two spellings. `InvalidDocumentError` carries a
schema failure, a refused `__proto__` member, or bytes that are not the one exact canonical
encoding. `IJsonNumberError`, `IJsonStringError`, and `UndefinedArrayElementError` carry a
value no canonical encoding admits at all — a fractional number or an unpaired surrogate
inside an open node, an `undefined` array element. All four carry
`category: "invalid-document"`; catch on that, not on `InvalidDocumentError` by class.

Design reference: `../../../docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md` §4 — a claim this record never makes on its own behalf.
