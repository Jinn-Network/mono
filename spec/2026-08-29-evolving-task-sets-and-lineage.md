# Evolving task sets and lineage on the reader surfaces

- **Version:** 0.1
- **Date:** 2026-08-29
- **Author:** Autopilot design session (seam citations read against `next` @ `a80ede03f`)
- **Status:** Proposed
- **Shape:** `design` — the output is this spec. Nothing here merges code; §8 is the follow-on implementation map.
- **Design scope:** What a published report states about its task set's lineage, and what the reader surfaces must therefore carry and refuse
- **Source of record:** This repository
- **Answers:** issue [#3017](https://github.com/Jinn-Network/mono/issues/3017)
- **Does not do:** reader-facing wording (#2987), reading order and concept budget (#2985), prose density (#3016), denominator composition within one run (#2977), the design of any multi-run surface. It does not amend §6.2's comparability rule, the change-class classifier, or the sealed Benchmark schema.

## 0. The decision in plain language

The platform already has everything this issue asks for. A sealed task set
already carries its version and the digest of the task set it replaced, the
rule that scores are comparable only within one task set is already ratified,
its classifier is already written and tested, and the bytes are already
published inside every bundle. None of it reaches a reader.

So this spec does not design a lineage concept. It requires the product to
show the lineage it already seals, states what a report must say about
comparability, and fixes the rules any comparison surface must obey before one
is built.

Two constraints carry most of the weight.

**Identity, never numbers.** A report states its predecessor's identity and
never its predecessor's results. That is what lets the face show a ratchet
honestly without becoming the cross-version comparison table the issue tells
us to refuse.

**One bundle proves less than two.** A bundle contains its own task set and
not its predecessor's, so a single bundle can prove only that a predecessor
was declared and which digest it names. The *change* between two task sets —
what was added, what was removed, and therefore what is comparable — is
derivable only by a reader holding both bundles. This spec keeps those two
tiers strictly apart, because a face asserting a change class it could not
check would be doing the thing the issue is about.

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

That rule is upstream and unchanged. This spec does not redefine or weaken it;
it carries it to the reader.

### 2.2 The chain is a contract field

[`packages/benchmarking/records/src/benchmark/schema.ts`](../packages/benchmarking/records/src/benchmark/schema.ts)
`BenchmarkRecordSchema` already carries `name`, a full SemVer 2.0.0
`version`, an optional `supersedes` digest-bearing descriptor, and the ordered
`items` list of Task digests. `itemTaskDigest` exposes each item's Task digest.

Task-set lineage is therefore already first-class in the sealed record. The
question the issue raises — whether lineage should be a first-class concept —
was answered when that field shipped.

Throughout this spec `supersedes` means the **Benchmark-level** field. Task
records carry a separate `supersedes` of their own, registered under the
evidence role `superseded-task` by `core/src/operations/publication-register.ts`.
The two are unrelated and nothing here bears on the Task-level one.

### 2.3 The classifier is written and tested, and it needs two records

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

Two properties of this code govern the whole spec.

**It takes both records.** `classifyVersionBump(prev, next)` needs the
predecessor. Its output is not a property of either record alone.

**It is a library surface, not a live path.** These four functions are
exported from the records barrel and exercised by tests; none has a production
call site today. `checkComparability` in particular is called only by the
method-conformance test kit. So §8's work is wiring, not just rendering, and
should be costed as such.

### 2.4 Within one report, the rule is enforced

[`packages/benchmarking/aggregate/src/report.ts`](../packages/benchmarking/aggregate/src/report.ts)
refuses to aggregate subjects that resolve to distinct Benchmark digests
unless the method declares itself version-robust, and then requires the result
to disclose an exact, unique, sorted shared Task-digest pairing. It does this
in its own `checkResolvedComparability` rather than by calling
`checkComparability`; see §8 M5.

The machine is airtight inside one report. The gap is entirely between
separately published bundles, where the comparison happens in a reader's head.

### 2.5 The bytes are published, but only this run's

`benchmark.json` is a fixed member of every public bundle
([`PUBLIC-BUNDLE.md`](../packages/benchmark-product/PUBLIC-BUNDLE.md)), written
by `core/src/bundle/materialize.ts`. Every bundle therefore already ships its
own task set's `name`, `version`, and `supersedes` as authenticated bytes.

The predecessor's record is **not** in the bundle. `PUBLIC_BUNDLE_FILES` names
one `benchmark.json`, and the content-addressed members are the evidence-graph
closure, which registers a superseded Task but never a superseded Benchmark.
This is the constraint §0 names and §4 is built around.

### 2.6 The face reads none of it

Public presentation is reader-owned: `core/src/bundle/assets.ts` is a shim
onto `@colophon-claims/verify`, so
[`packages/benchmark-product/verify/src/assets.ts`](../packages/benchmark-product/verify/src/assets.ts)
is the single surface these rules bind to.

- `scopeLine` renders `"<taskCount> tasks · <arms> arms · <replicates> replicates · <venue>"`.
  It is the page lede, and the binary-instrument branch reuses it for the
  badge, the social card, and the share text. The non-binary branch re-spells
  the same four fields inline rather than calling it.
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

Five rules follow.

**Digest is identity; version is a label.** Lineage is keyed on the Benchmark
record digest, never on the version string or the name. Nothing stops two
publishers sealing entirely different records under the same `name` and the
same `version`, and §6.3 already settles the point: names are claims, digests
are facts. The repository also holds a live demonstration of the same hazard —
`core/src/run/compile.ts`'s preview compilation builds a subset record that
copies `version` and `supersedes` verbatim while truncating `items`, producing
a different digest under an identical version string. Preview bytes are never
published, so that is not a publication defect; it is filed as §9 D6.

**A lineage is a claim; each link is a fact.** Anyone may publish a record
claiming any `name`. What is checkable is the link: that this record's
`supersedes` digest is the exact predecessor a reader holds, and that the
change class matches the content change. A report states lineage as an exact
chain of digests and treats the name as the publisher's label for it.

**An unlinked successor is a distinct instrument.** A publisher who reruns
against a fresh Benchmark record carrying no `supersedes` has published a
different instrument, whatever they call it. The surfaces must say so rather
than infer a chain from a matching name.

**The chain is not a total order.** Nothing prevents two distinct records from
superseding the same predecessor, so a lineage may fork, and a reader may hold
two bundles that are transitively linked through records they do not have. No
surface may present a lineage as a single ordered sequence, and no check may
report "unrelated" when it has only established "not directly linked". See §6.

**A report says what it can prove.** With one bundle, a report can say a
predecessor was declared and name its digest. It cannot say what changed. The
face states the first and never the second, and never phrases the absence of a
declaration as proof that no predecessor exists.

## 4. What a report states

The comparability statement is unconditional: it appears even when there is no
predecessor. A reader cannot tell a missing statement from a missing
predecessor, and the omission is exactly the reading this issue exists to
prevent, so the statement is a fact the page always carries rather than a
caption explaining one. It has two tiers, and the split is load-bearing rather
than cosmetic.

Each table's last column gives the **fact each case must convey**, not the
sentence that conveys it. The words are #2987's.

### 4.1 Tier one: what one bundle proves

These are the only lineage facts a published report may state on its own face,
because they are the only ones derivable from its own `benchmark.json`.

| Case | Derived from | Fact to convey |
|---|---|---|
| **No predecessor declared** | `supersedes` absent | Every rate here is a rate over this task set. No predecessor is declared, so nothing here places this run in a sequence. |
| **Predecessor declared** | `supersedes` present | Every rate here is a rate over this task set, which declares that it replaced the task set with digest `<d>`. What changed between them is not stated here and cannot be derived from this bundle alone. Rates from a run over any other task set are a different measurement. |

Three rules govern the statement.

1. **It is derived from bytes, never from prose.** A publisher supplies the
   `supersedes` digest and nothing else; the report never carries a
   publisher's characterization of the change.
2. **It never asserts comparability upward.** The product prints a narrowing
   or nothing. No rendered state reads "comparable to the previous release" as
   a product conclusion.
3. **It is stated once.** Per issue #3016 the page does not restate in prose
   what it renders as a fact. The limitations block does not repeat it.

### 4.2 Tier two: what two bundles prove

A reader holding both bundles can derive the change, and §6 specifies the
check that does it. Its outcomes are:

| Outcome | Derived from | Fact to convey |
|---|---|---|
| **Same task set** | both bundles resolve to one Benchmark digest | The same instrument. Rates are comparable. |
| **Patch** | `classifyVersionBump` returns `patch` | The item list is byte-identical; only metadata changed. See the note below. |
| **Minor** | `classifyVersionBump` returns `minor` | Tasks were added and none removed. Headline rates are not comparable, because the denominators differ. The added and shared Task digests are named, and a version-robust method may pair over the shared ones. |
| **Major** | `classifyVersionBump` returns `major` | Tasks were removed or changed. Headline rates are not comparable. Items that still share a Task digest are byte-identical tasks — a changed evaluation changes the digest, so a surviving digest is a survival, not a coincidence — and a version-robust method may pair over them exactly as in the minor case. The added and removed Task digests are named. |
| **Link does not bind** | `checkBenchmarkPredecessor` returns `invalid-predecessor` or `digest-mismatch` | These two bundles are not directly linked. They may still be transitively linked through records not held. Not "unrelated". |

**The patch case is an open question, not a license.** A patch bump still
changes the record bytes and therefore the record digest, so §6.2's rule —
comparable only within one Benchmark record digest — refuses it, and
`checkComparability` would return a failure for the pair. Whether a
byte-identical item list under changed metadata should be comparable is a
sensible question, but it is a question about a ratified rule. This spec has
no authority to relax it, so a patch reports as the ratified rule requires,
and any relaxation is raised upstream as its own amendment.

## 5. Surface rules

### 5.1 Identity, never numbers

This is the load-bearing constraint. A report states its predecessor's
identity. It never renders the predecessor's results.

The distinction is what makes the rest of this section enforceable rather than
aspirational. A surface that renders a predecessor's rate is a cross-version
comparison table however it is styled, and a bundle is self-contained by
construction, so a surface reaching for a predecessor's numbers would be
reaching outside the bytes the verifier can check. Identity is inside the
bundle. Numbers are not.

### 5.2 What the face must carry

The scope surface carries the task set's identity as a version, not only as a
digest: its `name`, its `version`, its Benchmark digest, and its tier-one
lineage position from §4.1.

The lede and the signposts carry the version alongside the count. A signpost
that says only `44 tasks` is the defect this spec exists to fix, because it is
the artifact most likely to sit beside its own predecessor.

Placement is #2985's. This spec's position, offered as input to that decision
rather than as a ruling over it: the version belongs with the count wherever
the count appears, and the statement should be one sentence rather than a
paragraph. If the concept budget cannot carry it there, the obligation to
state it stands and the placement moves.

### 5.3 What every surface must refuse

These bind any Colophon-produced or Colophon-branded surface, present or
future. A surface that cannot satisfy one does not render the comparison.

1. **No comparative view across task sets.** In any view whose form invites a
   reading across runs — a comparison table, a chart, an ordered sequence, a
   sparkline, a delta — every run must resolve to the same Benchmark digest.
   Rule 3 is the single exception.
2. **Where such a view is legitimate, the shared digest is stated on the
   surface**, not left to be inferred from the runs agreeing.
3. **A plain inventory may list runs of different task sets**, because a
   maintainer's release history is a real need. It is an inventory only if the
   difference is stated per row adjacent to the number, and no connecting
   line, trend arrow, delta, ranking, or shared axis is drawn between rows of
   different digests. Any of those makes it a rule 1 view.
4. **The signposts carry the task-set digest wherever they carry a rate.**
   `badge.svg`, `social-card.svg`, and `share.txt` travel alone. The
   wilson and paired branches already carry the Report digest and the sentence
   "no comparative winner stated"; this extends the same discipline to the
   denominator's identity, and the binary-instrument branch — which carries no
   equivalent sentence today — gains it with the rest.
5. **No inferred lineage.** A shared `name` is not a link. Only an exact
   `supersedes` digest binding puts two runs in one lineage.
6. **No claim a reader cannot check.** Every stated relationship names the
   digests it was derived from, and no single-bundle surface states a change
   class.

Product-authored copy, documentation, and marketing are bound by these rules
too.

### 5.4 The surfaces that exist today

No cross-run comparison surface has been built. `verify/src/comparison.ts`
compares arms within a single run, and a bundle structurally holds one Run,
one Matrix, and one Report. So §5.3 is prospective: it constrains surfaces not
yet built — a workspace history, a hub, a per-release page — plus the
signposts, which already travel independently. §5.2 is corrective: the face
omission is real and present today.

### 5.5 What these rules do not reach

Two residual exposures, named rather than papered over.

**A published bundle can never learn it was superseded.** Declaration is
forward-only and bundles are immutable, so last release's report and its
already-circulating badge will say `44 tasks` forever. §8 M4 improves the
successor's badge and can do nothing for the predecessor's. §6's reader check
is the intended answer: the fix for a stale artifact is a reader who can
derive the relationship, not a retroactive edit the format rightly forbids.

**The likeliest venue for the harm is outside these rules.** §5.3 binds
Colophon-branded surfaces; a maintainer pairing two badges in their own README
is bound by none of them. Nothing in this design can prevent that, which is
the second reason the signposts must carry their task-set identity: when the
product cannot govern the layout, the only defense is that each artifact
carries its own denominator's identity with it.

## 6. Comparability a reader can check

A reader about to compare two releases of one lineage is, by construction,
holding both bundles. They therefore hold the predecessor's exact
`benchmark.json` bytes, which is precisely the input `classifyVersionBump` and
`checkBenchmarkTransition` require and the input no single bundle has.

The reader verifier gains a two-bundle check. Given two bundles it binds the
`supersedes` link with `checkBenchmarkPredecessor`, derives the change class
with `classifyVersionBump`, computes the added and removed Task-digest sets by
difference over `itemTaskDigest`, and reports the tier-two outcome of §4.2.

Three requirements on the check:

- **A failed binding is reported as a failed binding.** When the link does not
  bind, the check reports that these two bundles are not *directly* linked and
  that a chain through records not held may still exist. It never reports
  "unrelated", and a caller must not render a not-directly-linked result as
  §3's "distinct instrument".
- **Transitive chains are the reader's to walk.** The check is a single-link
  operation. A reader holding v1 and v3 gets a not-directly-linked result and
  the digest v3 names, which is the pointer they need to find v2. Resolving
  chains automatically is deferred (§9 D3).
- **It reports; it does not gate.** A reader may compare whatever they like.
  The product's obligation is that nothing it renders helps them do it wrongly.

This is the form the product should prefer. It turns the change class from a
publisher's assertion into a reader's derivation over authenticated bytes,
which is what `PRINCIPLES.md` Legibility asks for, and it needs no change to
any published format because it consumes two bundles rather than enlarging
one.

`EXTERNAL-VERIFICATION.md` gains the matching rows in its proves-and-does-not
table: that the `supersedes` link and the change class are provable with the
reference verifier when the reader holds both bundles; and that neither "a
rate over an earlier version is comparable to this one" nor "the added tasks
are harder" is provable by any tool.

## 7. Ratcheting instruments

Print the fact prominently. Refuse the compliment.

**Print the fact.** A maintainer who makes the evaluation harder whenever they
optimize against it is doing the most valuable thing an instrument author can
do, and it is currently invisible. The declaration is sealed at lock, before
results exist, and the change it points at is derivable by any reader holding
both bundles. Rendering it converts an unfalsifiable social claim into a
legible one, which is `PRINCIPLES.md` Legibility working as intended, and it
is the most persuasive thing the page can say on the author's behalf.
Suppressing it would leave the honest ratchet looking identical to a quiet set
swap.

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

**The symmetry is the justification, and it lives in the two-bundle check.**
A maintainer who quietly drops the tasks they now fail produces a major bump
with removals, and one who adds harder tasks produces a minor bump with
additions. The single token `major` does not distinguish removal from
replacement, which is why §6 requires the check to report the added and
removed Task-digest sets rather than the class alone: the same derivation that
credits the honest ratchet exposes the quiet drop, and it is worth printing
only because it does both. On the single-bundle face, where neither set is
derivable, the honest statement is §4.1's — a predecessor is declared, and
what changed is not stated here.

## 8. What lands now

Issue #2987's split applies. Presentation strings may change now; sealed field
names and format identifiers are contract surfaces whose changes belong to a
format revision. Everything below is presentation, or a projection of bytes
the bundle already carries, so none of it waits on a format revision.

- **M1.** The task set's `name`, `version`, and, when present, its
  `supersedes` digest reach the face — and nothing else, since the bundle
  cannot prove a change class (§2.5). Two routes, and the cheaper is
  preferred: the verifier already parses the Benchmark record for
  `derivePublicComparison`, so passing it into `PublicAssetInput` touches no
  sealed member at all. Only if the facts are also wanted in the claim package
  does that need a projection, and then as one additive optional strict block
  following the `suiteComparability` precedent in `core/src/report/claim.ts` —
  an optional strict block with no schema-id guard — and explicitly not the
  `anchors` precedent, whose `superRefine` tie to specific schema ids is what
  made it a version event. On that route the binary-instrument control shape
  admits the new key by name so a misplaced block is refused by name rather
  than collapsing into a generic shape failure.
- **M2.** If M1 projects into the claim package, the verifier checks that the
  projection is the exact projection of `benchmark.json`. This lands inside
  the existing `claim-consistency` check rather than as a new name:
  `PUBLIC_BUNDLE_VERIFICATION_CHECKS` is a frozen ordered list enforced
  against every claim schema id, so adding a name to it would itself be a
  format event.
- **M3.** The tier-one statement of §4.1 appears on the face and in the
  Markdown and share-text projections, unconditionally.
- **M4.** The task-set identity reaches every signpost. `scopeLine` is the
  lede and the binary branch's badge, card, and share text; the non-binary
  branch re-spells the same fields inline and must be changed with it.
- **M5.** The refusals of §5.3 bind all present and future surfaces.
  `checkComparability` is the rule's canonical implementation and the one a
  presentation surface calls. It has no production caller today, and
  `aggregate`'s `checkResolvedComparability` is a second implementation of the
  same rule (§2.4); converging them is in scope for this work rather than a
  separate cleanup, because two implementations of a refusal rule will drift.
- **M6.** The two-bundle check of §6 ships in the reader verifier, and the
  rows of §6 are added to `EXTERNAL-VERIFICATION.md`.
- **M7.** When a draft's task set has a predecessor, the author is prompted to
  name it at lock, so the declaration predates the results. Declining seals a
  run with no `supersedes`, and the face then says a predecessor is not
  declared — which is all it can honestly say, since a declined declaration
  and a genuine first run produce indistinguishable records. Distinguishing
  them needs a sealed declination and is deferred (§9 D7). Issue #2978 is
  designing a confirmed-at-lock advisory on the same surface, and the two
  should be one confirmation step rather than two prompts.

## 9. Deferred

- **D1.** Any multi-run history, hub, or release-timeline surface. §5.3
  governs it in advance; this spec does not design it.
- **D2.** Rendering a predecessor's results. Out of scope by §5.1 — this is
  the boundary the design rests on.
- **D3.** Automatic resolution of chains longer than one link, and of forks.
  §6 is deliberately a single-link check. Walking a chain needs a way to fetch
  a bundle by Benchmark digest, which the self-contained bundle does not have.
- **D4.** Any rename of `supersedes`, `version`, or `benchmarkSha256` on the
  wire. Contract renames, queued to #2987's format revision.
- **D5.** Version-robust paired methods over shared Task digests. It is the
  sanctioned route to a genuine cross-version number, and naming it here is
  what keeps the refusals from reading as obstruction: this is how the
  ratcheting maintainer eventually does get a comparable figure.
- **D6.** The preview compilation's verbatim `version` and `supersedes` copy
  onto a truncated item list (§3). Preview bytes are never stored or
  published, so it is not a publication defect today; file it as a separate
  `fix`.
- **D7.** A sealed declination, so a run whose author declined to name a
  predecessor is distinguishable on the wire from a genuine first run. It is a
  new sealed field and therefore a format event, which is why §4.1 states only
  what the absence of `supersedes` actually proves.

## 10. What this feeds

- **Report page information architecture (#2985)** — owns where the lineage
  and comparability facts sit and what they cost against the concept budget.
  This spec supplies the facts and their derivation, and offers §5.2's
  placement view as input.
- **Reader-facing vocabulary (#2987)** — owns every reader-visible word,
  including the names of the tier-one and tier-two positions in §4. This spec
  deliberately uses the internal names, and its tables give the fact to convey
  rather than the sentence.
- **Report prose (#3016)** — the comparability position is a rendered fact, so
  under that issue's rule it is not restated in prose anywhere on the page.
- **Strict all-slots denominator (#2977)** — the closest sibling and the same
  failure mode on an orthogonal axis. That issue answers "which slots
  counted"; this one answers "counted over which task set, and is it the same
  one as last time". Both land in the same scope region of the face, and they
  must render adjacent rather than each growing a separate caveat block.
- **Whether a cross-run comparison surface should exist at all** is not
  decided here. This spec states what one must do if built.

Implementation follows as ordinary work against
`packages/benchmark-product/verify/src/assets.ts` and the reader verifier,
sequenced behind #2985 and #2987 so placement and wording land once.
