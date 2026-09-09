# Marketplace Ordering + Proof Anchors — One Honest Reader Statement

| | |
|---|---|
| **Version** | 0.2 |
| **Date** | 2026-09-06 (v0.1); 2026-09-09 (v0.2 applies the operator ruling) |
| **Shape** | `design` |
| **Status** | adopted — operator ruling 2026-09-07, with one amendment to the format numbering, recorded in §10 ([PR #4105 comment 5570963854](https://github.com/Jinn-Network/mono/pull/4105#issuecomment-5570963854)) |
| **Issue** | [#2763](https://github.com/Jinn-Network/mono/issues/2763) |
| **Depends on** | [benchmarking application](./2026-07-28-benchmarking-application-design.md) §7.2; [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md) §9.3; [benchmark product](./2026-08-05-benchmark-product-design.md) §7; [proof-carrying anchors](./2026-08-17-pluggable-integrity-providers-design.md) §9, §16.6, §19; [reader-facing vocabulary](./2026-09-02-reader-facing-vocabulary.md); [bundle capability composition](./2026-08-29-bundle-capability-composition-design.md) (v0.2: the generation this design's carriage registers into) |
| **Outcome** | one composed reader statement backed by two independent evidence channels; no blended score or claim |
| **v0.2 changes** | Ruling erratum; carriage only. §3 stops allocating `benchmark-product-public-bundle/9` and `benchmark-product.claim-package/7` and instead registers one `marketplace-ordering` capability entry in the composed generation `/10`, with §3.1, §3.2, §5, §6, §7's test 9, §8, and §9's allocation bullet following. §8's slice order inverts, because the composed generation is now a precondition rather than an optional fold-in. Two evidence corrections in the document's own voice: §3's census now spans all three bundle lineages, and §4.1 names the check's predecessor exactly. **The adopted substance is unchanged** — §0, §1, §2, §4's steps and states, §5's reader copy, §6's other rules, and §7's other tests carry over unedited, and no analysis is rewritten. The landing pass then made this document accurate against its own sources without touching adopted substance: §10 quotes each standing-ruling comment as written and attributed, §3.1 states one composite refinement target and the cardinality it needs from the registry, §3.2 stops overreading the ruling on `claim-package/7` and states its trust boundary as a testable property of the derivation module, §4.1's `passed` condition stops contradicting its own `invalid` state, §2.1 pins the ordinal pad width the example already showed, §7's test 9 and §8 stop attributing requirements to proofs that do not cover them, §8 names the C5 emission boundary and the inherited `/10` properties it depends on, §9's closing bullet is corrected, and the new §11 records five open items the pass found. |

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
zero and paths use the ordinal zero-padded to exactly six digits, then the
digest, as the example above shows. The width is normative: the member pattern
is a byte-exact allowlist (§3.1), so a producer padding to another width emits
paths a conforming reader refuses. Events must not be sorted by digest because
projector reduction is order-sensitive.

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

## 3. Additive bundle and claim carriage

This design allocates no bundle format number and no claim-package identifier.
Its bundle-level additions register as **one capability entry**,
`marketplace-ordering`, inside the composed generation
`benchmark-product-public-bundle/10` (operator ruling, §10 R2).

That generation is designed by [bundle capability
composition](./2026-08-29-bundle-capability-composition-design.md) (issue
#2889), which is itself still `proposed — needs operator decision on D1–D4`,
and whose text still names `/8` for the generation and
`benchmark-product.claim-package/6` for its claim id — both numbers were taken
after that design was written, which is the same numbering drift the ruling
corrects. `/10` therefore does not exist in the tree today. §8 states this
design's dependency on it rather than assuming it has landed.

The census at the claimed head spans three unrelated lineages, and this design
extends only the first. Paths below are relative to
`packages/benchmark-product/` for `core` and `verify`, and to
`packages/benchmarking/` for `protocol`:

| Lineage | Bundle formats | Claim-package ids |
|---|---|---|
| classic | `/2`, `/4`, `/6`, `/7`, `/8` (`core/src/legacy-closures.ts:44-58`; `core/src/bundle/manifest.ts:36`) | `/1`, `/2`, `/4`, `/5`, `/6` (`core/src/legacy-closures.ts:89-106`; `core/src/report/claim.ts:104`) |
| accounting-only | `/3` (`core/src/bundle/manifest.ts:28`) — producer-side only; absent from the reader's `SUPPORTED_BUNDLE_FORMATS` (`verify/src/manifest.ts:47-54`) | — |
| evidence-native | `/5`, carrying two profiles — full-evidence and metadata-first (`verify/src/manifest.ts:26`; `protocol/src/identifiers.ts:54-55`, `:63-64`) | `/3` (`protocol/src/portable.ts:33-34`) |

No `/9` exists in the tree. Per the ruling (§10 R2) it is allocated by PR #4090
(issue #3698) and is therefore unavailable — an allocation this document takes
from the ruling rather than from the tree. Every allocated format and claim id
above keeps its exact schema, member set, check order, accepted command, and
golden bytes, and nothing here touches `/3` or `/5`. The freeze binds hardest
on `/8` and claim-package `/6`, which already carry fixed disclosed, anchored
qualification meanings at the claimed head (`core/src/bundle/manifest.ts:29-35`;
`core/src/report/claim.ts:89-104`) — the fact that made v0.1 reach for the next
free number.

### 3.1 The `marketplace-ordering` capability entry

The entry states, in the field vocabulary of the composition design's §4:

| Field | Value |
|---|---|
| `token` | `marketplace-ordering` — the same string as §4.1's check name and §5's reader row, so wire token, check name, and reader row are one identifier |
| `order` | strictly below `anchoring`'s, which is what places this check before `integrity-anchors` in every derived check list |
| `requires` / `conflicts` | both empty. Ordering stands alone: §1's separation is exactly the claim that neither channel needs the other |
| `mandatoryFiles` | `ordering/marketplace.json` |
| `memberPatterns` | `ordering/events/<zero-padded-ordinal>-<sha256>.json`, the ordinal padded to the six digits §2.1 fixes, and `ordering/submissions/<sha256>.bin`, both `mayBeEmpty: false` — deliberately unlike `anchoring`, because a declared ordering capability carrying no events establishes nothing and must fail as a missing member rather than report a quiet `present` |
| `refines` | one target: the claim's open-competition venue grammar, spanning `scope.venue` and `venueHonesty` together (§3.2) |
| `claimSection` | `marketplaceOrdering` |
| `checks` | `marketplace-ordering` |
| `minimumReaderRelease` | the first `@colophon-claims/verify` release that implements the token, resolved through the composition design's `minimumRelease(vector)` derivation rather than pinned as a string here |
| `activation` | the sealed Run's venue is `open-competition` and the receipt came from `runOnMarketplace`'s already-frozen projection (§2.2) |

The member patterns are the allowlist. Exact bidirectional closure against the
record's own `events` and `submissions` arrays stays the `marketplace-ordering`
check's job (§2.1).

Declaration is authoritative and presence is derived, which is what v0.1's
closure sentence was reaching for. Declaring the token requires its members; a
bundle that did not declare it refuses an `ordering/**` member as
non-allowlisted; and a declared-but-stripped member is invalid rather than
treated as an older or self-run bundle. `integrity-anchors` is present exactly
when `anchoring` is in the vector, so "retain `integrity-anchors` whenever
anchors are declared" stops being a condition written into a fixed check array
and becomes what the derivation already does.

**One coordination item this design needs from the composition design.** Its
§5.2 registry invariant — at most one capability may refine a given target — is
stated over *bundle members* whose grammar a capability replaces, and its only
registered refiner, `binary-qualification`, refines member grammars. This
capability refines a **claim-package grammar slot** instead (§3.2). The
registry's target space therefore has to distinguish the two kinds, so that the
one-refiner-per-target invariant still runs as a build-time test rather than
comparing names drawn from different spaces.

Cardinality is the same coordination item seen from the other side. That
design's §4 gives `refines` "zero or one *refinement target*", while the target
this capability needs spans two claim slots in two files — `scope.venue`
(`core/src/report/claim.ts:276`) and the `VenueHonesty` grammar
(`core/src/operations/run-results.ts:102-108`). The registry must therefore
admit a single named target covering both slots, rather than this entry
declaring two. Both halves of the item are a dependency on a design that is
itself still proposed, and they are named here rather than assumed.

### 3.2 Claim projection

Declaring the token adds one claim section, `marketplaceOrdering`, beside the
existing `anchors` section, and refines the claim's venue discriminant into a
`venueHonesty` union:

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
      "harness": "<count>",
      "model": "<count>",
      "loadout": "<count>",
      "isolation": "<count>"
    }
  }
}
```

The section is biconditional with the token: declared ⟺ present. Declaring
`marketplace-ordering` requires `scope.venue = "open-competition"`, the
`marketplaceOrdering` section, and the open-competition `venueHonesty` variant
together; not declaring it leaves all three unreachable. Both venue slots are
single literals today — `venue: z.literal("self-run")`
(`core/src/report/claim.ts:276`) and `VenueHonesty.venue: "self-run"` with its
two-literal `preRegistration` union
(`core/src/operations/run-results.ts:102-108`) — so widening them is a
refinement of the claim grammar rather than a new section, and it is stated in
§3.1's entry rather than hidden inside `marketplaceOrdering`. The existing
`self-run` variants and their `preRegistration` literals
(`verify/src/profile/anchor-claims.ts:321`, `:323`) remain unchanged.
`anchors` keeps its current schema and derivation.

This design allocates no claim-package identifier. The composed generation
carries one claim-package id whose sections are the base plus one optional
section per declared capability; a capability contributes a section key, not an
id. Per the ruling (§10 R2), issue #4109 names
`benchmark-product.claim-package/7` for its own additions, so the two
implementations coordinate that allocation rather than each assuming it. They
compose as sibling registry entries whose section keys and `order` values are
unique by construction.

One pure derivation module builds `marketplaceOrdering` and the marketplace
honesty variant from authenticated bundle bytes. Producer and verifier import
that function, as they already share anchor derivation. `claim-consistency`
rebuilds both sibling sections. The module's inputs are exactly the
authenticated bundle members, and no port, resolver, or network call occurs
anywhere in its call graph on either side — which is why live marketplace
responses, TSA roots, and Bitcoin headers cannot reach sealed claim text. The
boundary is stated that way because a test can assert it over the module's
imports, where a promise about claim text alone could not be checked.

## 4. Independent verification

### 4.1 The `marketplace-ordering` check

The check's `order` places it after all six base checks — `manifest`,
`evidence-closure`, `trust`, `matrix-rederivation`, `report-verification`, and
`claim-consistency` (`verify/src/legacy-closures.ts:81-88`) — and before
`integrity-anchors`. `claim-consistency` is its immediate predecessor, which is
what lets §3.2's shared derivation rebuild both sibling sections before this
check runs:

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

The aggregate verification check is `passed` when steps 1–6 succeed and, when
a resolver is supplied, step 7 agrees. A supplied resolver that disagrees is
`invalid` below, and `invalid` fails the bundle. The ordering detail reports:

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
The timestamp-proof lines render exactly when `anchoring` is declared, which is
what this copy already assumes; a marketplace bundle that declares no anchoring
renders the marketplace-ordering paragraph and the independence sentence alone.

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
  `self-run`, and a marketplace bundle cannot silently drop the
  `marketplace-ordering` token: the capability vector is authenticated inside
  `bundle.json`, so stripping the declaration produces a different bundle
  identity rather than a quieter bundle.
- `runDigestAnchorAt > earliestCellPostAt` is invalid even when a timestamp
  proof predates both.
- A valid ordering channel remains valid when timestamp evidence is absent or
  pending; it receives no time-proof upgrade.
- A well-formed proof may remain `present` when reader trust material is absent;
  it never supplies marketplace leg (b).
- Live disagreement is invalid, not “newer data,” because the claim names an
  exact close anchor.
- Old bundle and claim formats remain on their frozen verifier paths, on every
  lineage — classic, accounting-only, and evidence-native. Their `VenueHonesty`,
  anchor copy, commands, checks, and bytes do not change.

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
9. `/2`–`/8` and claim `/1`–`/6` goldens stay byte-identical; and this
   capability is covered by the composed generation's generated conformance
   lattice, which asserts, for every satisfiable subset containing the token,
   the derived member list, the derived check list, the claim section set, and
   the derived minimum reader release — and, for every subset without it, that
   a planted `ordering/**` member is refused as non-allowlisted while declaring
   the token with its members stripped is refused as a missing member. This
   design additionally requires that lattice to pin the derived check *order*,
   not only the check set: §4.1 places `marketplace-ordering` between
   `claim-consistency` and `integrity-anchors`, and the composition design's §9
   enumerates the composed check list without pinning its order. A reader that
   does not implement the token refuses the bundle whole under the
   must-understand rule, and the release at which a reader does implement it is
   the entry's `minimumReaderRelease` (§3.1); and
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
3. **Capability registration.** Register `marketplace-ordering` in the `/10`
   capability registry with §3.1's entry: mandatory file, member allowlist,
   derived check position, claim section, claim-grammar refinement, and
   activation predicate. Legacy goldens come from the composed generation's own
   equivalence proof rather than from a per-format roster written here. That
   proof covers the four legacy cells, so it says nothing about a reader
   meeting this new token; compatibility there rests on the must-understand
   rule plus the entry's `minimumReaderRelease`, as test 9 states.
4. **Verifier channel.** Add byte-only `present`, injected live resolution to
   `checked`, hard failure on disagreement, JSON disclosure, and two-row human
   output.
5. **Product integration.** Permit `open-competition` run results, persist the
   ordering receipt, and render the combined statement from verified facts.

Slices 1 and 2 touch no bundle format and are unblocked. Slice 3 blocks on
packets C1–C4 of the composition design's §13 — a capability cannot register in
a generation that does not exist — and slices 4 and 5 follow it. Emission
blocks one packet further out: C4 lands the producer flagged off by default and
C5 is the cutover, so nothing this design ships reaches a published bundle
until C5. Slices 4 and 5 are therefore not shippable at C4 even though slice 3
can register there. v0.1's slice 6 ("capability-registry fold-in", conditional
and last) is absorbed into slice 3: the fold-in is no longer optional, and
there is no `/9` left to fold in from.

Three inherited properties of `/10` are **normative preconditions** on this
capability, not conveniences: the authenticated, must-understand capability
vector; whole-bundle refusal of a token the reader does not implement; and
two-way member closure, under which a declared capability's members are
required and an undeclared capability's members are refused as non-allowlisted.
None of the three exists in the tree today. Every fail-closed rule in §6 and
every negative case in §7's test 9 rests on them, so if `/10` lands without any
one of them, this capability must not ship — a change to the composition
design's D1–D4 must not be able to remove the fence silently.

This design does not decide the composition design's own open decisions D1, D2
and D3. D2 is the structural twin of this design's situation: it asks whether
the anchored lock registry design (issue #2869) registers into this model,
implying C1–C4 land first, or ships as `/9` under the current model with a
follow-on migration — and its `/9` option is itself stale under §10's R2, which
gives `/9` to PR #4090. If `/10` is not landing on the timeline this work
needs, the escalation is an operator call on sequencing. It is **not** a
fallback format allocation — minting a number here would re-create exactly what
§10's ruling removed.

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
- v0.1 allocated bundle `/9` and claim-package `/7` on next-free-number grounds,
  because `/8` and claim `/6` already have fixed meanings at this head. The
  operator amended that (§10, R2): `/9` is taken, and features register as
  capability entries in the composed generation `/10` rather than minting
  numbers. The superseded allocation is history, not a live option.
- Preserved current anchor status machinery and neutral lines, adding only the
  marketplace lead-in and explicit non-counting sentence.
- Resolved these gates headlessly from existing repository invariants. v0.1
  recorded that no new product authority or unresolved implementation choice
  remained. The v0.2 landing pass found otherwise and lists what it found in
  §11; none of those items reopens a ruled decision, and each is an evidence or
  precision question for the implementing slices or a further operator call.

## 10. Operator rulings

v0.1 was parked for approval. It is **ruled**: adopted, with one amendment.
Source: the operator comment on
[#4105](https://github.com/Jinn-Network/mono/pull/4105#issuecomment-5570963854)
(comment 5570963854), from the 2026-09-07 session, recorded here for the
implementation slices. Implementation proceeds from these rulings.

Each block restates the v0.1 position so the mapping is unambiguous, then
records the ruling. The ruling is the operator's meaning. The v0.1 position is
historical context only and is not restated as if it were still a pick.

**R1 — Is the two-channel composition adopted?**
v0.1 proposed that a marketplace run carry chain-observed ordering and
proof-carrying time anchors as sibling channels, presented together under **Who
ran this** and never combined in meaning: marketplace ordering as the only
evidence counted for registration before dispatch, timestamp proofs dating only
the digest bytes they cover, and no combined confidence value or badge (§0). It
rejected a widened `preRegistration` scalar because that erases which
proposition was established (§1). It specified an ordered marketplace evidence
record carrying the exact projector events, the coherent close anchor, and the
exact canonical cell Submission bytes, built once from `runOnMarketplace`'s
already-frozen projection rather than re-queried later (§2). It carried both
channels into the bundle and claim as sibling sections derived by one pure
module from authenticated bytes (§3). It defined a `marketplace-ordering` check
that reports `present` for byte-only replay and `checked` only when an
independently resolved finalized view agrees, leaving `integrity-anchors`
untouched and forbidding either channel from feeding the other (§4). It fixed
the exact reader copy, two verifier rows, and no combined badge (§5), the
fail-closed and compatibility rules under which one valid channel never rescues
an invalid one (§6), and ten conformance and adversarial tests (§7).
**Ruling, in the operator's words:** "The design is adopted: two independent
evidence channels inside one reader-facing statement, the ordered marketplace
evidence carrier, byte-only versus live-resolver verification, the exact reader
copy, fail-closed behaviour, the compatibility guarantees and the adversarial
tests." §0, §1, §2, §4's steps and states, and §5's reader copy are unchanged
by v0.2.

**R2 — Format numbering.**
§3 allocated `benchmark-product-public-bundle/9` and
`benchmark-product.claim-package/7` on next-free-number grounds, because `/8`
and claim-package `/6` already carry fixed disclosed, anchored qualification
meanings at the claimed head. §3.1 treated the capability registry as an
optional later restructuring that would change implementation structure but not
`/9`'s wire meaning, and §8 made the fold-in its last and conditional slice.
**Ruling, in the operator's words:** "Where the spec places its additions in a
new `benchmark-product-public-bundle/9`: `/9` is already allocated (PR #4090,
issue #3698, `/6`'s closure plus the denominator pair). Per the standing
allocation ruling and its amendment (see #3698, #2974, #3016, #3405), the
composed/capability generation is **`/10`**, and features register as capability
entries inside it rather than minting numbers. This design's bundle-level
additions therefore land as entries in `/10`. The same holds for
`claim-package/7`: #4109 names it too, so the two implementations coordinate
that allocation rather than each assuming it. Implementation slices should be
filed against `/10`."

The standing allocation ruling R2 invokes is on issue #3698, across two
comments. Comment 5554839794 (2026-09-05, "Operator ruling — bundle format
allocation") set the rule: "**The composed/capability generation takes `/9`.
Everything else registers as a capability entry inside it and does not mint its
own format number.**" Comment 5570722681 (2026-09-07, "Operator ruling —
amendment to the bundle format allocation") moved the number: "**Amended:**
`/9` stays with #4090. **The composed/capability generation takes `/10`.**
Everything else in the earlier ruling stands unchanged — one generation, and
features register as capability entries inside it rather than minting numbers."
R2 additionally cites #2974, #3016 and #3405 as items the standing ruling
settles; this document has not read them.

v0.2 carries R2 into §3, §3.1, §3.2, §6, §7's test 9, §8, and §9. The
implementation slices against `/10` are not filed by this document.

## 11. Open items carried into implementation

These are named by the v0.2 landing pass. None is decided by the operator's
ruling in §10, and each is for the implementing slices or a further operator
call.

1. **The sealed `preRegistration` scalar does not distinguish byte-only replay
   from independently resolved agreement.** `chain-observed-before-dispatch` is
   the same literal whether §4.1's check reached `present` or `checked`, and the
   aggregate is `passed` in both. §4.1's own reason for reserving `checked` — a
   manifest cannot prove the producer supplied a complete event stream — applies
   to the claim scalar too, but only the check detail carries it. §7's test 4 is
   the concrete case: a producer that omits the earliest cell event rederives a
   later `earliestCellPostAt`, passes `checkPreregistrationAnchoredOrder`
   (`packages/benchmarking/run/src/checks.ts:104`, a two-timestamp comparison),
   and seals the strong literal. The two existing literals
   (`packages/benchmark-product/verify/src/profile/anchor-claims.ts:321`,
   `:323`) name their evidentiary basis rather than their conclusion. Whether to
   grade the scalar, or to state normatively that it is a producer assertion and
   forbid deriving a badge from the check status alone, is undecided.
2. **There is no ordering state for a resolver that was supplied but could not
   produce a comparable view** — an unreachable endpoint, a timeout, or a
   `closeAnchor.chain` the reader has no resolver for. Under §4.1 as written
   such a case degrades silently to `present` while the aggregate stays
   `passed`, so a reader who asked for independent verification is told the
   weaker result in a field they may not read. A distinct non-upgrading state,
   with a matching §7 test, is the obvious remedy.
3. **§6's first bullet is tamper-evidence within one bundle, not a bar on
   suppression.** Stripping the declaration from a sealed bundle breaks the
   digest bindings, which is what that bullet establishes. Nothing stops a
   producer whose ordering check failed from sealing a fresh, entirely valid
   `self-run` bundle that never mentions the marketplace. Non-publication is
   outside the evidence boundary by construction, and saying so is more honest
   than the bullet's current unqualified phrasing.
4. **§5's adopted lead sentence says "task dispatch and settlement were
   observed".** Settlement appears in neither §2.1's carried-evidence minimum
   nor any step of §4.1. Because that copy is what the ruling adopted verbatim
   — "the exact reader copy" — correcting it wants an operator erratum rather
   than an edit to this document.
5. **The open-competition `limits` array is not enumerated.** §3.2 shows
   `"limits": ["<exact prose from §5>"]`, while §7's test 1 requires producer
   and verifier to derive byte-identical claim text, and the self-run limits are
   exact string constants duplicated on both sides
   (`packages/benchmark-product/core/src/operations/run-results.ts:167`;
   `packages/benchmark-product/verify/src/profile/run-results.ts:8`). Which §5
   strings become entries, in what order, and whether placeholders are
   interpolated, must be pinned before slice 4.
