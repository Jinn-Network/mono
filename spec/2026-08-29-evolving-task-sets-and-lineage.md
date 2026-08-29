# Evolving task sets and lineage on the reader surfaces

- **Version:** 0.1
- **Date:** 2026-08-29
- **Status:** Proposed
- **Decision owner:** Operator
- **Design scope:** What a published report states about its task set's lineage, and what the reader surfaces must therefore carry and refuse
- **Source of record:** This repository
- **Answers:** [Issue #3017](https://github.com/Jinn-Network/mono/issues/3017)
- **Does not do:** reader-facing wording (#2987), reading order and concept budget (#2985), prose density (#3016), denominator composition within one run (#2977), the design of any multi-run surface

## 0. The decision in plain language

The platform already has everything this issue asks for. A sealed task set
already carries its version and the digest of the task set it replaced, the
rule that scores are comparable only within one task set is already ratified
and already mechanized, and the bytes are already published inside every
bundle. None of it reaches a reader.

So this spec does not design a lineage concept. It requires the product to
show the lineage it already seals, states the sentence a report must carry
about comparability, and fixes the rules any comparison surface must obey
before one is built.

One constraint carries most of the weight: a report may state its
predecessor's **identity** and never its predecessor's **numbers**. That is
what lets the face show a ratchet honestly without becoming the cross-version
comparison table the issue tells us to refuse.

## 1. The problem is on the reader surfaces, not in the protocol

A developer who reruns his published comparison every release described his
practice:

> To make sure I'm not just optimizing to the test, I actually make the eval
> harder whenever I release new features or optimize to the existing eval.
> The earlier runs are actually for easier tasks than later ones.

His task set ratchets deliberately, so his own numbers are not comparable
across releases by construction. That is his guard against optimizing to the
test, and a second instrument author interviewed the same week had an
equivalent guard on a different mechanism. This is the most natural recurring
use of the product found so far: a per-release run by the tool's own author.

The protocol already knows this. What a reader sees does not.

A sealed run reads as a fixed instrument. The report face states a Benchmark
digest and a task count, and states nothing about which task set that is, what
version of it, or what it replaced. Two releases of a ratcheting set both
render `44 tasks`, differing only in a digest, and a digest is not an ordering
a reader can read. The face invites a comparison it never licenses.

## 2. What is already true

### 2.1 The rule is ratified

[`2026-07-28-benchmarking-application-design.md`](../docs/superpowers/specs/2026-07-28-benchmarking-application-design.md)
§6.2 already rules:

- Identity is the record digest. There is no separate set hash; the sealed
  item list *is* the set commitment.
- Versions are distinct sealed records linked by `supersedes`, carrying SemVer
  with operational meaning: **patch** is a metadata-only change with a
  byte-identical item list; **minor** adds items and removes or changes none;
  **major** removes or changes items, or changes a referenced Task's
  evaluation.
- **Scores are comparable only within one Benchmark record digest.** A minor
  bump does not license comparing new-version aggregates against old-version
  aggregates. Paired methods pair on shared Task digests and are
  version-robust by construction.

§6.3 adds the framing this spec leans on throughout: names are claims,
digests are facts.

This spec does not restate that rule and has no authority to weaken it. It
carries it to the reader.

### 2.2 The chain is a contract field

[`packages/benchmarking/records/src/benchmark/schema.ts`](../packages/benchmarking/records/src/benchmark/schema.ts)
`BenchmarkRecordSchema` already carries `name`, a full SemVer 2.0.0
`version`, an optional `supersedes` digest-bearing descriptor, and the ordered
`items` list of Task digests.

Task-set lineage is therefore already first-class in the sealed record. The
question the issue raises — whether lineage should be a first-class concept —
was answered when that field shipped.

### 2.3 The classifier is mechanized

[`packages/benchmarking/records/src/benchmark/checks.ts`](../packages/benchmarking/records/src/benchmark/checks.ts)
implements the rule:

- `checkBenchmarkPredecessor` binds a successor's `supersedes` to exact
  canonical predecessor bytes, failing as `missing-supersedes`,
  `invalid-predecessor`, or `digest-mismatch`.
- `classifyVersionBump` derives the change class from content: patch only when
  the ordered item list is byte-identical, minor only when new entries are
  appended after the exact existing ordered prefix, otherwise major.
- `checkBenchmarkTransition` additionally requires strictly increasing SemVer
  precedence and a bump consistent with that content class.
- `checkComparability` is the named check `benchmark-comparability`.

The change class is derived from the items, not asserted by the publisher. A
publisher who calls a rewritten set a patch fails `checkBenchmarkTransition`.

### 2.4 Within one report, the rule is enforced

[`packages/benchmarking/aggregate/src/report.ts`](../packages/benchmarking/aggregate/src/report.ts)
refuses to aggregate subjects that resolve to distinct Benchmark digests
unless the method declares itself version-robust, and then requires the result
to disclose an exact, unique, sorted shared Task-digest pairing.

The machine is airtight inside one report. The gap is entirely between
separately published bundles, where the comparison happens in a reader's head.

### 2.5 The bytes are already published

`benchmark.json` is a fixed member of every public bundle
([`PUBLIC-BUNDLE.md`](../packages/benchmark-product/PUBLIC-BUNDLE.md)), written
by `core/src/bundle/materialize.ts`. Every bundle therefore already ships its
task set's `name`, `version`, and `supersedes` as authenticated bytes inside
the manifest closure.

Nothing in sections 4 through 6 needs a new field in the bundle.

### 2.6 The face reads none of it

Public presentation is reader-owned: `core/src/bundle/assets.ts` is a shim
onto `@colophon-claims/verify`, so
[`packages/benchmark-product/verify/src/assets.ts`](../packages/benchmark-product/verify/src/assets.ts)
is the single surface these rules bind to.

- `scopeLine` renders `"<taskCount> tasks · <arms> arms · <replicates> replicates · <venue>"`.
  It is the page lede and the text of the badge, the social card, and the
  share text.
- The "Benchmark and configuration scope" section renders the Benchmark
  digest, the task count, the replicates, and the venue.

Neither carries the task set's name, its version, or its lineage position.
The claim package that both project from has no field for them.

### 2.7 There is a precedent for exactly this shape of mechanism

`core/src/runtime/suite-protocol/comparability.ts` already derives whether a
run may be compared against an external leaderboard's fixed dataset, and emits
flat, specific, plain-language limitation sentences when it may not — for
example, that a run "is not a Terminal-Bench 2.1 leaderboard submission"
followed by the exact reasons. That is this spec's mechanism and its register,
aimed at a different target.

## 3. Ruling: lineage is first-class, and `supersedes` is the chain

Task-set lineage is a first-class concept. A published lineage is the chain of
sealed Benchmark records linked by `supersedes`, each link binding exact
predecessor bytes by digest.

The alternative — treating each release as an unrelated sealed run and having
the face simply refuse comparison language — is rejected. It would discard a
shipped, digest-exact, independently checkable fact and put an unfalsifiable
disclaimer in its place. Under `PRINCIPLES.md` Legibility, a statement a
reader can check is worth more than a refusal a reader must take on faith. It
would also erase the ratchet, which is the interviewed maintainer's actual
methodological guard and the thing most worth showing.

Four rules follow.

**Digest is identity; version is a label.** Lineage is keyed on the Benchmark
record digest, never on the version string. This is not pedantry: today
`core/src/run/compile.ts`'s preview compilation builds a subset record that
copies `version` and `supersedes` verbatim while truncating `items`, producing
a different digest under an identical version string and an identical
predecessor. Preview bytes are never published, so this is not a publication
defect, but any surface that keyed lineage on the version string would be
unsound the day someone published one. See §9 D6.

**A lineage is a claim; each link is a fact.** Anyone may publish a record
claiming any `name`. What is checkable is the link: that this record's
`supersedes` digest is the exact predecessor a reader holds, and that the
change class matches the content change. A report states lineage as an exact
chain of digests and treats the name as the publisher's label for it.

**An unlinked successor is a distinct instrument.** A publisher who reruns
against a fresh Benchmark record carrying no `supersedes` has published a
different instrument, whatever they call it. The surfaces must say so rather
than infer a chain from a matching name.

**Silence is never read as absence.** A run with no `supersedes` may be a
genuine first run or a run whose author declined to declare a predecessor.
Those are different facts and the surfaces must not conflate them, which is
why the declaration is captured at lock (§8 M7) rather than inferred at
publish.

## 4. The comparability statement

Every published report states its comparability position. The statement is
unconditional — it prints even when there is no predecessor, because printing
it always is what teaches a reader what it means — and every case below is
derived, never asserted.

| Case | Derived from | What the report states |
|---|---|---|
| **No predecessor declared** | `supersedes` absent | Every rate here is a rate over this task set. No predecessor was declared, so nothing here places it in a sequence. |
| **Same digest** | predecessor digest equals this Benchmark digest | The same task set as the run it follows. Rates are comparable. |
| **Patch** | `classifyVersionBump` returns `patch` | The same tasks; only metadata changed. Rates are comparable. |
| **Minor** | `classifyVersionBump` returns `minor` | Tasks were added and none removed. Headline rates are not comparable. The shared items are named, and only a version-robust method pairing on shared Task digests may compare anything. |
| **Major** | `classifyVersionBump` returns `major` | Tasks were removed or changed. Nothing is comparable, including the items that look shared, because a changed evaluation changes the Task digest. |

Four rules govern how it is stated.

1. **It is derived from bytes, never from prose.** The change class comes from
   `classifyVersionBump` over the two records' item lists. A publisher cannot
   declare a run comparable.
2. **It never asserts comparability upward.** The product prints a narrowing
   or nothing. There is no rendered state that reads "comparable to the
   previous release" as a product conclusion; the two comparable cases state
   that the task set is unchanged and let that stand.
3. **It travels with the number.** Any surface that carries a rate carries the
   comparability position. This explicitly includes the signposts — the badge,
   the social card, and the share text — because those are what a reader sees
   beside last release's badge.
4. **It is stated once.** Per issue #3016 the page must not restate in prose
   what it renders as a fact. The comparability position is one rendered fact
   with one home; the limitations block does not repeat it.

The concrete wording of every term here — whether a reader meets "task set",
"benchmark", "lineage", "supersedes", or something plainer — is not decided
here. It belongs to the reader-vocabulary spec (#2987), which owns what each
thing is called on every surface. This spec fixes what must be *stated*; that
spec fixes the words. One sentence is the budget, not a paragraph.

## 5. Surface rules

### 5.1 Identity, never numbers

This is the load-bearing constraint. A report states its predecessor's
identity — the digest, and the change class derived from it. It never renders
the predecessor's results.

The distinction is what makes the rest of this section enforceable rather than
aspirational. A surface that renders a predecessor's rate is a cross-version
comparison table however it is styled, and a bundle is self-contained by
construction, so a surface that reached for a predecessor's numbers would be
reaching outside the bytes the verifier can check. Identity is inside the
bundle. Numbers are not.

### 5.2 What the face must carry

The scope surface carries the task set's identity as a version, not only as a
digest: its `name`, its `version`, its Benchmark digest, and its lineage
position — the predecessor digest and the derived change class, or the
explicit statement that no predecessor was declared.

The lede and the signposts carry the version alongside the count. A signpost
that says only `44 tasks` is the defect this spec exists to fix, because it is
the artifact most likely to sit beside its own predecessor.

Where these facts sit in the reading order, and whether they fit the reader
concept budget, is owned by #2985. This spec states that they must appear and
be derived; that spec states where.

### 5.3 What every surface must refuse

These bind any Colophon-produced or Colophon-branded surface, present or
future. A surface that cannot satisfy one does not render the comparison.

1. **No rates from two task sets in one table, chart, sequence, or
   sparkline.** Every run in one such view must resolve to the same Benchmark
   digest. This is `checkComparability` applied at the presentation boundary,
   and it is reused rather than reimplemented — a second implementation of the
   rule is itself a defect.
2. **Where a multi-run view is legitimate, the shared digest is stated on the
   surface**, not left to be inferred from the runs agreeing.
3. **Where different digests must appear together** — a maintainer's release
   history is a real need — the difference is stated per row, adjacent to the
   number, never once in a footnote; and no connecting line, trend arrow, or
   delta is drawn between rows of different digests.
4. **The signposts carry the task-set digest wherever they carry a rate.**
   `badge.svg`, `social-card.svg`, and `share.txt` travel alone. They already
   carry the Report digest and the sentence "no comparative winner stated";
   this extends the same discipline to the denominator's identity.
5. **No inferred lineage.** A shared `name` is not a link. Only an exact
   `supersedes` digest binding puts two runs in one lineage.
6. **No comparability claim a reader cannot check.** Every stated relationship
   names the two digests it was derived from.

Product-authored copy, documentation, and marketing are bound by these rules
too.

### 5.4 The surfaces that exist today

No cross-run comparison surface has been built. `verify/src/comparison.ts`
compares arms within a single run, and a bundle structurally holds one Run,
one Matrix, and one Report. So §5.3 is prospective: it constrains surfaces not
yet built — a workspace history, a hub, a per-release page — plus the
signposts, which already travel independently. §5.2 is corrective: the face
omission is real and present today.

These rules extend an existing habit rather than inventing one. The product
already declines to name a winner in its within-run comparison and prints "no
comparative winner stated" on the badge and the social card.

## 6. Comparability a reader can check

A reader about to compare two releases of one lineage is, by construction,
holding both bundles. They therefore hold the predecessor's exact
`benchmark.json` bytes, which is precisely the input
`checkBenchmarkTransition` requires.

The reader verifier gains a two-bundle check: given two bundles, it binds the
`supersedes` link, derives the change class from the item lists, and reports
the comparability position of §4 — or reports that the two bundles are not in
one lineage.

This is the form the product should prefer. It turns comparability from a
publisher's assertion into a reader's derivation over authenticated bytes,
which is what `PRINCIPLES.md` Legibility asks for, and it needs no change to
any published format.

The check reports; it does not gate. A reader may compare whatever they like.
The product's obligation is that nothing it renders helps them do it wrongly.

`EXTERNAL-VERIFICATION.md` gains the matching rows in its proves-and-does-not
table: that the `supersedes` link and the change class are provable with the
reference verifier when the reader holds both bundles, and that neither "a
rate over an earlier version is comparable to this one" nor "the added tasks
are harder" is provable by any tool.

## 7. Ratcheting instruments

Print the fact prominently. Refuse the compliment.

**Print the fact.** A maintainer who makes the evaluation harder whenever they
optimize against it is doing the most valuable thing an instrument author can
do, and it is currently invisible. The structural facts — this task set
replaced digest `<d>`, items were added and none removed, the successor was
declared at lock before results existed — are digest-checkable and already
sealed. Rendering them converts an unfalsifiable social claim into a legible
one, which is `PRINCIPLES.md` Legibility working as intended, and it is the
most persuasive thing the page can say on the author's behalf. Suppressing it
would leave the honest ratchet looking identical to a quiet set swap.

**Refuse the compliment**, for three reasons.

*The product cannot verify what the compliment asserts.* `classifyVersionBump`
proves items were added. It cannot prove they are harder. "Harder" is the
author's intent, not a property of any digest, and a face that called a
ratchet "evidence against optimizing to the test" would be asserting in the
product's own voice something no tool can check. The author's stated intent
may be sealed and displayed as a declaration attributed to the author; the
product does not restate it as its own finding.

*It is a comparative verdict, and this product refuses those everywhere.* A
"good practice" mark is a verdict about the author rather than the arms, which
is worse than the winner claims already declined on the page, the badge, and
the card. It would be the first editorial judgment on a face built to have
none.

*An author-triggered mark is farmable.* Append one trivial task per release
and collect the mark forever. A badge a bad-faith author earns as cheaply as a
good-faith one carries no information, and printing it would mislead — the
harm this issue exists to prevent, inverted. Under `PRINCIPLES.md` Neutral, a
quality is worth signaling only when the signal is expensive to fake. Each
link binds exact predecessor bytes and each change class is derived from
content, so the chain is expensive to fake; a word about the chain is not.

**The symmetry is the justification.** `classifyVersionBump` returns major on
removal as readily as on replacement, so a maintainer who quietly drops the
tasks they now fail also produces a major bump — with removals. The face must
therefore state removals with the same prominence as additions. The mechanism
that credits the honest ratchet is the mechanism that exposes the dishonest
one, and that is what makes the fact worth printing at all. It is also why the
per-row rule of §5.3 exists: a footnote cannot carry a fact whose whole value
is sitting next to the number it qualifies.

So: show the lineage, never praise it, and show removals as loudly as
additions.

## 8. What lands now

Issue #2987's split applies. Presentation strings may change now; sealed field
names and format identifiers are contract surfaces whose changes belong to a
format revision. Everything below is presentation or an additive projection of
bytes already published, so none of it waits on a format revision.

- **M1.** The claim package projects the task set's `version` and, when
  present, the predecessor digest and the derived change class, as one
  additive optional strict block. This follows the `suiteComparability`
  precedent in `core/src/report/claim.ts` — an optional strict block carrying
  Colophon bits with no schema-id guard — and explicitly not the `anchors`
  precedent, whose `superRefine` tie to specific schema ids is what made it a
  version event. The binary-instrument control shape admits the new key by
  name so a misplaced block is refused by name rather than collapsing into a
  generic shape failure.
- **M2.** The verifier checks that projection against `benchmark.json` and
  recomputes the change class with `classifyVersionBump` rather than trusting
  the producer. Failure is a bundle failure, consistent with fail-closed
  everywhere else in the format.
- **M3.** The comparability sentence of §4 appears on the face and in the
  Markdown and share-text projections, unconditionally.
- **M4.** `scopeLine` gains the task-set identity. It is the line most readers
  read and it currently omits the denominator's identity entirely.
- **M5.** The refusals of §5.3 bind all present and future surfaces, with
  `checkComparability` named as the single implementation of the rule.
- **M6.** The rows of §6 are added to `EXTERNAL-VERIFICATION.md`.
- **M7.** When a draft's task set has a predecessor, the author is prompted to
  name it at lock, so the declaration predates the results. Declining seals a
  run with no `supersedes` and the face says a predecessor was not declared;
  silence is never rendered as "no predecessor exists". Issue #2978 is
  designing a confirmed-at-lock advisory on the same surface, and the two
  should be one confirmation step rather than two prompts.

## 9. Deferred

- **D1.** Any multi-run history, hub, or release-timeline surface. §5.3
  governs it in advance; this spec does not design it.
- **D2.** Rendering a predecessor's results. Out of scope by §5.1 — this is
  the boundary the design rests on.
- **D3.** A machine-readable cross-bundle lineage index resolving predecessors
  by digest. It needs a resolution story the self-contained bundle does not
  have.
- **D4.** Any rename of `supersedes`, `version`, or `benchmarkSha256` on the
  wire. Contract renames, queued to #2987's format revision.
- **D5.** Version-robust paired methods over shared Task digests. §6.2 already
  contemplates this and `checkComparability` already accepts a version-robust
  method. It is the sanctioned route to a genuine cross-version number,
  restricted to the shared subset, and naming it here is what keeps the
  refusals from reading as obstruction: this is how the ratcheting maintainer
  eventually does get a comparable figure.
- **D6.** The preview compilation's verbatim `version` and `supersedes` copy
  onto a truncated item list (§3). Preview bytes are never stored or
  published, so it is not a publication defect today. It should be filed as a
  separate `fix`; it is cited here as the concrete reason for the
  digest-is-identity rule.

## 10. What this feeds

- **Report page information architecture (#2985)** — owns where the lineage
  and comparability facts sit and whether they fit the concept budget. This
  spec supplies the facts and their derivation, and flags that the
  comparability sentence consumes budget.
- **Reader-facing vocabulary (#2987)** — owns every reader-visible word,
  including the names of the five comparability positions in §4. This spec
  deliberately uses the internal names.
- **Report prose (#3016)** — the comparability position is a rendered fact, so
  under that issue's rule it is not restated in prose anywhere on the page.
  One sentence is the budget.
- **Strict all-slots denominator (#2977)** — the closest sibling and the same
  failure mode on an orthogonal axis. That issue answers "which slots
  counted"; this one answers "counted over which task set, and is it the same
  one as last time". Both land in the same scope region of the face, and they
  must render adjacent rather than each growing a separate caveat block.

Implementation follows as ordinary work against
`packages/benchmark-product/verify/src/assets.ts` and the reader verifier,
sequenced behind #2985 and #2987 so placement and wording land once.

## 11. What this spec does not decide

- The reader-facing name of any term. That is #2987.
- The reading order, the concept budget, or which facts fold. That is #2985.
- Whether a cross-run comparison surface should be built at all. This spec
  states what one must do if built.
- Any change to §6.2's comparability rule, the change-class classifier, or the
  sealed Benchmark schema. Those are upstream and unchanged.
- Anything about task sets not published as sealed Benchmark records.
