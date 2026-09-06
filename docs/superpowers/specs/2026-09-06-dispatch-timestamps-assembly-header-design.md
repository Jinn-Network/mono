# Dispatch Timestamps in the Assembly Header

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-06 |
| **Author** | Autopilot design session (Codex); source citations read against attempt base `9b08b1b05` |
| **Shape** | `design`; implementation is separate |
| **Status** | proposed; awaiting operator decision |
| **Issue** | [#2762](https://github.com/Jinn-Network/mono/issues/2762) |
| **Depends on** | [benchmark product design](./2026-08-05-benchmark-product-design.md); [pluggable integrity providers](./2026-08-17-pluggable-integrity-providers-design.md) §8, §9, §16.5; [public bundle contract](../../../packages/benchmark-product/PUBLIC-BUNDLE.md) |
| **Related** | [bundle capability composition](./2026-08-29-bundle-capability-composition-design.md), proposed but not implemented |
| **Does not do** | establish a trusted dispatch clock, prove backend receipt or execution timing, carry the raw run journal, or raise any execution/evaluation evidence to `attested` |

## 0. Decision in plain language

The assembly will carry the run journal's two pre-submit capture kinds as a
mandatory event array in a new `benchmark-product-assembly/3` header. Each event
retains its producer-supplied timestamp, source-journal position, canonical
entry digest, dispatch coordinates, and Submission digest. It includes solve
and evaluation captures, including abandoned, rejected, retried, and re-sealed
attempts. The array is the evidence; an `earliestDispatchAt` scalar is never
stored.

This makes one comparison reproducible from authenticated bundle bytes. Given
an RFC 3161 lock anchor with encoded generation time `G`, a reader can check
whether `G` is strictly earlier than every dispatch timestamp published in the
assembly. The claim may describe that byte-level comparison. It may not call
it proof that anchoring preceded actual backend dispatch or execution: the
producer supplies the dispatch clock, a copied bundle cannot prove that the
producer did not omit an unmatched local capture, and the timestamp authority's
independence remains a reader trust judgment.

The change receives new immutable closure identifiers:

- `benchmark-product-assembly/3`;
- `benchmark-product-public-bundle/9`; and
- `benchmark-product.claim-package/7`.

Bundle `/9` is deliberately `/8` plus dispatch-boundary evidence. This is the
smallest closure that upgrades the product's current disclosed, anchored,
binary-qualification bundle without waiting on the still-proposed capability
composition refactor or minting every combination of the old closure matrix.
All earlier formats and claim packages remain byte-immutable.

## 1. Problem and claim boundary

The anchor-evidence design currently permits the product to say that a sealed
lock digest existed no later than an anchor's time. It explicitly refuses
"anchored before execution started" because the public assembly contains no
dispatch timestamps ([anchor-evidence §8](./2026-08-17-pluggable-integrity-providers-design.md#8-verification-pipeline-and-offline-api)).

Adding a timestamp does not turn the producer's clock into an authority. Three
facts must remain separate:

| Fact | Source | What it supports |
|---|---|---|
| An RFC 3161 token encodes `genTime = G` over the lock digest | carried `AnchorEvidence` bytes | the named authority asserts that the exact lock digest existed no later than `G` |
| A capture entry encodes `at = D` | producer's append-only run journal, projected into the assembly | the product recorded exact Submission bytes at a pre-submit boundary with producer-supplied time `D` |
| `G < D` under exact RFC 3339 comparison | pure derivation from the two carried byte strings | the encoded anchor time is earlier than the encoded capture time |

The third row is offline-checkable. It does not upgrade the first two rows'
authorities. In particular, it does not establish when the backend received
the Submission, when execution began, or whether the producer clock agreed
with the timestamp authority.

## 2. Repository reality

The required producer boundary already exists.

- `submission-captured` stores the solve Submission in the product CAS and
  appends a fsynced journal entry before `backend.submit`; capture failure
  prevents the backend side effect
  ([`publication-capture.ts`](../../../packages/benchmark-product/core/src/run/publication-capture.ts)).
- `evaluation-submission-captured` is appended before the evaluation
  `backend.submit`. On recovery after a pre-acceptance interruption, the
  evaluation leg may re-seal different bytes under the same evaluation
  coordinate and append a second capture; the replay map intentionally uses
  the last capture
  ([`drive.ts`](../../../packages/benchmark-product/core/src/run/drive.ts)).
- Journal lines are append-only and fsynced; reads retain file order and report
  integrity failures by zero-based line index
  ([`journal.ts`](../../../packages/benchmark-product/core/src/run/journal.ts),
  [`atomic.ts`](../../../packages/benchmark-product/core/src/fs/atomic.ts)).
- The existing demo-1 preregistration adapter already identifies a journal fact
  by `journalIndex` plus the SHA-256 of the complete canonical entry
  ([`demo1-preregistration.ts`](../../../packages/benchmark-product/core/src/method/demo1-preregistration.ts)).
- The public assembly is frozen as `benchmark-product-assembly/2`; its graph
  contains accepted Submission edges but no pre-submit capture edges
  ([`schema.ts`](../../../packages/benchmark-product/verify/src/schema.ts)).
- Public bundle `/8` and claim package `/6` are already allocated to the
  disclosed anchored binary-qualification closure
  ([`manifest.ts`](../../../packages/benchmark-product/verify/src/manifest.ts),
  [`claim.ts`](../../../packages/benchmark-product/verify/src/profile/claim.ts)).

Accepted Submission edges and `cell-event:dispatch` are not substitutes. They
are observed after, or independently of, the prospective capture boundary and
do not cover the crash window between a backend side effect and its accepted
journal append. Evaluation recovery makes the distinction observable: an
abandoned capture can correctly have no accepted edge, and a later capture at
the same coordinate can name different bytes.

## 3. Assembly `/3`

### 3.1 Header member

`benchmark-product-assembly/3` retains every `/2` header and cell member and
adds one required, non-empty graph member:

```json
{
  "format": "benchmark-product-assembly/3",
  "kind": "run",
  "graph": {
    "dispatchBoundaries": [
      {
        "journalIndex": 4,
        "entrySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "kind": "submission-captured",
        "at": "2026-09-06T08:00:00.100Z",
        "cellKey": "cell-a",
        "armId": "arm-a",
        "replicate": 1,
        "dispatch": 1,
        "submissionSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      {
        "journalIndex": 11,
        "entrySha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        "kind": "evaluation-submission-captured",
        "at": "2026-09-06T08:01:00.200Z",
        "cellKey": "cell-a",
        "dispatch": 1,
        "evalIndex": 1,
        "evaluationAttempt": 1,
        "submissionSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
      },
      {
        "journalIndex": 15,
        "entrySha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "kind": "evaluation-submission-captured",
        "at": "2026-09-06T08:02:00.300Z",
        "cellKey": "cell-a",
        "dispatch": 1,
        "evalIndex": 1,
        "evaluationAttempt": 1,
        "submissionSha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
      }
    ]
  }
}
```

The two evaluation rows deliberately share a coordinate. The first may be a
pre-acceptance capture abandoned across a crash; the second is the re-sealed
Submission later offered and accepted. Collapsing them by coordinate would
erase the earlier boundary this design exists to disclose.

### 3.2 Event schema

Every event has:

- `journalIndex`: the source line's zero-based position in the complete local
  run journal, a non-negative safe integer;
- `entrySha256`: lowercase SHA-256 of `canonicalJsonBytes(sourceEntry)`, where
  `sourceEntry` is the complete validated journal entry and does not contain
  either derived identity field;
- `kind`: `submission-captured` or
  `evaluation-submission-captured`;
- `at`: the exact, unnormalized string from the source entry;
- `cellKey`, positive `dispatch`, and `submissionSha256`.

A solve event additionally carries `armId`, positive `replicate`, and the
source entry's optional `publicationSourceSequence` and
`publicationEntrySha256` together or not at all. An evaluation event
additionally carries positive `evalIndex` and `evaluationAttempt`.

The event identity is `(journalIndex, entrySha256)`. Coordinates are semantic
bindings, not event identity. Exact repeated entries at different journal
positions remain different events. Their presence is disclosed, not silently
deduplicated.

### 3.3 Projection

The producer projects every `submission-captured` and
`evaluation-submission-captured` entry exactly once and in source-journal
order. `journalIndex` values must be strictly increasing but need not be
contiguous because non-capture entries occupy the gaps.

Projection must not:

- filter through accepted Submission edges;
- discard unmatched, repeated, rejected, superseded, or crash-interrupted
  captures;
- normalize timestamp strings;
- synthesize captures from `submission-accepted`, `cell-event:dispatch`, a
  Matrix cell, a Delivery, or a Verdict; or
- sort by time or dispatch coordinate.

Assembly `/3` is available only when at least one prospective capture exists.
A run with none remains on an earlier compatible closure and receives no
dispatch-ordering claim.

## 4. Closure and verification

### 4.1 Producer and workspace verification

Before emitting `/9`, materialization and the workspace's own verification
must rederive `dispatchBoundaries` from the complete local journal and require
byte equality with the assembly projection. They must also:

1. validate every source entry against `RunJournalEntrySchema`;
2. reconstruct every `entrySha256` from the complete canonical source entry;
3. carry every referenced Submission's exact bytes as
   `records/<submissionSha256>.bin`, including captures with no accepted edge;
4. assign each referenced record its existing `solve-submission` or
   `evaluation-submission` evidence role;
5. parse each Submission and verify its run, task, cell, nonce/idempotency key,
   dispatch, arm, evaluator requirement, and evaluation coordinate as
   applicable; and
6. require every accepted solve or evaluation Submission graph edge to match
   at least one capture with the same coordinate and digest.

An unmatched capture is valid. It records a pre-submit attempt whose backend
acceptance may have failed, been rejected, or not been journaled before a
crash. An accepted edge without a matching capture is invalid.

### 4.2 Copied-bundle verification

The standalone verifier runs a new `dispatch-boundaries` check after
`evidence-closure` and before `claim-consistency`. It operates only on bytes
already authenticated by `bundle.json` and must:

- enforce the `/3` event union, non-empty array, and strictly increasing
  `journalIndex` values;
- reconstruct the canonical source-entry shape copied into every event and
  its `entrySha256`;
- authenticate and parse every referenced Submission record;
- enforce the coordinate and role bindings in §4.1; and
- reject missing record bytes, invalid time strings, mutated coordinates,
  reordered rows, accepted edges without a capture, or any non-capture event
  presented as a boundary as `record-integrity`.

The check does not claim to reconstruct omitted unmatched local captures. A
copied bundle does not carry the complete run journal, and a non-capture line
can legitimately occupy any gap between two `journalIndex` values. Carrying
the raw journal would add sensitive operational material without solving the
deeper owner-control problem: the self-run producer could still alter its
local source before publication. This limitation remains in the honesty copy
rather than being hidden behind a false completeness proof.

## 5. Time and ordering semantics

### 5.1 Two orderings

The design uses two different orderings and never substitutes one for the
other.

- **Causal/source order** is ascending `journalIndex`. It establishes which
  capture entry was appended first under the product's run-journal contract.
- **Recorded-time order** uses
  `compareCalendarStrictRfc3339Instants` from the benchmarking records package.
  It compares the encoded instants without `Date.parse`, millisecond
  truncation, or string-order assumptions.

Producer clocks may repeat or regress. Therefore timestamp monotonicity is not
a validity condition, and the event with the lowest timestamp need not have
the lowest journal index.

### 5.2 Derived facts

The following values are derived and never serialized into the assembly:

- `firstDispatchBoundary`: event with the lowest `journalIndex`;
- `earliestRecordedDispatch`: event with the minimum exact RFC 3339 instant,
  with lowest `journalIndex` as the deterministic tie-break; and
- `dispatchBoundaryCount`: the array length.

The anchor comparison uses `earliestRecordedDispatch.at`, not merely the first
event's timestamp. Thus a qualifying anchor time is earlier than every
published producer timestamp even when the clock regressed later. Equal
instants do not qualify.

Every `/3` timestamp must pass the existing calendar-strict RFC 3339 rules:
real civil dates, explicit `Z` or numeric offset, exact arbitrary fractional
precision, and valid leap-second placement. The original spelling remains in
the event. The run journal's currently weaker syntactic regex does not weaken
the public contract; a legacy timestamp that cannot pass strict validation
prevents `/9` publication.

## 6. Bundle and claim versions

### 6.1 Public bundle `/9`

`benchmark-product-public-bundle/9` is exactly the current `/8` closure plus:

- assembly `/3` instead of `/2`;
- the CAS records reachable only from `dispatchBoundaries`; and
- `dispatch-boundaries` inserted before `claim-consistency` in the check list.

It retains `/8`'s qualification, anchors, disclosure record, trust material,
and all existing checks. It does not reinterpret those members.

The complete ordered check list is:

1. `manifest`;
2. `evidence-closure`;
3. `dispatch-boundaries`;
4. `trust`;
5. `matrix-rederivation`;
6. `report-verification`;
7. `claim-consistency`;
8. `integrity-anchors`; and
9. `disclosure-specification`.

`dispatch-boundaries` precedes `claim-consistency` because claim package `/7`
contains a projection derived from that check's authenticated input.

The activation predicate is biconditional: a producer emits `/9` exactly when
the `/8` closure applies and it can establish a complete, non-empty local
dispatch-boundary projection. A `/9` bundle with assembly `/2`, a `/2`–`/8`
bundle with assembly `/3`, or an earlier assembly containing
`dispatchBoundaries` is invalid. A producer unable to establish the new
closure refuses `/9`; it never backfills from acceptance evidence and never
emits upgraded honesty copy on an earlier format.

This deliberately serves the product's current flagship closure rather than
allocating the full cross-product of base, qualification, anchoring,
disclosure, and dispatch evidence. When the proposed capability-composition
design is revised around the already-shipped `/8`, dispatch evidence should
become one must-understand capability. That migration is not a dependency and
does not change `/9` after publication.

### 6.2 Claim package `/7`

`benchmark-product.claim-package/7` is claim package `/6` plus:

```json
{
  "dispatchBoundary": {
    "count": 3,
    "first": {
      "journalIndex": 4,
      "entrySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "kind": "submission-captured",
      "at": "2026-09-06T08:00:00.100Z",
      "cellKey": "cell-a",
      "dispatch": 1,
      "submissionSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    "earliestRecorded": {
      "journalIndex": 4,
      "entrySha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "at": "2026-09-06T08:00:00.100Z"
    }
  }
}
```

`first` carries the complete first event, including kind-specific members;
`earliestRecorded` carries the stable identity and timestamp of the minimum
event. The producer and verifier derive this section through one shared pure
function from the authenticated assembly. `claim-consistency` byte-compares
the result. The claim's verification instructions name the release that first
understands `/9` and its full check list.

Claim-package `/1` through `/6` remain unchanged. In particular, the existing
`venueHonesty` text on every earlier bundle is byte-stable.

## 7. Honesty mapping

### 7.1 Qualification predicate

The new honesty value is available only when all of the following are true:

1. the bundle is `/9` and its `dispatch-boundaries` check passes;
2. the assembly has a derived `earliestRecordedDispatch`;
3. a carried lock-subject anchor is structurally complete, digest- and
   kind-matching, and uses the RFC 3161 authority-time profile;
4. its byte-embedded `genTime` is calendar-strict RFC 3339; and
5. exact comparison returns
   `genTime < earliestRecordedDispatch.at`.

The governing qualifying anchor is the one with the earliest `genTime`, with
record digest as the deterministic tie-break. A non-qualifying additional
anchor remains disclosed but does not weaken a qualifying one. Pending proofs,
matrix anchors, equality, invalid times, and OpenTimestamps block heights do
not qualify. A block height is not an instant on the producer's clock, even
when a verifier separately supplies Bitcoin headers.

When the predicate holds:

```text
venueHonesty.preRegistration =
  "structural-append-order-and-anchored-time-before-recorded-dispatch"
```

Otherwise `/9` retains the strongest existing value justified by its anchors.

### 7.2 Exact permitted copy

The replacement for the pre-registration limitation is:

> Pre-registration here is anchored relative to the published byte record: an external timestamp authority asserts this run's sealed design digest existed no later than `<genTime>`. Every pre-submit capture timestamp published in this assembly compares later; the earliest is `<earliestRecordedDispatchAt>`. This comparison is reproducible from authenticated bundle bytes, but the capture times come from the self-run producer's own clock and the copied bundle cannot prove that an unmatched local capture was not omitted. It does not prove backend receipt or execution timing, and it is only as good as the authority behind the signing key named in the token.

This sealed copy keys only on byte-embedded facts. Verifier-supplied trust roots
may change the anchor check's report from `present` to `verified`; they never
change the claim package bytes.

The upgraded claim may say:

- the named timestamp authority asserts that the exact lock digest existed no
  later than `genTime`;
- every pre-submit capture timestamp published in this authenticated assembly
  encodes a later instant;
- which published event is first in journal order and which has the earliest
  recorded timestamp; and
- the comparison can be reproduced offline from the bundle.

It may not say or imply:

- "the anchor preceded execution," "execution began after anchoring," or that
  anchoring preceded actual backend dispatch or receipt;
- the producer clock was independent, synchronized, monotonic, accurate, or
  protected from manipulation;
- the timestamp authority was independent of the producer merely because the
  token's signature is valid;
- the published array proves that no unmatched local capture was omitted;
- no earlier rehearsal, hidden execution, discarded run, abandoned lock, or
  selectively unpublished run existed;
- an OpenTimestamps block height is directly ordered against a producer time;
  or
- anchoring upgrades execution, evaluation, identity, or any other evidence
  axis to `attested`.

The existing run-before-lock, rehearsal, selective-publication, owner-control,
agent-distinctness, self-reported-cost, and per-axis pinning limitations remain
visible. Dispatch timestamps replace none of them.

## 8. Failure behavior

| Condition | Producer | Standalone verifier | Honesty result |
|---|---|---|---|
| No capture event | retain an earlier closure | `/9` is invalid | no dispatch-ordering copy |
| Invalid calendar timestamp | refuse `/9` | `record-integrity` | no upgrade |
| Accepted edge lacks matching capture | refuse `/9` | `record-integrity` | no upgrade |
| Capture record bytes missing or digest/coordinate mismatched | refuse `/9` | `record-integrity` | no upgrade |
| Repeated coordinate with different capture digests | preserve both events | valid if both records and bindings validate | both affect the minimum |
| Capture has no accepted edge | preserve it | valid | it still affects the minimum |
| Rows reordered or `entrySha256` altered | refuse `/9` | `record-integrity` | no upgrade |
| Producer clock regresses | preserve journal order and exact times | valid | compare anchor against the minimum time |
| `genTime == earliestRecordedDispatch.at` | publish facts | valid | no upgrade |
| Only a chain-time anchor is present | publish facts | valid | retain existing anchor wording |
| Local journal and assembly projection differ | refuse `/9` | not externally decidable for omitted unmatched captures | no publication from the conforming producer |

Failures are loud where the authenticated bundle is internally contradictory.
Limitations are explicit where no copied artifact can decide the fact.

## 9. Rejected alternatives

### 9.1 Store only `firstDispatchAt`

Rejected. A scalar does not identify its source event, cannot disclose retries
or abandoned attempts, and can drift from the graph. The minimum is derived
from event evidence.

### 9.2 Timestamp accepted Submission edges

Rejected. Acceptance is after the side effect and absent in the crash window
that prospective capture exists to close. It also erases rejected and
pre-acceptance-abandoned attempts.

### 9.3 Use `cell-event:dispatch`

Rejected. It is backend-dependent and does not cover both Submission legs or
the same pre-submit boundary.

### 9.4 Deduplicate by coordinate

Rejected. Evaluation recovery may legitimately re-seal different bytes under
the same coordinate. Journal position plus canonical entry digest is the event
identity.

### 9.5 Require monotonic timestamps

Rejected. Journal position is the source-order authority. Refusing clock
regression would hide real producer-clock behavior; comparing against the
minimum is conservative and keeps it visible.

### 9.6 Carry the raw journal

Rejected. It broadens the public artifact with operational data while still
not proving honesty against the self-run owner. The exact capture projection,
its source positions, and the limitation are sufficient for this claim.

### 9.7 Mutate assembly `/2` or bundle `/8`

Rejected. Both are published contracts. Older readers must refuse a new
closure, not accept an old format while silently ignoring new semantics.

### 9.8 Wait for capability composition

Rejected as a dependency. That design is still proposed and its planned `/8`
allocation has been overtaken by the shipped disclosed closure. `/9` solves
this issue against repository reality; later composition may register the
same semantics without rewriting `/9`.

## 10. Implementation sequence

Implementation should land as stacked, independently verifiable packets:

1. **Assembly contract.** Add assembly `/3` TypeScript and public JSON schemas,
   projection types, exact RFC 3339 comparison reuse, and golden/adversarial
   schema fixtures. Keep `/2` byte-identity tests green.
2. **Projection and records.** Project every capture entry with journal
   identity, carry all referenced Submission bytes, and add local
   journal-to-assembly equality checks. Cover solve, evaluation re-seal,
   retries, rejection, cancellation, and crash recovery.
3. **Bundle `/9` and verifier check.** Add the manifest closure, reader
   instructions, record roles, check ordering, outcome denominator, and
   tamper tests. Verify a copied bundle without workspace access.
4. **Claim package `/7` and honesty.** Add the derived boundary section, strict
   RFC 3161 predicate, exact copy, claim-consistency rules, and negative tests
   for equality, chain-time anchors, invalid times, omission, and clock
   regression.
5. **Public documentation and release line.** Update `PUBLIC-BUNDLE.md`,
   `EXTERNAL-VERIFICATION.md`, package exports, public schemas, packed-package
   tests, and docs-consistency pins. Prove the released reader line verifies a
   real `/9` bundle end to end.

No packet may synthesize missing capture evidence or weaken an earlier format
to keep its slice green.

## 11. Verification and acceptance

The implementation bar is:

- source and public schemas agree on every `/3` member;
- a fixture covers one solve capture, two same-coordinate evaluation captures
  with different digests, and one unmatched rejected capture;
- deletion, insertion, reordering, digest mutation, coordinate mutation, and
  timestamp normalization inside a fixed authenticated snapshot fail through
  manifest, boundary, or claim consistency; accepted-edge synthesis without a
  matching capture fails boundary verification;
- a self-consistent re-materialization that omits only an unmatched local
  capture is tested as externally undecidable and never described as proven
  complete;
- exact comparison covers offsets, arbitrary fractions, leap seconds,
  equality, and regressing producer clocks;
- only a strict qualifying RFC 3161 lock anchor selects the new literal and
  exact text;
- chain-time, pending, matrix-only, equal-time, and later-time anchors never
  select it;
- every `/2`–`/8` and claim-package `/1`–`/6` golden remains byte-identical;
- the docs-consistency suite has a total row for `/9` and the reader release it
  pins; and
- core and verifier typecheck, test, build, parity, and package-smoke commands
  pass, followed by the Benchmark Product CI lane.

This satisfies issue #2762 by specifying dispatch timestamps in the assembly
header and giving an exact allowlist and denylist for the upgraded honesty
claim. Approval of this document authorizes implementation planning; it does
not itself authorize code or format activation.

## 12. Headless decision log

No human was present during this design session. The session therefore took
the convention-preserving options required by the headless workflow:

1. **Event array over scalar** — selected because evidence stays attributable
   and retry history cannot be hidden by one summary value.
2. **Pre-submit captures over accepted edges** — selected because they are the
   existing crash-safe boundary before backend side effects.
3. **Both solve and evaluation captures** — selected because a selective graph
   would understate execution attempts and make the minimum unsound.
4. **Preserve repeated coordinates** — selected because current evaluation
   recovery intentionally re-seals under the same coordinate.
5. **Journal order plus exact entry digest** — selected because it matches the
   existing demo-1 identity precedent and does not pretend clocks are causal.
6. **Minimum timestamp for the anchor gate** — selected because it remains
   conservative when the producer clock regresses.
7. **New `/3`, `/9`, and `/7` contracts** — selected because existing formats
   are allocated and immutable; `/9` extends the current flagship closure.
8. **Do not block on capability composition** — selected because that proposal
   is unresolved and its planned number conflicts with shipped reality.
9. **Byte-level claim with explicit residuals** — selected because it makes the
   newly reproducible comparison legible without laundering producer time into
   trusted execution evidence.
10. **Human approval remains required** — this document is marked proposed and
    the design lifecycle parks its draft PR rather than self-declaring approval.
