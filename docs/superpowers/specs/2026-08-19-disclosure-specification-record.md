# Disclosure Specification Record — the six-variable declaration

| | |
|---|---|
| **Version** | 0.1 |
| **Date** | 2026-08-19 |
| **Author** | S1 design session (Claude Fable 5, lane coordinator); seam citations read against `next` @ `4f4ad46f2` |
| **Shape** | `design` (packet S1). Implementation is packet S2 and lands separately |
| **Status** | proposed — awaits operator ratification of §13's open questions |
| **Issue** | [#2839](https://github.com/Jinn-Network/mono/issues/2839) (F7 in the original mapping). Part of program parent [#2833](https://github.com/Jinn-Network/mono/issues/2833) |
| **Design authority** | The experiment design posted in [snap-research/locomo#23](https://github.com/snap-research/locomo/issues/23#issuecomment-5334425775) (2026-08-18), §2 (the six variables) and §8 (what the report may and may not say) |
| **Depends on** | [judge-report implementation program](../plans/2026-08-18-judge-report-implementation-program.md) §4 (packets S1/S2), §8 (prohibitions), §9 (D3); [benchmark product](./2026-08-05-benchmark-product-design.md); [publication interoperability profile](./2026-08-13-benchmark-publication-interoperability-profile.md); [pluggable integrity providers](./2026-08-17-pluggable-integrity-providers-design.md) (the record/carriage/claim/check pattern this design follows) |
| **Does not do** | Any judge-path delta. Instrument and model profiles, the evidence channel, parser identities, stratum vocabulary, ungradeable classes, and the screening-model admission branch are packet **P0**'s scope; P0's spec is the authority for every one of them (§12.1). This design cites those surfaces and never redefines them |
| **Never run-blocking** | Per operator ruling D3 (2026-08-19): S1 designs now, S2 implements during report-writing week, and the confirmatory run never waits on either |

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
and provable from the bundle. The four answer-factory variables are not: candidate
answers are drawn from previously published sets, so whatever produced them was fixed
by someone else and is knowable only to the extent the source stated it.

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
`${RECORDS_ROOT}/<segment>/<major>` already mirrored in
`packages/benchmarking/records/src/identifiers.ts:28-36`. The extension key follows
the `benchmark-publication/v1` and `anchor-intent/v1` precedents in the same file
(`identifiers.ts:40-48`).

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

**Undisclosed.**

```jsonc
{
  "status": "undisclosed",
  "reason": "not-stated" | "stated-without-identifiers" | "outside-this-experiment"
}
```

- No `statement`, no `evidence`, no `sources`. The branch carries a reason token and
  nothing else.
- The three reasons are the honest distinctions a reader needs: the source said
  nothing; the source said something too vague to pin (a family name with no dated
  snapshot, a strategy name with no parameters); or this experiment deliberately
  holds the variable out of scope.

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
be in that order, so an insertion would re-order existing bundles' role arrays and
break their bytes.

The disclosure record carries **exactly** this one role and no other. A record bearing
`disclosure-specification` together with any second role refuses.

### 6.3 Report extension

```jsonc
// on the Report record, alongside its existing fields
"https://spec.jinn.network/extensions/disclosure-specification/v1": {
  "uri": "<optional acquisition hint>",
  "mediaType": "application/vnd.jinn.disclosure-specification.v1+json",
  "digest": { "sha256": "<64 lowercase hex digits>" }
}
```

The value is a `DigestBearingResourceDescriptor`
(`records/src/descriptors.ts:11-18`), the same shape
`RunPublicationExtensionSchema` uses for registration artifacts.

**The Report record schema does not change.** `ReportRecordSchema` is built on
`topLevelRecordSchema`, which is a `z.looseObject` admitting any absolute-URI or
reverse-DNS extension key (`records/src/extensions.ts:16-31`). A new reader function
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
| Bundle format | `benchmark-product-public-bundle/7` | Mandatory member list **identical** to `PUBLIC_BUNDLE_V4_FILES`. The only differences from `/4` are the role vocabulary, the required Report extension, the claim id, and the check |
| Claim schema | `benchmark-product.claim-package/5` | `claim-package/2` (binary qualification) plus the `disclosure` section and the extended check list |
| Check name | `disclosure-specification` | Always present on `/7`, never on any earlier closure |

Next free numbers verified against `next` @ `4f4ad46f2`: bundle formats `/2`, `/4`,
`/5` (evidence-native), `/6` (anchored) are taken (`verify/src/manifest.ts:18-24`);
claim ids `/1`, `/2`, `/3` (evidence-native), `/4` (anchored) are taken
(`verify/src/profile/claim.ts:50-58`). **S2 re-verifies both against `next` at
implementation time** and takes the then-next free numbers if the anchored or
evidence-native lines have advanced.

Why a format bump at all, given no new file member: `verify.ts` already enforces that
a bundle matches one complete, deterministic presentation profile rather than mixing
members. Letting a `/4` bundle grow a new evidence role would make "what a `/4`
bundle may contain" time-dependent, which is exactly the property the frozen role
order exists to prevent. With the bump, a `/4` bundle carrying a
`disclosure-specification` role is a non-conforming bundle and refuses loudly, and an
older verifier meeting a `/7` bundle refuses at the role enum rather than silently
ignoring a disclosure. Failing closed on an unknown disclosure is the only acceptable
behavior for this record type.

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

Runs exactly on the `/7` closure, after `report-verification` and before
`claim-consistency`, over the authenticated byte snapshot. No consumer reopens a
bundle path after `verifyBundleSnapshot`.

1. **Carrier binding.** Read the Report's `DISCLOSURE_SPECIFICATION_EXTENSION` value.
   Refuse if it is absent on a `/7` bundle. Refuse if it is present on any earlier
   closure. Its `digest.sha256` must resolve to exactly one record in the evidence
   catalog, and that record's declared roles must be exactly
   `["disclosure-specification"]`.
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
9. **Projection equality.** `deriveDisclosureSpecification(recordBytes)` must byte-equal
   the claim's `disclosure` section. Delivered by extending
   `assertClaimConsistency`'s existing whole-claim compare rather than by a second
   comparison.
10. **Result surface.** The verification result gains an optional `disclosure` block:
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
      "reason": "outside-this-experiment"
    },
    "retrieval-config": {
      "status": "undisclosed",
      "reason": "outside-this-experiment"
    },
    "answer-model": {
      "status": "disclosed-by-publisher",
      "statement": "Candidate answers were produced elsewhere by a dated model snapshot named in the source collection's own notes; this venue did not run it.",
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

Three things this example demonstrates, and each is the reason the record exists:

1. Two variables are proved, four are not, and a reader can tell at a glance which is
   which without reading a word of the report body.
2. `answer-prompt` asserts with no source, and the record says so rather than
   fabricating a citation.
3. `ingestion-model` and `retrieval-config` are marked out of scope rather than
   omitted. The report proposes a six-variable standard; a compliant record states all
   six even when four of them are "not here".

## 10. S2 implementation map

Mechanical. Ordered so each step compiles on the one before it. Every step is
additive; nothing existing changes shape.

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
| `src/profile/disclosure.ts` *(new)* | `deriveDisclosureSpecification` (shared pure projection, §6.6) and `assertDisclosureSpecification` (§7 steps 1–8). Exported from the package root so `core`'s carriage imports the same function |
| `src/profile/claim.ts` | `DISCLOSURE_CLAIM_PACKAGE_SCHEMA_ID = "benchmark-product.claim-package/5"`; `DisclosureSectionSchema`; a `/5` superRefine branch (requires `disclosure`, requires the `/2` qualification projection, pins the `/7` check list); refuse `disclosure` on `/1`, `/2`, `/3`, `/4` |
| `src/reader-instructions.ts` | `PUBLIC_BUNDLE_V7_CHECKS = [...PUBLIC_BUNDLE_VERIFICATION_CHECKS, "disclosure-specification"]`; `/7` entries in `PUBLIC_BUNDLE_VERIFICATION_INSTRUCTIONS` |
| `src/verify.ts` | `PublicBundleVerificationCheck` gains `"disclosure-specification"` (`verify.ts:121-130`); result `format` union gains `/7`; optional `disclosure` block on the result; `isV7` flag; call `assertDisclosureSpecification` after `report-verification` and `checks.push(...)`; evidence-closure derived-roles map learns the new role's edge (Report extension → record) |
| `src/assets.ts` | The `/7` presentation profile renders the six-variable table into `index.html` / `README.md`. Deterministic projection of verified facts only |

### 10.3 `packages/benchmark-product/core`

| File | Change |
|---|---|
| `src/disclosure/state.ts` *(new)* | Workspace-side declaration state: the six entries a sponsor composes before lock. Product state, not a sealed record |
| `src/operations/disclosure-declare.ts` *(new)* | `disclosure declare` operation: validate the declaration, seal the record, write it to the sealed store, record its digest in run state. Idempotent; re-declaring before lock replaces, after lock refuses |
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
| T11 | Report extension present on a `/4` bundle, or absent on a `/7` bundle | Refuses at §7 step 1 |
| T12 | `disclosure-specification` role on a `/4` bundle | Refuses at the role enum |
| T13 | Report record with the extension: parse → re-seal → byte-compare | Byte-identical (loose-object retention, §6.3) |
| T14 | Claim `disclosure` section edited by one byte | `claim-consistency` refuses, naming the field |
| T15 | Record bytes edited by one byte | `manifest` refuses before any semantic check |
| T16 | Run with no declaration | `/4` bundle, six checks, byte-identical to today's fixture |
| T17 | Every pre-existing bundle, claim, and Report fixture | Byte-unchanged |
| T18 | The 144-cell qualification lifecycle test | Green, unmodified |
| T19 | An assertion whose `statement` is plainly false | **Verifies.** The record is valid and the assertion is carried (R4). This test exists to pin the posture, not to tolerate a bug |

T19 is the test a reviewer will want to delete. It must not be deleted: a verifier
that failed on a false assertion would be claiming a power it does not have.

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

### 12.2 License law

Program §1 constraint 2 and §8 apply without exception. No third-party prompt bytes,
dataset rows, annotations, or audit-derived text land in this record, its schema, its
fixtures, its tests, or this document. Every `statement` is the record author's own
original prose. §9's worked example is synthetic placeholder text written for this
document.

### 12.3 Never run-blocking

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
§7 step 10 defines the machine surface. The bundle's own `index.html` and `README.md`
are S2 (§10.2); the site's report template is R1 (§10.4). If the operator wants the
six-variable table on the site before S2 lands, R1 needs a fallback that renders it
from report prose, which would be a second source of truth for the same facts.
*Recommendation:* do not build the fallback. Either the record ships and the table is
rendered from it, or the table is prose in the report body and the site does not
duplicate it.
