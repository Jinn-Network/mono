# Offer catalog fixtures

`catalog/` holds three sealed offer envelopes — the exact bytes, not a re-encoding —
mirrored from the offer record package's own golden corpus
(`packages/evidence/offer/fixtures/offer/{free,priced,superseding}.json`). They are the
smallest catalog that exercises a real listing: one subject, one free offer, and two
priced offers that quote the same rail at different amounts, one of which supersedes
the other.

| File | Subject | Rails |
|---|---|---|
| `catalog/free.json` | `sha256:aaaa…` | none — a free offer |
| `catalog/priced.json` | `sha256:aaaa…` | OLAS `2500000000000000000`, USDC `1500000` |
| `catalog/superseding.json` | `sha256:aaaa…` | USDC `900000`; supersedes the priced offer |

They ship in the published archive under the `./fixtures/*` export, because a consumer
demonstrating a card-only catalog needs real record bytes to recompute cards from, and
this leaf is the one sanctioned edge between the discovery tree and the offer record
kind — a consumer on the far side of that boundary reaches the offer world through here
or not at all.

Mirroring is a copy, so `src/fixtures.test.ts` pins each file byte-for-byte against the
record package's golden. A drift there is a failing test, never a silently forked
fixture.
