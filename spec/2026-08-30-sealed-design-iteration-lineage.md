# Sealed design iteration lineage

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-30 |
| **Author** | Autopilot design session (seam citations read against `next` @ `1e78bd5ea`) |
| **Shape** | `design` — the output is this spec. Nothing here merges code; §11 is the follow-on implementation map |
| **Status** | Proposed |
| **Answers** | issue [#2861](https://github.com/Jinn-Network/mono/issues/2861) |
| **Design scope** | How a design that is iterated before it is sealed carries that iteration as product records, and what a verifier may conclude from them |
| **Depends on** | [evolving task sets and lineage](2026-08-29-evolving-task-sets-and-lineage.md) (the sibling ruling on lineage, whose rules this spec inherits rather than restates); [benchmarking application design](../docs/superpowers/specs/2026-07-28-benchmarking-application-design.md) §6.2/§6.3; [benchmark product design](../docs/superpowers/specs/2026-08-05-benchmark-product-design.md); [pluggable integrity providers](../docs/superpowers/specs/2026-08-17-pluggable-integrity-providers-design.md) §7/§9; [publication interoperability profile](../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md) §9.3; [disclosure specification record](../docs/superpowers/specs/2026-08-19-disclosure-specification-record.md) (the record/carriage/claim/check pattern this design follows) |
| **Blocked until** | the judge-report program [#2833](https://github.com/Jinn-Network/mono/issues/2833) completes. Per the issue, nothing here is run-blocking for anything in that program, and no packet of this spec may be scheduled ahead of it |
| **Does not do** | Task-set lineage (the sibling spec owns it). Reader wording and page layout. Any rendering of what a revision changed in substance. Any change to the lock ceremony's gates, to `Run`'s sealed fields, or to the frozen bundle check list |

## 0. The decision in plain language

The product's machine-checkable record of an experiment begins at `lock`. Everything
before it — the iteration that actually produces the design — has no product
representation at all. A draft is a mutable local document, `lock` seals it once, and
the only exit from `locked` is `launch`. So a publisher who amends a design before
sealing it either keeps the lineage by hand or does not keep it.

This house has kept it by hand twice, at full size, and both attempts are worth reading
as requirements rather than as anecdotes (§1.2). The verdict from them is narrow: the
discipline is right, the accounting is what fails. Hand-cut hash chains lose their own
predecessors, hand-typed version counters drift away from the artifacts they count,
same-day dates stop being an ordering, and superseded-clause accounting written as prose
has no referential integrity — to the point where one amendment superseded its own
sibling clauses and only a hand-written tie-break sentence resolved it.

So this spec does not propose a design-authoring system. It proposes one small sealed
record whose only job is to make three facts checkable that are prose today: **which
exact bytes this revision replaces, what it supersedes, and where it sits relative to the
seal.** Everything else is left to the author's own words, carried and never checked.

Two constraints carry most of the weight.

**The Run is not the amendable unit.** The Run record is sealed at lock and its
immutability is correct. What iterates is the design statement that *precedes* the Run,
which is why adding `supersedes` to `Run` would not have captured either worked example
(§1.3). The record goes on the thing that iterates, and the sealed Run names its head.

**The lock digest dates the whole chain, so no new ordering primitive is needed.** The
head revision's digest sits inside the sealed Run bytes, and every link binds exact
predecessor bytes, so every revision in the chain existed before the Run's bytes did. The
shipped lock anchor already dates those bytes and already refuses to run after launch.
The chain inherits that ordering for free (§5).

## 1. What actually iterates, and where the product's evidence starts

### 1.1 The lock is the product's first checkable fact

`packages/benchmark-product/core/src/domain/lifecycle.ts` gives the state machine
`draft → quoted → locked → running → closed → reported → published-bundle`, and the
`locked` row admits exactly one event:

```ts
  locked: {
    launch: "running",
  },
```

`runLock` (`core/src/operations/run-lock.ts`) refuses any draft that is not `quoted`,
refuses when the quote has been invalidated by an edit, compiles the draft, seals the Run
record, and stores its exact bytes. Its own header states the consequence: "Once locked,
the draft is immutable by construction."

That is correct and this spec does not touch it. But it means the product's evidence
starts one step too late. Every fact the bundle can prove is a fact about a design that
was already finished. The work of arriving at that design — which is where a reader's
suspicion actually lives, because it is where a publisher could have tuned the design
against results they had already seen — leaves no product trace.

### 1.2 Two worked examples, at full size

**The judge-report packet.** The issue describes it: five successive draft manifests plus
a prose amendment record enumerating which clauses each amendment supersedes, "held
together by discipline rather than product." The packet itself has since moved out of
this repository, so this spec describes the pattern rather than its contents, and cites
only what remains public here. The governing rule survives on this checkout in
[`docs/superpowers/plans/2026-08-18-judge-report-implementation-program.md`](../docs/superpowers/plans/2026-08-18-judge-report-implementation-program.md):
the posted text is the commitment, and any change is a dated amendment posted **before**
any outcome is observed. The runbook
[`docs/runbooks/judge-report-official-run.md`](../docs/runbooks/judge-report-official-run.md)
carries the operational form of the same rule.

Five properties of that packet are requirements for anything that replaces it, and each
one is a failure the hand-cut version had:

1. **A link must bind bytes the holder still has.** The earliest two manifests each
   recorded a digest of a predecessor whose bytes were never retained. Those links are
   unverifiable in principle, not merely inconvenient.
2. **A revision counter must be derived, not typed.** The counter reached six while five
   snapshots existed and the rolling manifest had in fact been re-cut eight times. Six
   re-cuts inside one amendment left no lineage record at all.
3. **A date is not an ordering.** Two amendments carry the same calendar date with no
   time and no zone, so their order is recoverable only from the counter that had already
   drifted.
4. **Superseded-clause accounting needs identity.** References were free prose against
   section numbers that move. Nothing could detect a superseded clause that was never
   edited, a clause superseded twice, or a section number that had since shifted.
5. **Supersession within one amendment must be unrepresentable.** One item in the final
   amendment superseded parts of seven of its own siblings, resolved only by a prose
   tie-break sentence written earlier in the same document.

A sixth property is the one the issue names as the thing worth preserving as data:
pre-outcome ordering. In the hand-cut version it is a single self-attesting sentence,
cross-checked against nothing.

**The long-tail protocol probe.** The second example is on this checkout and points the
other way. [`experiments/defi-longtail-probe/PREREGISTRATION-AMENDMENT-1.md`](../experiments/defi-longtail-probe/PREREGISTRATION-AMENDMENT-1.md)
is an amendment committed **mid-run**, and it opens with a section headed "Disclosure:
what was already scored when this was committed" that names exactly which 24 of 42 cells
had been scored, what they scored, and which of the affected instances were still
unscored. It closes: "No renegotiation of these rules after the remaining 18 cells
score."

That is the honest form of a post-outcome amendment, and it matters because the issue's
own framing — "each reseal predates outcomes" — is narrower than this house's actual
practice. A design record that can only express clean pre-outcome revisions would have
had nothing to say about the probe, and a publisher facing that gap would either amend
silently or not amend. The vocabulary must have a place to write the exposure down.

### 1.3 The Run is not the amendable unit

The obvious move is to give `RunRecordSchema` a `supersedes`, mirroring
`BenchmarkRecordSchema`. It is the wrong move, for two independent reasons.

**It contradicts a correct rule.** `locked` has one exit. A sealed Run that can be
replaced by a successor Run is a lock that does not lock, and the escape hatch would be
available at exactly the moment it is most dangerous — after launch, when outcomes exist.

**It would not have captured either example.** Both worked examples iterated entirely
*before* any Run record existed. The judge-report packet's five manifests are pre-lock
documents; the Colophon Run that carries an ordering guarantee had not been created yet.
So a Run-level `supersedes` would have had nothing to link.

The amendable unit is the design statement that precedes the Run. The product has no
record for it, which is the actual gap, and adding one is cheaper than the alternative
because the seam it plugs into already exists (§2.3).

## 2. What already exists

Five shipped primitives cover most of this design. Naming them precisely is the point of
this section: the acceptance criteria ask for reuse, and the honest answer is that only
one genuinely new thing is needed.

### 2.1 The link shape is ratified and implemented

`packages/benchmarking/records/src/benchmark/schema.ts:34` carries
`supersedes: DigestBearingResourceDescriptorSchema.optional()`, and
`records/src/benchmark/checks.ts:144` `checkBenchmarkPredecessor` binds a successor's
declared digest to exact canonical predecessor bytes, failing as `missing-supersedes`,
`invalid-predecessor`, or `digest-mismatch`.

The sibling spec's §3 ruled on what such a chain means, and this spec inherits every one
of those rules without restating them: digest is identity and version is a label; a
lineage is a claim while each link is a fact; an unlinked successor is a distinct object;
the chain is not a total order; a report says only what it can prove.

### 2.2 A per-revision manifest already has a schema

`records/src/publication-extension.ts:11`:

```ts
/** A registration artifact commits a Run to bytes whose meaning remains adapter-owned. */
export const RegistrationArtifactSchema = z.object({
  role: AbsoluteIriSchema,
  artifact: DigestBearingResourceDescriptorSchema,
});
```

A list of `(role, digest)` pairs, sorted and unique by role then digest, whose meaning the
records layer deliberately does not own. That is precisely what a draft manifest is. The
hand-cut manifests were this shape written in `sha256sum` format, and this spec reuses the
schema rather than inventing a second spelling of it.

### 2.3 The carriage seam is already sealed into the Run

`run-lock.ts` already attaches the publication extension at lock:

```ts
      const runWithPublicationAuthorization = withRunPublicationExtension(
        compiled.plannedRun.record as unknown as Record<string, unknown>,
        {
          registrationArtifacts: [...runtimeRegistrationArtifacts(...)],
        },
      );
```

`registrationArtifacts` is role-keyed, so a new role is additive by construction and needs
no schema change to the extension. `core/src/operations/publication-report.ts:217` already
iterates that list, and `publication-register.ts:242` already pulls it into the publication
closure. This is the whole carriage story for a pre-lock chain.

### 2.4 Ordering receipts exist, in three shipped shapes

- `records/src/accounting/schema.ts:54` `RegistrationBoundarySchema` — a discriminated
  union of a record-discovery source position and a substrate anchor — with
  `PublicRegistrationSchema` (`:76`) carrying `pre-dispatch` / `post-hoc` /
  `unverifiable`, and `accounting/checks.ts:18` `checkPublicRegistrationOrder` returning
  `pass | fail | indeterminate` over it. This is the house's canonical vocabulary for
  "did X precede Y, and can anyone check."
- `packages/benchmarking/run/src/checks.ts:60` `checkPreregistrationPrecedesDispatchLegA`
  and its anchored leg at `:104`, with the local-append leg at `:89` marked explicitly
  non-decision-grade.
- `core/src/operations/run-anchor.ts` — third-party time evidence over the Run's own lock
  digest, refusing once `launchedAt` is set (`:209`), verified before storage, write-once
  per subject and provider.

### 2.5 Chain-resolution hazards are already enumerated

`packages/evidence/offer/src/supersession.ts:39` `resolveLiveOffers` is the reference
fold: self-supersession, unknown predecessor, subject mismatch, foreign supersession,
fork, and cycle each have a named diagnosis, and an unknown predecessor is deliberately
non-fatal because "the predecessor is simply not in hand." §7's check lifts that taxonomy
rather than rediscovering it.

The repository currently holds three incompatible fork policies —
`resolveLiveOffers` keeps both forks live, `core/src/run/state.ts`'s anchor-upgrade chain
refuses a fork outright, and the sibling spec rules that a lineage may legitimately fork.
§3 rule 6 resolves which applies here and why.

## 3. Ruling

**Build it, as one sealed record and one sub-check, and not before two conditions hold.**

The strongest argument against building is real and should be stated first. The Benchmark
`supersedes` chain shipped with a full check suite and, as the sibling spec's §2.3
records, has no production call site: `classifyVersionBump` and `checkBenchmarkTransition`
are a library surface exercised only by tests. Shipping a second lineage concept while the
first is unwired would mint exactly the drift that spec's M5 already warns about, where
two implementations of one rule diverge.

The answer is sequencing, not refusal:

- **Condition 1.** The judge-report program [#2833](https://github.com/Jinn-Network/mono/issues/2833)
  completes. This is the issue's own deferral and it is not negotiable here.
- **Condition 2.** The sibling spec's M6 two-bundle lineage check ships, so the reader
  verifier already holds a lineage-walking seam this design extends instead of duplicating.

And a scope ruling: **Part A only, first.** Part A is the record, the Run carriage, and
the sub-check for a chain that is entirely pre-lock. Part B — a revision authored after
lock, carried by the Report, with a disclosure of what had already been observed — waits
for a second real instance. The house has exactly one (§1.2's probe) and it was not a
Colophon run. Designing Part B now is specified in §5.2 so the record shape does not have
to change later; building it now would be speculation.

Seven rules follow. Each is enforced structurally where it can be, and §4's schema is
written so that violating one is a parse failure rather than a review finding.

**Rule 1 — The record covers the design statement, never the Run.** `RunRecordSchema` is
unchanged. `locked` keeps its single exit.

**Rule 2 — A link binds exact predecessor bytes.** `supersedes` names a digest, and the
check resolves it to bytes that parse as a revision and re-hash to that digest, exactly as
`checkBenchmarkPredecessor` does. A digest whose bytes nobody holds is reported as an
unresolved predecessor, never as a valid link. This is requirement 1 of §1.2.

**Rule 3 — Nothing derivable is stored.** There is no version field and no revision
number. The chain's length is the revision number and the reader derives it. This is
requirement 2 of §1.2, and it is the sibling spec's "digest is identity, version is a
label" applied to a chain the reader is already walking.

**Rule 4 — The author's words are carried, never checked.** The statement of what changed
and why is the author's own original prose. The product never parses it, never summarizes
it, never renders a diff, and never asserts what a revision changed in substance. This is
the disclosure record's R4 and R7 applied unchanged: the verifier authenticates
measurements and carries assertions.

**Rule 5 — Supersession is between revisions, so it cannot occur inside one.**
`supersedes` names a predecessor revision's digest. A revision cannot name its own digest,
so the case that needed a prose tie-break in the hand-cut version is unrepresentable here:
it has to be two revisions. This is requirement 5 of §1.2, and it is the clearest example
of the product enforcing a discipline the prose could only ask for.

**Rule 6 — Within one Run the chain is a total order; across Runs it is not.** The sealed
Run names exactly one head, so a fork inside one Run's chain is a refusal, following
`run/state.ts`'s anchor-upgrade policy rather than `resolveLiveOffers`'s. Two different
Runs whose chains share an ancestor is an ordinary fork, legitimate, and the reader's to
interpret — the sibling spec's rule, unchanged. This resolves §2.5's three-policy conflict
by scope rather than by preference.

**Rule 7 — The product declares a predecessor; it never claims a complete history.** A
publisher can abandon a chain and seal a fresh unlinked one, which is the anchor design's
own named *selective publication* residual (§9.1 there: "anchors date what is published,
not what was abandoned"). No surface may say "iteratively refined", "fully amended", or
anything a reader would hear as a completeness claim. The face states the declaration and
the digests, and stops.

## 4. The record

Field names and token values below are normative.

### 4.1 Identifiers

```
DESIGN_REVISION_RECORD_KIND
  = "https://spec.jinn.network/records/design-revision/v1"
DESIGN_REVISION_MEDIA_TYPE
  = "application/vnd.jinn.design-revision.v1+json"
DESIGN_REVISION_ROLE
  = "https://spec.jinn.network/roles/design-revision/v1"
```

The record-kind URI follows the record-discovery grammar as
`records/src/identifiers.ts:20-28` states it, in the `v1` spelling every shipped sibling
constant uses. `DESIGN_REVISION_ROLE` is a `registrationArtifacts` role, not a new
extension key: §2.3's list is role-keyed, so no extension schema changes.

### 4.2 Shape

```jsonc
{
  "kind": "https://spec.jinn.network/records/design-revision/v1",
  "author": "<absolute agent IRI>",
  "at": "<calendar-strict RFC 3339 timestamp>",
  "statement": "<the author's own prose: what this revision changes, and why>",
  "manifest": [
    { "role": "<absolute IRI>", "artifact": <DigestBearingResourceDescriptor> }
  ],
  "supersedes": {
    "revision": { "sha256": "<64 lowercase hex digits>" },
    "clauses": [ { "role": "<absolute IRI>", "locator": "<author's own reference>" } ]
  },
  "exposure": <Exposure>
}
```

Constraints:

- Strict object over exactly these seven keys, minus `supersedes` on a root revision.
  Unknown keys refuse. Sealed once through `sealRecord`; identity is the SHA-256 of those
  exact bytes forever.
- `kind` is a literal. `author` matches `AgentIriSchema`
  (`records/src/descriptors.ts:20-24`).
- `at` is the author's clock and is a **label, not a fact**. It orders nothing, and no
  check consumes it. It exists because a reader wants to see what the author believed the
  date to be, and because omitting it would push authors to encode a date inside
  `statement` where nothing could even find it. §1.2 requirement 3 is the reason it is
  labeled this bluntly.
- `statement` is non-empty, and is carried under rule 4. No length cap beyond the
  record-size limits every sealed record already has.
- `manifest` is a non-empty array of `RegistrationArtifactSchema` entries (§2.2), sorted
  and unique by role then `sha256`, reusing that schema's own refinement verbatim. It is
  the digest-freeze of the design bytes this revision covers, and its per-entry meaning
  stays adapter-owned exactly as the schema's comment says.
- `supersedes` is absent on a root revision and present otherwise. It has exactly two
  keys, both required:
  - `revision.sha256` is the predecessor's record digest, in the DigestSet spelling
    (`{ "sha256": "<hex>" }`) that `Sha256DigestSetSchema` uses, not the `sha256:`-prefixed
    string form.
  - `clauses` is a non-empty array, sorted and unique by role then locator. `role` must be
    a role the **predecessor's** `manifest` actually names — which is checkable, and is the
    part of §1.2 requirement 4 the product can enforce. `locator` is the author's own
    reference inside those bytes (`"§7 items 4-5"`); it is prose, carried and never
    checked, because the bytes it points into are adapter-owned.
- `exposure` is required. §4.3.

An absent `supersedes` cannot distinguish a genuine first revision from a predecessor the
author declined to declare. That hole is real and is the same one the sibling spec files as
D7; §14 inherits its deferral rather than pretending a sealed declination exists.

### 4.3 `Exposure` — a status the carrier proves, not one the author asserts

```jsonc
{ "status": "sealed-before-lock" }

{ "status": "sealed-after-lock",
  "observed": "<the author's own disclosure of exactly which outcomes were already known>",
  "boundary": <RegistrationBoundary>   // optional
}
```

The token names **what a reader must check**, not what the author claims is true. That
distinction is the reason this design does not repeat the defect in
`packages/benchmarking/protocol/src/manifest.ts:111`, where `preregistration` is a
four-valued enum the publisher writes and nothing cross-checks against any boundary.

- `sealed-before-lock` carries no evidence of its own and asserts nothing. It is a
  statement about **carriage**: this revision claims to be reachable from the head named
  inside a sealed Run. §7 step 4 either finds it there or refuses the record. An author who
  writes this token on a revision that is not in the chain has produced a record that fails
  verification, not a record that lies successfully.
- `sealed-after-lock` requires `observed` — non-empty prose, carried under rule 4 — and is
  the vocabulary §1.2's probe needed. Its `boundary` is `RegistrationBoundarySchema`
  (§2.4) reused unchanged, and is optional for the same reason `publicRegistration`'s
  `unverifiable` arm keeps its boundaries optional: a publisher who has no comparable
  ordering authority should still record what they have rather than write nothing.
- There is no third token. A revision is either inside the lock or after it; the
  `unverifiable` case is not a third state here, because the carriage question has a
  definite answer once a reader holds the Run.

The schema alone cannot enforce the pairing of token to carrier, because a record is sealed
before its carrier exists. §7 enforces it, and that is stated here so the gap is a named
division of labor rather than an omission.

## 5. Ordering

### 5.1 The lock digest dates the whole chain

The chain of reasoning, each step citing something already shipped:

1. `runLock` seals a Run only from a `quoted` draft, and `lifecycle.ts` gives `locked` one
   exit, `launch`. So a sealed Run's bytes exist before any dispatch.
2. The head revision's digest is inside those sealed bytes, as a `registrationArtifacts`
   entry under `DESIGN_REVISION_ROLE` (§2.3).
3. Every link binds exact predecessor bytes (rule 2), so a successor's bytes cannot be
   formed until its predecessor's digest exists.
4. Therefore every revision reachable from the head existed before the Run's bytes did.
5. `run-anchor` already obtains third-party time evidence over the Run's lock digest, and
   already refuses once `launchedAt` is set (`run-anchor.ts:209`).

So a verified lock anchor dates the entire chain at once, and **this design adds no new
ordering primitive for the common case**. That is the strongest reuse available and it is
worth stating as the reason the record is small: the ordering problem the issue names was
already solved for the Run, and the chain simply hangs off the thing that was solved.

Step 3 is also what makes a cycle unreachable. A cycle would require a record whose bytes
contain the digest of bytes that contain its own digest. The check asserts non-self-
reference because it is cheap, and otherwise reports an unresolved predecessor rather than
running a cycle search.

### 5.2 The post-lock revision, and why the Report carries it

A revision authored after lock cannot be carried by the Run, because the Run is sealed. It
is carried by the **Report**, through an additive optional block, for the same reason the
disclosure record chose that carrier: the Report is already a DSSE payload signed by the
report authority, so the revision is covered by the author's existing signature at no new
key-management cost, and a second signature over the same claim by the same key would only
create a way for the two to disagree.

Three rules bind Part B when it is built:

- A `sealed-after-lock` revision's `supersedes.revision` must resolve into the Run-carried
  chain or into an earlier Report-carried revision. It may not start a new root.
- `observed` is mandatory and is what the face shows. The probe's disclosure section is the
  model: name what was already known, not merely that something was.
- No post-lock revision may be represented as pre-outcome by any surface, whatever its
  `boundary` says. An anchor over a post-lock revision dates bytes; it says nothing about
  what the author had seen.

Part B is specified here and built later (§3). Specifying it now is what keeps the record
shape stable: `exposure` exists from v1, so adding Part B later is wiring rather than a
format revision.

### 5.3 What no anchor upgrades

Inherited verbatim from the anchor design §9.1 and restated because a lineage surface is
exactly where a reader would over-read them:

- *run-before-lock* — nothing proves the results were produced after the anchored time.
  Execution timing on a self-run venue stays owner-asserted.
- *selective publication* — an owner can discard an anchored chain and start over. This is
  rule 7's whole basis.
- On a self-run venue with no anchor at all, the chain is owner-asserted end to end, which
  is what [`packages/benchmark-product/EXTERNAL-VERIFICATION.md`](../packages/benchmark-product/EXTERNAL-VERIFICATION.md)
  already prints: "Pre-registration here is a discipline enforced by this tool, not a proof
  against the run's own owner."

What the chain adds without any anchor is still worth having, and it is worth being precise
about: it does not make a dishonest publisher honest. It makes an honest publisher's
discipline **checkable and cheap** — every link binds real predecessor bytes, every
superseded clause names a role the predecessor actually froze, the revision count is
derived rather than typed, and intra-revision supersession is unrepresentable. The hand-cut
version failed four of those five.

## 6. Carriage and binding

Four bindings for Part A, all required together.

1. **Run extension.** The head revision appears in the sealed Run's
   `registrationArtifacts` under `DESIGN_REVISION_ROLE`. Exactly one entry with that role
   (rule 6); two is a refusal.
2. **Publication closure.** Every revision in the chain, and every artifact each revision's
   `manifest` names, joins the publication closure through the path
   `publication-register.ts:242` already walks for `registrationArtifacts`.
3. **Bundle members.** Each revision's sealed bytes are content-addressed members under
   `records/<sha256>.bin`, the way every other sealed record in the bundle already is. No
   new fixed bundle member, and therefore no `bundle.json` format literal change.
4. **Claim projection.** The head revision's digest and the derived chain length project
   into the claim package as one additive optional strict block, following the
   `suiteComparability` precedent in `core/src/report/claim.ts` and explicitly not the
   `anchors` precedent, whose `superRefine` tie to specific schema ids is what made it a
   version event. The sibling spec's §8 M1 records that reasoning; this spec applies it.

The `manifest` entries' referenced artifacts are the design bytes themselves. Whether those
bytes are published or only digested is the publisher's choice and outside this spec: a
digest-only revision still verifies as a link, and a reader who holds no design bytes can
still walk the chain. Publishing the bytes is what lets a reader read the design; not
publishing them is a disclosure choice the existing surfaces already govern.

## 7. The check

The check lands **inside the existing `claim-consistency` name**, not as a new entry in
`PUBLIC_BUNDLE_VERIFICATION_CHECKS` (`verify/src/reader-instructions.ts:1-8`). That list is
frozen and enforced against every claim schema id, so adding a name to it is itself a format
event — the sibling spec's §8 M2 finding, applied unchanged.

Steps, in order, refusing at the first failure:

1. **Head resolution.** Read the Run's `registrationArtifacts`; find entries under
   `DESIGN_REVISION_ROLE`. Zero entries means this bundle declares no design lineage and
   every later step reports `skipped`, not `fail`. Two or more is `fail` (rule 6).
2. **Parse.** Resolve the head digest to bundle bytes, `parseExact` them as a design
   revision, and confirm they re-hash to the declared digest.
3. **Walk.** Follow `supersedes.revision.sha256` until a revision has none. At each link:
   the predecessor resolves and re-hashes; the predecessor is not the successor itself; and
   every `clauses[].role` names a role present in the **predecessor's** `manifest`. A
   predecessor whose bytes are not in the bundle is reported as `unresolved-predecessor`
   with the digest named — the sibling spec's "not directly linked" discipline, not
   "unrelated" and not `fail`.
4. **Carriage.** Every revision reached in step 3 carries
   `exposure.status = "sealed-before-lock"`. A `sealed-after-lock` revision inside the
   Run-carried chain is `fail`: it claims a carriage it does not have.
5. **Manifest integrity.** Each revision's `manifest` is sorted and unique by role then
   digest, and every artifact it names that is also a bundle member re-hashes correctly.
   Artifacts not carried in the bundle are reported as digest-only, not as failures.
6. **Claim projection.** The head digest and the derived chain length in the claim package
   are the exact projection of what steps 1 through 3 derived.

Outcome vocabulary matches the existing tri-state house shape: `pass`, `fail`, and a
reported-but-not-failing state for the two cases where the bundle simply does not hold the
bytes (`unresolved-predecessor`, digest-only artifacts).

## 8. What the check deliberately does not do

- **It never reads a `statement`, an `observed`, or a `locator`.** Rule 4. These are the
  author's words and the check's only relationship to them is that it refuses an empty one.
- **It never asserts what changed.** No diff, no change class, no characterization. The
  sibling spec's `classifyVersionBump` derives a change class from a task set's ordered
  item list because that list has product meaning; a design revision's manifest points at
  adapter-owned bytes and has none.
- **It never claims the chain is complete.** Rule 7. It reports what the bundle declares
  and what resolves.
- **It never upgrades any other axis.** Chain state is its own disclosure. It never folds
  into a single "verified" mark, exactly as the anchor design's no-launderable-summaries
  discipline requires.
- **It never cross-checks `at` against anything.** §4.2 says why.

## 9. Prior art considered

### 9.1 Git commit DAGs

The acceptance criteria name this and it is the right first reference. Git's commit graph
is exactly this shape: each commit names its parents by content hash, a commit's identity is
the hash of its content **and** its parents, and the result is a partial order rather than a
sequence.

Two lessons adopted:

- **Parent-by-hash makes a rewritten history a different history rather than an edited
  one.** Rebasing does not modify commits; it produces new ones with new identities and
  leaves the originals reachable until they are pruned. Rule 2 takes this directly, and it
  is what §1.2 requirement 1 was reaching for by hand.
- **Git keeps ordering out of band, on purpose.** A commit's author and committer dates are
  unverified strings the author supplies, and every real ordering guarantee git users rely
  on comes from somewhere else: a signed tag, a push receipt on a server they do not
  control, a CI run. §4.2's blunt labeling of `at` and §5's routing of ordering through the
  carrier and the anchor are the same architecture, arrived at for the same reason.

One lesson declined: git admits multiple parents, because a merge commit means something
specific and checkable. A design revision has exactly one predecessor. Merging two design
lineages has no meaning the product could verify, and admitting the shape would invite a
publisher to represent an abandonment as a merge.

### 9.2 Trial registries and study registrations

Clinical-trial registries and the study-registration services keep every submitted version
of a protocol, assign each a registry-side posting date, and expose the full version history
beside the current one. Amendments are not edits; they are new versions linked to their
predecessor.

The lesson taken is a single sentence: **the ordering authority must sit outside the
author.** A registry's value is not that it stores versions — a git repository does that —
but that the author cannot backdate a posting. That is exactly what §5.3 names as the
residual on a self-run venue, and exactly what the lock anchor supplies when it is present.
It is also why this spec routes so much through the anchor rather than inventing a
timestamp field: a field the author writes reproduces a registry's storage without its
authority.

### 9.3 Certificate Transparency

An append-only log with inclusion proofs, where a log that quietly omits an entry is caught
only by gossip between independent monitors — never by inspecting any single certificate.

The lesson is rule 7's whole basis, in a setting where it has been argued to exhaustion: no
self-contained artifact can prove that its own chain is complete. A bundle can prove every
link it holds and can prove nothing about a chain the publisher abandoned. Certificate
Transparency's answer is a second population of observers, which this product does not have
and this spec does not propose inventing.

### 9.4 In-repo precedents

- **`pre-run-freeze v2 ← v3 ← v4`** (`core/src/method/skillsbench-prerun-v4.ts:16-25`) is
  the house's own three-link chain and states the right doctrine — "every link is
  verifiable: v3 names v2 by schema and digest, and v4 names v3 the same way. None of the
  three earlier artifacts is rewritten." Its validation is shape-only:
  `demo1-prerun-v3.ts:268` checks that the declared digest matches `/^[0-9a-f]{64}$/` and
  never resolves it to bytes. Rule 2 exists because of that gap, and the check's step 3
  closes it.
- **`resolveLiveOffers`** (`evidence/offer/src/supersession.ts:39`) is the hazard taxonomy
  §7 lifts, including its treatment of an unknown predecessor as diagnostic rather than
  fatal.
- **The anchor-upgrade chain** (`core/src/run/state.ts:275-300`) is the fork-refusing
  policy rule 6 adopts inside one Run, and its reasoning transfers: a second edge into one
  predecessor forks a chain the carrier declared to be single-headed.
- **The fixture `errata` mechanism** (`packages/marketplace/testing/src/projector-conformance.ts:179-182`)
  is the only thing in the repository literally named an erratum chain, and it is an
  append-only-successor pattern over test fixtures. It is cited for the naming precedent
  only; nothing about its semantics transfers.

## 10. Worked example

The judge-report packet's shape, expressed in this design, without reproducing any of its
content:

- Six revisions instead of five snapshots plus a rolling head, because the counter is
  derived and a re-cut that changes bytes is a revision by definition. The six intra-
  amendment re-cuts that left no lineage record either become revisions or do not happen;
  there is no third option where the bytes move and the chain does not.
- The two dangling predecessor digests are impossible: step 3 reports them as
  `unresolved-predecessor` and names the digest, so the reader sees the gap instead of
  reading past it.
- The two same-day amendments need no date disambiguation, because the chain orders them
  and `at` was never consulted.
- The sixteen superseded-clause references become `clauses` entries. Each one's `role` is
  checked against the predecessor's manifest, so "supersedes a file this packet never
  froze" is caught; each one's `locator` stays the author's prose, so "supersedes §7 items
  4-5" is carried verbatim and never parsed.
- The item that superseded seven of its own siblings is two revisions, and the prose
  tie-break sentence has nothing left to do.
- Ordering is the lock anchor over the Run whose sealed bytes name the head, replacing the
  self-attesting confirmation sentence with a fact a reader can check — subject to §5.3's
  residuals, which no mechanism removes.

The long-tail probe's mid-run amendment is Part B: one `sealed-after-lock` revision whose
`observed` carries the disclosure of the 24 already-scored cells, and whose `statement`
carries the classification rules. The product's contribution there is small and worth being
honest about: it makes the disclosure a required field rather than a habit.

## 11. Implementation map

Sequenced, and gated on §3's two conditions. Each item is a candidate issue, not a
commitment.

- **A1 — the record.** `packages/benchmarking/records/src/design-revision/{schema,checks}.ts`,
  the three identifiers in `identifiers.ts`, and the barrel export.
  `checkDesignRevisionPredecessor` mirrors `checkBenchmarkPredecessor`'s failure vocabulary.
  No production caller yet; A3 supplies it, and A1 must not land far ahead of A3 for the
  reason §3 gives.
- **A2 — authoring.** A workspace operation that seals a revision from the current draft's
  design artifacts, and a CLI verb. The operation refuses on a non-`draft`/`quoted` state,
  since a revision authored against a locked draft is Part B.
- **A3 — carriage.** `run-lock.ts` appends the head revision to `registrationArtifacts`
  under `DESIGN_REVISION_ROLE` when the workspace holds a chain. A workspace with no chain
  produces byte-identical Run records to today's, following the anchor-intent precedent
  exactly: the record object is not touched at all rather than extended with an empty
  declaration.
- **A4 — closure and bundle.** `publication-register.ts` pulls the chain into the closure;
  `materialize.ts` writes the revisions as content-addressed members.
- **A5 — the check.** §7, inside `claim-consistency`. Rows added to
  [`EXTERNAL-VERIFICATION.md`](../packages/benchmark-product/EXTERNAL-VERIFICATION.md).
- **A6 — claim projection and face.** §6 binding 4, plus the tier-one statement. Wording and
  placement belong to the reader-surface issues, not here.
- **B1 — post-lock revisions.** §5.2. Not scheduled; see §3.

## 12. Test matrix

| # | Case | Expectation |
|---|---|---|
| T1 | Root revision, no `supersedes` | seals; check passes with chain length 1 |
| T2 | Two-link chain, both in bundle | passes; derived length 2 |
| T3 | Successor declares a digest whose bytes are absent | `unresolved-predecessor`, digest named, not `fail` |
| T4 | Successor declares a digest whose bytes are present but re-hash differently | `fail`, digest mismatch |
| T5 | Revision names its own digest | `fail` |
| T6 | `clauses[].role` names a role absent from the predecessor's manifest | `fail` |
| T7 | `clauses[].locator` is arbitrary prose | carried; never parsed |
| T8 | Unsorted or duplicated `manifest` entries | parse failure |
| T9 | Unsorted or duplicated `clauses` entries | parse failure |
| T10 | Unknown top-level key | parse failure |
| T11 | Empty `statement` | parse failure |
| T12 | `sealed-after-lock` without `observed` | parse failure |
| T13 | `sealed-after-lock` inside the Run-carried chain | `fail` at step 4 |
| T14 | Two `DESIGN_REVISION_ROLE` entries on one Run | `fail` at step 1 |
| T15 | No `DESIGN_REVISION_ROLE` entry | every later step `skipped`, never `fail` |
| T16 | Workspace with no chain | Run bytes byte-identical to a pre-feature lock |
| T17 | Revision bytes round-trip through `parseExact` | byte-identical |
| T18 | Claim projection disagrees with the derived chain | `fail` at step 6 |
| T19 | Chain of three, middle revision absent | `unresolved-predecessor` at the first broken link; earlier links unreported |
| T20 | Manifest artifact present in the bundle but re-hashing differently | `fail` at step 5 |

## 13. Boundaries

- **The sibling spec owns task-set lineage.** A Benchmark record's `supersedes` and this
  chain are unrelated fields on unrelated records. A bundle may carry both, and no surface
  may present them as one lineage.
- **The reader-surface issues own wording and placement.** This spec states what a face
  must be able to say and refuses what no face may say; it writes no copy.
- **`Run` is unchanged**, `PUBLIC_BUNDLE_VERIFICATION_CHECKS` is unchanged, and
  `bundle.json`'s format literal is unchanged. If any packet finds it needs one of those,
  it is a format revision and belongs to that queue, not to this spec.
- **This is not a design-authoring tool.** The product seals digests and accounts for
  supersession. Writing the design, deciding what to amend, and judging whether an amendment
  is legitimate stay with the author.

## 14. Deferred

- **D1 — sealed declination.** An absent `supersedes` cannot be distinguished from a
  withheld predecessor. Inherited from the sibling spec's D7; the same mechanism would
  answer both, so it should be designed once, for both, and not here.
- **D2 — chains across bundles.** A reader holding one bundle can walk only the chain that
  bundle carries. Fetching a revision by digest needs a resolution surface the
  self-contained bundle does not have; the sibling spec's D3 is the same deferral and should
  be answered once.
- **D3 — post-lock revisions.** §5.2 and §3's Part B.
- **D4 — publishing the design bytes.** §6 leaves digest-only revisions legitimate. Whether
  a Colophon bundle should carry the design documents themselves is a disclosure question
  with its own audience, not a lineage question.
- **D5 — any rendering of what changed.** Rule 4 and §8. Reopening this means reopening the
  sibling spec's D2 first, since a design diff is strictly more than a results diff.

## 15. Open questions for the operator

1. **Is `at` worth its cost?** It is explicitly not a fact (§4.2), and a field that orders
   nothing invites exactly the misreading §1.2 requirement 3 documents. The alternative is
   to omit it and let authors write a date inside `statement`, where nothing can even
   pretend to check it. This spec keeps it and labels it; the opposite ruling is defensible.
2. **Should A1 land before A3?** §3 says not far ahead, on the sibling spec's evidence that
   an unwired check suite stays unwired. A stricter ruling would require them in one change.
3. **Does Part B need a second real instance, or is the probe enough?** §3 rules that one
   non-Colophon instance is not enough to design against. An operator who expects post-lock
   amendments to be routine should overrule that and schedule B1 with A5.
