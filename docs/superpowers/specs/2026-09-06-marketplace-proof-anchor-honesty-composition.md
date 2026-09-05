# Marketplace Ordering + Proof Anchors — One Honest Reader Statement

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-06 |
| **Shape** | `design` |
| **Status** | proposed; approval-ready |
| **Issue** | [#2763](https://github.com/Jinn-Network/mono/issues/2763) |
| **Depends on** | [benchmarking application](./2026-07-28-benchmarking-application-design.md) §7.2; [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md) §9.3; [benchmark product](./2026-08-05-benchmark-product-design.md) §7; [proof-carrying anchors](./2026-08-17-pluggable-integrity-providers-design.md) §9, §16.6, §19; [reader-facing vocabulary](./2026-09-02-reader-facing-vocabulary.md) |
| **Outcome** | one composed reader statement backed by two independent evidence channels; no blended score or claim |

## 0. Decision in plain language

A marketplace run may carry both chain-observed ordering and proof-carrying time
anchors. The product presents them together under **Who ran this**, but it does
not combine their evidentiary meaning.

- **Marketplace ordering** establishes that the sealed Run design was observed
  on the marketplace's finalized chain projection at or before the earliest
  cell post. It is the only evidence counted for registration before dispatch.
- **Timestamp proofs** date the exact digest bytes they cover. They do not
  establish marketplace dispatch order, execution, evaluation, publication,
  or chain finality beyond the proof's own trust boundary.

These are sibling channels in the claim and verifier result. Neither upgrades,
satisfies, rescues, or scores the other. There is no combined confidence value
and no combined “verified” badge.

This closes the composition question deferred by the proof-carrying-anchor
design §16.6 while preserving that design's central rule: the claim is derived
from authenticated bytes, while reader-supplied trust material changes only the
verifier's evaluation of those bytes.

## 1. The propositions must remain separate

| Channel | Proposition | Minimum carried evidence | Reader-side material | Must not claim |
|---|---|---|---|---|
| Marketplace ordering | the sealed Run digest was chain-observed no later than the earliest cell post | the exact ordered finalized projector events, coherent close anchor, and exact canonical cell Submission bytes used by leg (b) | an optional canonical finalized marketplace projection through the named close anchor | that the Run bytes existed before the chain observation; that an external clock dated them; that execution or evaluation was honest |
| Timestamp proof | the covered digest existed no later than the time asserted by the selected proof system | the existing `AnchorEvidence` record and proof bytes | TSA roots or Bitcoin headers supplied by the reader, exactly as specified today | that the digest was publicly disclosed; that it was registered before dispatch; that marketplace events are complete or canonical |

The same Run digest may appear in both channels. That is a binding, not two
votes for one proposition. An earlier timestamp proof cannot repair a failed
marketplace-ordering check, and successful marketplace ordering cannot verify
an RFC 3161 token or OpenTimestamps proof.

### Rejected alternative: one widened scalar

Extending `venueHonesty.preRegistration` with a value such as
`marketplace-and-anchored`, or selecting whichever channel has the earliest
time, would erase which proposition was established. It would also make two
proofs over the same digest look like independent support for dispatch order.
That violates the publication profile's separation of digest commitment,
retrievability, and temporal ordering, so this design rejects it.

## 2. Marketplace ordering evidence

### 2.1 Record and members

The new strict canonical JSON record is `ordering/marketplace.json`:

```json
{
  "schema": "benchmark-product.marketplace-ordering/1",
  "runDigest": "sha256:<digest of the canonical Run>",
  "closeAnchor": {
    "chain": "eip155:<chain-id>",
    "blockNumber": 0,
    "blockHash": "0x<32-byte hash>"
  },
  "events": [
    {
      "ordinal": 0,
      "sha256": "<digest>",
      "path": "ordering/events/000000-<digest>.json"
    }
  ],
  "submissions": [
    {
      "submission": "<Submission URN>",
      "task": "sha256:<task digest>",
      "sha256": "<digest>",
      "path": "ordering/submissions/<digest>.bin"
    }
  ],
  "transcript": {
    "runDigestAnchorAt": "<strict RFC 3339 instant>",
    "earliestCellPostAt": "<strict RFC 3339 instant>"
  }
}
```

`events` carries the exact canonical JSON byte strings accepted by the
marketplace projector through the coherent close anchor. Array order is the
projector's input order and is evidence: `ordinal` values are contiguous from
zero and paths use a zero-padded ordinal plus digest. Events must not be sorted
by digest because projector reduction is order-sensitive.

`submissions` carries each exact canonically sealed cell Submission needed to
resolve `submission-accepted` and `attempt-engaged` observations that commit to
this Run. The current ordering gate derives both timestamps from those cell
Submissions; the format does not invent a separate “anchor Submission.” Entries
are sorted by `(submission, task, sha256)` using code-unit order. Identical byte
material may be referenced more than once but has one digest-addressed member.

The transcript is a summary, not proof. It carries the two timestamps from the
existing `AnchoredOrderingTranscript`; its current `check` object is omitted
because the verifier re-runs `checkPreregistrationAnchoredOrder`.

Strict parsing rejects unknown keys, unsafe or non-canonical paths, noncontiguous
ordinals, digest mismatches, non-canonical Submission bytes, conflicting
Submission identities, missing referenced members, and unreferenced
`ordering/**` members.

### 2.2 One frozen source

`runOnMarketplace` already collects events once, derives one
`AuthorityProjection`, enforces leg (b), freezes that projection, and assembles
the Matrix from it. The carrier must be built from that same collected event
sequence, coherent close anchor, orphan set, and exact Submission material. It
must not query the projector or material port again after Matrix assembly.

This binds the public ordering record to the authority snapshot that governed
the published result rather than constructing a plausible transcript later.

## 3. Additive bundle and claim formats

Allocate:

- `benchmark-product-public-bundle/9`; and
- `benchmark-product.claim-package/7`.

At the claimed head `/8` and claim-package `/6` already have fixed disclosed,
anchored qualification meanings. `/9` and `/7` are additions; `/2` through `/8`
and claim-package `/1` through `/6` keep their exact schemas, member sets,
check order, accepted commands, and golden bytes.

### 3.1 Bundle closure

Bundle `/9` is the current fully disclosed anchored closure plus the declared
marketplace-ordering capability. It requires:

- `ordering/marketplace.json`;
- every event member referenced by that record;
- every Submission member referenced by that record; and
- a `marketplace-ordering` verification check, while retaining
  `integrity-anchors` whenever anchors are declared.

The closure is biconditional: `/9` requires those members, and older formats
refuse them. A `/9` bundle with a missing member is invalid rather than treated
as an older or self-run bundle. The check occupies a fixed position in the `/9`
check list immediately before `integrity-anchors`, so claim construction and
verification share one ordered constant.

If the planned capability registry lands first, marketplace ordering becomes
one additive registry entry. That changes implementation structure, not `/9`'s
wire meaning.

### 3.2 Claim projection

Claim-package `/7` adds `marketplaceOrdering` beside existing `anchors` and
uses a discriminated `venueHonesty` union:

```json
{
  "marketplaceOrdering": {
    "recordSha256": "<sha256 of exact ordering/marketplace.json bytes>",
    "runDigestAnchorAt": "<byte-derived instant>",
    "earliestCellPostAt": "<byte-derived instant>"
  },
  "anchors": ["<existing ClaimAnchor projections, unchanged>"],
  "venueHonesty": {
    "venue": "open-competition",
    "preRegistration": "chain-observed-before-dispatch",
    "limits": ["<exact prose from §5>"],
    "unverifiableAxisCounts": {
      "harness": 0,
      "model": 0,
      "loadout": 0,
      "isolation": 0
    }
  }
}
```

For `/7`, `scope.venue = "open-competition"`, `marketplaceOrdering`, and the
open-competition `venueHonesty` variant are required together. The existing
`self-run` variants and their `preRegistration` literals remain unchanged.
`anchors` keeps its current schema and derivation.

One pure derivation module builds `marketplaceOrdering` and the marketplace
honesty variant from authenticated bundle bytes. Producer and verifier import
that function, as they already share anchor derivation. `claim-consistency`
rebuilds both sibling sections. Live marketplace responses, TSA roots, and
Bitcoin headers are never inputs to sealed claim text.

## 4. Independent verification

### 4.1 The `marketplace-ordering` check

The check runs after manifest/evidence closure and before `integrity-anchors`:

1. strict-parse `ordering/marketplace.json` from the authenticated snapshot;
2. recompute the canonical Run digest and require `runDigest` equality;
3. authenticate every event and Submission member and require exact closure;
4. replay the carried events in their recorded order through
   `deriveAuthorityProjection` using the stated close anchor;
5. resolve only exact, canonically sealed carried Submissions;
6. rederive `runDigestAnchorAt` and `earliestCellPostAt`, require exact
   transcript equality, and re-run `checkPreregistrationAnchoredOrder`;
7. if a verifier-side marketplace resolver is supplied, obtain the canonical
   finalized view through the same close anchor and require the carried event
   sequence, close-anchor identity, and derived pair to agree.

The aggregate verification check is `passed` when steps 1–6 succeed. The
ordering detail reports:

- `present`: authenticated carried bytes replay and pass, but no live resolver
  was supplied;
- `checked`: the carried bytes pass and an independently resolved canonical
  finalized view agrees;
- `declared-but-absent`: the format declares ordering but its record or member
  is absent; this fails closure and never degrades to `present`; or
- `invalid`: schema, digest, canonical-byte, Run binding, ordering, close-anchor,
  orphan/canonical-chain, completeness, or live-view mismatch; this fails the
  bundle.

A manifest proves that carried bytes did not change. It cannot prove that the
producer supplied a complete event stream or that the named block remains
canonical. That is why byte-only evidence is `present`, not `checked`.

### 4.2 Timestamp proofs remain unchanged

`integrity-anchors` continues to report each proof as `verified`, `present`,
`pending`, or `invalid` and each subject as `anchored`, `absent`, or
`declared-but-absent`. Its TSA roots and Bitcoin headers do not feed the
marketplace check. Marketplace resolver data does not feed proof verification.

An invalid channel still fails under its own existing rule. Independence means
one valid channel cannot rescue the invalid one; it does not turn invalid proof
bytes into an optional warning.

## 5. Reader-facing composition

The report uses the adopted presentation vocabulary while retaining contract
keys such as `venueHonesty`, `marketplace-ordering`, `integrity-anchors`, schema
IDs, and JSON paths.

Under **Who ran this**, a marketplace bundle renders:

> This run used the open-competition Jinn marketplace; task dispatch and settlement were observed through its finalized chain projection.
>
> **Marketplace ordering.** The carried marketplace transcript records this run's sealed design at `<runDigestAnchorAt>`, at or before the earliest cell post at `<earliestCellPostAt>`. A reader must recheck the finalized marketplace data before treating that ordering as independently checked.
>
> **Timestamp proofs.** `<the applicable lines below>`
>
> These are independent checks. Marketplace ordering is the only evidence counted for registration before dispatch. Timestamp proofs date the bytes they cover; they are not counted toward marketplace ordering and say nothing about execution or evaluation.

For a carried RFC 3161 lock anchor, the timestamp-proof line is:

> This design digest also carries a timestamp proof: an external timestamp authority asserts it existed no later than `<genTime>`. That assertion dates the design bytes and nothing else about the run, and it is only as good as the authority behind the signing key named in the token.

For a carried OpenTimestamps lock anchor, it is:

> This design digest also carries an OpenTimestamps proof asserting a Bitcoin commitment at block height `<height>`. Checking that commitment requires Bitcoin block headers supplied by the reader; if it holds, it dates the design bytes to no later than that block and says nothing about dispatch, execution, or evaluation.

Additional lock and Matrix anchors retain the existing neutral lines and
earliest-governs ordering. Pending, absent, and declared-but-absent proof
contexts render, respectively, “A timestamp proof is still pending.”, “No
timestamp proof was carried.”, and “A timestamp proof was promised but is
missing.” Invalid ordering or invalid proof evidence produces no success page.

Human-readable verifier output displays two rows, never one badge:

```text
marketplace-ordering   present   the carried ordering was recomputed; live marketplace data was not supplied
integrity-anchors      passed    the timestamp proofs are well formed
```

With live agreement the first detail becomes `checked`. JSON preserves exact
protocol names and identities. Presentation may say **Where it ran**, **Who ran
this**, **Timestamp proofs**, and **Fingerprint**; allocated contract spellings
do not change without another format revision.

## 6. Fail-closed and compatibility rules

- Marketplace claim bytes without ordering evidence cannot masquerade as
  `self-run`, and `/9` cannot silently fall back to `/8`.
- `runDigestAnchorAt > earliestCellPostAt` is invalid even when a timestamp
  proof predates both.
- A valid ordering channel remains valid when timestamp evidence is absent or
  pending; it receives no time-proof upgrade.
- A well-formed proof may remain `present` when reader trust material is absent;
  it never supplies marketplace leg (b).
- Live disagreement is invalid, not “newer data,” because the claim names an
  exact close anchor.
- Old bundle and claim formats remain on their frozen verifier paths. Their
  `VenueHonesty`, anchor copy, commands, checks, and bytes do not change.

## 7. Conformance and adversarial tests

The implementation must add network-free fixtures containing captured
finalized events and exact Submission bytes, plus injected-resolver integration
tests. At minimum they cover:

1. same-snapshot composition: `runOnMarketplace` emits evidence after the
   existing leg-(b) gate, and producer and verifier derive byte-identical claim
   text;
2. swapped Run digest, venue/claim mismatch, altered transcript timestamp,
   reversed ordering, the valid equal-time boundary, and malformed RFC 3339;
3. reordered events, ordinal gaps, digest/path substitution, duplicate or
   unreferenced material, missing Submission, non-canonical Submission bytes,
   and a Submission whose extension commits to another Run;
4. producer omission of an earlier cell event: byte-only status is at most
   `present`; live replay detects incompleteness and returns `invalid`;
5. orphaned/reorganized events and close-anchor hash mismatch under live replay;
6. failed ordering plus an earlier RFC 3161 or OpenTimestamps proof: the bundle
   remains invalid;
7. passing ordering with timestamp proof `pending`, `present`,
   `declared-but-absent`, or `verified`: ordering output is unchanged;
8. multiple anchors over the same Run: no increment or strengthening of the
   ordering result;
9. `/2`–`/8` and claim `/1`–`/6` goldens stay byte-identical; `/9` rejects
   stripped members, undeclared members, unsupported capabilities, wrong check
   order, and a verification command that cannot read `/9`; and
10. CLI/page snapshots show two rows, the exact limitation prose, and no
    combined verified badge.

## 8. Implementation slices

Each slice is independently reviewable and preserves old closures:

1. **Ordering record and conformance kit.** Add the strict schema, canonical
   byte helpers, ordered event/submission closure, pure replay, and adversarial
   fixtures around `packages/benchmarking/marketplace`.
2. **Marketplace carrier.** Extend `runOnMarketplace` to return a publication
   receipt built from its already-collected events, coherent close anchor, and
   exact material; do not perform a second read.
3. **Bundle `/9` and claim `/7`.** Extend manifest closure, fixed check roster,
   discriminated `VenueHonesty`, shared claim derivation, legacy goldens, and
   reader-command compatibility in `benchmark-product/core` and `verify`.
4. **Verifier channel.** Add byte-only `present`, injected live resolution to
   `checked`, hard failure on disagreement, JSON disclosure, and two-row human
   output.
5. **Product integration.** Permit `open-competition` run results, persist the
   ordering receipt, and render the combined statement from verified facts.
6. **Capability-registry fold-in.** Register marketplace ordering additively if
   the capability-vector migration has landed; never reinterpret `/9`.

No slice may ship a producer before the released reader accepts its exact
closure. The producer and verifier must share derivation functions rather than
maintain matching prose or claim assembly by convention.

## 9. Decision log

- Selected sibling channels because chain ordering and byte dating establish
  different propositions. This directly resolves §16.6 without blending or
  double-counting.
- Carried exact ordered projector events and exact Submission bytes, not two
  timestamps alone, because a summary cannot establish its provenance.
- Preserved projector input order with explicit ordinals after confirming that
  reduction is order-sensitive; digest-sorting events would change evidence.
- Reused the run-committing cell Submissions used by the existing gate rather
  than inventing a distinct anchor Submission.
- Reserved `present` for internally replayed bytes and `checked` for agreement
  with reader-resolved finalized data because bundle authentication alone does
  not prove completeness or canonical-chain status.
- Kept sealed claim prose independent of reader trust roots, Bitcoin headers,
  and marketplace availability.
- Allocated bundle `/9` and claim `/7` because `/8` and `/6` already have fixed
  meanings at this head.
- Preserved current anchor status machinery and neutral lines, adding only the
  marketplace lead-in and explicit non-counting sentence.
- Resolved these gates headlessly from existing repository invariants. No new
  product authority or unresolved implementation choice remains in the design.
