# @jinn-network/information-world

The sealed information-world record kind, its canonical request key, and its loopback replay
service.

One record describes exactly one information world: a corpus of digest-pinned captured
responses, the request-key policy that maps a request to a corpus entry, the fail-closed miss
policy that answers an uncaptured request, the capture provenance, and the corpus fidelity
class. The document is I-JSON, canonicalized once under RFC 8785 JCS, and the sha256 of those
exact bytes is the record's identity, written `sha256:<64 lowercase hex>`. Sealed once,
forever — there is no status field, and nothing in this package ever rewrites a sealed record.

**The corpus is that world's whole web.** A request that is not in the corpus receives the
record's own declared miss response. CE6's closed execution profile admits only loopback replay:
production source statically rejects undeclared transport and ambient capabilities, and
`src/service.ts` is the sole file permitted to import `createServer` from `node:http`. The
conformance check also runs the actual replay service inside Docker's network-denied namespace,
where loopback succeeds while external TCP and DNS cannot. The syntax-aware source policies are
maintainability gates; the network-denied runtime boundary is the egress guarantee.

**Fidelity is a declaration, not a proof.** `captured-snapshot` records what an author states
a source returned at a stated time for stated requests. This package makes no claim that the
source ever returned those bytes; cryptographic response provenance is a parked extension
(design §13). `synthetic` records authored fixtures and is forbidden from carrying capture
provenance at all.

**Corpus content is data, never instruction.** Response bodies are attacker-authorable text
delivered into an agent's context (design §8). This package copies them to the wire byte for
byte and interprets none of them: no `eval`, no `new Function`, no templating, no
content-conditional behavior anywhere in the response path.

Digest discipline: every digest in the record body carries the `sha256:` prefix. In-toto
DigestSet subject values, by contrast, are bare hex — `bareHexDigest` converts, and the
conformance kit carries the confusion fixture.

See `../../../docs/superpowers/specs/2026-07-31-chain-environment-family-design.md` §4.4.
