# @jinn-network/evidence-gate

The reference **paid-retrieval gate**: the thing a holder runs to sell bytes. Bounded
exact-byte serving for one offered subject, with a per-rail payment check in front. I/O-free
— every side effect is an injected port, so this binds to whatever a holder actually runs.

It is the third piece of the evidence market. The sealed terms are
[`@jinn-network/evidence-offer`](../offer); the announcement facts profile that lets an index
render a priced catalog lives with record discovery. This package honors the terms.

## One flow, free and paid

1. A buyer holds the offer — offers are always freely retrievable — and pays on one of its
   rails, referencing the offer's digest.
2. They ask the gate the offer names for the subject.
3. The gate verifies the payment through a per-rail adapter, then serves the exact bytes.
4. The buyer checks that the received bytes hash to the offer's `subject` digest. **That hash
   check is the whole warranty.** Nothing else was promised, and nothing else needs to be.

A zero-price offer — the empty `rails` list — skips steps 1 and 3 entirely. Same gate, served
on sight.

```ts
const gate = createRetrievalGate({
  offers: createInMemoryOfferSource([sealedOffer.envelopeBytes]),
  subjects: createRepositorySubjectSource(repository),
  rails: [myRailAdapter],
  challenges: createInMemoryChallengeStore(),      // needed once a rail is public
  deliveryStatements: { signer },                  // optional; omit and the gate emits nothing
});

const outcome = await gate.request({
  offer: "sha256:…",
  payment: { rail: "https://…/rails/…/v1", reference: "0x9f…" },
});
// → { status: "delivered", subject, bytes, statement?, warnings }
// → { status: "challenge", challenge }        on a publicly visible rail
// → { status: "refused", code, detail }
```

A refusal is a value, never a thrown error: a gate answers strangers, and a buyer who
mistyped a rail identifier deserves the same shaped answer as one whose payment has not
landed yet. A *port* that throws is left to throw — a resolver outage is not a statement
about the terms and must never read as one.

## The rail adapter interface

The gate implements no payment system and knows no rail's rules. It consumes adapters with a
three-step lifecycle:

| Step | Method | What it is |
|---|---|---|
| observe | `observe` (required) | a payment referencing offer digest X exists and matches a rail entry exactly |
| deliver | `deliver` | the rail's own act at the moment of delivery |
| claim | `claim` | taking the payment, where that is a separate act |

Both `deliver` and `claim` must be **idempotent for one payment**. The gate keeps no record
of who has collected what — that is what makes redelivery free — so it runs both acts on
every collection of the same purchase. `already-delivered` and `already-claimed` are
successes and are how a rail says so. This matters most on an `on-delivery` rail, where the
delivery act *is* the taking: settling twice charges twice, and refusing the repeat breaks
free redelivery.

Three steps rather than one `verify` call, deliberately. That is what admits
assurance-bearing rails without reshaping the gate: an escrow contract observes a funded
escrow, releases it on delivery, and refunds on timeout; a key-reveal rail observes a
purchase and reveals the key at delivery, which is *simultaneously* the claim; a card
processor observes an authorization and captures it as its own act. A single verify call
would force all three to pretend payment is instantaneous and final at observation time.

Each adapter carries a self-description an index can badge:

- **`trustModel`** — `assured-by-code`, `assured-by-institution`, `assured-by-named-party`,
  or `unassured`, with `assuredBy` naming the party for the three that have one. `unassured`
  is a legitimate answer and the honest one for most chain rails.
- **`settlement`** — `already-settled` (nothing left to take), `on-delivery` (delivery *is*
  the taking), or `explicit-claim` (capture is its own act).
- **`paymentsArePubliclyVisible`** — whether an onlooker can see that a payment was made.

`assertConformingRailAdapter` refuses, at construction, every adapter whose description and
methods disagree: an `on-delivery` rail that also implements `claim` would charge twice, and
a rail that says its payments are public but ships no payer-control check does not fail — it
serves the first onlooker to quote the transaction hash. Loud at construction is the only
place those are cheap.

**In scope here: the interface and one in-memory test adapter.** No production rail binding
ships with this package. Rail authors run `describeRailAdapterConformance` from
`@jinn-network/evidence-gate/testing` against their own.

## What the gate enforces itself

An adapter is third-party code speaking for a payment system the gate knows nothing about,
so after every `observe` the gate re-checks the observation itself: that it names the payment
the request named, and that the referenced offer, the destination, and the amount are the
*sealed* ones. Amount equality is integer-exact,
including against overpayment — a gate cannot make change, and a payment for a different
amount is a payment on different terms. A lax, buggy, or hostile adapter can misjudge its own
rail; it can never widen the offer.

`maxSubjectBytes` bounds what the gate hands over, not what it reads: `SubjectSource` returns
whole bytes, so by the time the bound applies the source has already produced them. A source
reading from somewhere unbounded owes its own read bound — which is where it belongs anyway,
since only the source knows a subject's size before fetching it.

The description a gate decides from is the frozen copy taken when the adapter was installed,
and so are the four methods it calls. All of them are ordinary properties of third-party code
and may be getters: one answering `paymentsArePubliclyVisible: true` at construction and
`false` afterwards would otherwise pass the payer-proof requirement and then be served to
onlookers with no challenge at all.

The gate also hashes the subject bytes before serving them. The buyer would catch a mismatch
too, but catching it here means a holder whose store has quietly corrupted learns it from
their own gate rather than from a customer.

## The three rules

**Pickup belongs to the payer.** On a rail whose payments are publicly visible, the gate
answers the first request with a one-shot challenge and serves only an answer the paying key
produced. Onlookers cannot redeem someone else's payment, and a proof copied off the wire
does not work twice.

**Redelivery to the same payer is free.** No one-time-download bookkeeping exists anywhere in
this package — nothing records who has collected what. The gate runs the rail's delivery and
claim acts on every collection, and `already-delivered` / `already-claimed` are successes,
which is what makes the second collection cost nothing.

**A payment made while terms were live is honored even after they are superseded.** The gate
does not consult supersession at all. Repricing announces new terms and says nothing about
the old ones; the holder's own announcement chain plus the rail's timestamps order any
dispute. A holder who wants to *stop* honoring terms takes them off the gate — that is
delisting, a different act, and the gate then answers `unknown-offer`.

## What the gate deliberately does not do

- **It does not verify the holder's signature on the offers it serves.** A gate serves the
  offers its own holder put on it. Resolving a signature through key-binding records is the
  *buyer's* step, before they pay, and doing it here would put an announcement-chain walk in
  front of every byte.
- **It does not price, convert, split, or settle.** One offer prices one subject and payment
  goes where that offer says. Nothing in this stack ever holds two parties' money at once.

## The delivery statement (optional)

On delivery the gate MAY hand the buyer a small sealed, holder-signed record: provenance of
acquisition for them, verifiable sales history for the holder.

Kind: `https://spec.jinn.network/records/delivery-statement/v1`
Media type: `application/vnd.jinn.delivery-statement.v1+json`

```jsonc
{
  "kind": "https://spec.jinn.network/records/delivery-statement/v1",
  "offer": "sha256:…",
  "subject": "sha256:…",
  "payment": { "rail": "https://…/v1", "reference": "0x9f…" },  // absent on the free path
  "deliveredAt": "2026-08-31T12:00:00.000Z"
}
```

Sealed the way an offer is: JCS canonical payload, DSSE envelope under the media type, signed
by the holder, identity being the digest of the envelope bytes. It ships inside this
implementation package rather than as its own sealed-platform record package because the gate
is its only producer and only consumer today; a second one of either is the signal to promote
it, and the kind URI and media type do not move when that happens. It carries no price — the
offer it names carries the terms, and a second copy of a number is a number that can
disagree with the first. `payment` absent is the free path, and absence is its only spelling.

**Supplying a signer is the flag.** Without one the gate emits nothing, and a gate that emits
nothing is conforming. If a signer is supplied and fails, the buyer still gets the bytes they
paid for and the outcome carries a `statement-not-emitted` warning: the statement is optional
by design, so its failure must not cost a delivery, and must not vanish silently either.

The payment `reference` is a string rather than open JSON. On every rail that exists it is a
transaction hash or an invoice id, and keeping it a string keeps a sealed statement inside the
I-JSON subset without inheriting the opaque-value canonicalization problem for a generality no
rail has asked for. It carries the same display-safety rule as an offer's `to`, because a
reference is what a human reads back in a dispute.

## Ports

| Port | What it answers |
|---|---|
| `OfferSource` | the sealed envelope **bytes** for an offer digest, or `null` — which is delisting |
| `SubjectSource` | the bytes for a subject digest, or `null` |
| `ChallengeStore` | one-shot questions for publicly visible rails |
| `Clock` | the delivery time a statement carries |

`OfferSource` returns bytes rather than a parsed offer because an offer's identity *is* the
digest of those bytes: the gate re-derives it and compares, instead of taking a lookup key's
word for which offer this is.

Shipped bindings: `createInMemoryOfferSource`, `createInMemorySubjectSource`,
`createInMemoryChallengeStore` (bounded, so an unauthenticated stranger cannot exhaust
memory), and `createRepositorySubjectSource`, which reads an evidence repository's artifact
store — the repository contract's one purely digest-addressed read. `getRecord` is keyed by
`(family, digest)` and a subject has no family, so a holder selling sealed records writes
their own five-line `SubjectSource`; the interface is the extension point.

## Testing kit

`@jinn-network/evidence-gate/testing` exports `createTestRailAdapter` (the in-memory rail,
with trust model, settlement, and payment visibility as construction options),
`describeRailAdapterConformance` (the runnable contract every rail adapter owes the gate),
`sealTestOffer`, `signTestPayerProof`, and `createFixtureSigner`.

That signer emits a hash, not a cryptographic signature. DSSE signature checking is an
injected port throughout this tree, so its bytes are opaque to every code path these helpers
exercise. Fixtures and tests only.
