# Reader-Facing Vocabulary — Inherited Platform Terms Mapped to Reader-Expected Names

- **Version:** 1.0
- **Date:** 2026-09-02
- **Author:** Jinn contributor
- **Shape:** `design` (output is a naming spec, not code)
- **Issue:** #2987
- **Status:** Ruled. Every reader-visible term below carries a disposition and a
  presentation-vs-contract classification. Implementation is follow-on work, split per §7.

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

Internal source-code identifiers, type names, and record kinds are **out of scope except where
they surface to a reader**. A term ruled `hide` keeps its internal name unchanged.

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
  `disclosure-specification`, `artifact-integrity`) — sealed into
  `claim-package.json`'s `verification.checks`, asserted by the external verification path,
  *and* printed to the reader, which is why §4.2 rules them **keep + gloss** rather than
  rename;
- method identifiers (`wilson@1`, `paired-delta@1`, `pairwise-disagreement@1`,
  `paired-majority-delta@1`) and enum values (`two-human-unanimous`, `operator-only`,
  `screened-operator-sampled`, `complete`/`partial`/`cancelled`);
- `--json` output keys, the package name `@colophon-claims/verify`, and the command name
  `colophon-verify`.

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
| Sealed Matrix accounting | rename | What was run, and what came back | "Matrix" is hidden from readers (below). |
| Matrix (the record) | hide | — | Internal and contract name unchanged; the reader meets "the runs", never "the Matrix". The file link stays `matrix.json`. |
| Matrix expected / judged / floor | rename | Runs planned / runs scored / minimum required | |
| Completeness | rename | How much was scored | |
| Attrition | rename | Runs that did not count | |
| Unjudged | rename | Not scored | |
| Unscorable | rename | Could not be scored | |
| Expired / Invalidated / Excluded / Replacements | keep | — | Already plain. |
| Matrix asymmetry flags | rename | Where the configurations were not treated alike | |
| Sealed Report facts | rename | The result | "Sealed" is machinery; the reader wants the number. |
| Report / report payload (the record) | rename + gloss | The result | `report.json` link and field names unchanged. |
| Report envelope / report signature envelope | hide | — | A reader meets "signature", not "envelope". Consistent with `GLOSSARY.md`'s envelope ruling. |
| Report preregistered / Claim preregistered | keep | Preregistered | A real term readers know from science; renaming it would cost meaning. Gloss on first use: "the method was fixed before the runs". |
| Report method / Claim method | rename | Method | Drop the record prefix; the section already says which record it came from. |
| Method parameters | keep | — | |
| Report conflicts / Claim conflicts (`conflicted`) | rename | Runs the scorers disagreed on | |
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
| Verification assembly dissent / Dissenting cells | rename | Runs the scorers disagreed on | Same reader concept as `conflicted`; **one name, one place** — see §5. The `verification/assembly.jsonl` link is retained under "how each score was decided". |
| Limitations by stored source | rename | Limitations | The per-source split is IA (#2985), not naming. |
| Records and exact identities | rename | Every file in this bundle | |
| CAS record | rename | Evidence file | |
| Evidence catalog / Verdict catalog | hide | — | The reader gets "evidence files" and "scores"; the catalogs are the index, not a concept. |
| Static-bundle projection | hide | — | |
| Benchmark record / Run record | rename | What was tested / What was run | |
| Public trust material | rename | The public keys | |
| Portable verification | rename | Recheck this yourself | |
| Named checks | rename + gloss | What gets rechecked | Check-name strings are **contract**; see §4.2. |
| Trust root | rename | Whose keys these are | |
| Exact verifier / compatible major line | rename | Exact version / compatible version | |
| Wilson interval, interval low/high | rename + gloss | Uncertainty range | The method's own name stays in the table caption, which is where a reader who wants it will look. |
| Alpha | rename + gloss | Confidence level | |
| n | rename | Runs | |
| Pass rate | keep | — | |
| Delta / candidate minus baseline estimate | rename | Difference | |
| Baseline / candidate | keep | — | Standard comparison vocabulary. |
| Paired task count | rename | Tasks both faced | |
| Interval withheld | rename | Range not reported | Withheld reasons kept verbatim. |
| Confirmatory floor | rename | The minimum fixed in advance | Prose term inherited from the demo report; not a code string. |
| Independence clusters | rename + gloss | Groups that do not share a source | The counted quantity is kept; only the noun changes. |
| Evidence signpost (social card) | rename | Benchmark report | The v4 card's phrase; the current card already says "Benchmark report". Retire the older wording with the v4 assets. |
| Colophon · verified qualification (v4 badge) | **deferred to #2982** | — | Contains the reserved word. Not ruled here. |
| No comparative winner stated | keep | — | Load-bearing and already plain. |

### 4.2 Reader tool output (`colophon-verify` human-readable stdout)

Every row is **presentation** except the two marked **Contract** — the check-name strings and
the `--json` keys — which are ruled *keep* for that reason.

| Reader-visible term today | Ruling | Reader-facing name | Note |
| --- | --- | --- | --- |
| `Verified: N of N checks passed` | **deferred to #2982** | — | Reserved. Whatever verb #2982 picks becomes the canonical verb for this act everywhere, including the page's "Recheck this yourself" — §5. |
| Bundle / bundle | keep | Bundle | One of the converged plain words. |
| Format: `benchmark-product-public-bundle/N` | keep | Format | The identifier itself is **contract**. |
| `manifest`, `evidence-closure`, `trust`, `matrix-rederivation`, `report-verification`, `claim-consistency`, `integrity-anchors`, `disclosure-specification`, `artifact-integrity` | **keep + gloss** | unchanged | **Contract.** These strings are sealed into `verification.checks` and asserted by the external verification path; renaming them is a format revision. The presentation fix is a plain-language gloss on the same line — e.g. `matrix-rederivation   passed   the run tally was recomputed from the evidence`. This is the single highest-value change in this document: it fixes reader comprehension at zero contract cost. |
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
| Usage text | rename where §4.1 renames | — | Follows the same glossary. |

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
| The fixed statistical procedure | method | `method.id`, `wilson@1`, … |
| Method fixed before the runs | preregistered | `preregistered` |
| A single stored piece of authenticated evidence | evidence file | `records/<sha256>.bin` |
| Who decided a run's outcome | judge | `instrument`, evaluator |
| Runs the judges disagreed on | runs the scorers disagreed on | `conflicted`, assembly dissent |
| The content hash naming a thing | fingerprint | `sha256`, digest |
| Proof that bytes existed by a time | timestamp proof | `anchor` |
| Running the checks again over the bundle | *reserved — #2982* | `verify`, `verification.checks` |
| Where and by whom the runs happened | where it ran / who ran this | `venue`, `venueHonesty` |
| What was and was not pinned | what was pinned | `disclosure`, six-variable disclosure |

Two entries earn their place by removing a duplicate: **"runs the scorers disagreed on"**
collapses `conflicted` (Report/Claim) and *assembly dissent* (verification), which are one
reader concept under two names on the same page today; and **"the runs"** collapses *Matrix
accounting* and *completeness/attrition*, which a reader reads as one thing.

Concepts a reader never meets by name, after this spec: Matrix, envelope, catalog, projection,
subject, assurance preset, assurance primitive, disclosure specification, declaration, CAS.
That is **10 nouns removed from the reader's vocabulary by hiding alone** — before a single
rename, and before #2985 folds anything.

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
   Sequence *after* #2985 rules the IA, so the renames land against the surviving elements
   rather than being applied twice.
3. **Reader tool prose vocabulary** — §4.2's remaining rows, including the usage text; same
   gate as (1).
4. **Docs reader-vocabulary tables** — §4.3: one table each in `PUBLIC-BUNDLE.md` and
   `EXTERNAL-VERIFICATION.md`, no prose rename.
5. **Glossary conformance test** — an asset/CLI test asserting that no hidden term from §5
   appears in any reader-facing generated string, and that no §5 concept is presented under two
   names. Without it this spec decays on the next feature that adds a surface.

Items (1), (3), (4), and (5) are unblocked today; (2) waits on #2985. All five must adopt
#2982's verdict verb rather than minting one.

**Contract renames — queued to a bundle-format revision, not scheduled here.** Nothing in §4
requires one; every ruling above is reachable through presentation. The queue exists so the
question is asked once, at the next revision, rather than drifting:

- the check-name strings, if the glosses prove insufficient in a later comprehension probe;
- `arm` → `configuration` and `cell` → `run` in sealed field names, which would make the
  contract and reader vocabularies identical at the cost of a format bump;
- `claim-package.json` → a plainer member name.

Each is a **candidate**, not a decision. A format revision that lands for another reason should
consult this list; a format revision must not be minted for this list alone.
