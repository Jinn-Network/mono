# @jinn-network/evidence-offer

The sealed **offer** record kind: one holder-signed statement of terms for one
digest-addressed subject. I/O-free — schema, sealing, verification, and supersession
semantics, with every network- or chain-touching concern injected as a port.

Kind: `https://spec.jinn.network/records/offer/v1`
Media type: `application/vnd.jinn.offer.v1+json` (also the DSSE envelope's `payloadType`)

## Why a record and not a field

Commercial terms cannot live inside sealed subject bytes. Repricing would change the
record's identity, and a holder who is not the producer could never set terms at all. The
task-execution protocol already codified the first half of that rule — `FORBIDDEN_TASK_FIELDS`
in `packages/task-execution/protocol` bans `price`/`reward` from sealed Tasks. The evidence
market applies the same rule and expresses the terms as an evidence-native sealed record, so
they are tamper-evident, announceable, and bindable by digest.

The protocol takes no fee and no cut, ever. There is no fee field to take one with.

## The record

```jsonc
{
  "kind": "https://spec.jinn.network/records/offer/v1",
  "subject": "sha256:…",            // one digest of any digest-addressed content
  "rails": [                         // zero or more; sorted and unique by rail
    { "rail": "https://…/rails/eip155-8453-erc20-usdc/v1",
      "to": "0x…",                  // rail-specific destination, opaque here
      "amount": "1500000" }          // exact integer, the rail's native units
  ],
  "gate": { "uri": "https://gate.example/offers" },  // where to pay and collect bytes
  "supersedes": "sha256:…"          // optional: the offer this one replaces
}
```

- **One offer prices one subject, always.** Usually a sealed record; equally an artifact
  such as an OCI image blob — which is what makes an environment sellable: the environment
  record, its image, its attempts and its verdicts are each their own offer.
- **Zero is first-class.** An empty `rails` list is an explicit free offer, served on sight.
- **Absence is meaningful.** A record with no live offer is not offered. Silence is not free
  — which is why `rails` is required and may be empty, rather than optional.
- **Rails are self-describing and the vocabulary is open.** A rail identifier is any
  absolute URI, joining the identifier namespace the way scheme IRIs do. No rail binding
  ships with this package; concrete rails arrive as their own adapters. `to` keeps that
  openness — its syntax is opaque, because no address shape can be imposed on a rail that
  does not exist yet — but it must be non-blank and free of control characters and Unicode
  bidi formatting characters, which exist only to make one destination display as another.
- **No reference currency and no conversion, anywhere.** Equivalence across a multi-rail
  offer is the holder's assertion, sealed with the offer.
- **Repricing is supersession, never mutation.** A new price is a new record with a new
  digest naming the old one.

Amounts are integer strings because native units routinely exceed the exact-integer range a
JSON number carries. They are written without sign, decimal point, or leading zeros, and a
zero amount is refused: free already has a spelling, and it is the empty list.

Rail entries are unique by `rail` and sorted by `rail` in UTF-16 code-unit order. Unique
because "pay on one of its rails" is ambiguous when one rail carries two prices, and the
gate matches a rail entry by integer-exact amount. Sorted because equal terms must seal to
equal bytes and JCS does not sort arrays, so the schema does.

Both rules compare identifiers as exact strings, so a rail identifier must arrive already in
its normalized spelling. Without that, `HTTPS://R.EXAMPLE/v1` and `https://r.example/v1` would
pass uniqueness and sortedness alike and the offer would carry one rail at two prices.

`new URL` round-tripping the string unchanged is most of that rule but not all of it, because
WHATWG round-trips several spellings RFC 3986 calls equivalent. So the check also refuses a
trailing-dot host (`r.example.` is the same DNS name), a percent-escape that is not in RFC 3986
§6.2.2 normal form (`%2f` for `%2F`, `%62` for the `b` it encodes), and an empty query or
fragment (`…/v1?` and `…/v1#` address the same thing as `…/v1`). Each of those was otherwise a
second identifier for one rail — a seller could seal `…/v1` at one price and `…/v1?` at another,
and both would pass.

What the rule does **not** reach is opaque hosts and opaque paths, which round-trip verbatim:
`ipfs://BAFYBEIGD/x` and `ipfs://bafybeigd/x` are two distinct rails here, as are `urn:UUID:x`
and `urn:uuid:x`. A rail vocabulary minted under such a scheme owes its own spelling rule; this
check cannot supply one without knowing that scheme's equivalence law.

Sealing refuses an unsorted list rather than reordering it, because a canonicalizer that
silently rewrites content is how one document quietly becomes another; `sortOfferRails` puts a
producer's entries in the required order without every producer reimplementing locale-free
ordering.

Top-level keys beyond the ones above must be namespaced (reverse-DNS or absolute URI, TEP
§21.3). The same rule applies inside a rail entry and inside `gate`.

## Signing is required for this kind

Most record kinds may be sealed unsigned. This one may not: "only the holder can offer" is
enforced by resolving the envelope signature, through key-binding records, to a bound
identity. So `sealOffer` takes a `DsseSigner` and there is no unsigned seal entry point — an
unsigned offer would be a price anyone could publish for anyone else's bytes.

The offer's identity is the digest of the **sealed DSSE envelope**, and that is what
`supersedes` names.

```ts
const sealed = await sealOffer({ offer, signer });   // → { envelopeBytes, digest, offer }

const outcome = await verifyOffer(
  { envelopeBytes: sealed.envelopeBytes, key, holder, atTime },
  { bindingResolver, witnessVerifier, dsseVerifier },  // trust-core ports
);
```

`verifyOffer` checks both halves and needs both: `parseOfferEnvelope` alone proves only that
someone wrote a price down. The binding must carry the offers trust scope
(`OFFER_TRUST_SCOPE`) at the offer's effective time.

Read the success case precisely. `ok: true` establishes that the signing key is bound to the
agent you named, at that time, in that scope — it does not establish who that agent is. The
holder IRI is an input, not something read out of the record, so it has to come from an
independent claim: in practice the offer's announcement, on a chain that is holder-owned. A
caller who derives the holder from the signing key has asked the signature to vouch for
itself and learned nothing.

## Supersession

"The current price" is a property of a *set* of offers, never a field on one, so
`resolveLiveOffers` folds a set of verified offers into the live ones plus diagnostics. A
supersession is honored only when it names an offer in the set with the same subject and the
same holder — an offer prices one subject, and only the holder can retire their own offer.
A fork (two successors to one predecessor) leaves both live; the holder's own append-only
announcement chain, not this package, orders them.

## Two consequences worth stating plainly

**Money is never aggregated, so there is no settlement machinery.** One offer prices one
subject and payment goes to the destination that offer names. Buying a set of N records is
therefore N payments, each routed directly to its own payee in full. No split, escrow-pool,
netting, or settlement component exists anywhere in this stack, because nothing ever holds
two parties' money at once.

**Naming.** `packages/marketplace/*` already occupies the task-execution market, so this
kind lives with the evidence group as `packages/evidence/offer`. Final group naming can ride
the broader repo-topology discussion; the kind URI and media type above do not move with it.

## Companions

The offer is one of three pieces. The announcement facts profile lets an index render a
priced catalog from cards alone, and the paid-retrieval gate is the reference implementation
a holder runs to sell bytes. Neither is in this package.

## Testing kit

`@jinn-network/evidence-offer/testing` exports `describeOfferRecordConformance()`, the
conformance driver any producer or consumer runs to prove it reproduces the frozen record
surface, and `createFixtureOfferSigner()`, the deterministic signer the shipped golden
envelopes under `fixtures/offer/` were sealed with. That signer emits a hash, not a
cryptographic signature: DSSE signature checking is an injected port throughout this tree, so
the fixtures' signature bytes are opaque to every code path they exercise. It is for fixtures
and tests only.
