# anchor-kit-v1 — OpenTimestamps stamp provenance

Where the two committed `.ots` proofs came from, what they are evidence of, and
how to re-derive every value the kit asserts about them.

The anchor-evidence design (§11) builds its OpenTimestamps fixtures
deterministically (`src/anchor-kit/ots-builder.ts`), and that is the right
default — a builder never drifts out of agreement with itself. These two files
are the exception the design names: a builder can only produce a *self-consistent*
proof, and §11 family 10 exists precisely because self-consistency proves
nothing. A proof whose commitment sits in a Bitcoin block is the one artifact in
this kit whose truth a third party can check against something nobody here
controls.

## The stamp

| | |
|---|---|
| Subject digest | `47fe3768e164b8663dd4da743c8f416fa09658c652f21617f45eea8a5a8a705c` |
| What it digests | the kit payload in `capture-provenance.md` (64 bytes) |
| Submitted | 2026-08-17T20:39:16Z |
| Calendars | `alice.btc.calendar.opentimestamps.org`, `bob.btc.calendar.opentimestamps.org`, `finney.calendar.eternitywall.com` |

The raw 32-byte digest was POSTed to each calendar's `/digest` endpoint; each
answered with the operation path from that digest to its own commitment, ending
in a calendar promise. Stamping through three calendars is the standard
mitigation for the availability caveat §6.2 states: a calendar that disappears
before upgrade strands a pending proof permanently, and three independent
calendars make that a survivable event rather than a total loss.

The three raw response bodies stay outside the repository, with the rest of the
P0 capture record. What is committed is what the kit asserts against.

## The committed proofs

| File | Bytes | SHA-256 | What it is |
|---|---|---|---|
| `real-stamp-v1-pending.ots` | 530 | `32e607d6dc1f32911bf36b559ffc376f9833f054d3e16fe75db3b9d707402694` | the three calendar responses merged into one detached proof: a three-branch fork, every branch ending in a calendar promise |
| `real-stamp-v1-complete.ots` | 1496 | `948e5dcda5fc5b6824009c865c6e33d96be90de89c0d8a63bdf9b31f2722f806` | the same proof with the `alice` branch upgraded to its Bitcoin attestation; the other two branches are still promises |

Both were assembled by `scripts/assemble-ots-real-proof.mjs`, which refuses to
write a proof the trust-core verifier cannot replay. Neither is minted, and
neither can be regenerated from source: re-running the script against the same
captures reproduces the pending file byte-for-byte, and reproduces the complete
file only for as long as `alice` serves the same upgrade path.

**They are an upgraded pair, not a correction.** §6.2 makes upgrading an
append-only operation: the completed proof is a new record over the same subject,
the pending record is never rewritten, and a bundle may carry both. The kit
therefore commits both, and `src/anchor-kit/real-ots-proof.test.ts` reports each
on its own bytes.

## The block

| | |
|---|---|
| Height | 962949 |
| Block hash | `0000000000000000000154afb13efe9b3958f76ed301f55ce4e9a2ac1bc1f218` |
| Merkle root (header order) | `b8dcd52d129234b8e73db0dcb9c48e736d053fb3d4c231c1f4112a75411ea5fb` |
| Block time | 2026-08-17T21:11:34Z (32 minutes after the stamp) |

The 80-byte header was fetched on 2026-08-18 from two independent public
explorers, which agreed byte-for-byte:

- `https://blockstream.info/api/block-height/962949` → `…/api/block/<hash>/header`
- `https://mempool.space/api/block-height/962949` → `…/api/block/<hash>/header`

**The header is not committed here, deliberately.** Chain material is
verifier-side trust material (§4.3, §8 step 3): the kit ships none, exactly as it
ships no authority roots. The test that exercises the `verified` path carries
those 80 bytes as its own configuration, cited to the two sources above, so
anyone can re-fetch them and reach the same result without taking the kit's word
for anything.

## What these fixtures prove, and what they do not

- **They prove the verifier replays production bytes.** No builder in this kit
  produced the calendar aggregation paths or the Bitcoin merkle path inside
  `real-stamp-v1-complete.ots`.
- **They prove `present` is not `verified`.** With no chain view the completed
  proof is `present` at height 962949 — the height is extracted, the time basis
  is not evaluated. Supply the block header and the same bytes are `verified` at
  the block's own time. The two outcomes differ only in what the verifier's
  operator supplied, which is the §4.3 discipline in one pair of assertions.
- **They do not endorse a calendar.** Which calendars a producer stamps through
  is endpoint configuration, and which chain view a reader trusts is that
  reader's decision. Verification identifies an anchor; it never endorses one.
- **They are not a wall-clock assertion.** The block time is historical, and
  every assertion about it runs against these recorded values, never against the
  clock a test happens to run under.

## Not yet here

Two of the three branches (`bob`, `finney`) were still answering "Pending
confirmation in Bitcoin blockchain" when the complete proof was assembled. When
they upgrade, the honest addition is a **new** fixture beside these two — never
an edit to either. `scripts/assemble-ots-real-proof.mjs` regenerates and
re-validates, and refuses to overwrite a committed file whose bytes it no longer
reproduces.

One operational note for whoever runs that script: `alice` answered `404 Pending
confirmation` for the same commitment minutes before it answered with the
upgraded path. A calendar's 404 means "not yet", never "not ever", and it is not
reliably monotonic across a calendar's own backends.
