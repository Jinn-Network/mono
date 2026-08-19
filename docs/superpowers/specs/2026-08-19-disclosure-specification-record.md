# Disclosure Specification Record — the six-variable declaration

| | |
|---|---|
| **Version** | 0.2 |
| **Date** | 2026-08-19 (v0.1 same day; v0.2 applies independent review) |
| **Author** | S1 design session (Claude Fable 5, lane coordinator); seam citations read against `next` @ `4f4ad46f2` |
| **Shape** | `design` (packet S1). Implementation is packet S2 and lands separately |
| **Status** | proposed — awaits operator ratification of §13's open questions |
| **Issue** | [#2839](https://github.com/Jinn-Network/mono/issues/2839) (F7 in the original mapping). Part of program parent [#2833](https://github.com/Jinn-Network/mono/issues/2833) |
| **Design authority** | The experiment design posted in [snap-research/locomo#23](https://github.com/snap-research/locomo/issues/23#issuecomment-5334425775) (2026-08-18), §2 (the six variables) and §8 (what the report may and may not say) |
| **Depends on** | [judge-report implementation program](../plans/2026-08-18-judge-report-implementation-program.md) §4 (packets S1/S2), §8 (prohibitions), §9 (D3); [benchmark product](./2026-08-05-benchmark-product-design.md); [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md); [pluggable integrity providers](./2026-08-17-pluggable-integrity-providers-design.md) (the record/carriage/claim/check pattern this design follows) |
| **Does not do** | Any judge-path delta. Instrument and model profiles, the evidence channel, parser identities, stratum vocabulary, ungradeable classes, and the screening-model admission branch are packet **P0**'s scope; P0's spec is the authority for every one of them (§12.1). This design cites those surfaces and never redefines them |
| **Never run-blocking** | Per operator ruling D3 (2026-08-19): S1 designs now, S2 implements during report-writing week, and the confirmatory run never waits on either |
| **v0.2 changes** | Independent review, verdict *with fixes*. The record design (§3–§5, §7, §8) is unchanged; every fix landed in the closure/bundle-binding analysis and the S2 map. New: §6.5.1 (claim-id collision), §6.5.2 (real refusal mechanisms), §6.5.3 (the five `isV4` sites), §7's G0/steps split, §10.5 (grep pass), §12.2 (anchoring non-goal), Q5/Q6, and T20–T25 |

## 0. Decision in plain language

The report's central strategic claim is a standard: **every published LoCoMo-derived
score should state all six of the choices that produced it** — ingestion model,
retrieval config, answer model, answer prompt, judge model, judge prompt. Today that
claim can only be made as prose in the report's own text, because nothing in the
product can express it as data.

Everything the product currently discloses describes *what it executed*. The Report
record counts pinning outcomes across four execution axes for subjects the venue
actually ran (`packages/benchmarking/records/src/report/schema.ts:26-50`). Arm
pinning is an open bag of requirement keys with no declared vocabulary
(`packages/benchmark-product/core/src/domain/draft.ts:38-45`). The qualification
projection names item banks, arms, and admission evidence, all of them things the
venue carried out (`packages/benchmark-product/verify/src/schema.ts:177-208`). There
is no surface anywhere that says *this variable was fixed by someone else, here is
what they stated, and this bundle proves nothing about it*.

That sentence is the whole product. A disclosure standard that can only describe
measurements is a standard nobody outside the measuring venue can comply with. The
six-variable standard needs a record whose central capability is **carrying an
assertion honestly** — one that keeps a declared-but-not-run variable permanently
distinguishable from a measured one, at the schema level, so that no rendering,
projection, summary, or later reader can confuse them.

This design defines that record:

1. **One sealed record**, portable and verifiable without running any Jinn code,
   naming exactly one subject and exactly six variables, each carrying exactly one of
   three statuses: `measured-here`, `disclosed-by-publisher`, `undisclosed`.
2. **Four bindings into a Colophon bundle** — manifest digest, evidence catalog role,
   a Report extension key that pulls the record's digest under the report author's
   existing signature, and a claim-package section projected by the same function the
   standalone verifier rebuilds it with.
3. **One new verifier check**, `disclosure-specification`, that authenticates
   measurements against evidence the bundle actually carries, carries assertions
   without ever checking them, and refuses any record that blurs the two.

Shipping the report with its own disclosure record makes us the first publisher
complying with the standard we propose. That is the point, and it is why the record
must be strict about the case where we ourselves have nothing to prove.

## 1. Problem

### 1.1 What the shipped surfaces say

| Surface | What it expresses | Why it cannot carry the standard |
|---|---|---|
| `Report.disclosures.perSubject[].pinning` (`records/src/report/schema.ts:26-50`) | For each measured subject, `match` / `mismatch` / `unverifiable` counts across `harness`, `model`, `loadout`, `isolation` | Four execution axes of one venue's own run. There is no axis for a variable the venue did not run, and no way to record its absence except by omitting the subject entirely |
| `Arm.pinning` (`core/src/domain/draft.ts:38-45`) | A `RequirementsMap`-shaped free record of requirement keys | Open bag. A key's presence is not a declaration and its absence is not a disclosure; nothing constrains the vocabulary, so nothing can be checked against it |
| `qualification.json` (`verify/src/schema.ts:177-208`) | Item bank, arms, strata, classes, admission closure, exclusions | Every field describes work this venue performed and can prove |
| `claim-package.json` `limitations` (`verify/src/profile/claim.ts:190`) | Free-text strings extracted verbatim from the sealed Report | Prose. A reader cannot enumerate variables from it, a renderer cannot table it, and a verifier cannot check it |
| `Benchmark.citation` | One free-text citation string | Same |

Every row is a description of execution. The standard needs a description of
*declaration*, and the two are different objects.

### 1.2 What breaks if we express it as prose

Three concrete failures, each of which the report would inherit:

1. **The claim is unreproducible by anyone else.** A standard stated only in our
   report's body is a recommendation. A standard stated as a record type is something
   a second publisher can emit next week without asking us anything.
2. **Silence and denial become indistinguishable.** In prose, "we did not run the
   answer factory" and "we forgot to mention the answer factory" read identically. In
   a record where all six variables are structurally required, the second is
   impossible.
3. **An assertion can drift into a measurement.** Prose has no type system. A later
   summary, slide, or site card that reads "answer model: `<some snapshot>`" beside
   "judge model: `<some snapshot>`" has already lost the distinction that makes the
   report honest. The record must make that loss unrepresentable rather than
   discouraged.

### 1.3 The specific shape this report needs

For the judge experiment, exactly two of the six variables are measured here. The
judge model and judge prompt are pinned, sealed, executed in the contained runtime,
and provable from the bundle. The four answer-factory variables are not, and they are
not uniformly anything: per the design authority's §4, candidates are drawn from
previously published system answers, or taken from the verified reference itself (no
answer model involved at all), with remaining gaps filled by hand and marked. So the
answer factory is not one undisclosed configuration but a mixture, some of it stated
by an upstream source and some of it never stated by anyone.

A record that could not say that cleanly would force one of two dishonest moves:
inventing an execution record for the answer factory, or dropping the four variables
and publishing a two-variable disclosure while proposing a six-variable standard.
Both are refused by §3's rules.

## 2. Vocabulary

### 2.1 The six variables

Frozen, exactly as the design authority's §2 states them. All six keys are required
on every record.

| Key | What it fixes |
|---|---|
| `ingestion-model` | What reads the source material and builds the memory or index |
| `retrieval-config` | How context is selected: depth, search strategy, caps |
| `answer-model` | What writes the answer that is later graded |
| `answer-prompt` | The instructions that answer was written under |
| `judge-model` | What grades the answer against the key |
| `judge-prompt` | The grading instructions |

The set is closed. A seventh variable is a conformance failure, not a tolerated
extra — see §13 Q1 for the one candidate under discussion and why it is not being
added here.

### 2.2 The three statuses

| Status | Means | Evidence | Verifier posture |
|---|---|---|---|
| `measured-here` | This venue executed this variable, and this bundle carries the sealed bytes that fix it | Required, at least one `pinned-configuration` citation | **Authenticated.** Every cited digest must be present in the bundle's evidence closure under an admissible role |
| `disclosed-by-publisher` | The variable is fixed and stated, but this venue did not execute it, so no evidence in this bundle can establish it | **Structurally impossible to carry** | **Carried, never checked.** The verifier confirms the entry is internally well formed and reports it as an assertion. It performs no lookup, no fetch, no cross-check, and no upgrade |
| `undisclosed` | The variable is not stated | None; the branch has no field for one | **Structural.** The entry carries a reason token and nothing else |

The status is not a confidence score and not a tier. It is a statement about *who did
the work and where the bytes are*, and it is the only field a downstream renderer may
use to decide how a variable is presented.

## 3. Record law

Seven rules. Each is enforced structurally rather than by convention, and §4's schema
is written so that violating one is a parse failure rather than a review finding.

- **R1 — One record, one subject.** The subject is a single object, never a list, so
  composite, truncated, or derived subjects have nowhere to live.
- **R2 — All six variables, always.** Silence is a status you write down, not a status
  you get for free. There is no default and no inferred value; an absent key refuses.
- **R3 — Evidence is representable on exactly one status.** The variable entry is a
  strict discriminated union: `disclosed-by-publisher` and `undisclosed` have no
  `evidence` field, so an assertion has nowhere to put a digest. This is the single
  most load-bearing rule in the design.
- **R4 — The verifier authenticates measurements and carries assertions.** It never
  checks, corroborates, upgrades, downgrades, or manufactures an assertion. An
  assertion that turns out to be false is a false assertion in a valid record; that is
  the correct outcome and the honest one.
- **R5 — Nothing derivable is stored.** No pinning statuses, no counts, no verdicts,
  no rates, no restatement of anything the Report or Matrix already carries. Two
  surfaces stating one fact are two surfaces that can disagree.
- **R6 — Sealed once; the bytes are the record forever.** Canonical JCS encoding,
  identity is the SHA-256 of those exact bytes, strict schema, unknown keys fail
  closed.
- **R7 — No third-party bytes.** Every `statement` is the record author's own original
  prose describing a configuration. Quoted prompts, dataset rows, annotations, and
  audit-derived text never appear in this record, in its fixtures, or in this document
  (program §8; program §1 constraint 2).

## 4. Schema

Exact shapes. Field names and token values below are normative.

### 4.1 Identifiers

```
DISCLOSURE_SPECIFICATION_RECORD_KIND
  = "https://spec.jinn.network/records/disclosure-specification/v1"
DISCLOSURE_SPECIFICATION_MEDIA_TYPE
  = "application/vnd.jinn.disclosure-specification.v1+json"
SIX_VARIABLE_DISCLOSURE_SPECIFICATION
  = "https://spec.jinn.network/disclosure/six-variable/v1"
DISCLOSURE_SPECIFICATION_EXTENSION
  = "https://spec.jinn.network/extensions/disclosure-specification/v1"
```

The record-kind URI follows the record-discovery grammar
`${RECORDS_ROOT}/<segment>/<major>.<minor>` as
`packages/benchmarking/records/src/identifiers.ts:20-28` states it, and adopts the
`v1` spelling every shipped sibling constant actually uses (`identifiers.ts:29-36`)
rather than the grammar comment's literal `<major>.<minor>` form. The extension key
follows the `benchmark-publication/v1` and `anchor-intent/v1` precedents in the same
file (`identifiers.ts:40-48`).

`specification` is a separate identifier from `kind` on purpose. `kind` names *this
record shape*; `specification` names *the standard the record claims compliance with*.
A later standard revision that keeps the record shape bumps only the second, and a
reader can tell the two apart without a changelog.

### 4.2 The record

```jsonc
{
  "kind": "https://spec.jinn.network/records/disclosure-specification/v1",
  "specification": "https://spec.jinn.network/disclosure/six-variable/v1",
  "author": "<absolute agent IRI>",
  "subject": {
    "kind": "<absolute record-kind URI>",
    "digest": { "sha256": "<64 lowercase hex digits>" }
  },
  "variables": {
    "ingestion-model":  <VariableEntry>,
    "retrieval-config": <VariableEntry>,
    "answer-model":     <VariableEntry>,
    "answer-prompt":    <VariableEntry>,
    "judge-model":      <VariableEntry>,
    "judge-prompt":     <VariableEntry>
  }
}
```

Constraints:

- Strict object. Exactly these five keys; unknown keys refuse (R6).
- `kind` and `specification` are literals.
- `author` is an absolute IRI, matching `AgentIriSchema`
  (`records/src/descriptors.ts:20-24`). It is present so the record is attributable
  when it travels alone; §7 step 4 binds it to the carrier when it travels in a
  bundle.
- `subject.digest` uses the DigestSet shape `{ "sha256": "<hex>" }`, matching
  `Sha256DigestSetSchema` (`packages/trust/core/src/anchor-evidence.ts:121-124`) — not
  the `sha256:`-prefixed string form. `sha256` is the only admitted algorithm; the
  strict object is what makes a second algorithm a conformance failure rather than an
  ignored extra.
- `variables` is a strict object over the six frozen keys. All six required. No
  additional keys.

### 4.3 `VariableEntry` — the discriminated union

**Measured here.**

```jsonc
{
  "status": "measured-here",
  "statement": "<1..1024 characters, the author's own words>",
  "evidence": [
    { "role": "pinned-configuration", "digest": { "sha256": "<hex>" } },
    { "role": "execution-observation", "digest": { "sha256": "<hex>" } }
  ]
}
```

- `evidence` has at least one entry, and at least one entry has role
  `pinned-configuration`. A measurement with only observations and no pinned
  configuration is a measurement of something nobody wrote down.
- `evidence` is sorted and unique by `(role, digest.sha256)` in UTF-16 code-unit
  order, the same discipline `publication-extension.ts:16-32` applies to
  `registrationArtifacts`. The record seals to exact bytes, so two spellings of one
  citation list would be two records claiming one thing.
- `role` is a closed two-token vocabulary (§4.4).

**Disclosed by publisher.**

```jsonc
{
  "status": "disclosed-by-publisher",
  "statement": "<1..1024 characters, the author's own words>",
  "sources": [ { "uri": "<absolute IRI>" } ]
}
```

- **No `evidence` key exists on this branch.** This is R3, enforced by the strict
  union.
- `sources` is optional. When present it has at least one entry, sorted and unique by
  `uri`. When absent, the assertion is the record author's own, with no external
  citation, and the projection says exactly that.
- `sources` is optional rather than required because requiring it would be circular
  for the flagship case: the report that states these variables is the artifact this
  record is published inside, so at seal time there is no URI to cite. Inventing a
  placeholder URI to satisfy a required field would be worse than an honest empty.
- **Heterogeneous variables are carried by `statement`, not by structure.** A variable
  may be fixed differently across the items in one experiment: the design authority's
  §4 draws correct-class candidates from published system answers *or* from the
  verified reference itself, and fills gaps by hand, so `answer-model` genuinely has
  no single value. `disclosed-by-publisher` therefore means *fixed and stated for the
  items it covers*, and `statement` must name the mixture, including any subset with
  no answer model at all. v1 does not give heterogeneity a structural home; §13 Q6
  asks whether it should.

**Undisclosed.**

```jsonc
{
  "status": "undisclosed",
  "reason": "not-stated" | "stated-without-identifiers" | "outside-this-experiment"
}
```

- No `statement`, no `evidence`, no `sources`. The branch carries a reason token and
  nothing else.
- `not-stated` — nobody stated the variable. This is the token for a variable that
  some upstream party necessarily fixed but never wrote down, which is the ordinary
  case for an experiment grading answers it did not produce.
- `stated-without-identifiers` — something was stated, but too vague to pin: a model
  family with no dated snapshot, a strategy name with no parameters.
- `outside-this-experiment` — the variable is **structurally inapplicable**, not
  merely unknown: an experiment with no retrieval step at all has no retrieval config
  to disclose. It is not the token for "someone else fixed this and we do not know
  what they chose"; that is `not-stated`. Scope and knowledge are different
  distinctions and the tokens must not be used interchangeably.

**Acknowledged tradeoff.** Dropping `statement` from this branch costs the
`stated-without-identifiers` case its ability to say *what* was vaguely stated. That
is deliberate: a free-text field on the `undisclosed` branch is the most likely place
for an assertion to reappear under a status that promises none, and R3's guarantee is
worth more than the lost nuance. A publisher who wants to record the vague statement
uses `disclosed-by-publisher` and says in `statement` that it is unpinnable, which is
the honest expression of that case anyway.

### 4.4 Evidence roles

Two tokens, closed, and owned by the standard rather than by any bundle format:

| Role | What it cites |
|---|---|
| `pinned-configuration` | The sealed bytes that *fix* the variable: an instrument, a selection manifest, an evaluation specification, a task specification, an item bank |
| `execution-observation` | The recorded receipt of what was actually served or executed under that configuration |

Two roles rather than four is deliberate. The check that matters is "this citation
resolves to bytes the bundle carries, and those bytes are of the right species". A
finer vocabulary would encode Jinn's own record taxonomy into a portable standard and
would need revision every time the taxonomy grew.

The mapping from these two roles onto a specific carrier's record roles is the
carrier's business, not the record's. Jinn's mapping is §6.4.

## 5. Sealing and identity

- **Sealed, never separately signed.** The record is validated, I-JSON enforced,
  JCS-serialized once; its identity is the SHA-256 of those exact bytes, forever. This
  is `sealRecord`'s contract (`records/src/sealing.ts:11-15`).
- **No DSSE envelope of its own.** Attribution comes from the carrier. In a Colophon
  bundle the record's digest is named by a Report extension key, and the Report is
  already a DSSE payload signed by the report authority — so the disclosure record is
  covered by the author's existing signature at no new key-management cost. A second
  signature over the same claim by the same key would add no fact and would create a
  way for the two to disagree. This mirrors the reasoning in
  `trust/core/src/anchor-evidence.ts:14-30`, arrived at from the opposite direction:
  AnchorEvidence is unsigned because the authority's signature is *inside* the proof;
  this record is unsigned because the author's signature is *around* the carrier.
- **Producible before the Report exists.** The subject is the Matrix, not the Report
  (§7 step 3), so the record can be sealed as soon as the Matrix is sealed and its
  digest is then available to embed in the Report. A record whose subject were the
  Report could never be embedded in it.

## 6. Bundle binding

Four bindings, all required together. Any one alone would be a decoration.

### 6.1 Manifest

The record travels at `records/<sha256>.bin`, listed in `bundle.json` with its exact
digest and byte length. It is therefore inside the authenticated snapshot before any
semantic check runs (`verify/src/manifest.ts:214-283`). No new path pattern and no new
mandatory member: `records/<sha256>.bin` is already the allowlisted shape driven by
the evidence catalog (`verify/src/verify.ts:361-378`).

### 6.2 Evidence catalog role

One new role token, `disclosure-specification`, **appended to the end** of
`BUNDLE_V4_EVIDENCE_ROLES` (`verify/src/schema.ts:16-46`). Appending is the only
additive move available: the enum order is frozen and per-record `roles` arrays must
be in that order (`schema.ts:162,168`), so an insertion would re-order existing
bundles' role arrays and break their bytes.

Appending is also what keeps the **v2** catalog byte-stable. The producer derives the
v2 catalog's roles with a hardcoded prefix slice,
`ROLE_ORDER.slice(0, 12)` (`core/src/bundle/materialize.ts:794`), where the first
twelve entries are exactly the v2 role set. A token appended after index 11 is
invisible to that slice; a token inserted anywhere earlier would silently change what
a v2 bundle publishes. **S2 must not touch that slice**, and §11 T20 pins it.

The disclosure record carries **exactly** this one role and no other. A record bearing
`disclosure-specification` together with any second role refuses (§11 T21).

### 6.3 Report extension

```jsonc
// on the Report record, alongside its existing fields
"https://spec.jinn.network/extensions/disclosure-specification/v1": {
  "uri": "<optional acquisition hint>",
  "mediaType": "application/vnd.jinn.disclosure-specification.v1+json",
  "digest": { "sha256": "<64 lowercase hex digits>" }
}
```

The value is a bare `DigestBearingResourceDescriptor`
(`records/src/descriptors.ts:11-18`), matching
`MatrixPublicationExtensionSchema`'s single-descriptor shape
(`publication-extension.ts:34-36`). The Run extension's
`registrationArtifacts` array (`publication-extension.ts:11-14`) is the wrong
precedent here: this extension names exactly one record, and R1 says the cardinality
should be structural rather than a length rule on a list.

**The Report record schema does not change.** `ReportRecordSchema` is built on
`topLevelRecordSchema`, which is a `z.looseObject` admitting any absolute-URI or
reverse-DNS extension key (`records/src/extensions.ts:18-30`). A new reader function
and the §7 check are the only additions; every existing Report record stays
byte-identical and every existing fixture stays green. S2 must assert the loose-object
retention explicitly (§11 T13), because the whole binding rests on unknown keys
surviving the parse → re-seal → byte-compare in `verify.ts:1533-1536`.

### 6.4 Bundle binding profile — which bundle roles satisfy which disclosure role

Jinn-side mapping. Not part of the portable record.

| Disclosure role | Admissible bundle evidence roles |
|---|---|
| `pinned-configuration` | `task`, `item-bank`, `source-item`, `evaluation-spec`, `judge-instrument`, `runtime-selection`, `admission-manifest` |
| `execution-observation` | `run-pinning-evidence`, `solve-submission`, `solve-delivery`, `solve-output`, `evaluation-submission`, `evaluation-delivery`, `verdict` |

v1 deliberately does **not** narrow the admissible set per variable. Per-variable
narrowing is profile-specific — which record species fixes `judge-model` depends on
the judge profile P0 is freezing — and encoding a guess here would put this design in
P0's lane (§12.1). Reserved as a v2 tightening once P0's record vocabulary is merged.

### 6.5 Closure version and claim allocation

| Thing | Value | Note |
|---|---|---|
| Bundle format | `benchmark-product-public-bundle/7` | Mandatory member list **identical** to `PUBLIC_BUNDLE_V4_FILES`, including `qualification.json`. The differences from `/4` are enumerated below; "no new file member" does **not** mean "no code changes beyond a constant" |
| Claim schema | `benchmark-product.claim-package/5` | `claim-package/2` (binary qualification) plus the `disclosure` section and the extended check list |
| `qualification.json` `claimSchema` | **stays `benchmark-product.claim-package/2`** | See §6.5.1. This field is a hard literal and is deliberately *not* widened |
| Check name | `disclosure-specification` | Always present on `/7`, never on any earlier closure |

Next free numbers verified against `next` @ `4f4ad46f2`. Bundle formats `/2`, `/4`,
`/5` (evidence-native), and `/6` (anchored) are taken in
`verify/src/manifest.ts:18-24`, and **`/3` is taken as well** — the accounting-only
publication profile at `core/src/bundle/manifest.ts:23`, with its own
`v3-materialize.ts` / `v3-verify.ts` pair. `/3` appears in no `verify` constant, which
is §10.5's duplicate-format-constants hazard surfacing in this very sentence: reading
only `verify/src/manifest.ts` makes `/3` look free. Claim ids `/1`, `/2`,
`/3` (evidence-native), and `/4` (anchored) are taken
(`verify/src/profile/claim.ts:50-58`). `/7` and claim `/5` are therefore still the
next free allocations. **S2 re-verifies against both packages' constants at
implementation time** and takes the then-next free numbers if any line has advanced.

#### 6.5.1 The `qualification.json` claim-id collision, and its resolution

`qualification.json` is a mandatory member of the v4 file list
(`verify/src/materialize.ts:10-14`) and its schema pins
`claimSchema: z.literal("benchmark-product.claim-package/2")`
(`verify/src/schema.ts:179`). The producer writes the same literal
(`core/src/bundle/materialize.ts:421`) and gates the qualification branch on it
(`core/src/bundle/materialize.ts:239`). A `/7` bundle that naively declared
`claim-package/5` in `qualification.json` would refuse at that literal **before** the
disclosure check ever ran.

**Resolution: `qualification.json` keeps `claim-package/2`; only
`claim-package.json` becomes `/5`.** The two fields answer different questions.
`qualification.json`'s `claimSchema` names *which claim projection shape the
qualification graph was built for*, and the disclosure section changes nothing about
that graph — the qualification projection under `/5` is byte-identical to the one
under `/2`. Widening the literal to a union would make the qualification schema
co-vary with an unrelated section and would need widening again for every future
closure. `verify/src/schema.ts:179` therefore stays untouched, and §7 gains a check
that a `/7` bundle's `qualification.json` declares exactly `claim-package/2` while its
`claim-package.json` declares exactly `claim-package/5` (§11 T22).

#### 6.5.2 Why a format bump, and where the refusals actually fire

`verify.ts` already enforces that a bundle matches one complete, deterministic
presentation profile rather than mixing members. Letting a `/4` bundle grow a new
evidence role would make "what a `/4` bundle may contain" time-dependent, which is
exactly the property the frozen role order exists to prevent.

The two refusals this buys, with their real mechanisms:

- **A `/4` bundle carrying a `disclosure-specification` role refuses in the
  evidence-closure walk**, not at the role enum. The enum is a single shared constant
  consumed by `BundleV4EvidenceCatalogSchema` (`verify/src/schema.ts:162`), so once
  the token is appended it is admitted on `/4` and `/7` alike — there is no
  per-closure role vocabulary. Off `/7` the Report extension is never read, so no
  graph edge derives the role, and **which** existing refusal fires depends on how the
  role was smuggled in:
  - as a *standalone* catalog record, the extra digest trips the size guard,
    `if (expectedRoles.size !== declaredRoles.size) refuse(... "evidence catalog
    contains missing or unreachable records")` (`verify.ts:1439`);
  - *appended to an existing graph record's* role array, the sizes still match and the
    per-digest compare trips instead, `record <digest> roles do not equal its derived
    graph roles` (`verify.ts:1441-1445`).

  Both are stronger than an added bespoke guard because they already exist and cannot
  be forgotten. S2 adds **no** new refusal for either case; §11 T12a and T12b pin them
  by line.
- **An older verifier meeting a `/7` bundle refuses at
  `SUPPORTED_BUNDLE_FORMATS` (`verify/src/manifest.ts:25-30`) and
  `LegacyBundleManifestSchema` (`manifest.ts:41-48`)**, not at the role enum — it
  never reaches the catalog. Failing closed on an unknown disclosure is the only
  acceptable behavior for this record type, and the manifest-level refusal is the
  earliest possible place for it.

#### 6.5.3 `isV4` is strict equality — a `/7` flag does not cover it

`verify.ts` decides the whole v4 graph from one strict-equality test,
`const isV4 = checked.manifest.format === BUNDLE_V4_FORMAT` (`verify.ts:345`), and
branches on it at four load-bearing sites. A `/7` bundle would take the **v2** branch
at every one and then refuse at `verify.ts:379` with `qualification.json` reported as
a non-allowlisted file. Adding "an `isV7` flag" does not fix this; the predicate
itself must change.

**S2 introduces a closure-descriptor predicate** — `usesV4Graph(format)`, true for
`BUNDLE_V4_FORMAT` and `BUNDLE_V7_FORMAT` — and replaces every consumer:

| Site | What it selects | Effect if left as strict equality |
|---|---|---|
| `verify.ts:345` | the `isV4` definition itself | root cause |
| `verify.ts:349` | `mandatoryFiles` (v4 list vs v2 list) | `qualification.json` not required, then non-allowlisted |
| `verify.ts:355` | evidence catalog schema (v4 vs v2) | v2 enum rejects every v4-era role |
| `verify.ts:393` | trust schema (v4 vs v2) | admission trust block rejected |
| `verify.ts:404` | the `qualification.json` read | qualification graph never verified |

The five sites are exhaustive for `verify.ts` as of `4f4ad46f2`; §10.2 restates them
as the checklist, and §10.5 records the wider grep that produced them.

**Strictly opt-in at produce time.** A run with no disclosure declaration produces
exactly the `/4` bundle it produces today, byte-identical, with no `disclosure`
section and the six frozen checks. This is the same property the anchor design holds
for unanchored runs, and it is what lets D3's fast-follow be genuinely optional: the
flagship bundle is publishable with or without this record.

### 6.6 Claim-package section

```jsonc
"disclosure": {
  "recordSha256": "<64 lowercase hex digits>",
  "specification": "https://spec.jinn.network/disclosure/six-variable/v1",
  "subjectSha256": "<64 lowercase hex digits>",
  "variables": {
    "ingestion-model":  { "status": "...", ... },
    "retrieval-config": { "status": "...", ... },
    "answer-model":     { "status": "...", ... },
    "answer-prompt":    { "status": "...", ... },
    "judge-model":      { "status": "...", ... },
    "judge-prompt":     { "status": "...", ... }
  }
}
```

Rules, following `deriveClaimAnchors` exactly:

- The section carries **only facts embedded in the record's own bytes**, plus the
  record's digest. Each variable entry is its record entry verbatim; nothing is
  summarized, counted, ranked, or reworded.
- It is built by one shared pure function, `deriveDisclosureSpecification`, exported
  from `@colophon-claims/verify` and called by *both* the workspace producer and the
  standalone verifier — so the claim-consistency byte-compare compares one function's
  output over two byte sets rather than two implementations' guesses
  (`core/src/anchor/carriage.ts:10-15` states the same rule for anchors).
- It exists at all so a reader of `claim-package.json` alone sees all six statuses
  without opening an evidence record, and so `assertClaimConsistency`'s existing
  whole-claim byte-compare (`verify/src/profile/claim-consistency.ts`) covers the
  disclosure without a second bespoke comparison.

## 7. The `disclosure-specification` check

The named check `disclosure-specification` runs **only** on the `/7` closure, after
`report-verification` and before `claim-consistency`, over the authenticated byte
snapshot. No consumer reopens a bundle path after `verifyBundleSnapshot`.

A check that runs only on `/7` cannot, by construction, refuse anything on an earlier
closure. The guards therefore split in two, and the split is load-bearing:

- **G0, closure-independent.** Runs on every format, outside the named check, in the
  same pass that already reads the Report. *A Report carrying
  `DISCLOSURE_SPECIFICATION_EXTENSION` on any format other than `/7` refuses.* Without
  this, a `/4` bundle could carry the extension and the disclosure record with the
  record's role derived by the extension edge, satisfying `verify.ts:1439`, and no
  check would ever look at it. G0 closes that hole; §6.5.2's reachability refusal
  closes the complementary one (role present, extension absent). The two together are
  what make the extension and the closure inseparable.
- **Steps 1–11 below, `/7`-only.** These assume the extension is present and
  authenticate what it names.

`/2`, `/5`, and `/6` are all covered by G0: the extension is legal on `/7` and on no
other format, evidence-native and anchored included. §13 Q5 asks whether a later
allocation should combine anchoring with disclosure.

1. **Carrier binding.** Read the Report's `DISCLOSURE_SPECIFICATION_EXTENSION` value.
   Refuse if it is absent (its presence on non-`/7` formats is G0's job, not this
   step's). Its `digest.sha256` must resolve to **exactly one** record in the evidence
   catalog — two catalog entries matching the digest, or none, both refuse — and that
   record's declared roles must be exactly `["disclosure-specification"]`, one role and
   no second. Conversely, any catalog record bearing `disclosure-specification` that
   the extension does not name refuses: the role and the extension must be in exact
   one-to-one correspondence.
2. **Exact bytes.** The record's bytes must be the exact canonical encoding of the
   parsed record (parse → JCS → byte-compare), and their SHA-256 must equal both the
   catalog digest and the descriptor digest. Strict schema; unknown keys refuse.
3. **Subject binding.** `subject.digest.sha256` must equal the bundle's Matrix digest
   and `subject.kind` must equal `MATRIX_RECORD_KIND`. One subject, structural (R1).
   The Matrix rather than the Report because the Report cannot name its own digest
   inside its own signed payload, and because the record must be sealable before the
   Report is (§5).
4. **Author binding.** `author` must equal `report.author`. A disclosure record
   asserting under one identity inside a bundle signed by another is a carrier
   mismatch, not an extra fact.
5. **Vocabulary completeness.** All six variable keys present, exactly, no more and no
   fewer (R2). A missing key and an unknown key both refuse, and the refusal names the
   key.
6. **`measured-here` implies real evidence.** For each `measured-here` entry: every
   cited `digest.sha256` is present in the bundle's evidence catalog; each cited
   record's bundle roles intersect §6.4's admissible set for the citation's disclosure
   role; at least one citation has role `pinned-configuration`; citations are sorted
   and unique. **No `measured-here` variable may cite a record the bundle does not
   carry.** This is the whole substance of "variables the venue actually ran must
   match actual pinning evidence in the bundle".
7. **Assertions are checked for internal consistency only.** For each
   `disclosed-by-publisher` entry: `statement` is non-empty and within bounds;
   `sources`, when present, is non-empty, absolute-IRI-valued, sorted, and unique. The
   verifier performs no lookup, no fetch, no cross-check against the Matrix or Report,
   and no status upgrade (R4).
8. **`undisclosed` carries nothing.** Structural via the union; restated as a check so
   the refusal names the variable rather than a schema path.
9. **Claim-id pairing.** `claim-package.json` declares exactly
   `benchmark-product.claim-package/5` and `qualification.json` declares exactly
   `benchmark-product.claim-package/2` (§6.5.1). Either field carrying the other's
   value refuses, so the two identifiers cannot drift into each other.
10. **Projection equality.** `deriveDisclosureSpecification(recordBytes)` must
    byte-equal the claim's `disclosure` section. Delivered by extending
    `assertClaimConsistency`'s existing whole-claim compare rather than by a second
    comparison.
11. **Result surface.** The verification result gains an optional `disclosure` block:
    `{ recordSha256, specification, subjectSha256, statuses: { <six keys>: <status> } }`.
    Statuses are disclosed facts, never folded into a single badge — the same posture
    `anchors` takes in `LegacyPublicBundleVerificationResult`
    (`verify/src/verify.ts:145-148`).

## 8. What the check deliberately does not do

Stated as law, because each of these is a thing a well-meaning implementer would add.

- **It does not reconcile against `Report.disclosures.perSubject[].pinning`.** Those
  counts answer "how well did each executed axis pin"; this record answers "which
  variables were executed at all". Two surfaces restating one fact are two surfaces
  that can disagree (R5). No cross-check, in either direction.
- **It does not infer a status from the bundle.** A bundle that plainly executed a
  judge model does not license the check to mark `judge-model` as `measured-here` if
  the record says otherwise. The record is the declaration; the check tests the
  declaration against evidence, never the reverse.
- **It does not fetch anything.** No `sources` URI is dereferenced, at verification
  time or ever. A verifier that reached the network would make its own result depend
  on when it ran.
- **It does not narrow evidence per variable.** §6.4, reserved for v2 once P0 lands.
- **It does not rank, score, compare, or aggregate.** There is no "disclosure
  completeness score". Counting the statuses would create a number publishers optimize
  against, and a six-of-six record with six vague assertions would outscore a
  two-of-six record with two proofs.
- **It does not name vendors.** The record names configurations. The report's §8
  interpretation table already binds this and the record must not create a new surface
  that evades it.

## 9. Worked example

Synthetic throughout. Every string below is placeholder text written for this
document; no third-party prompt, dataset, annotation, or audit-derived byte appears
here (R7). Digests are illustrative.

A venue that grades previously published candidate answers with its own sealed judge
instruments:

```jsonc
{
  "kind": "https://spec.jinn.network/records/disclosure-specification/v1",
  "specification": "https://spec.jinn.network/disclosure/six-variable/v1",
  "author": "did:key:zPlaceholderAuthorIdentity",
  "subject": {
    "kind": "https://spec.jinn.network/records/benchmark-matrix/v1",
    "digest": { "sha256": "1111111111111111111111111111111111111111111111111111111111111111" }
  },
  "variables": {
    "ingestion-model": {
      "status": "undisclosed",
      "reason": "not-stated"
    },
    "retrieval-config": {
      "status": "undisclosed",
      "reason": "not-stated"
    },
    "answer-model": {
      "status": "disclosed-by-publisher",
      "statement": "Mixed across items. Most candidates were produced elsewhere by a dated model snapshot named in the source collection's own notes; a minority are the verified reference answer itself, with no answer model involved; a marked remainder were written by hand. This venue ran none of them.",
      "sources": [ { "uri": "https://example.invalid/placeholder-source-collection" } ]
    },
    "answer-prompt": {
      "status": "disclosed-by-publisher",
      "statement": "The instructions the candidate answers were written under are described in the source collection and were not re-executed here."
    },
    "judge-model": {
      "status": "measured-here",
      "statement": "One dated model snapshot, fixed for every arm, with sampling frozen by the sealed instrument.",
      "evidence": [
        { "role": "execution-observation", "digest": { "sha256": "2222222222222222222222222222222222222222222222222222222222222222" } },
        { "role": "pinned-configuration", "digest": { "sha256": "3333333333333333333333333333333333333333333333333333333333333333" } }
      ]
    },
    "judge-prompt": {
      "status": "measured-here",
      "statement": "Six sealed grading instruments, one per arm, each with its own frozen template digest and declared response parser.",
      "evidence": [
        { "role": "pinned-configuration", "digest": { "sha256": "4444444444444444444444444444444444444444444444444444444444444444" } }
      ]
    }
  }
}
```

Four things this example demonstrates, and each is the reason the record exists:

1. Two variables are proved, four are not, and a reader can tell at a glance which is
   which without reading a word of the report body.
2. `answer-prompt` asserts with no source, and the record says so rather than
   fabricating a citation.
3. `ingestion-model` and `retrieval-config` are `not-stated`, not
   `outside-this-experiment`. All four answer-factory variables are equally outside
   what this venue ran; what separates them is whether anyone *stated* them. Two were,
   two were not. Using a scope token for a knowledge gap would claim the standard does
   not apply, when in fact it applies and the answer is unknown (§4.3).
4. `answer-model` is heterogeneous, and `statement` says so plainly rather than
   picking whichever value covers the most items.

## 10. S2 implementation map

Mechanical. Ordered so each step compiles on the one before it. Every step is
additive in the sense that no shipped bundle changes bytes — but §10.2's `isV4`
row and §10.3's format-selection row are **edits to existing branching**, not new
files, and §6.5.3 is the reason.

### 10.1 `packages/benchmarking/records`

| File | Change |
|---|---|
| `src/identifiers.ts` | Add the four constants from §4.1 |
| `src/disclosure/schema.ts` *(new)* | `DisclosureSpecificationSchema` (§4.2–§4.4), `parseDisclosureSpecification`, `sealDisclosureSpecification`. Strict objects and a strict discriminated union on `status`. Mirrors `report/schema.ts`'s parse/seal pair |
| `src/disclosure-extension.ts` *(new)* | `ReportDisclosureExtensionSchema`, `withReportDisclosureExtension`, `readReportDisclosureExtension`. Mirrors `anchor-intent-extension.ts` and `publication-extension.ts` exactly |
| `src/index.ts` | Export the above |

### 10.2 `packages/benchmark-product/verify`

| File | Change |
|---|---|
| `src/schema.ts` | Append `"disclosure-specification"` to `BUNDLE_V4_EVIDENCE_ROLES` (end of list, §6.2) |
| `src/manifest.ts` | `BUNDLE_V7_FORMAT`; add to `SUPPORTED_BUNDLE_FORMATS` and to `LegacyBundleManifestSchema`'s format union |
| `src/materialize.ts` | `PUBLIC_BUNDLE_V7_FILES` = `PUBLIC_BUNDLE_V4_FILES` (alias; no new mandatory member) |
| `src/profile/disclosure.ts` *(new)* | `deriveDisclosureSpecification` (shared pure projection, §6.6) and `assertDisclosureSpecification` (§7 steps 1–9). Exported from the package root so `core`'s carriage imports the same function |
| `src/profile/claim.ts` | `DISCLOSURE_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/5"`; `DisclosureSectionSchema`; a `/5` superRefine branch (requires `disclosure`, requires the `/2` qualification projection, pins the `/7` check list); refuse `disclosure` on `/1`, `/2`, `/3`, `/4` |
| `src/reader-instructions.ts` | `PUBLIC_BUNDLE_V7_CHECKS = [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, "disclosure-specification"]`; `/7` entries in `PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS` |
| `src/verify.ts` — **the five `isV4` sites** | Replace strict equality with `usesV4Graph(format)` at `verify.ts:345` (definition), `:349` (`mandatoryFiles`), `:355` (evidence catalog schema), `:393` (trust schema), `:404` (`qualification.json` read). §6.5.3 tabulates what each one breaks if missed. This is the single highest-risk edit in the packet |
| `src/verify.ts` — the rest | `PublicBundleVerificationCheck` gains `"disclosure-specification"` (`verify.ts:121-130`); result `format` union gains `/7`; optional `disclosure` block on the result; G0's closure-independent extension guard (§7); call `assertDisclosureSpecification` after `report-verification` and `checks.push(...)`; evidence-closure derived-roles map learns the new role's edge (Report extension → record) on `/7` only, so §6.5.2's `verify.ts:1439` refusal keeps firing on every other format |
| `src/schema.ts` — **not changed** | `BundleQualificationSchema.claimSchema` stays `z.literal("benchmark-product.claim-package/2")` (`schema.ts:179`). §6.5.1 |
| `src/profile/claim.ts` — `exactKeys` | The allowlist at `claim.ts:357` is an exact-key control shape; `"disclosure"` must be added or every `/5` claim fails as a generic control-shape violation |
| `src/cli.ts` | No change needed. `supportedFormats` is projected from `SUPPORTED_BUNDLE_FORMATS` (`cli.ts:238,246`), so `/7` appears once `manifest.ts` lists it |
| `src/index.ts` | Export `BUNDLE_V7_FORMAT` and the disclosure types alongside the existing format exports (`index.ts:77,80,102`) |
| `src/assets.ts` | Assets branch on **report facts**, not bundle format: `reportFacts.kind === "binary"` (`assets.ts:321,472,484,522`). The six-variable table therefore hangs off the new `binaryQualification`-style input, not off a `/7` format test. Deterministic projection of verified facts only |

### 10.3 `packages/benchmark-product/core`

| File | Change |
|---|---|
| `src/disclosure/state.ts` *(new)* | Workspace-side declaration state: the six entries a sponsor composes before lock. Product state, not a sealed record |
| `src/operations/disclosure-declare.ts` *(new)* | `disclosure declare` operation: validate the declaration, seal the record, write it to the sealed store, record its digest in run state. `author` is taken from the workspace's **report authority identity** at declare time, which is the same identity `report.author` resolves to, so §7 step 4 holds by construction. Idempotent before lock. After lock the declaration is frozen, with one exception: if the report authority key rotates between lock and report, an **author-only re-seal** is permitted and recorded, because otherwise a rotation would make §7 step 4 unsatisfiable and strand the run |
| `src/bundle/manifest.ts` | **A second, independent copy of the bundle-format constants lives here** (`core/src/bundle/manifest.ts:25,46,75`), separate from `verify`'s. `BUNDLE_V7_FORMAT` must be added in both or the producer cannot emit what the verifier accepts |
| `src/bundle/materialize.ts` — format selection | The producer's format ternary (`materialize.ts:879-883`) and its format type union (`:181-182`) currently resolve anchored → `/6`, binaryQualification → `/4`, else `/2`. A disclosure branch is added; §12's non-goal and §13 Q5 govern what happens when disclosure and anchoring are both present |
| `src/bundle/materialize.ts` — **`ROLE_ORDER.slice(0, 12)` must not change** | `materialize.ts:794` derives the v2 catalog from the first twelve roles. Appending leaves it correct; any other edit silently changes what every v2 bundle publishes (§6.2, §11 T20) |
| `src/report/claim.ts` | `claimSchema` union (`claim.ts:158-161`) gains `/5`; the superRefine chain (`:226-249`) gains a `/5` branch; the `exactKeys` control shape (`:367`) gains `"disclosure"`. This is the producer-side twin of `verify/src/profile/claim.ts` and drifts silently if only one is edited |
| `src/disclosure/carriage.ts` *(new)* | Mirrors `anchor/carriage.ts`: reads bytes from the sealed store via `getSealedBytes` (never from run state), projects the claim section via the shared `deriveDisclosureSpecification`, and reports whether this run publishes on the `/7` closure. A projection failure is a typed `record-integrity` product refusal |
| `src/operations/report.ts` | When a disclosure declaration exists, add the Report extension key before sealing |
| `src/cli/main.ts` | `disclosure declare` verb, plus `disclosure show` reading back the sealed record |

### 10.4 Out of scope for S2, noted as seams

- **Site rendering** beyond the bundle's own `index.html`: packet **R1** owns
  `packages/benchmark-product/web`. When R1 renders a `/7` bundle it renders the six
  statuses with `measured-here` and `disclosed-by-publisher` visually distinct and
  never merged into one list. Frontend rules apply: spec update in the same PR, no
  helper-text cruft.
- **Report prose.** The report's own disclosure section is written research-side and
  cites this record; it is not a repository artifact.
- **External-publisher tooling** (a standalone emitter for publishers with no Jinn
  workspace) is a later, separate packet. The record's portability (§5, §4.4) is what
  makes it possible; building it is not in S2.

### 10.5 Grep pass (executed 2026-08-19 against `4f4ad46f2`)

Run over `isV4`, `BUNDLE_V4_FORMAT`, `claimSchema`, `exactKeys`,
`SUPPORTED_BUNDLE_FORMATS`, `PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS`, and
`ROLE_ORDER`, excluding tests. It confirmed the five `verify.ts` `isV4` sites and
surfaced four coupling points that a `verify`-only reading misses, all now rows in
§10.2 and §10.3:

1. `core/src/bundle/manifest.ts` holds a **duplicate** set of format constants.
2. `core/src/bundle/materialize.ts:794` slices `ROLE_ORDER` by a hardcoded `12`.
3. `core/src/report/claim.ts` is a full producer-side twin of the verifier's claim
   schema, with its own union, refines, and `exactKeys` allowlist.
4. `verify/src/cli.ts:238,246` projects `SUPPORTED_BUNDLE_FORMATS` and needs no edit.
   `verify/src/index.ts:75-81` is **not** the same case: it is an explicit named-export
   list, so `BUNDLE_V7_FORMAT` has to be added there by hand or the constant is
   unreachable to consumers.

S2 re-runs this grep before starting; if `next` has moved, the new hits are added
here rather than discovered during review.

## 11. Test matrix for S2

TDD per handbook `feat` SOP. Fixtures synthetic throughout (R7); a license scan over
the added fixtures is part of the packet's acceptance.

| # | Case | Expected |
|---|---|---|
| T1 | Full `/7` lifecycle: declare → lock → run (stubbed provider) → report → publish → delete workspace → cold standalone verify | Seven checks, `disclosure-specification` last |
| T2 | Assertion entry carrying an `evidence` key | Refuses at parse (R3) |
| T3 | `undisclosed` entry carrying a `statement` | Refuses at parse |
| T4 | Record missing one of the six variables | Refuses, naming the missing key (R2) |
| T5 | Record carrying a seventh variable key | Refuses, naming the unknown key |
| T6 | `measured-here` citing a digest absent from the bundle | Refuses at §7 step 6 |
| T7 | `measured-here` citing a record whose bundle role is outside §6.4's admissible set | Refuses at §7 step 6 |
| T8 | `measured-here` citing only `execution-observation` entries | Refuses at §7 step 6 |
| T9 | `author` differing from `report.author` | Refuses at §7 step 4 |
| T10 | `subject.digest` differing from the Matrix digest | Refuses at §7 step 3 |
| T11a | Report extension absent on a `/7` bundle | Refuses at §7 step 1 |
| T11b | Report extension present on a `/2`, `/4`, `/5`, or `/6` bundle | Refuses at **G0** (§7 preamble), the closure-independent guard — not at step 1, which never runs on those formats |
| T12a | `disclosure-specification` role on a `/4` bundle as a **standalone** catalog record, extension absent | Refuses at `verify.ts:1439` (`evidence catalog contains missing or unreachable records`): the extra digest makes `declaredRoles` exceed `expectedRoles` |
| T12b | `disclosure-specification` role **appended to an existing graph record's** role array on a `/4` bundle | Refuses at `verify.ts:1441-1445` (`record <digest> roles do not equal its derived graph roles`): the catalog sizes still match, so the per-digest compare is what fires |
| T13 | Report record with the extension: parse → re-seal → byte-compare | Byte-identical (loose-object retention, §6.3) |
| T14 | Claim `disclosure` section edited by one byte | `claim-consistency` refuses, naming the field |
| T15 | Record bytes edited by one byte | `manifest` refuses before any semantic check |
| T16 | Run with no declaration | `/4` bundle, six checks, byte-identical to today's fixture |
| T17 | Every pre-existing bundle, claim, and Report fixture | Byte-unchanged |
| T18 | The 144-cell qualification lifecycle test | Green, unmodified |
| T19 | An assertion whose `statement` is plainly false | **Verifies.** The record is valid and the assertion is carried (R4). This test exists to pin the posture, not to tolerate a bug |
| T20 | v2 evidence catalog after the role append | Byte-unchanged; `ROLE_ORDER.slice(0, 12)` still yields exactly the v2 role set (§6.2) |
| T21 | Record declaring `disclosure-specification` plus a second role | Refuses at §7 step 1 |
| T22 | `/7` bundle whose `claim-package.json` declares `/2` or `/4`, or whose `qualification.json` declares `/5` | Refuses at §7 step 9 (§6.5.1) |
| T23 | Two catalog records matching the extension's digest | Refuses at §7 step 1 (exactly-one cardinality) |
| T24 | Catalog record bearing `disclosure-specification` that the Report extension does not name | Refuses at §7 step 1 (one-to-one correspondence) |
| T25 | `sources` unsorted, or carrying a duplicate `uri` | Refuses at §7 step 7 |

T19 is the test a reviewer will want to delete. It must not be deleted: a verifier
that failed on a false assertion would be claiming a power it does not have.

T12a, T12b, and T24 are complements and all three are required. T12a and T12b cover
*role without extension* in its two smuggling shapes, standalone record and appended
role, which trip different refusals (§6.5.2). T24 covers *role without the extension
naming it*, on a bundle where the extension does exist. Dropping any one leaves a path
by which a disclosure record rides in a bundle with nothing checking it.

## 12. Boundaries

### 12.1 P0 owns the judge-path deltas

Packet **P0** (`design`, issue #2842, branch `claude/judge-p0-delta-contracts`) is
concurrently freezing the instrument and model profiles, the evidence channel, the
stratum vocabulary, the parser identities, the ungradeable classes, and the
screening-model admission branch. **P0's spec is the authority for every one of
those.** This design:

- cites instrument pinning and arm identity; it never redefines them;
- fixes no requirement key, no model literal, no parser id, no stratum token;
- leaves §6.4's per-variable narrowing explicitly unfrozen until P0's record
  vocabulary is merged.

If P0 introduces new record species that fix `judge-model` or `judge-prompt` (a
model-profile record, an evidence-channel input-shape identity), those species join
§6.4's `pinned-configuration` row at S2 time. That is the only coupling, and it is
one-directional.

### 12.2 Explicit non-goal: `/7` does not combine disclosure with integrity anchors

The closure space is more than one dimension, and `/7` deliberately occupies only one
corner of it:

| Closure | Composition |
|---|---|
| `/2` | base graph |
| `/3` | accounting-only publication profile, unrelated to this axis (`core/src/bundle/manifest.ts:23`) |
| `/4` | `/2` + binary qualification |
| `/5` | evidence-native, its own lineage |
| `/6` | `/2` + anchors (`verify.ts:346,348`) |
| `/7` *(this design)* | `/4` + disclosure |

**An anchored, qualified, disclosed bundle has no closure version and cannot be
published.** Two points of accuracy about that:

- The anchored + qualification exclusion **pre-dates this design**. The producer
  already refuses the combination outright — `core/src/bundle/materialize.ts:273-279`
  ("no closure version expresses both") and `core/src/report/claim.ts:640-644`. So
  today's flagship qualification bundle cannot be anchored regardless of anything
  here.
- What `/7` adds is that it keeps that exclusion in place rather than resolving it,
  and stacks disclosure on the same unanchored branch. A publisher choosing disclosure
  is choosing it *instead of* anchoring for as long as no combined allocation exists.

This is stated as a non-goal rather than a limitation because resolving it means
allocating a combined closure, which is a larger piece of work than S2 and is not on
the critical path for the report. §13 Q5 puts the choice to the operator, because for
a flagship publication the tradeoff — a third-party time proof against a machine-readable
disclosure — is a product decision, not an engineering one.

### 12.3 License law

Program §1 constraint 2 and §8 apply without exception. No third-party prompt bytes,
dataset rows, annotations, or audit-derived text land in this record, its schema, its
fixtures, its tests, or this document. Every `statement` is the record author's own
original prose. §9's worked example is synthetic placeholder text written for this
document.

### 12.4 Never run-blocking

Per D3, S2 lands during report-writing week and the record publishes with the report
if ready, or fast-follows within days with the thread post saying so. §6.5's opt-in
property is what makes that real: without a declaration, the flagship bundle is
exactly the bundle it is today.

## 13. Open questions

Each needs an operator ruling before S2 begins. None blocks the confirmatory run.

**Q1 — Does the judge's input shape become a seventh variable?**
The design authority's §2 states six variables. Its §8 makes "the judge's input shape
is a first-class disclosure entry" a claimable outcome if the evidence-conditioned arm
differs materially from its evidence-free twin. Expanding the vocabulary to seven is a
change to the posted design and would require a dated public amendment in the thread
before any outcome is observed (program §1 constraint 1).
*Recommendation:* keep six. Express input shape inside the `judge-prompt` variable's
`measured-here` evidence, where the evidence-declaring instrument is already a
distinct sealed digest from its evidence-free twin. This is fully expressive and needs
no amendment. Revisit as `specification/v2` after the report publishes, if the result
warrants it.

**Q2 — Closure version, or additive inside `/4`?**
§6.5 recommends a `/7` bump plus claim `/5`. The cheaper alternative — allowing the
new role additively inside `/4` — avoids one format constant but makes "what a `/4`
bundle may contain" time-dependent, which the existing one-complete-profile rule
exists to prevent.
*Recommendation:* bump. The cost is a handful of constants; the property bought is
that an older verifier refuses an unknown disclosure rather than ignoring it.

**Q3 — Should `disclosed-by-publisher` carry a retrieval timestamp?**
A `retrievedAt` on each source would make an assertion auditable against the source's
own history. It is also itself an unanchored claim by the same author, so it adds a
field the verifier cannot check.
*Recommendation:* omit in v1. R5 says nothing derivable is stored; a self-asserted
timestamp is worse than that — it is unverifiable *and* invites readers to treat it as
evidence. If the report's reviewers ask for it, add it in `specification/v2` with the
projection labeling it explicitly as an unanchored assertion.

**Q4 — Where does the verification result's `disclosure` block surface for humans?**
§7 step 11 defines the machine surface. The bundle's own `index.html` and `README.md`
are S2 (§10.2); the site's report template is R1 (§10.4). If the operator wants the
six-variable table on the site before S2 lands, R1 needs a fallback that renders it
from report prose, which would be a second source of truth for the same facts.
*Recommendation:* do not build the fallback. Either the record ships and the table is
rendered from it, or the table is prose in the report body and the site does not
duplicate it.

**Q5 — Does the flagship report want integrity anchors, disclosure, or a combined
closure?** Per §12.2, an anchored qualification bundle is already impossible today and
`/7` keeps it that way while adding disclosure to the unanchored branch. Three
options: publish `/7` (disclosure, no anchor); publish `/4` and defer disclosure to a
later artifact (no anchor either, since anchored + qualification is already refused);
or allocate a combined closure, which is materially more work than S2 and would move
the fast-follow date.
*Recommendation:* publish `/7`. The report's contribution is the disclosure standard,
and a third-party time proof does nothing for a claim whose whole content is
"here is what we did and did not measure". But this is a product call about what the
flagship should carry, so it is the operator's, not this design's.

**Q6 — Should per-variable heterogeneity get a structural home in `specification/v2`?**
§4.3 resolves v1 by having `statement` carry the mixture, and §9's `answer-model`
shows it. The alternative is a per-variable breakdown with item counts, which would
make heterogeneity machine-readable and countable.
*Recommendation:* keep prose in v1 and revisit after the report. A structural
breakdown needs an item-partition vocabulary that would have to agree with the item
bank's own, and that coupling is exactly the kind of thing §6.4 defers until P0's
record vocabulary is merged. If reviewers of the published record ask for it, that is
strong evidence it belongs in v2.
