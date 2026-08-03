# `@jinn-network/policy-outcomes`

> Phase A/C maturity: experimental, `experimental-policy` release group, publication disabled.
> The production adapter is deliberately deferred (program §1 C8): a named tier-4 product must
> first supply the seven curation-precedent joins plus tuple derivation and per-axis fidelity
> resolution, with a fail-closed conflict policy. A second consumer is required before that join
> may be extracted into discovery facts.

## What this is

The policy-keyed sibling of `@jinn-network/task-curation`: a projection of observed verdicts
into per-**treatment** aggregates, instead of per-task ones.

`projectPolicyOutcomes(observations)` takes policy-keyed verdict observations and returns rows
keyed by `(tupleDigest, bucket)`, each carrying `{tupleDigest, axes, bucket, attempts, verdicts,
passRate: {num, den}, pinning, window, inputRefs}`. `foldPolicyOutcomes(previous, observations)`
folds new observations into an existing projection and is idempotent under at-least-once
redelivery.

It is a **projection, never a record**. Nothing here seals, signs, hashes an on-chain identity,
or assigns a record kind. `serializePolicyOutcomesProjection` emits host-stored derived state
under the format token `network.jinn.policy.outcomes-projection/1.0` — a format, not a record
kind. Anyone can throw the stored document away and re-derive it from the announcements listed
in every row's `inputRefs`.

The package is pure: no clock, no network, no filesystem, no randomness. `Date.parse` is the
only time primitive it uses, and it is a pure function of its argument. Every instant in the
output came from an observation. A guard (`.github/scripts/policy-outcomes-guards.test.mjs`)
enforces this by scanning the source.

**Rows are keyed by treatment, not by task.** `PolicyOutcomesRow` deliberately carries no
`taskDigest` — the whole point of this projection (substrate §6.1) is pooling verdicts across
whatever subject tasks happened to be attempted under the same execution-policy tuple. A single
row can (and typically will) mix observations from many different `taskDigest`s.

## Bounded claims

The numbers on a row describe **what was observed under the requested treatment**, and nothing
more.

- `tupleDigest` names a **requested** treatment (substrate §4.1); it says nothing about whether
  the request was honored. `pinning` is the disclosure of what verification established.
- `attempts` — the number of *distinct attempts among the observed verdicts*, counted by
  `attemptUri`. `verdicts` — every observed verdict, including `inconclusive`.
- `passRate` — `num` = pass, `den` = pass + fail; inconclusive is counted in `verdicts` but
  excluded from `den`. Always a pair of integers; no float anywhere on the output.
- `pinning` — per axis (`harness`, `model`, `loadout`, `isolationPolicy`), the count of `match`,
  `mismatch`, and `unverifiable` observations (substrate §7). Each axis's three counts always sum
  to the row's `verdicts`: every observation contributes exactly one status per axis. **The
  weakest-axis rule** (substrate §4.3) is a consumer's job, not this package's: nothing here
  collapses four axes into one strength, and nothing upgrades `unverifiable`.
- `axes` denormalizes the tuple's own values onto the row for filtering (e.g. a UI listing rows
  by harness without a second dereference). It is not a second source of truth: every observation
  folded into one row hashes, via `tupleDigest`, to that row's key, so all of them share
  canonically-identical tuple bytes.
- `window` — `{first, last}` observation instants, compared by instant value rather than by
  string so offsets other than `Z` order correctly.

A row is not a statement about the policy's quality. It is a statement about a population of
observed verdicts, produced by whichever solvers and evaluators happened to act under that
treatment, under whatever incentives were in force. **No thresholds in-package**: how many
samples are enough, how much fidelity disclosure is sufficient, and any policy-value verdict are
consumer decisions with caller-supplied parameters — this package never adopts a default.

## Adapter boundary

`PolicyOutcomeObservation` is a neutral input type defined in this package. It mirrors
`@jinn-network/task-curation`'s `CurationObservation` field for field, plus the policy join
(`tuple`, `perAxisStatus`). The adapter that resolves `taskDigest`, `attribution`, `benchmarkRun`,
and `ref` from discovery announcements lives **outside** this package, exactly as curation's
does (see its README "Adapter boundary" for those five joins). This package adds two more joins
the adapter must supply:

| Field | Where an adapter reads it from |
| --- | --- |
| `tuple` | The REQUESTED execution-policy tuple, derived by the adapter from the (Task, Submission) pair via `@jinn-network/policy-identity`'s `deriveExecutionTuple` (substrate §4.1). This package never derives one — it only canonicalizes and digests an already-constructed tuple. |
| `perAxisStatus` | The adapter-resolved treatment-fidelity disclosure (substrate §7): `match` on an `enforced` axis via the local backend's admission gate + Runtime Observation corroboration, `unverifiable` as the honest default everywhere fidelity legs do not yet exist. The benchmarking design (§8.1/§12.1) owns the derivation rule; this package only carries the vocabulary. |

`inputRefKey(ref)` is the discovery subscribe plane's at-least-once dedupe tuple `(source agent,
source name, entry digest, announcementId)` — identical to curation's `inputRefKey`. Folding on
it is what makes redelivery a no-op.

## Manipulation, and what this layer can and cannot do

Sybil and collusion effects on an observed pass rate **cannot be prevented at the projection
layer** — identical posture to curation. `fixtures/observations-manipulation.json` and
`src/manipulation.test.ts` pin both derivations: twelve observations under one tuple, four honest
and eight from a sybil cohort. The unfiltered projection reports `{num: 10, den: 12}` with all
twelve refs present; a consumer excluding the cohort re-derives `{num: 2, den: 4}` from the same
announcements.

### The re-announcement boundary (substrate §6.2/§6.3)

Re-announcing a favorable verdict through a second discovery source is cheaper than mounting a
Sybil cohort, so the design calls it out separately: "the adapter contract dedupes on the
underlying verdict record digest, not only on the announcement dedupe tuple." This package's own
fold discipline is inherited verbatim from curation and dedupes **only** on the announcement
tuple. `src/reannouncement.test.ts` demonstrates, honestly, both halves of that:

1. Without adapter-side handling, the same underlying verdict re-announced through a second
   source (different `source`, `entry`, `announcementId`) is counted **twice** — this layer
   cannot and does not silently prevent it.
2. `PolicyOutcomeInputRef.record` (mirroring `AnnouncedItem.record.digest`, a content digest) is
   identical across both re-announcements and visible on every row's `inputRefs`, exactly the
   field a consumer or the tier-4 adapter needs to detect and collapse the duplicate — the same
   "manipulation is visible in the inputs" posture as the sybil cohort above.

See "Findings" F-C2-2 below for the one thing this test does **not** resolve.

## Fixtures

`fixtures/` is exported (`@jinn-network/policy-outcomes/fixtures/*`) so a reviewer can re-derive
by hand: `observations-golden.json` (two tuples x two buckets) → `projection-golden.json` is
pinned byte-for-byte by `src/golden.test.ts`, three ways (forward, reversed, and through an
incremental fold).

## Findings

Every ambiguity or interface-availability gap this package hit, with a proposed disposition.
None was resolved by silent improvisation.

### F-C2-1 — `tupleDigest`/`canonicalTupleBytes` are not yet exported by `@jinn-network/policy-identity`

Substrate §2 declares the dependency direction: "outcomes imports identity for the tuple type
**and digest** — one direction, declared." At the time this package was written,
`@jinn-network/policy-identity` ships only C1's conformance kit (program §1 C1 "Produces"; see
`packages/policy/identity/README.md` "Handover") — its public surface exports the frozen type and
token vocabulary only (`ExecutionPolicyTuple`, `CORE_AXES`, `EXECUTION_TUPLE_FORMAT_TOKEN`), not
yet `canonicalTupleBytes`/`tupleDigest`. Per program rule R1, C2 builds against C1's kit, not its
implementation.

**Proposed disposition:** `src/tuple-support.ts` implements the same normative procedure
(substrate §4.1 step 5: I-JSON, JCS, UTF-16 code-unit member ordering, sha256) locally, pinned for
byte-for-byte parity against C1's own committed golden fixtures
(`packages/policy/identity/fixtures/tuple/golden/*.json`, exercised in
`src/tuple-support.test.ts`). This is not a novel duplication of business logic: unlike
`deriveExecutionTuple` (C1's actual hard problem), canonicalizing an already-constructed tuple has
no implementation-defined behavior, and every sealing package in this stack
(`packages/environments/record/src/canonical.ts`, `packages/benchmarking/records/src/canonical.ts`,
C1's own `fixtures/reference/canonical.ts`) independently implements the identical rule rather
than importing a shared canonicalizer. **Follow-up:** once C1 ships `canonicalTupleBytes`/
`tupleDigest` from its public surface, delete `src/tuple-support.ts`'s canonicalization internals
and import them directly; `denormalizeAxes` and `assertValidTuple`'s core-axis check may still be
package-local (they are policy-outcomes-specific row-shaping, not C1's surface).

### F-C2-2 — whether `ref.record` is guaranteed source-invariant for the same underlying verdict is outside this package's boundary

The re-announcement fixture (`src/reannouncement.test.ts`) demonstrates that
`PolicyOutcomeInputRef.record` (mirroring curation's `CurationInputRef.record`, itself
`AnnouncedItem.record.digest` — a content digest, not an announcement-event digest) is the field
an adapter needs for dedupe-by-underlying-verdict-record-digest (substrate §6.3). Whether two
independent discovery sources observing the **same** underlying fact are guaranteed to produce
the same `record.digest` depends on the determinism of the upstream marketplace projector's
facts-card derivation (`packages/marketplace/projector/src/announce.ts`) — a property outside
this package's boundary (it has no fetch capability and imports nothing from discovery or
marketplace) and outside C2's remit to verify.

**Proposed disposition:** routed to the coordinator and C8 (the policy-outcomes adapter, program
§1 C8): before C8 implements the adapter's re-announcement dedupe, confirm the facts-card
derivation is a pure function of the underlying on-chain fact (in which case `ref.record` is
sufficient as specified), or extend `PolicyOutcomeInputRef` with an explicit
`verdictRecordDigest` field distinct from the announcement's own record digest if it is not. This
package's `ref` shape is unchanged either way pending that confirmation, since curation's
identical shape sets the precedent for "dedupe tuple identical to curation's" (program §1 C2).

### F-C2-3 — conflict detection against a previous (stored) projection cannot see full observation disagreement

Inherited from curation's own documented closure (`packages/task-supply/curation/src/projection.ts`,
`SeenAnnouncement`): a previous projection retains each row's `inputRefs` but not the observation
behind each ref, so `foldPolicyOutcomes(previous, observations)` can only check a same-ref
redelivery for **ref agreement**, not for full-observation agreement (verdict, `perAxisStatus`,
`taskDigest`, etc.). Two observations sharing a dedupe key that arrive in the **same** fold call
(both fresh) are checked against every field; a same-ref redelivery re-derived from a previously
folded and re-parsed projection is not. `src/fold.test.ts` pins both halves so the boundary is
visible rather than assumed. Not a new gap C2 introduces — recorded here because it applies with
one more field (`perAxisStatus`) than curation's original statement of it.
