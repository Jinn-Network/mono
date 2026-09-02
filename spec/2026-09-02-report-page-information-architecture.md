# Report page information architecture

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-09-02 |
| **Author** | Autopilot design session (page inventory read against `next` @ `712d0b934`) |
| **Shape** | `design` — the output is this spec. Nothing here changes the rendered page; §8 is the follow-on implementation map |
| **Status** | Proposed |
| **Answers** | issue [#2985](https://github.com/Jinn-Network/mono/issues/2985) |
| **Design scope** | The reading order of a published Colophon report page, how many named concepts a cold reader may meet and where, and a keep / fold / cut ruling for every element the page renders today |
| **Depends on** | [`BRAND.md`](../BRAND.md) (voice, and the show-don't-narrate rule restated in [`CLAUDE.md`](../CLAUDE.md) §Frontends); [`PRINCIPLES.md`](../PRINCIPLES.md) (Legibility); [benchmark product design](../docs/superpowers/specs/2026-08-05-benchmark-product-design.md) §9 (branding isolation); [publication interoperability profile](../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md); [disclosure specification record](../docs/superpowers/specs/2026-08-19-disclosure-specification-record.md) |
| **Does not do** | Name anything. Every term below is written in whatever word the page uses today; the renaming ruling is issue [#2987](https://github.com/Jinn-Network/mono/issues/2987) and this spec adopts its output wholesale. Nor does it write sentences: density and register are issue [#3016](https://github.com/Jinn-Network/mono/issues/3016). Nor does it change any record schema, any sealed field, any check, or what a verifier concludes |

## 0. The decision in plain language

A published report page is the product. It is what a skeptic opens, and it is the only
artifact most readers will ever see. Today it opens with the product's name in the largest
type on the page, then a status chip, then a hero heading whose text is the constant string
"Colophon report", then a line of four counts, and only then — in a single unstyled
paragraph — the actual claim. Everything after that is the machinery, in the order the
machinery was built rather than the order a reader needs it.

This spec makes three rulings.

**The claim goes first.** The largest element on the page states what came out. Where the
method states no comparative winner, that is the claim and it is said plainly in that slot.
The constant hero label is cut; the product's name keeps the masthead, which is where a
masthead belongs.

**A cold reader may meet five named concepts before the first scroll, and twelve across the
closed page.** Today the header and the first two sections alone name thirty-eight (§1.2,
which independently reproduces the cold-reader figure the issue cites). The reduction is
achieved entirely by folding and by cutting duplicates and labels; not one disclosure is
removed, shortened, or softened.

**Machinery folds behind its own conclusion.** Each block of evidence gets a closed control
whose visible label is the plain statement that block supports. The reader who accepts the
statement moves on; the reader who does not opens the block and finds today's content,
verbatim. A fold is a change of default state, never a change of content.

The order that results is: the claim, what was compared, the result, what this does not
establish, why you can believe it, everything sealed.

## 1. The page as it stands

### 1.1 Element inventory

`packages/benchmark-product/verify/src/assets.ts` `buildIndex()` renders twenty-one
top-level elements. This is the complete list; §6 rules on every row of it.

| # | Element | Rendered by |
|---|---|---|
| H1 | Masthead: mark plus `PRODUCT_BRANDING.displayName` | `buildIndex` |
| H2 | Eyebrow: `PRODUCT_BRANDING.categoryDescriptor` | `buildIndex` |
| H3 | Status chip: `outcomeLabel(runOutcome)` | `outcomeLabel` |
| H4 | Hero heading, constant text "Colophon report" | `buildIndex` |
| H5 | Lede: `<n> tasks · <n> arms · <n> replicates · <venue>` | `scopeLine` |
| H6 | Neutral claim line, one sentence keyed on the method | `neutralClaimHtml` |
| M1 | "Prominent adverse facts" | `adverseFacts` |
| M2 | "What happened, task by task": descriptive sentence, sample disclosure, task-by-arm matrix, and a per-cell disclosure for every cell | `comparisonSectionHtml` |
| M3 | "Benchmark and configuration scope": benchmark digest, tasks, replicates, venue, arms and pinned configuration | `buildIndex` |
| M4 | "Authenticated truth admission and instruments" (binary profiles only) | `binaryAdmissionHtml` |
| M5 | "Six-variable disclosure": six variables, each with status and detail | `disclosureSpecificationHtml` |
| M6 | "Sealed Matrix accounting": provenance line, canonical dump, completeness and attrition figures, per-arm attrition table, asymmetry flags | `buildIndex` |
| M7 | "Sealed Report facts": provenance line, arm results, method and preregistration, parameters, conflicts, disclosures | `armResultsHtml` |
| M8 | "Stored Claim facts": provenance line, mirrored arm results, method and preregistration, assurance preset, parameters, completeness, attrition, conflicts, disclosures, resolved assurance primitives, assurance sentence, rehearsal | `armResultsHtml` |
| M9 | "Verification assembly dissent": count and cell keys | `buildIndex` |
| M10 | "Limitations by stored source": Report limitations, Claim limitations, local self-run trust boundary | `buildIndex` |
| M11 | "Records and exact identities": four digests, top-level records, every content-addressed record | `recordPaths` |
| M12 | "Portable verification": exact command, compatible command, named checks, trust root, attribution | `buildIndex` |
| F1 | Footer navigation: limitations, verification | `buildIndex` |
| F2 | Footer report digest | `buildIndex` |
| F3 | Footer attribution | `buildIndex` |

### 1.2 The thirty-eight

Counting terms of art — a name a reader must already hold, or acquire, to parse the
sentence in front of them — the header and the first two sections name thirty-eight before
the reader has scrolled past the comparison matrix on a typical laptop viewport:

*Header (12):* Colophon · benchmark publishing · agent configuration · complete/partial/cancelled comparison · report · task · arm · replicate · venue · comparative winner · wilson@1 · per-arm facts.

*Prominent adverse facts (9):* prominent adverse fact · Matrix · conflicted cell · Claim · verification assembly · dissenting cell · asymmetry flag · Report limitation · Claim limitation.

*What happened, task by task (17):* answer first · paired cell · measurement · descriptive evidence · registered comparative winner · bundled sample · synthetic outcome · sample consensus input · authenticated Task · task digest · primary score · score direction · cell · cell key · outcome · authenticated output · authenticated verdict evidence.

The remaining sections name substantially more again — six disclosure variables and three
disclosure statuses, eight attrition categories, a completeness floor, an assurance preset,
resolved assurance primitives, a rehearsal, four distinct digests, a manifest, four
catalogs, a compatible major line, and a trust root among them. This spec does not put a
figure on the tail, because the tail is exactly what folds and its size below the fold is
not the defect.

### 1.3 What is structurally wrong

**The claim is not the headline.** The largest type on the page carries a constant string.
The claim sentence is a paragraph of body text, three elements below it, styled only with a
hairline rule.

**Provenance is narrated three times.** M6, M7, and M8 each open with "Source:
authenticated `<file>`; values below are copied without reconciliation." The statement is a
real disclosure — the page does not reconcile its sources — and it is made once too many
twice.

**One number is printed twice in three shapes.** M6 prints `{completeness, attrition}` as a
canonical dump, then the same completeness figures as a definition list, then the same
attrition figures as a table. M8 mirrors M7's arm results in full. Both duplications carry
disclosure — a reader must be able to see that Claim and Report agree — but the disclosure
is the *reconciliation state*, not the second printing of the digits.

**Self-evident controls are narrated.** M2 carries the sub-heading "Open a cell to inspect
its evidence" above a list of disclosure controls. `CLAUDE.md` §Frontends bans this
category outright.

**Attribution appears twice.** M12 and F3 both render `PRODUCT_BRANDING.attribution`. The
report UI kit's own structural rule 5 says the imprint is the only place it appears.

## 2. The reader this page is designed for

One reader, cold and skeptical, who has arrived from a link and has not agreed to spend
five minutes yet. They have a question — did this configuration actually do better — and a
prior — benchmark numbers are usually marketing. They are not hostile; they are unwilling
to extend credit before they see what the credit is for.

Three consequences.

**They read the top and decide.** Every ruling below is about the first screen because the
rest of the page is only reached by a reader the first screen has kept.

**Their second question is always "what's wrong with it".** A caveat that arrives after a
persuasion section reads as a retraction of that section. A caveat that arrives with the
result reads as part of the result. This is why §4 puts the boundary before the machinery,
and it is the single most contestable ruling in this spec.

**Names are the cost, not numbers.** A reader absorbs an unfamiliar figure for free and an
unfamiliar noun expensively, because the noun has to be held for every later sentence that
uses it. The budget in §3 therefore counts names and lets numbers run free.

## 3. The concept budget

### 3.1 What counts

A **reader concept** is a named thing the reader must hold to parse the sentence in front
of them, where the name is a term of art rather than ordinary English: a product noun, a
record name, a method or format identifier, a named statistic, or a member of a status
vocabulary.

- Two names for one thing count twice. This is the budget's pressure on issue #2987 and the
  reason the two issues are separable: this spec sets the ceiling, #2987 decides which
  single name each thing gets.
- A number, a digest, a date, and a proper name drawn from the reader's own subject matter
  (a benchmark's name, a model's name, a configuration's own identifier) cost nothing.
- A term inside a closed disclosure costs nothing until the reader opens it. Folding is
  therefore the instrument that pays for the budget.
- A term repeated costs nothing after its first appearance in the counted region.
- The counted region's boundaries are structural, not visual, so the count is reproducible
  without a browser (§7).

### 3.2 The two ceilings

**Above the fold: five.** The counted region is the `<header>` plus every element of
`<main>` up to and including the result visual.

**Whole page, closed state: twelve.** The counted region is the entire document with every
disclosure control shut.

### 3.3 Where the numbers come from

Twelve is the count of things a reader must be able to *reach* in closed state — one name
per band of evidence the page carries:

result · configuration · task · venue · method · replicate · completeness · attrition ·
disagreement · limitation · record · recheck

Five is that list restricted to what a reader needs before deciding whether to keep
reading:

result · configuration · task · venue · method

Replicate is the first term the budget spends below the fold, and it is the worked example
of the counting rule. The replicate *count* still appears above the fold, inside the result
visual, as the per-arm `n`. Only its *name* moves down, into the accounting band where the
reader who cares about it is already standing.

Neither ceiling is a target to hit; both are ceilings. A method whose honest claim needs
four concepts should spend four.

### 3.4 What the budget does not constrain

Word count, sentence count, section count, page length, and the number of numbers. A page
may be long. The budget is a bound on how much *vocabulary* a reader has to acquire before
the page starts paying them back, and nothing else. Reducing length is issue #3016's
business, under its own rule that removing a caveat to save words is out of bounds.

## 4. The reading order

Six bands, in this order. Bands 1 through 3 are the above-the-fold region. Band 4 must
begin within the first scroll on a 1024 by 768 viewport; it need not finish there.

### Band 1 — The claim

One sentence, in the largest type on the page, stating what came out.

Where the method states a comparative estimate, the sentence is that estimate with its
interval status attached — never the estimate alone. Where the method states no comparative
winner, the sentence says so, in that slot, at that size: the absence of a winner is the
claim, and demoting it to body text while a constant label takes the hero slot is how the
page currently understates its own honesty.

Concepts permitted: result, method. Ceiling: two.

### Band 2 — Orientation

One short line: what was compared, on what work, and where it ran.

Concepts permitted: configuration, task, venue. Ceiling: three, and these three complete
the above-the-fold budget.

### Band 3 — The result

The numbers, as a visual: the per-arm table, the paired readout, the disagreement panel, or
the task-by-arm matrix, according to the method.

Concepts permitted: none new. Every column and row label must already be a concept spent in
Bands 1 and 2, or a number, or a subject-matter proper name. This is the constraint that
keeps the budget honest, because a table is where unbudgeted vocabulary otherwise enters a
page for free.

### Band 4 — What this does not establish

The adverse facts and the boundary, as plain statements, before any persuasion.

This band carries today's M1 content and today's sample disclosure, restated as statements
rather than as tallies of internal record names — "three of the sixty cells were never
judged" rather than "Matrix: partial comparison; incomplete cells remain accounted below".
The tallies themselves survive, in Band 5's accounting fold, where the record names they
refer to are in scope.

Nothing in this band folds. A closed control here would be a caveat the page had chosen to
hide, which is the one thing this spec forbids.

Concepts permitted: disagreement, limitation. Both come out of the twelve.

### Band 5 — Why you can believe it

The machinery, folded. Each fold's closed-state label is the plain statement the fold
supports; opening it shows today's content unchanged.

Four folds, in this order:

1. **The method was fixed before the run.** Opens onto method identity and version,
   preregistration, parameters, the disclosure variables, and, where the profile carries it,
   the truth admission and instrument commitments.
2. **Every attempt is accounted for.** Opens onto completeness, attrition per arm, the
   asymmetry flags, and the replicate accounting.
3. **The evaluators did not always agree.** Opens onto the conflicted cells, the assembly
   dissent, and the per-cell evidence.
4. **You can recheck this yourself.** Opens onto the records, the digests, the exact and
   compatible verifier commands, the named checks, and the trust root.

Concepts permitted in closed state: method, completeness, attrition, disagreement, record,
recheck. Six, and they complete the twelve.

The single provenance statement — this page copies its values from authenticated records
and does not reconcile them — is made once, as this band's own opening line, and not
repeated inside any fold.

### Band 6 — Everything sealed

The unabridged evidence: every element §6 marks `fold` that no Band 5 fold has already
claimed, in its current form, verbatim.

This band has no budget. It is where a reader who has opened everything ends up, and by
that point every term in it has been introduced by a fold they opened deliberately.

## 5. How the fold preserves disclosure

Four rules govern every fold, and together they are the answer to the issue's question of
how machinery folds without weakening disclosure.

**A fold changes default state, never content.** The bytes inside a fold are the bytes the
page renders today. A fold that rewrote its content would be a disclosure change wearing an
information-architecture costume.

**A fold is labeled with its conclusion, not its contents.** "Every attempt is accounted
for", not "Sealed Matrix accounting". A reader must be able to learn what the block
establishes without opening it, because the reader who never opens it still has to leave
with the right belief.

**A fold's label must be false-negative safe.** Where the underlying facts do not support
the conclusion, the label states the exception instead and the fold opens by default. A run
with unjudged cells is labeled "Three attempts were never judged", open, in Band 4 — not
"Every attempt is accounted for", closed, in Band 5. The label is derived from the facts,
in the manner `neutralClaimHtml` and `report-face.ts` already derive their sentences: the
words key on facts, never on configuration, so the text is identical for every reader.

**Nothing adverse folds.** Adverse facts, limitations, sample disclosures, and honesty
boundaries render open, in Band 4, always. A reader must be able to reach every one of them
without a click.

Deduplication follows the same discipline. Where a fact is currently printed twice, the
ruling is never "delete one" but "state the *relation* once, above, and keep both printings
inside the fold". M8's mirror of M7 becomes a Band 5 statement that the stored claim and the
sealed report agree — or, where they do not, an adverse fact in Band 4 — with both
printings intact behind the fold that statement labels.

## 6. Element-by-element ruling

`keep` — survives as a first-class page element, possibly moved and possibly restated in
plain words. `fold` — survives unchanged behind a closed control. `cut` — is not rendered;
admissible only where the element carries no disclosure.

| # | Element | Ruling | Destination and note |
|---|---|---|---|
| H1 | Masthead | keep | Unchanged, above Band 1. A masthead is the one place the product may name itself. |
| H2 | Category eyebrow | cut | Product positioning, not a fact about this report. Its content moves to the imprint. No disclosure. |
| H3 | Status chip | keep | Band 1, attached to the claim sentence rather than floating above it. Where the outcome is not complete, its content is also an adverse fact in Band 4. |
| H4 | Hero heading "Colophon report" | cut | A constant string in the largest type on the page. Its slot goes to Band 1. No disclosure. |
| H5 | Lede scope line | keep | Becomes Band 2, minus the replicate term (§3.3). |
| H6 | Neutral claim line | keep | Becomes Band 1, promoted to hero type. Its wording is #3016's business; its position is this spec's. |
| M1 | Prominent adverse facts | keep | Becomes Band 4, restated as statements rather than as tallies of record names. Never folds. |
| M2 | What happened, task by task | split | The descriptive sentence and the matrix become Band 3. The sample disclosure becomes Band 4, open. The per-cell disclosures fold into Band 5 fold 3. The "Open a cell to inspect its evidence" sub-heading is **cut** — narration of a self-evident control, no disclosure. The "Answer first" eyebrow is **cut**: with the claim in Band 1 it is no longer true. |
| M3 | Benchmark and configuration scope | fold | Band 5 fold 1. The task count and venue are already spent in Band 2; the digest, replicates, and pinned arm configuration are what the fold adds. |
| M4 | Truth admission and instruments | fold | Band 5 fold 1. Binary profiles only. |
| M5 | Six-variable disclosure | fold | Band 5 fold 1. All six variables, all three statuses, and the specification and record identities, unchanged. |
| M6 | Sealed Matrix accounting | fold | Band 5 fold 2. Its provenance line is **cut** here and stated once as Band 5's opening line. Its canonical `{completeness, attrition}` dump is retained inside the fold below the definition list and table it duplicates, not above them. |
| M7 | Sealed Report facts | fold | Arm results are Band 3's source and are not reprinted; the rest is Band 5 fold 1 (method, preregistration, parameters) and fold 3 (conflicts). Provenance line **cut**, per M6. |
| M8 | Stored Claim facts | fold | Band 5 fold 1. The mirrored arm results stay inside the fold; the *agreement* between claim and report is stated once, in Band 5's opening, and becomes a Band 4 adverse fact where they disagree. Provenance line **cut**, per M6. |
| M9 | Verification assembly dissent | fold | Band 5 fold 3. Its count is also an adverse fact in Band 4 where it is non-zero — as it is today. |
| M10 | Limitations by stored source | keep | Band 4, open, in full. Both limitation lists and the local self-run trust boundary. This element never folds under any reading. |
| M11 | Records and exact identities | fold | Band 5 fold 4. |
| M12 | Portable verification | fold | Band 5 fold 4. Its trailing attribution is **cut**; see F3. |
| F1 | Footer navigation | keep | Retained and extended to the six bands. A page this long earns in-page navigation, and the navigation is how a reader who folded everything gets back to a specific fold. |
| F2 | Footer report digest | keep | Unchanged. |
| F3 | Footer attribution | keep | The single site of `PRODUCT_BRANDING.attribution`, per the report UI kit's structural rule 5. M2's category descriptor content joins it here. |

Two rows are marked `split` or carry an internal `cut`; both are cases where one rendered
element carries several jobs. In every such case the disclosure-bearing part is kept or
folded and only labels, narration, and duplicate provenance are cut. Across the whole
table, four things are cut outright — a constant hero label, a category eyebrow, an
instruction for a self-evident control, and a duplicate attribution — plus two of three
copies of one provenance sentence. No fact, figure, caveat, limitation, digest, or command
is removed by this spec.

## 7. Enforcement

A budget nobody counts is a preference. Three checks, all cheap, because the page is
already byte-pinned and therefore already deterministic.

**Budget check.** A test in `packages/benchmark-product/verify/src/` renders `index.html`
from a fixture, strips the content of every closed disclosure control, and counts distinct
controlled-vocabulary terms in the two counted regions of §3.2. It fails over either
ceiling. It reports the terms it counted, so a failure is actionable rather than a number.

**Vocabulary source.** The controlled term list is issue #2987's glossary. Until that
lands, the test carries a provisional list derived from §1.2 and marks it provisional in
one comment; the two issues then converge by the test switching its import, not by either
spec being rewritten.

**Order check.** A test asserts the band sequence and that no element the §6 table marks
`keep`-in-Band-4 renders inside a disclosure control. This is the check that catches a
future change quietly folding a caveat, which is the failure mode §5 exists to prevent.

## 8. Contract, and how this lands

The published page is not editable. `verifyPublicBundleSnapshot` byte-compares every
presentation asset against its own rebuild, so a bundle whose page differs from what the
pinned verifier renders is refused. Two consequences.

**Adopting this order is a bundle-format allocation.** Allocated formats today are
`benchmark-product-public-bundle/2`, `/4`, `/5`, `/6`, `/7`, and `/8`; the next free number
is `/9`. The work is: allocate `/9`, render the new order behind it, release a verifier
that understands it, and leave every earlier format rendering exactly what it renders now.

**Already-published bundles never change.** A report published under `/8` keeps `/8`'s page
forever, which is the property that makes a published claim citable. This spec is a
forward commitment, not a migration.

**No record schema changes.** Every value the new order presents is already carried by the
sealed Claim, Report, and Matrix; the bands are a re-projection, not a new fact. This is a
deliberate constraint on the design rather than a happy accident: an IA that needed a new
sealed field would have to wait for a records revision, and would arrive years after the
reader problem it solves. Term renames that touch a *field* name are contract surface and
belong to #2987 and to the same `/9` revision; presentation strings are free.

Implementation is a `feat` against `assets.ts` plus the tests in §7, and is the one
follow-on this spec authorizes.

## 9. What the say-back findings may change

The iterated layout explorations and the say-back comprehension findings named in the issue
are operator-held and were not available to this session; they are not in the repository or
in the operator's local working directories reachable from it. This spec is written so that
their arrival strengthens it rather than restarts it.

**Movable by say-back, without re-deriving anything else:**

- the above-the-fold ceiling, if readers say back fewer than five concepts reliably — three
  and four are both consistent with every ruling here, and the surplus terms move into Band
  5 by the rule already stated in §3.3 for `replicate`;
- Band 1's exact sentence and Band 5's fold labels, which are wordings and belong to #3016
  in any case;
- the closed-state ceiling of twelve, if the twelve-item derivation in §3.3 turns out to
  contain a name readers do not need to reach at all.

**Not movable by say-back:**

- the band order, which follows from the disclosure constraint and from Legibility rather
  than from comprehension data — a reader comprehending a persuasion section better when it
  precedes the caveats is an argument for the order this spec rejects, not against it;
- fold-not-cut, and the four fold rules in §5;
- that nothing adverse folds.

## 10. Open items

1. **Reconcile against the operator-held explorations.** The three-round explorations are
   described in the issue as a claim-first page with a headline claim, plain orientation,
   result visuals, and a why-you-can-believe-it band folding open the machinery. That is the
   shape §4 arrives at independently, which is corroboration rather than agreement on
   detail. Where the explorations differ in detail, they should win on visual treatment and
   this spec should win on which facts may fold — the two questions do not overlap.
2. **Issue #2987 supplies the vocabulary** the §7 counter reads. Until it lands, the counter
   runs on a provisional list.
3. **Issue #3016 owns every sentence** this spec places. The two are ordered: place first,
   write second, because a sentence written for the wrong slot has to be written twice.
4. **Format `/9` allocation** is not made here. This spec names it as the next free number
   and does not reserve it.
