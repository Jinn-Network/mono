# Reader-Facing Vocabulary — Inherited Platform Terms Mapped to Reader-Expected Names

- **Version:** 1.1
- **Date:** 2026-09-02 (v1.1: 2026-09-03)
- **Author:** Jinn contributor
- **Shape:** `design` (output is a naming spec, not code)
- **Issue:** #2987
- **Status:** Ruled. Every reader-visible term below carries a disposition and a
  presentation-vs-contract classification. Implementation is follow-on work, split per §7.
- **v1.1** (#3794, sweeping the review follow-ups on this spec's PR): rules the
  pairwise-disagreement report surface, the last method block left unruled (§4.1); moves the
  `wilson@1`-style method spellings from the contract side to the presentation side and gives
  §2 the sealed `jinn.benchmarking.method/…` spelling they were standing in for; adds §5's
  headings rule and splits its venue row, so §7 item 5's conformance test has one target;
  corrects three source pointers, one prescribed reader name, and one word of prose. No v1.0
  ruling is reversed.

## 1. Scope

This document owns **what each thing is called wherever a reader meets it**: the published
report page (`index.html`), the reader tool's human-readable output (`colophon-verify`), the
in-bundle `README.md` and `share.txt`, the badge and social card, and the public docs a cold
reader is pointed at (`PUBLIC-BUNDLE.md`, `EXTERNAL-VERIFICATION.md`).

It is deliberately narrow at three boundaries:

- **#2985 owns the information architecture** — how many concepts appear, in what order, and
  what folds. This document does not decide what appears; it decides what the things that
  appear are called. Where #2985 cuts a concept from the page entirely, the ruling here
  becomes moot for that surface and survives for the others.
- **#2982 owns the verdict word.** The reader tool's `Verified: N of N checks passed` line is
  ruled there, not here. This document treats "verified" as a reserved decision and states the
  rest of the tool's vocabulary around it (§4.2).
- **#2983 owns identity rendering** (keys bound to domains). The signer-role names in §4.2 are
  ruled here; what a bound identity looks like is ruled there.

The report page renders a different facts block per method, so the page is ruled across all
five of them: the Wilson, comparison, and paired-majority-delta blocks in §4.1's main table,
and two method-specific blocks in the sub-tables that close §4.1 — the binary-qualification
block, which prints only on a binary report and prints five sealed field names verbatim as row
headers, and the pairwise-disagreement block, whose caption, column headers, and empty state
were the last method strings left unruled.

Internal source-code identifiers, type names, and record kinds are **out of scope except where
they surface to a reader**. A term ruled `hide` keeps its internal name unchanged — but a
field name that is *printed* to a reader is a reader-visible term and is ruled here, whatever
it is called in the source.

## 2. The two sides of the line

Every reader-visible term sits on exactly one side. The side decides *when* a rename may land,
not *whether* it is correct.

**Presentation.** Strings a reader sees that nothing outside the repository parses. HTML
headings, `<dt>` labels, table captions and column headers, badge and card text, `share.txt`,
the in-bundle `README.md` prose, the reader tool's human-readable stdout prose, and docs prose.
These are free to change now, in ordinary changes, guarded by the existing asset and CLI
snapshot tests.

**Contract.** Strings that are either sealed inside authenticated bundle bytes or parsed by
something outside this repository. Renaming one changes what a published bundle *is*, so it
belongs to a bundle-format revision and to nothing smaller:

- bundle format identifiers (`benchmark-product-public-bundle/2` … `/8`);
- manifest member paths (`matrix.json`, `report-envelope.json`, `claim-package.json`,
  `verdicts.json`, `evidence.json`, `static-bundle.json`, `verification/assembly.jsonl`,
  `trust/public-keys.json`, `records/<sha256>.bin`, `qualification.json`, `native/inspect/*`);
- JSON field names in every sealed record, including `claim-package.json`'s `scope`, `method`,
  `assurance`, `completeness`, `attrition`, `conflicted`, `disclosures`, `limitations`,
  `venueHonesty`, `rehearsal`, `records.*`, `verification.*`;
- the check-name strings (`manifest`, `evidence-closure`, `trust`, `matrix-rederivation`,
  `report-verification`, `claim-consistency`, `integrity-anchors`,
  `disclosure-specification`, `artifact-integrity`, `signature-validity`) — sealed into
  `claim-package.json`'s `verification.checks`, asserted by the external verification path,
  *and* printed to the reader, which is why §4.2 rules them **keep + gloss** rather than
  rename;
- method identifiers — the `jinn.benchmarking.method/…` registry URIs (`/wilson`,
  `/paired-delta`, `/binary-instrument`, `/pairwise-disagreement`, `/paired-majority-delta`;
  `BENCHMARKING_METHOD_IDS`, `packages/benchmarking/records/src/identifiers.ts:99`), sealed as
  `method.id` alongside `method.version` — and enum values (`two-human-unanimous`,
  `operator-only`, `screened-operator-sampled`, `complete`/`partial`/`cancelled`);
- `--json` output keys, the package name `@colophon-claims/verify`, and the command name
  `colophon-verify`.

The `wilson@1`-style spellings are **not** on this side. They are a presentation composition of
`method.id` and `method.version`, and they appear in **zero** sealed records —
`claim-package.json` carries `jinn.benchmarking.method/wilson` and `"1"` in two separate
fields. Every `@1` occurrence in `verify/src/` is either a code comment or one of four
hard-coded literals: the two table captions at `assets.ts:829` and `:531`, and the two
neutral-verdict sentences at `:744` and `:753`. §4.1 rules all four.

**The load-bearing rule:** a term may be *presented* under a reader-facing name while its
contract spelling is unchanged. That is the normal case here, and it is what makes almost all
of this work landable now. The precedent is `GLOSSARY.md`'s ruling on *capture envelope*:
"*Envelope* stays as the internal container term; the user-facing noun is *attempt*."

## 3. Dispositions

Three, and only three:

- **keep** — the word is already what a reader expects. No change.
- **rename** — the reader-facing surface uses the stated plain word. The internal and contract
  spellings are untouched unless the row says otherwise.
- **hide** — the concept is machinery a reader does not need to name. It leaves reader
  surfaces entirely; the internal name stays. A hidden concept may still be *shown* (a digest,
  a file link) without being *named*.

Where a rename would strand a reader who has seen the old word elsewhere, the row says
**rename + gloss**: the plain word leads, the inherited word appears once in parentheses or in
a tooltip, never as the heading.

## 4. Rulings

### 4.1 Report page (`index.html`, `README.md`, badge, social card)

Every row in this table is **presentation**. Where a row also names a contract spelling, that
spelling is the untouched other side of the line (§2), not a second ruling.

| Reader-visible term today | Ruling | Reader-facing name | Note |
| --- | --- | --- | --- |
| Colophon report | keep | Colophon report | The masthead noun. |
| Benchmark publishing for agent configurations | keep | — | Category descriptor; `PRODUCT_BRANDING`. |
| Matrix run outcome (`complete` / `partial` / `cancelled`) | rename | Run outcome | Drop "Matrix". Enum values are **contract**; the label is presentation. |
| Arm / arm ID | rename + gloss | Configuration | The page already writes "Arms and pinned configuration" — the gloss is doing the work the name should. `armId` stays contract; the badge's "exact configuration arm IDs" becomes "exact configuration IDs". |
| Cell / cell key | rename | Run | One task, one configuration, one repeat. `cellKey` stays contract. |
| Replicate | rename | Repeat | |
| Venue | rename | Where it ran | `venue` stays contract. |
| Benchmark digest / SHA-256 / digest | rename + gloss | Fingerprint | Hex value unchanged; only the label changes. "SHA-256" survives once, in the verification section, where the algorithm is the point. |
| Prominent adverse facts | keep | Prominent adverse facts | Plain, and deliberately unsoftened. |
| Answer first / What happened, task by task | keep | — | Already reader-shaped. |
| Open a cell to inspect its evidence | rename | Open a run to see its evidence | Follows the cell→run rename. |
| Sealed Matrix accounting | rename | What was run, and what came back | A **section heading**, not a second name: §5 names this concept *the runs*, and the heading is its sentence-shaped form under §5's headings rule. "Matrix" is hidden from readers (below). |
| Matrix (the record) | hide | — | Internal and contract name unchanged; the reader meets "the runs", never "the Matrix". The file link stays `matrix.json`. |
| Matrix expected / judged / floor | rename | Runs planned / runs judged / minimum required | |
| Completeness | rename | How much was judged | |
| Attrition | rename | Runs that did not count | |
| Unjudged | rename | Not judged | |
| Unscorable | rename | Could not be judged | |
| Expired / Invalidated / Excluded / Replacements | keep | — | Already plain. |
| Matrix asymmetry flags | rename | Where the configurations were not treated alike | |
| Sealed Report facts | rename | The result | "Sealed" is machinery; the reader wants the number. |
| Report / report payload (the record) | rename + gloss | The result | `report.json` link and field names unchanged. |
| Report envelope / report signature envelope | hide | — | A reader meets "signature", not "envelope". Consistent with `GLOSSARY.md`'s envelope ruling. |
| Report preregistered / Claim preregistered | keep | Preregistered | A real term readers know from science; renaming it would cost meaning. Gloss on first use: "the method was fixed before the runs". |
| Report method / Claim method | rename | Method | Drop the record prefix; the section already says which record it came from. |
| Method parameters | keep | — | |
| Report conflicts / Claim conflicts (`conflicted`) | rename | Runs the judges disagreed on | |
| Stored Claim facts / Claim package | rename | The claim | Drop "package" and "stored". `claim-package.json` unchanged. |
| Assurance preset / Resolved assurance primitives | hide | — | Replaced on the page by one plain sentence naming what was enforced. Fields stay contract. |
| Rehearsal / rehearsal disclosure | rename | Practice run | |
| Venue honesty / Local self-run trust boundary | rename | Who ran this | The existing verbatim limitation sentences are already plain and are kept as-is. |
| Six-variable disclosure | rename | What was pinned, and what was not | |
| Disclosure specification / declaration | hide | — | The record is named in the link; the reader meets the six variables, not the specification. |
| Subject | hide | — | Single-subject product; the reader has no use for the noun. |
| Authenticated truth admission and instruments | rename | How the right answers were decided | |
| Truth admission | rename + gloss | How the right answers were decided | Enum values are **contract** and stay verbatim beside the plain heading. |
| Instrument | rename | Judge | "Instrument" is the qualification vocabulary; a reader expects "judge". `instrumentSha256` stays contract. |
| Prompt-template commitment | rename | The exact prompt used | |
| Publication grade | rename | Meets the publication bar | |
| Source manifest / Admission manifest | rename | Where the items came from / How they were admitted | |
| Pre-run exclusions | keep | — | |
| Verification assembly dissent / Dissenting cells | rename | Runs the judges disagreed on | Same reader concept as `conflicted`; **one name, one place** — see §5. The `verification/assembly.jsonl` link is retained under "how each run was judged". |
| Limitations by stored source | rename | Limitations | The per-source split is IA (#2985), not naming. |
| Records and exact identities | rename | Every file in this bundle | |
| CAS record | rename | Evidence file | |
| Evidence catalog / Verdict catalog | hide | — | The reader gets "evidence files" and "how each run was judged"; the catalogs are the index, not a concept. |
| Static-bundle projection | hide | — | |
| Benchmark record / Run record | rename | What was tested / What was run | |
| Public trust material | rename | The public keys | |
| Portable verification | rename | Recheck this yourself | |
| Named checks | rename + gloss | What gets rechecked | Check-name strings are **contract**; see §4.2. |
| Trust root | rename | Whose keys these are | |
| Exact verifier / compatible major line | rename | Exact version / compatible version | |
| Wilson interval, interval low/high | rename + gloss | Uncertainty range | The method's own name stays in the table caption, which is where a reader who wants it will look. |
| Table caption `Exact wilson@1 values from the sealed Report` | keep | — | **Presentation, not contract.** `wilson@1` is a hard-coded literal (`assets.ts:829`) that appears in no sealed record; the sealed spelling is `method.id` plus `method.version` (§2). Kept for the reason the row above gives, and free to change in an ordinary change if a later comprehension probe wants it plainer — not a contract-rename candidate (§7). The same ruling covers the `wilson@1` and `pairwise-disagreement@1` mentions inside the neutral-verdict sentences at `assets.ts:744` and `:753`, which `No comparative winner stated` keeps. |
| Alpha | rename + gloss | Confidence level | |
| n | rename | Runs | |
| Pass rate | keep | — | |
| Delta / candidate minus baseline estimate | rename | Difference | |
| Baseline / candidate | keep | — | Standard comparison vocabulary. |
| Paired task count | rename | Tasks both faced | |
| Interval withheld | rename | Range not reported | Withheld reasons kept verbatim. |
| Confirmatory floor | rename | The minimum fixed in advance | Prose term inherited from the demo report; not a code string. |
| Independence clusters | rename + gloss | Groups that do not share a source | The counted quantity is kept; only the noun changes. |
| Benchmark and configuration scope | rename | What was tested, and how each configuration was pinned | The `<h2>` at `assets.ts:827`; its `Arms and pinned configuration` sub-heading becomes **Each configuration, pinned**, following the `arm` → *Configuration* rename above. |
| Evidence signpost (social card) | rename | Benchmark report | The v4 card's phrase; the current card already says "Benchmark report". Retire the older wording with the v4 assets. |
| Colophon · verified qualification (v4 badge) | **deferred to #2982** | — | Contains the reserved word. Not ruled here. |
| No comparative winner stated | keep | — | Load-bearing and already plain. |

#### Binary-qualification report surface (binary reports only)

`binaryFactsHtml` (`assets.ts:548`), its `README.md` twin `binaryFactsMarkdown`
(`assets.ts:926`), and the two sub-headings of `binaryAdmissionHtml` /
`binaryAdmissionMarkdown` (`assets.ts:715`, `:721`) render only when the method is binary
qualification, alongside the admission block already ruled above. Every row here rules a
**label** — a literal in the template or a `.map()`ed display label — and every label is
**presentation**. Two rows also carry a sealed value inside the string they head: the `<h3>`
per arm *is* the bare `armId`, and the stratum caption interpolates `configuration["strata"]`.
Those values are data and are unchanged; a ruling here reaches the label around a value, never
the value itself. The contract spellings named in the Note column stay verbatim.

The `<h3>` printed for each arm section is the bare `armId` value, so the `arm` →
*Configuration* rename does not reach it. The rename does reach every *label*, which is why
`Registered configuration` is ruled away from the word "configuration" below: after the rename
a reader would otherwise meet **Configuration** (one arm) and **Registered configuration** (the
qualification's stratum setup) as two adjacent headings naming two different things — the same
comprehension bug §5's law forbids, introduced by this spec's own rename.

| Reader-visible term today | Ruling | Reader-facing name | Note |
| --- | --- | --- | --- |
| Qualification facts are presented per instrument without comparative conclusions. | rename | These facts are given per judge, with no comparison drawn. | Follows `Instrument` → *Judge* above. |
| Registered configuration | rename | How the judges were qualified | Resolves the collision with the `arm` → *Configuration* rename; the word "configuration" leaves this heading entirely. `qualification.configuration` stays contract. |
| `<h3>` per arm (bare `armId`) | keep | — | An identifier, not a label. |
| Instrument `<fingerprint>` | rename | Judge `<fingerprint>` | `instrumentSha256` stays contract; the hex is relabeled per the digest → *Fingerprint* rule. |
| Item, call, and confusion denominators | rename | What was counted | The three denominators keep their contract names (`item`, `call`, `confusion`) inside the block they head. |
| Five registered rates with exact denominators and Wilson intervals | rename | The five judge rates, with exact counts and Wilson uncertainty ranges | Table caption. "Wilson" survives here for the same reason it survives in the arm-results caption: the caption is where a reader who wants the method looks. |
| Rate / Registered result (column headers) | rename | Rate / Result | The preregistration fact is stated once for the section, not repeated in a column header. |
| `agreement` | rename | Agreed with the human label | The five rate labels print today as raw camelCase field names (`assets.ts:551`) in `index.html` and as title-cased variants (`Agreement`, `False accept`, …) in `README.md`. Both become the one reader-facing set in this table; the sealed field names are untouched. |
| `falseAccept` | rename | Wrongly accepted | |
| `falseReject` | rename | Wrongly rejected | |
| `instability` | rename | Answer changed on rerun | Same reader concept as the *instability* named in the per-item heading below — **one name, one place**, see §5. |
| `parserInvalid` | rename | Answer could not be read | `parser-invalid` stays contract wherever it is a sealed value. |
| Every candidate-class bucket | rename + gloss | Results by answer group | `byCandidateClass` stays contract; gloss the class names on first use. |
| Buckets by stratum (…) | rename | Results by sampling group (…) | `stratumCaption` (`assets.ts:540`); the stratum names interpolated into the parentheses are data and are unchanged. |
| Per-item decisions and instability | rename | Each item's decision, and where the answer changed on rerun | |
| Per-item decisions, instability, and exclusions | rename | Each item's decision, where the answer changed on rerun, and what was excluded | The `README.md` variant folds the exclusions payload into the same block. Same concept plus one, not a second name for the same concept. |
| Parser-invalid, infrastructure, and other exclusions | rename | What was excluded, and why | |
| Human disagreement and deterministic replacements | rename | Where the human labelers disagreed, and what replaced those items | `binaryAdmissionHtml` (`assets.ts:718`) and its Markdown twin. |
| Exact instrument and prompt-template commitments | rename | The exact judge and prompt used | Same block; follows `Instrument` → *Judge* and `Prompt-template commitment` → *The exact prompt used* above. |
| Registered (as a bare modifier) | rename | — | Drop it wherever it modifies a rate, a result, or a configuration on this surface. It is not the same word as *Preregistered*, which §4.1 keeps and glosses; carrying both would present one idea under two spellings. |

#### Pairwise-disagreement report surface (pairwise-disagreement reports only)

`pairwiseDisagreementFactsHtml` (`assets.ts:526`) and its `README.md` twin
`pairwiseDisagreementFactsMarkdown` (`assets.ts:968`) render only when the method is
`jinn.benchmarking.method/pairwise-disagreement`. The block is a panel readout over every
unordered pair of configurations, so it has no baseline and no candidate, and its caption, its
`Arm pair` and `Disagreements` headers, and its empty state print on no other block. It is the
last method block whose strings were unruled; every other kind's are in the main table above.

Every row here rules a **label**, and every label is **presentation**, exactly as in the binary
sub-table. The one row that heads a sealed value — the row header, which *is* two bare `armId`s
— is ruled the same way that surface's `<h3>` per arm is.

| Reader-visible term today | Ruling | Reader-facing name | Note |
| --- | --- | --- | --- |
| Table caption `Exact pairwise-disagreement@1 values from the sealed Report` | keep | — | **Presentation, not contract**, on the same ground as the `wilson@1` caption ruled in the main table: the string is a literal at `assets.ts:531` and appears in no sealed record (§2). |
| `Arm pair` (column header) | rename | Configuration pair | Follows `Arm / arm ID` → *Configuration*. |
| `n` (column header) | rename | Runs | Same ruling as the main table's `n`. |
| `Disagreements` (column header) | keep | Disagreements | A **column header**, not a second name: §5 names this concept *runs the judges disagreed on*, and a column cannot carry nine words. Under §5's headings rule this is that name's column-width form, in a table whose rows are already runs — so §7 item 5's conformance test reads it as the same concept, not as a competing one. |
| `Rate` (column header) | keep | Rate | Already plain, and the binary surface rules the same header the same way. |
| `Interval` (column header) | rename | Uncertainty range | Follows `Wilson interval` → *Uncertainty range*. The `withheld` and `—` cell values follow the main table's `Interval withheld` → *Range not reported*. |
| `<th scope="row">` per pair (`armA` vs `armB`) | keep | — | Two bare `armId` values joined by "vs" — identifiers, not labels, exactly as the binary surface's `<h3>` per arm. |
| `No arm pairs were computed.` (empty state) | rename | No configuration pairs were computed. | `assets.ts:527` and its markdown twin at `:969`; follows the `arm` → *Configuration* rename. |

### 4.2 Reader tool output (`colophon-verify` human-readable stdout)

Every row is **presentation** except the two marked **Contract** — the check-name strings and
the `--json` keys — which are ruled *keep* for that reason.

| Reader-visible term today | Ruling | Reader-facing name | Note |
| --- | --- | --- | --- |
| `Verified: N of N checks passed` | **deferred to #2982** | — | Reserved. Whatever verb #2982 picks becomes the canonical verb for this act everywhere, including the page's "Recheck this yourself" — §5. |
| Bundle / bundle | keep | Bundle | One of the converged plain words. |
| Format: `benchmark-product-public-bundle/N` | keep | Format | The identifier itself is **contract**. |
| `manifest`, `evidence-closure`, `trust`, `matrix-rederivation`, `report-verification`, `claim-consistency`, `integrity-anchors`, `disclosure-specification`, `artifact-integrity`, `signature-validity` | **keep + gloss** | unchanged | **Contract.** These strings are sealed into `verification.checks` and asserted by the external verification path; renaming them is a format revision. The presentation fix is a plain-language gloss on the same line — e.g. `matrix-rederivation   passed   the run tally was recomputed from the evidence`. This is the single highest-value change in this document: it fixes reader comprehension at zero contract cost. |
| `not fetched` | keep | — | Already exact. |
| Signed by: publisher / automated grader / human reviewer / label admission | keep | — | Already plain. The `urn:`/`did:key` forms correctly stay in `--json`. |
| same operator / custody not declared | keep | — | |
| Anchors / Anchor subjects | rename | Timestamps | |
| Anchor (the record) | rename + gloss | Timestamp proof | |
| Time basis | rename | What the timestamp covers | |
| anchored / absent / `declared-but-absent` | rename | timestamped / none / promised but missing | The `declared-but-absent` **string in `--json` is contract**; only the human line changes. |
| Trust material | rename | Trust anchors you supply | |
| Artifact content … not fetched | keep | — | Already reader-shaped, and the caveat under it is exemplary. |
| freeze repository | keep | — | |
| No files were uploaded. | keep | — | |
| `--json` keys (`ok`, `code`, `message`, `verifierVersion`, `supportedFormats`, …) | keep | — | **Contract.** Machine surface; not a reader surface. |
| `This checks the bundle's integrity, evidence closure, calculations, report, and claim consistency. It does not prove…` | keep | — | The closing paragraph at `cli.ts:186`. Already reader-shaped, and the limitation half is exemplary. "evidence closure" here is the check name, glossed by the row above rather than renamed. |
| `Verification uses the exact platform bytes installed from npm.` | **deferred to #2982** | — | `cli.ts:191`, and the shortened form in the usage/error text at `cli.ts:45`. Carries the reserved noun; the rest of the sentence is already plain and stands. |
| `Protocol identifiers name https://spec.jinn.network/…. That origin is not hosted yet.` | keep | — | `cli.ts:190`. Names a contract origin and its honest status; both halves are load-bearing. |
| Usage text | rename where §4.1 renames | — | Follows the same glossary. Reaches the usage and error text in full, including `cli.ts:45`; the three closing-paragraph rows above are ruled explicitly so that reach is not left to inference. |

### 4.3 Docs

Docs prose is **presentation**; the contract spellings quoted inside it are not.

`PUBLIC-BUNDLE.md` and `EXTERNAL-VERIFICATION.md` are **format references** aimed at an
implementer, not a cold reader. They keep the contract spellings verbatim — that is their job —
and gain one **Reader vocabulary** table mapping each contract term to its reader-facing name,
so the two vocabularies are provably the same set seen from two sides. No prose rename lands in
these two files.

The in-bundle `README.md` and `share.txt` are reader surfaces and follow §4.1 in full.

## 5. Canonical glossary

One concept, one reader-facing name, on every surface. A surface that needs a different word
has found a different concept — or a bug.

| Concept | Reader-facing name | Contract spelling (unchanged) |
| --- | --- | --- |
| The published directory of evidence | bundle | `benchmark-product-public-bundle/N` |
| One configuration under test | configuration | `arm`, `armId` |
| One task run by one configuration once | run | `cell`, `cellKey` |
| Repeated runs of the same task and configuration | repeat | `replicate` |
| The tally of what was run and what came back | the runs | `Matrix`, `matrix.json` |
| The statistics computed from the runs | the result | `Report`, `report.json` |
| The signed, self-describing summary a publisher stands behind | the claim | `claim-package.json` |
| The fixed statistical procedure | method | `method.id` (`jinn.benchmarking.method/…`), `method.version` |
| Method fixed before the runs | preregistered | `preregistered` |
| A single stored piece of authenticated evidence | evidence file | `records/<sha256>.bin` |
| Who decided a run's outcome | judge | `instrument`, evaluator |
| Runs the judges disagreed on | runs the judges disagreed on | `conflicted`, assembly dissent |
| The content hash naming a thing | fingerprint | `sha256`, digest |
| Proof that bytes existed by a time | timestamp proof | `anchor` |
| Running the checks again over the bundle | *reserved — #2982* | `verify`, `verification.checks` |
| Where the runs physically happened | where it ran | `venue` |
| Who operated the runs | who ran this | `venueHonesty` |
| What was and was not pinned | what was pinned | `disclosure`, six-variable disclosure |
| How a judge was qualified before it was used | how the judges were qualified | `qualification.configuration` |
| A judge giving a different answer on rerun | answer changed on rerun | `instability` |
| An answer that could not be parsed | answer could not be read | `parserInvalid`, `parser-invalid` |

Two entries earn their place by removing a duplicate: **"runs the judges disagreed on"**
collapses `conflicted` (Report/Claim) and *assembly dissent* (verification), which are one
reader concept under two names on the same page today; and **"the runs"** collapses *Matrix
accounting* and *completeness/attrition*, which a reader reads as one thing.

**Headings and column headers.** A section heading and a table column header are
length-constrained surfaces: the first wants a sentence, the second wants one or two words, and
neither can carry a nine-word canonical name. A heading or column header may therefore be a
sentence-shaped or column-width form of a concept named above **without being a second name for
it**, on one condition: the §4 row that rules it says so and points back to the concept's row
here. Two rows meet that condition today: §4.1's *What was run, and what came back* (the
concept is **the runs**) and the pairwise-disagreement surface's *Disagreements* (**runs the
judges disagreed on**). A heading that *contains* a canonical name rather than substituting for
it — the binary surface's *Each item's decision, and where the answer changed on rerun* — is
not in this class and needs no exception; its own row already says why. Everything else is a
name, and the law above applies to it in full.

This is what §7 item 5's conformance test asserts over: the **Reader-facing name** column, with
the §4 rows marked heading or column header as the enumerated exception set. Without the
distinction the test cannot be written, because the page legitimately carries both forms.

One entry earns its place by preventing a duplicate this spec would otherwise create:
**"how the judges were qualified"** keeps the binary report's *Registered configuration*
heading clear of the `arm` → *configuration* rename, so **configuration** names one arm and
nothing else on a page that carries both (§4.1, binary-qualification surface).

Concepts a reader never meets by name, after this spec: Matrix, envelope, catalog, projection,
subject, assurance preset, assurance primitive, disclosure specification, declaration, CAS.
That is **nine nouns removed from the reader's vocabulary by hiding alone** — before a single
rename, and before #2985 folds anything. `CAS` is the tenth noun a reader stops meeting, but it
leaves by rename (§4.1: `CAS record` → *Evidence file*), not by hiding.

## 6. What this spec does not decide

- The verdict verb (#2982). Every "recheck" in §4 is provisional on it and must adopt whatever
  word #2982 rules, in the same change that ships #2982.
- How many of these terms survive above the fold (#2985).
- How a signing identity is displayed (#2983).
- Whether any contract spelling should *also* change at the next format revision. §7 queues the
  question; it does not answer it.

## 7. Follow-on work

**Presentation renames — ordinary changes, landable now.** No format revision, no bundle
reissue, no reader-visible identifier moves. Each is one issue-shaped unit, in this order:

1. **Reader tool check-name glosses** — §4.2's gloss column, in
   `verify/src/cli.ts` `renderVerifiedBundle`; gate `verify/test/cli.test.mjs`. Highest value,
   smallest diff, zero contract exposure. Do this first, independently of everything else.
2. **Report page vocabulary** — §4.1 applied to `verify/src/assets.ts` (`index.html`,
   `README.md`, `share.txt`, badge, social card); gates
   `verify/src/assets-presentation-profile.test.ts` and `assets-binary-admission.test.ts`.
   Covers the ordinary report surface and both method-specific surfaces ruled at the end of
   §4.1: the binary-qualification surface — `binaryFactsHtml`, `binaryFactsMarkdown`, and the
   two `binaryAdmission*` sub-headings — whose rate labels are the clearest instance of an
   internal field name printed verbatim to a reader; and the pairwise-disagreement surface —
   `pairwiseDisagreementFactsHtml` and `pairwiseDisagreementFactsMarkdown` — whose caption,
   column headers, and empty state are ruled in their own sub-table.
   Sequenced *after* #2985 rules the IA, so the renames land against the surviving elements
   rather than being applied twice; #2985 closed completed on 2026-09-02, so that sequencing
   condition is already satisfied.
3. **Reader tool prose vocabulary** — §4.2's remaining rows, including the usage text; same
   gate as (1).
4. **Docs reader-vocabulary tables** — §4.3: one table each in `PUBLIC-BUNDLE.md` and
   `EXTERNAL-VERIFICATION.md`, no prose rename.
5. **Glossary conformance test** — an asset/CLI test asserting that no hidden term from §5
appears in any reader-facing generated string, and that no §5 concept is presented under two
names. It asserts over §4's **Reader-facing name** column, with the rows §5's headings rule
marks as headings or column headers as its enumerated exception set; §5 states that boundary so
the test has one target rather than a judgment call per row. Without it this spec decays on the
next feature that adds a surface.

All five items are unblocked today — (2)'s only sequencing condition, #2985, has closed. All
five adopt the verdict verb ruled by #2982 rather than minting one.

**Contract renames — queued to a bundle-format revision, not scheduled here.** Nothing in §4
requires one; every ruling above is reachable through presentation. The queue exists so the
question is asked once, at the next revision, rather than drifting:

- the check-name strings, if the glosses prove insufficient in a later comprehension probe;
- `arm` → `configuration` and `cell` → `run` in sealed field names, which would make the
  contract and reader vocabularies identical at the cost of a format bump;
- `claim-package.json` → a plainer member name.

Each is a **candidate**, not a decision. A format revision that lands for another reason should
consult this list; a format revision must not be minted for this list alone.
