# Public benchmark bundle

The frozen format is `benchmark-product-public-bundle/2`. It is an immutable,
digest-addressed directory containing a Report, the exact evidence needed to
check it, public trust material, and five deterministic presentation assets.
Its evidence remains verifiable after the originating product workspace and
private keys are gone.

`publish` means local immutable emission, not hosting. It does **not** upload, host, deploy,
register, release, or write remotely. Deployment status is none.

## Identity and closure

`bundle.json` is the exact canonical manifest and is not listed inside itself.
The bundle identity is the lowercase SHA-256 of those exact manifest bytes.
Each manifest entry binds one normalized relative path, byte length, and
SHA-256; entries are canonical and unique. Missing, extra, reordered,
duplicate, absolute, dot, parent, symlink, hardlink, special-file, or changed
members fail closed.

The fixed files are:

- `static-bundle.json`
- `benchmark.json`
- `run.json`
- `matrix.json`
- `report.json`
- `report-envelope.json`
- `claim-package.json`
- `verdicts.json`
- `evidence.json`
- `verification/assembly.jsonl`
- `trust/public-keys.json`
- `index.html`
- `badge.svg`
- `social-card.svg`
- `README.md`
- `share.txt`

The manifest also includes one exact `records/<sha256>.bin` member for every
record in the authenticated evidence graph. For an Inspect-backed Task this
closure includes the exact canonical Inspect selection manifest under the
`runtime-selection` evidence role. The verifier checks that the Task, selected
arm, complete ordered scorer definitions, selected projections, Jinn verdict
rule, provider evidence, and native log all agree with that sealed selection; a
bundle is not portable if it retains the Task and log but omits the method that
selected them. A cancelled run additionally has the optional
`verification/cancel-requested.json`. When publication explicitly authorizes
native Inspect content, each delivered native log is duplicated byte-for-byte
as `native/inspect/<sha256>.eval`. The verifier requires that set to exactly
match the Inspect log outputs in the authenticated delivery graph; the `.eval`
extension makes the artifact directly usable by the pinned Inspect reader and
Inspect View. No other role is permitted in
`benchmark-product-public-bundle/2`; an incompatible closure requires a new
format version.

Version 2 is the first format that permits runtime-native artifacts and
same-execution scorer relationships. Version 1 remains a historical native-only
format; this implementation emits and verifies version 2 rather than changing
version 1's closed schema in place.

Every format section below carries the complete recipe for that format, pinned
at the reader line that understands it. **The lines are not interchangeable.**
A reader that predates a format refuses it under `record-integrity`, which is
also the code for a corrupt bundle, so running the wrong line reads as an
invalid bundle rather than as a version mismatch. What that looks like, and how
to tell the two apart, is under
[Reading a bundle with a reader that is too old](#reading-a-bundle-with-a-reader-that-is-too-old).
The bundle names its own line: the producer wrote it into the claim package's
`verification.command`, with `verification.compatibleCommand` beside it. That is
the instruction to follow whenever the claim package is at hand, because it is
the exact line the producer named. The table in
[Portable verification](#portable-verification) is the same mapping keyed by
format, for a reader who has only `bundle.json`.

Verify a version 2 bundle with:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

`@0.1.0` is the exact producer-side release inside that line, for byte-for-byte
reproduction. Version 2 carries no anchors, so the anchor trust-material flags
below do not apply to it. It returns **six checks**.

One kind of version 2 bundle names a later line. A run whose screening was
prompted — its claim carries `method.parameters.promptedScreeningProfile ===
"prompted-codex-screening/v1"` — pins `@0.2.1`, with `@0.2` as the compatible
line and `@0.2.0` on bundles materialized before `0.2.1` existed. Prompted
screening does not move the format, so such a bundle is still `.../2`, and the
`@0.1` line does verify it: claim-package/1 states no reader requirement of its
own, so no line refuses it on the pin. What the bundle's own `index.html` and
share text instruct, and what reproduces the producer's exact release, is the
`@0.2.1` line its claim names. Take the line from the claim package's
`verification.command` rather than inferring it from the format string; the
publication caveat stated for v7 below applies to that `@0.2.1` too.

### Binary qualification bundle v4

`binary-instrument@1` emits the additive
`benchmark-product-public-bundle/4`; the v2 grammar and bytes above remain
unchanged, and the unrelated accounting-only v3 is not reused. V4 retains the
complete v2 Run/Matrix/Report graph and adds the fixed `qualification.json`
derived index. That index is not a new signed statement or truth authority: it
joins the exact claim-package/2 F6 projection to the already authenticated item
bank admission graph, its four judge instruments, and their prompt-template
commitments.

The v4 evidence catalog assigns closed semantic roles to every reachable
admission record, including the source manifest, admission manifest and ledger,
source items, label resolutions, analysis contexts, the frozen human-review
specification and form when applicable, signed review records and receipts, and
operator assertions when applicable. Publication first replays the canonical
portable admission verifier, then requires exact accepted-Task coverage and
exact digest/role closure. Missing, extra, dangling, duplicate, reordered, or
role-swapped evidence fails closed. The v4 trust file carries the exact Ed25519
SPKI material for Run evaluators and admission reviewers, plus the closed
reviewer and report-authority role mappings needed by a copied bundle.

V4 full HTML and Markdown present all four instruments, item/call/confusion
counts, five registered rates with denominators and intervals, every declared
candidate-class and stratum slice, parser-invalid and instability facts,
truth-admission status, exclusions/replacements, and stored limitations. Its
badge, social card, and share text are narrower signposts: verified state, exact
scope, full Report digest, and relative links only. They carry no rate,
instrument conclusion, preference, selection, or ordering.

An unprompted v4 reads on the same first public line as v2:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

`@0.1.0` is the exact producer-side release inside that line. A v4 whose
screening was prompted pins `@0.2.1` instead, with `@0.2` compatible only for a
bundle pinning `@0.2.0` — the line a prompted v4 materialized before `0.2.1`
existed carries — and `@0.1` refusing outright:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir>
```

The format string does not record that difference — prompted screening is a
fourth axis, and only anchoring, qualification, and disclosure select the format
— so take the line from the claim package's own `verification.command`, or read
`method.parameters.promptedScreeningProfile`, which is
`"prompted-codex-screening/v1"` on a prompted bundle and absent otherwise. The
publication caveat stated for v7 below applies to a prompted v4's `@0.2.1` too,
but the refusal a prompted v4 earns is not v7's: v7 is refused on the format,
before the claim is read, while a prompted v4 is a format `0.1.0` and `0.2.0`
both support and is refused on the claim inside it. That case is described in
[A listed format is not on its own a verdict either](#reading-a-bundle-with-a-reader-that-is-too-old).

V4 carries no anchors, so the anchor trust-material flags below do not apply to
it. It returns the same **six checks** as v2 on both lines: the qualification
projection changes what `evidence-closure` and `claim-consistency` examine, not
which checks run.

### Anchored bundle v6

A run that carries third-party time evidence over one of its own sealed records
emits the additive `benchmark-product-public-bundle/6`; the v2 grammar and bytes
above remain unchanged, and a run that carries no anchor keeps emitting the
version it emitted before this format existed. V6 retains the complete v2
Run/Matrix/Report graph and adds one exact `anchors/<sha256>.bin` member per
carried AnchorEvidence record, named by the digest of its own exact sealed
bytes. Those bytes are the record: an alternate JSON spelling of the same
content is a different member and is refused.

A run whose sealed Run **declared** anchoring intent is on this closure too,
even when it carries no anchor at all. Otherwise stripping the anchor would
also drop the bundle to a version with nothing to say about the declaration,
which is exactly the disclosure the declaration exists to make. Such a bundle
carries an empty `anchors` section, keeps every unconditional sentence, and
reports its lock subject as declared-but-absent.

The claim package moves to `benchmark-product.claim-package/4`, which is
claim-package/1 plus an `anchors` section. Each entry carries the subject
reference, the resolved record kind, the provider profile, the record digest,
and only the facts embedded in the proof's own bytes: `genTime`, `policyOid`,
`serialNumber`, and `signerCertificateSha256` for an RFC 3161 token; the
attested Bitcoin block height, or the calendar-only `pending` state, for an
OpenTimestamps proof. Facts that need data from outside the bundle, such as a
block's time, and facts with no canonical rendering, such as an issuer
distinguished name or an accuracy interval, never enter this section; they are
verifier-report content. Producer and verifier derive the section from the same
bundle bytes with the same function, so claim consistency stays an exact
byte-compare.

Anchor subjects are selected by digest, never by label: the lock anchor is the
one whose subject digest equals the digest of this bundle's exact `run.json`,
and the matrix anchor the one that equals `matrix.json`. The record's own
`subject.kind` is then required to equal the kind of the record its digest
resolves to. A valid proof over a digest no bundle record has, or a kind that
misdescribes the record it names, fails the bundle loudly rather than passing
quietly.

A carried, structurally complete, digest- and kind-matching lock anchor is what
changes the sealed honesty copy: `venueHonesty.preRegistration` widens from
`structural-and-append-order-only` to
`structural-append-order-and-anchored-time`, the pre-registration limitation
names the anchored time or block height, and the trust-root sentence records
that the anchor is checked against trust material supplied on the verifier's
side. Each additional lock anchor adds one neutral line, and a matrix anchor
adds one that upgrades nothing. A pending proof, a matrix-only anchor, or no
anchor at all leaves every sentence unconditional. What a verified anchor
proves is that the sealed design digest existed no later than the anchored
time — not that results were produced after it, and nothing else about the run.

Trust roots are strictly verifier-side configuration. The verifier ships with
none, so a well-formed proof reports as `present` rather than `verified` until
an operator supplies timestamp-authority roots or Bitcoin block headers; any
certificate chain carried inside the bundle is archival convenience and is
never used to validate. Verification never contacts an anchor provider and
never upgrades a pending proof.

V6 pins the same first public line as v2 and v4. It is the only anchored format
that does: v7 and v8 are anchored too and read on a later line, named in their
own sections.

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

Supply your own trust material to reach `verified`:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir> \
  --tsa-root ./authority-root.pem \
  --ots-headers ./bitcoin-headers.txt
```

`--tsa-root` takes a DER or PEM certificate and is repeatable. `--ots-headers`
takes a file of `<height>:<80-byte-hex>` lines and is repeatable. Both default
to nothing: which authorities and which chain are acceptable is the reader's
judgment, not the bundle's, and this tool holds no opinion it did not ask for.
These two flags mean the same thing on every anchored format; only the version
in front of them changes.

V6 returns **seven checks**: the six above, in the same order, followed by
`integrity-anchors`. That check is always present for this format, because an
anchored bundle whose anchors were stripped is a closure failure, not a shorter
list. An `invalid` anchor fails the whole verification; every other status is a
disclosed fact that prints and passes.

Both output modes print the anchor detail; neither summarizes it away. Under the
check list the default human output names every carried anchor — its subject,
time basis, status, and the `genTime` or block height embedded in its own bytes
— followed by what this reader's own trust material did about the time basis:
evaluated it, was supplied and did not verify this anchor, or was never
supplied. Then each subject's outcome, with an absent anchor and a
declared-but-absent one named as the different facts they are:

```
Anchors
  lock anchor · authority-time · present · 2026-01-01T12:00:00Z
    time basis not evaluated: no trust material supplied
    record 4d1c...

Anchor subjects
  lock: anchored
  matrix: absent — no anchor was carried and none was declared
```

The closing paragraph gains the anchor's own limit: an anchor dates the bytes it
covers and says nothing else about the run — not that results were produced
after it, and not that the anchoring authority is independent of the bundle's
owner.

### Anchored binary qualification bundle v7

A run that is both anchored and projecting a binary qualification emits
`benchmark-product-public-bundle/7`. It is the intersection of the two closures
above and nothing else: v4's complete member list, including
`qualification.json`, plus v6's `anchors/<sha256>.bin` members and its
`integrity-anchors` check. Every rule stated for either parent holds here
unchanged, and v2, v4, and v6 bundles keep the versions, member lists, and bytes
they already had.

Its claim package is `benchmark-product.claim-package/5`: claim-package/2's
exact per-subject F6 qualification projection plus claim-package/4's `anchors`
section. Both parents' refusals are inherited. A ranking, selection, or any
other conclusion smuggled into the claim is refused exactly as it is on
claim-package/2, and an omitted anchors section is refused exactly as it is on
claim-package/4. `qualification.json` keeps its frozen
`benchmark-product.claim-package/2` literal on this closure: that field names
which projection shape the qualification graph was built for, and that shape is
byte-identical under both binary allocations.

Unlike every earlier closure, v7 does not stamp the first public `@0.1` line. No
reader before `0.2.1` understands the format, so its claim pins `@0.2.1`, with
`@0.2` as the compatible line:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir>
```

V7 is anchored, so it takes the trust-material form too:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir> \
  --tsa-root ./authority-root.pem \
  --ots-headers ./bitcoin-headers.txt
```

`--tsa-root` and `--ots-headers` carry exactly the meaning and the defaults
stated for v6 above; supplying neither leaves a well-formed anchor at `present`
rather than `verified`. V7 returns the same **seven checks** as v6, in the same
order.

**`0.2.1` is not published yet, and `@0.2` will refuse a v7 bundle.** The reader
is cut by a manual, demand-gated workflow that no one has fired, so today
`@0.2.1` does not resolve and `@0.2` resolves to `0.2.0`, whose supported
formats stop at public-bundle/6. Running the compatible line against a v7 bundle
therefore produces the version-mismatch refusal described in
[Reading a bundle with a reader that is too old](#reading-a-bundle-with-a-reader-that-is-too-old),
not a verdict about the bundle. Until the release is cut, read a v7 bundle with
the installed product,

```bash
colophon bundle verify --bundle <bundle-dir> --json
```

which wraps the same reader implementation, or with a reader built from the
`0.2.1` source. The product route is not the easier of the two:
`@colophon-claims/cli` and `@colophon-claims/core` are implemented but
unpublished as well, so it needs the same mono checkout the source build does. A
reader who cannot build from the repository has no route to a v7 bundle until
the `0.2.1` cut. The product verb takes no trust-material flags and passes none,
so under it a well-formed anchor reports `present` and never `verified`; only
the `npx` reader can carry an anchor further, and only once the release exists.

### Evidence-native bundle v5 and its two profiles

`benchmark-product-public-bundle/5` is the evidence-native closure. Unlike every format above it
declares a `profile` IRI in its own `bundle.json`, and that declaration is part of the frozen
contract: which members a reader must find is a fact the bundle states, never one the reader infers
from what happens to be present. Its member list is `benchmark.json`, `analysis-manifest.json`,
`cohort.json`, `matrix.json`, `report.json`, `report-envelope.json`, `claim-package.json`, one
`records/<sha256>.bin` per evidence reference in `benchmark-product.claim-package/3`, and one
`artifacts/<sha256>.bin` per artifact that package declares. It returns **seven checks**:
`manifest`, `evidence-closure`, `artifact-integrity`, `signature-validity`,
`matrix-rederivation`, `report-verification`, `claim-consistency`.

Its `bundle.json` is the exact canonical manifest, is not listed inside itself, and is the only
member that differs in shape from every earlier closure: `format` is the exact string
`benchmark-product-public-bundle/5`, `profile` is one of the two IRIs below, and `files` is a
non-empty array whose entries each bind one relative `path`, its lowercase hex `sha256`, and its
`bytes` length. Entries are sorted and unique by path under UTF-16 code-unit comparison, and the
manifest is serialized as canonical JSON; the bundle identity is `sha256:` followed by the
lowercase hex SHA-256 of those exact bytes. A path is refused when it is empty, `.`, the reserved
`bundle.json`, absolute, contains a backslash, or has any empty, `.`, or `..` segment.

The v5 closure is **manifest-relative, not a fixed file list**. The set of files present must
equal `bundle.json`'s declared paths plus `bundle.json` itself — an undeclared file present on
disk, or a declared file that is missing, fails closed, as does any length or digest mismatch.
Within that, the seven fixed members above are required, the `records/<sha256>.bin` set must match
`benchmark-product.claim-package/3`'s evidence set exactly in both directions, and the
`artifacts/<sha256>.bin` set is governed by the declared profile below. **Members beyond those are
permitted** provided the manifest declares them: the bundle published on colophon.claims carries
`presentation.json`, `README.md`, and a `source/` copy of the human-readable report and its sealed
pre-run artifacts. A reader that rejects a member simply because this document does not name it
will reject the real artifact.

Its stored claim is `benchmark-product.claim-package/3`: the v5 evidence graph is addressed from
`records.evidence` and `records.artifacts`, both sorted and unique, and its `verification.checks`
is the exact seven-name tuple above. It is not the six-name tuple of public-bundle/2 and
public-bundle/4; not the anchored seven-name tuple of public-bundle/6 and public-bundle/7, which is
those six plus `integrity-anchors`; and not the eight-name tuple of public-bundle/8, which is that
anchored seven plus `disclosure-specification`.

None of the five deterministic presentation assets is a v5 member, and the verifier runs no asset
byte-compare for this format: there is no `index.html`, `badge.svg`, `social-card.svg`, or
`share.txt` in its closure, so the citation rules about badges and cards do not apply to it. An
extra member that happens to be human-readable — the published bundle's `README.md` and
`presentation.json` — is manifest-integrity-checked like any other member and is not compared
against the asset builder.

V5 stamps the same first public line as v2 and v4. Unlike the v2-derived claim packages,
`claim-package/3` carries one `verification.command` and no separate compatible line, and what it
pins is the compatible `@0.1` line:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

`@0.1.0` is the exact producer-side release inside that line, for byte-for-byte reproduction. V5
carries no anchors, so the anchor trust-material flags do not apply to it, and it returns the
**seven checks** named above rather than the anchored seven.

Two profiles are defined. Both are the same format, the same grammar, and the same seven checks.

- **Full evidence** — `https://spec.jinn.network/profiles/benchmark-product-public-bundle/5`.
  Every declared artifact body is carried. `artifact-integrity` reads every one of them. An
  artifact the evidence graph references but the bundle does not carry is a closure failure.
- **Metadata first** —
  `https://spec.jinn.network/profiles/benchmark-product-public-bundle/5/metadata-first`.
  Exactly the full-evidence bundle minus the evidence artifact bodies. It carries every record,
  every fixed member, and the artifact bodies that are declared signer public keys — those are
  trust material `signature-validity` reads, not evidence a reader can fetch later. A reader who
  only wants to recheck the arithmetic, the closure, the signatures, and the claim downloads the
  records and the digests instead of the evidence.

Every retained member of a metadata-first bundle is byte-identical to its full-evidence
counterpart, `claim-package.json` included. That is how the two forms cross-reference:
`claim-package/3`'s `records.artifacts` names every omitted body by exact digest, so a reader
holding the metadata-first form has both the address to fetch and the exact expectation to check
against, and the full form reduces to the metadata-first form by dropping those members and
rebuilding `bundle.json`. Only `bundle.json` and the set of `artifacts/` members differ.

Under metadata first, `manifest`, `evidence-closure`, `signature-validity`,
`matrix-rederivation`, `report-verification`, and `claim-consistency` are unchanged and complete:
they read records and fixed members, never artifact bodies. `artifact-integrity` reports
**not fetched** rather than passing or failing. An absent body is a disclosed fact, not a closure
failure; a body that *is* carried is still digest-checked, and a mismatch still fails the whole
verification; the closure rule narrows from "every referenced artifact has bytes here" to "every
referenced artifact is declared by digest in the claim package", so an evidence reference the claim
never declared is still refused. The carried artifact set must be exactly the declared signer
public keys — a metadata-first bundle carrying some other body is not the profile it declares and
is refused, because a profile that admits any partial fetch names a family rather than one exact
projection.

The reader prints the deferred check as `not fetched`, counts it out of the passed total, and
states what was not read. Nothing folds a deferred check into a pass: a bundle that reports seven
of seven over bytes nobody read would be the one claim this format cannot afford.

Under full evidence nothing changes. An unavailable artifact body is still a hard failure, and
every v5 bundle published before this profile existed keeps its exact bytes, its profile IRI, and
its outcome.

A reader keys on the declared profile, not on which members happen to be present. `bundle.json`'s
`profile` is a closed set, so a reader that predates the metadata-first profile refuses such a
bundle at manifest parse rather than misreading it as a full-evidence bundle with members missing.
Read a metadata-first bundle with a reader that lists the profile among the ones it supports.

That is also the publication gate. `claim-package/3`'s `verification.command` names the reader a
bundle instructs its readers to use, and no released reader line understands this profile yet, so
**nothing may publish a metadata-first bundle until its claim package pins a reader release that
declares the profile** — a claim naming a reader that cannot read it is an instruction to fail.
Today the profile is a format definition and a local derivation of an already-published
full-evidence bundle; no producer emits one. The local viewer, which is the one surface that can
be pointed at a hand-derived metadata-first bundle, offers the local `colophon bundle verify`
command instead of an `npx` line that would refuse.

### Disclosed anchored binary qualification bundle v8

A run that is anchored, projecting a binary qualification, and carrying a sealed
six-variable disclosure declaration emits
`benchmark-product-public-bundle/8`. It is v7's complete member list plus one
`records/<sha256>.bin` carrying the sealed disclosure-specification record, and
nothing else. v2, v4, v6, and v7 bundles keep the versions, member lists, and
bytes they already had, and a run with no declaration emits exactly the bundle
it emitted before this closure existed.

The record states all six variables that produced the score --- ingestion model,
retrieval config, answer model, answer prompt, judge model, judge prompt ---
each under exactly one of three statuses:

- `measured-here`: this venue executed the variable, and the bundle carries the
  sealed bytes that fix it. Every citation is authenticated against the
  bundle's own evidence closure.
- `disclosed-by-publisher`: the variable is fixed and stated, but this venue did
  not execute it, so no evidence in this bundle can establish it. The verifier
  carries the statement and never checks it.
- `undisclosed`: the variable is not stated. The entry carries a reason token
  and nothing else.

The distinction is structural, not editorial: the record's schema gives an
assertion nowhere to put a digest, so a declared variable can never be presented
as a measured one.

The Report names the record through the
`https://spec.jinn.network/extensions/disclosure-specification/v1` extension
key, which puts the record's digest under the report author's existing
signature. That key is legal on this format and no other. Its claim package is
`benchmark-product.claim-package/6`: claim-package/5 plus a `disclosure` section
carrying each variable entry verbatim, and it pins the same `@0.2.1` reader v7
does. It returns **eight checks** --- v7's seven plus `disclosure-specification`,
last.

V8 reads on that same `0.2.1` line, with `@0.2` as the compatible line:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir>
```

V8 is anchored, so it takes the trust-material form too:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir> \
  --tsa-root ./authority-root.pem \
  --ots-headers ./bitcoin-headers.txt
```

`--tsa-root` and `--ots-headers` carry the meaning and the defaults stated for
v6. The publication caveat stated for v7 applies here unchanged: `0.2.1` is not
published yet, `@0.2` resolves to `0.2.0`, and `0.2.0` refuses a v8 bundle with
the same version-mismatch refusal it gives a v7 one. Until the release is cut,
read a v8 bundle with `colophon bundle verify --bundle <bundle-dir> --json` or
with a reader built from the `0.2.1` source — and, as for v7, the product CLI is
itself unpublished, so both routes need a mono checkout.

## Portable verification

Verification with your own tools — no Jinn code at all — is specified in
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md): the check split, the
DSSE and digest rules, the JSON Schemas shipped under the reader package's
`schemas/`, and the conformance kit under
`verify/fixtures/public-bundle-conformance-v1/` whose tampered variants an
external verifier must reject.

Use the smaller reader package, without the product or source workspace. Which line reads which
closure is not uniform, and the format string alone does not settle it: **read the line the
bundle's own claim package pins** in `verification.command`, with `verification.compatibleCommand`
as the compatible line. The producer named that line for this exact bundle, and it is correct on
every closure. Use the table below when you cannot reach the claim package and have only
`bundle.json`. Each section above states the same thing in place, with the anchored form spelled
out where it applies.

| `bundle.json` format | Pinned line | Compatible line | Checks | Anchor flags |
| --- | --- | --- | --- | --- |
| `benchmark-product-public-bundle/2`, unprompted | `@0.1.0` | `@0.1` | six | not applicable |
| `benchmark-product-public-bundle/2`, prompted screening | `@0.2.1`, publication pending (`@0.2.0` if already materialized) | `@0.2`; `@0.1` also verifies, since claim-package/1 states no reader requirement | six | not applicable |
| `benchmark-product-public-bundle/4`, unprompted | `@0.1.0` | `@0.1` | six | not applicable |
| `benchmark-product-public-bundle/4`, prompted screening | `@0.2.1`, publication pending (`@0.2.0` if already materialized) | `@0.2`, and only for a bundle pinning `@0.2.0`; `@0.1` refuses | six | not applicable |
| `benchmark-product-public-bundle/5` | `@0.1` | none pinned | seven | not applicable |
| `benchmark-product-public-bundle/6` | `@0.1.0` | `@0.1` | seven | `--tsa-root`, `--ots-headers` |
| `benchmark-product-public-bundle/7` | `@0.2.1`, publication pending | `@0.2` | seven | `--tsa-root`, `--ots-headers` |
| `benchmark-product-public-bundle/8` | `@0.2.1`, publication pending | `@0.2` | eight | `--tsa-root`, `--ots-headers` |

Prompted screening is why the format string is not sufficient for the first four rows. It is a
fourth axis: the format is selected by anchoring, qualification, and disclosure only, so a
prompted run emits `.../2` or `.../4` exactly as an unprompted one does while pinning a later
reader. What distinguishes it is inside the claim package: its
`method.parameters.promptedScreeningProfile` is `"prompted-codex-screening/v1"` on a prompted
bundle and absent otherwise. That is the second reason to take the line from the claim package
rather than from the format.

Every row runs as `npx @colophon-claims/verify<line> <bundle-dir>`, with the anchor flags appended
where the row lists them.

The qualification axis, unlike prompted screening, is not left to the format string's word. Across
the legacy lineage and v8 — every row above but `.../5`, whose evidence-native closure is read by a
different path — a reader binds that axis to the sealed Report: the Report's method is
`binary-instrument@1` exactly when the format literal is a qualifying one (`.../4`, `.../7`,
`.../8`), and any disagreement refuses under `record-integrity` at path `bundle.json`. The binding
runs in both directions, so it closes the relabeling of a qualifying bundle down to its
non-qualifying sibling — `.../7` presented as `.../6`, `.../4` as `.../2`, which otherwise passes
every admission-bearing check, because dropping `qualification.json` and the admission-only evidence
records leaves `claim-package.json` byte-unchanged and `claim-consistency` still passing — and the
inverse smuggle of a non-binary Report onto a qualifying format. What it establishes is agreement,
not truth: it says the format literal describes the Report the bundle actually seals, never that the
Report's own method claim is correct. That remains what the Report's signature and the
`report-verification` check are for.

**This binding is a `0.2.1` guarantee**, and `0.2.1` is not published — see the note below. An
earlier reader does not make the relabeled bundle verify: `0.1.0` and `0.2.0` still stop the `.../7`
and `.../4` downgrades, because their presentation projection dispatches on the sealed Report's
method too and finds a binary Report where the comparison profile was expected. But they stop it as
an untyped crash from the last step of the run rather than as this named refusal, so do not read a
missing `record-integrity`-at-`bundle.json` signature on an older line as the check not having
fired.

**Publication pending is not a formality.** The `0.2.1` reader that public-bundle/7,
public-bundle/8, and every prompted bundle pin is cut by a manual, demand-gated workflow that has
not been fired, so no `0.2.1` exists on the registry today. `@0.2.1` does not resolve, and `@0.2`
resolves to `0.2.0`, which supports public-bundle/2, /4, /5, and /6 and refuses /7 and /8. Until the
release is cut, read anything that pins `@0.2.1` with `colophon bundle verify --bundle <bundle-dir>
--json`, which wraps the same reader, or with a reader built from the `0.2.1` source. Both routes
require a mono checkout: `@colophon-claims/cli` and `@colophon-claims/core` are implemented but
unpublished as well, so the product verb is not an easier path than the source build. A reader who
cannot build from the repository has no route to a `@0.2.1`-pinned bundle today.

A prompted /4 bundle fails differently from a /7 or /8 one under `@0.2`, and the distinction
matters when you read the refusal. `0.2.0` supports the format and carries the prompted-screening
branch, so it parses `bundle.json`; what it requires of claim-package/2 is the command `@0.2.0`
exactly, so it accepts a prompted bundle materialized before `0.2.1` existed and refuses a newer
one on the claim, with `binary claim package must pin verifier 0.2.0/@0.2`. That is a
reader-too-old refusal, not a fact about the bundle. A prompted /2 is refused by neither line:
claim-package/1 carries no reader requirement, so an older reader verifies it while the bundle's
own assets name `@0.2.1`.

Claim-package/1, claim-package/2, and claim-package/4 — the claims of public-bundle/2,
public-bundle/4, and public-bundle/6 — stamp the same first public line, `@0.1.0` / `@0.1`, with one
exception: a claim-package/1 or claim-package/2 whose method parameters carry
`promptedScreeningProfile` stamps `@0.2.1` / `@0.2` instead (`@0.2.0` / `@0.2` if it was
materialized before `0.2.1` existed). Only claim-package/2 enforces that pin, so the `@0.1` line
refuses a prompted public-bundle/4 and verifies a prompted public-bundle/2 whose stated line it is
not.
Claim-package/3, the claim of public-bundle/5, reads on the same line but pins only `@0.1`,
because it has a single `command` field and no compatible-line field. Claim-package/5 and
claim-package/6, the claims of public-bundle/7 and public-bundle/8, are the ones the `@0.1` line
cannot read; both pin `@0.2.1` / `@0.2`.

Public-bundle/2 and public-bundle/4 return the same six top-level check names in the order below;
v4 expands those checks internally rather than adding a seventh top-level result. The closures
that return more name their own lists where they are defined: v5 above with its own seventh,
v6 and v7 with `integrity-anchors`, and v8 with `integrity-anchors` plus an eighth,
`disclosure-specification`.

The full installed product exposes the same implementation through:

```bash
colophon bundle verify --bundle <bundle-dir> --json
```

For public-bundle/2 and public-bundle/4, success returns the bundle identity, record digests,
an Inspect runtime-method summary when applicable, and exactly **six checks**
in this order:

1. `manifest`
2. `evidence-closure`
3. `trust`
4. `matrix-rederivation`
5. `report-verification`
6. `claim-consistency`

The verifier authenticates one no-follow byte snapshot, reconstructs the exact
typed record graph and evaluator set, checks bundle-carried public keys against
signed identities, re-derives the Matrix, verifies the signed Report and method,
checks the stored claim, and byte-compares all five presentation assets with the
deterministic asset builder. Asset comparison does not add a seventh returned
check.

The bundle's closure selects exactly one presentation profile, and all five assets
must byte-match that profile completely. A qualification-projecting bundle
(`benchmark-product-public-bundle/4`, `/7`, and `/8`) renders the binary
instrument-qualification graph and carries no comparison section; every other
bundle that carries these five assets renders the human comparison. There is no
fallback profile: an asset set that is not the projection the closure selects is
refused, whichever profile it happens to resemble.

### Reading a bundle with a reader that is too old

Reader lines are not forward compatible, and the refusal does not say so in as many words. A
reader validates `bundle.json` against a closed set of format literals before anything else, so a
format it predates fails that parse. What it prints is:

```
colophon-verify: bundle.json does not satisfy the manifest schema
```

with exit code 1 and, under `--json`, `"code":"record-integrity"`. That is the same code and the
same message a genuinely corrupt or tampered manifest earns. **A valid bundle read by a reader
that is too old is indistinguishable from an invalid bundle on the human surface.** An auditor
who runs `@0.1` or `@0.2` against a public-bundle/7 or public-bundle/8 bundle sees exactly this,
and the bundle is fine.

Tell the two apart with `--json`, which names both sides of the mismatch:

```json
{"ok":false,"verifierVersion":"0.2.0","supportedFormats":["benchmark-product-public-bundle/2","benchmark-product-public-bundle/4","benchmark-product-public-bundle/5","benchmark-product-public-bundle/6"],"code":"record-integrity","message":"bundle.json does not satisfy the manifest schema"}
```

If the `format` string in the bundle's own `bundle.json` is absent from that `supportedFormats`
list, the refusal is a version mismatch and says nothing about the bundle: re-run the line the
bundle's claim package pins, or the line the table above gives for that format.

A listed format is not on its own a verdict either. A reader can support the format and still be
too old for the claim inside it — a prompted-screening public-bundle/4 is a format both `0.1.0` and
`0.2.0` support, while its claim pins `@0.2.1`, so each of those readers parses `bundle.json` and
then refuses the claim: `binary claim package must pin verifier 0.1.0/@0.1` under `@0.1`, and
`binary claim package must pin verifier 0.2.0/@0.2` under `@0.2`. A refusal that names the pinned
verifier is that mismatch, not a fact about the bytes. Before treating any refusal as a failing
bundle, check that the line you ran is the one the claim package's `verification.command` names.

The reverse direction is safe. A newer reader keeps every earlier format in `supportedFormats`,
so `0.2.1` reads a public-bundle/2 bundle exactly as `0.1.0` does; the line pinned inside the
claim package stays the one the producer named, for byte-for-byte reproduction.

## Task-selection provenance

Who chose the tasks changes what a headline number means as much as the number
itself, so the answer is a sealed field rather than prose. A Run record may carry
the `https://spec.jinn.network/extensions/task-selection/v1` extension, whose
`mode` is one of exactly three values:

- `claimant-chosen` — the claimant picked the tasks;
- `fixed-public-set` — the tasks are a complete set that was already public
  before the lock;
- `drawn-post-lock` — the tasks were fixed by rule only after the lock.

Because the declaration is sealed into the Run, it is fixed at the lock and
cannot be softened once results are known. Sealing does not make it true, so the
verifier refuses a bundle whose other sealed records positively contradict it,
under the `claim-consistency` check:

- `fixed-public-set` is refused when the Benchmark record names no author — a set
  nobody declared was never publicly declared — and when its reveal policy
  withholds its items past the end of the run (`after-run`, or `scheduled` with a
  `notBefore` at or after the Run's `closeAt`, or `scheduled` with no `notBefore`
  at all, which announces no instant at which the items become readable);
- `drawn-post-lock` is refused when the Benchmark reveals its items
  `immediate`ly, because the run was then locked against a set the claimant could
  already read, and nothing was drawn afterwards.

`claimant-chosen` carries no structural obligation. It asserts nothing about
anyone but the claimant, and constraining it would only make the honest answer
the expensive one.

The same rule runs twice, on purpose: `run lock` applies it before sealing, so a
contradicted declaration is a draft-validation refusal the claimant can still act
on, and the cold verifier applies it again on bytes alone. Left to publish time
only, a contradiction would surface after the run had been locked, executed,
reported, and materialized — a bundle the workspace can never verify, with no way
back.

`drawn-post-lock` therefore needs a Benchmark whose reveal is withheld, and no
task-set intake in this product mints one yet — every intake reveals `immediate`.
Declaring it today is refused at the lock, by name; the value is reachable as soon
as an intake supports a withheld reveal, and it stays in the vocabulary because
that vocabulary lives in the shared protocol package, not in this product.

Two limits are worth stating plainly rather than leaving a reader to assume more.

**These checks refuse; they never endorse.** No check can establish that a
`fixed-public-set` declaration is true: the bundle carries no independent witness
of the upstream set, so a claimant who assembled a private subset and declared it
public will pass. The declaration's force comes from being sealed and attributable,
not from being proved.

**The comparison is against the run's close, not its lock.** `closeAt` is
`lockedAt` plus a strictly positive interval, and no bundle carries `lockedAt`, so
only the far side of the comparison is sound: a `notBefore` at or after `closeAt`
is provably after the lock, while one before it settles nothing. A schedule that
opens mid-run is therefore not refused under either mode.

**Nothing about the declaration reaches the published face.** `index.html`,
`README.md`, `share.txt`, `badge.svg`, and `social-card.svg` carry no projection
of it: the asset builder is never given the mode, so a declaring bundle's five
assets are exactly what a reader that has never heard of `task-selection/v1`
rebuilds from the same records. (Its Run *digest* still differs, as it would for
any other Run field, and every reader derives that digest from the bundle's own
Run.) This is a compatibility requirement rather than an editorial choice. Every
allocation pins a reader release, and each of those releases byte-compares every
presentation asset against its own rebuild; a bundle that rendered the sentence
would therefore instruct its reader to run a verifier that refuses it. Rendering
the declaration is held for issue #3416, to land once the reader line the bundle
pins derives the sentence too. Until then the declaration is readable where it is
sealed — in the Run record — and enforced where it is checked, under
`claim-consistency`.

The declaration is also not a claim-package field, and will not become one:
`claim-package.json` pins its own key set byte-for-byte.

## Presentation and citation

This section describes the five deterministic presentation assets of the v2-derived closures
(v2, v4, v6, v7, and v8). Public-bundle/5 has none of them in its closure; its citation rules are
the shared list below, minus every sentence about a badge, card, or share text.

`index.html` is the canonical self-contained human report. It uses inline CSS
only and no JavaScript, remote resource, object, frame, embed, or active content.
It labels Matrix, Report, Claim, and verification-assembly facts separately and
links every raw content-addressed record. `badge.svg` and `social-card.svg` keep
neutral/no-winner and adverse facts prominent and retain the full Report digest
and exact arm ids in accessible metadata. `README.md` and `share.txt` are
portable text assets, not alternate conclusions.

A citation should include at least:

- the bundle format and bundle identity;
- the full Report digest;
- the benchmark scope and exact configuration ids;
- the material limitations; and
- the standalone verification command or a byte-preserving location of the
  complete directory.

Do not cite a badge, card, or headline as if it were the full result. A `wilson@1`
report states no comparative winner. A `paired-delta@1` full report spells out the
candidate-minus-baseline direction and presents the estimate, interval or withheld
state, exact alpha, and paired Task count together. Its compact badge, social card,
and share text contain no result number and link relatively to `index.html`; they are
signposts to the full report, never alternate conclusions.

Every paired Report also carries a limitation stating that the method estimates an
effect but does not gate one: no verdict, threshold, or selection was registered.
That limitation stays separate from power or minimum-detectable-effect disclosures;
an interval withheld for insufficient pairs or clusters is not the same claim as a
completed interval whose sensitivity is below a target effect.

## Freeze-artifact repository

A sealed bundle is digest-addressed; a human audience clones, browses, and diffs a
repository. `colophon freeze-repo export --bundle <dir> --out <dir>` projects a
qualification bundle's freeze artifacts into one, and
`colophon freeze-repo verify --bundle <dir> --repo <dir>` checks a published tree
against the bundle it claims to be derived from.

The export accepts the closures that carry the qualification graph, and only those:
`benchmark-product-public-bundle/4`, `benchmark-product-public-bundle/7`, and
`benchmark-product-public-bundle/8`. Every other closure is refused rather than
projected into an empty repository. The accepted set is a table keyed by every
supported bundle format, so a new closure version cannot land without stating what
it means to this projection.

A `/8` bundle's freeze artifacts are a `/7` bundle's exactly. The sealed
disclosure-specification record that closure adds is claim-side — it states the
variables that produced the score, and its `disclosure-specification` evidence role
is not a freeze-artifact role, so it stays in the bundle a reader verifies, where
that bundle's own `disclosure-specification` check reads it. The tree rendered from
such a bundle says so in its generated `README.md`; a tree rendered from a closure
that carries no such record is byte-identical to what it always was.

The repository is a **derived artifact**, not the claim of record — the same
doctrine the Inspect View export carries. The sealed records remain the sole
source of truth; what the projection adds is that the derivation is a function
rather than a hand assembly, so a published tree cannot drift from the bundle
without the check saying so.

The format is `colophon-freeze-repo/2`, and the determinism claim is stated for
it exactly: for a given format version the rendered tree is a pure function of the
bundle bytes. No clock, no locale, no filesystem enumeration order, and no tool
version reaches the tree. A renderer change is therefore a format bump, not silent
drift.

The layout:

- `freeze.json` — every rendered path with its byte length and SHA-256, the
  publication's licence data, and the protocol identifier each role's records
  declare. It does not restate the source rows: those are carried byte for byte
  under `artifacts/source-manifest/` and rendered into `NOTICE` and
  `metadata/spdx.json`, and re-serializing schema-parsed objects here would make
  these bytes a function of the verifier's schema shape as well as of the bundle.
  It does not list itself: its own digest is not knowable before it is written.
- `bundle/` — `bundle.json`, `benchmark.json`, `evidence.json`, and
  `qualification.json`, copied byte for byte.
- `artifacts/<role>/<sha256>.<json|bin>` — the sealed freeze records, grouped by
  the evidence role the bundle's own catalog assigns. The extension is `.json`
  when the record's exact bytes parse as JSON and `.bin` when they do not; the
  stem is the SHA-256 of those bytes, so a file's name is its own check. The freeze artifacts are the
  admission/qualification graph: the item bank and its sources, the admission
  decisions and their ledger, label resolutions, analysis contexts, judge
  instruments, and the human-review and screening material including the sampling
  script. The Run/Matrix/Report execution graph is deliberately absent: that is the
  claim, and the claim belongs in the bundle a reader verifies. Two later catalog
  roles are absent for the same reason rather than by oversight: `snapshot-probe`
  is the pre-run snapshot-serving probe sealed alongside the runtime-selection
  manifest, which evidences how the Run's arms were served, and
  `disclosure-specification` hangs off the Report extension. Both are execution
  evidence that merely arrives later in the catalog's frozen append order. The
  carried and excluded role lists are asserted to partition the catalog, so a role
  appended there fails the suite until it is placed in one of them.
- `LICENSE`, `NOTICE`, `metadata/spdx.json` — generated from the bundle's licence
  data, never hand-written. The publication licence is the SPDX identifier the
  sealed Benchmark record declares; the per-source attribution and licence
  descriptors come from the sealed source-manifest rows. `LICENSE` states the
  identifier, and where the SPDX list can carry it the list address for that
  identifier, rather than reproducing licence text the bundle does not carry.
  `NOTICE` carries the modification notice, and it states the
  fact rather than inverting it: the bundle carries no upstream source bytes at
  all, so no member is an unmodified upstream copy. Every member under
  `artifacts/` is a Colophon-authored or Colophon-derived sealed record over
  sources the manifest names by URI and digest. The declared licence must be an
  SPDX licence expression: the export checks it against the SPDX 2.3 Annex D
  grammar, so free text is a refusal rather than a rendered
  `SPDX-License-Identifier:` line, while an ordinary dual licence
  (`Apache-2.0 OR MIT`) is accepted. The grammar is not the SPDX licence list, and
  the export deliberately does not carry a list that would date — so `LICENSE`
  cites the SPDX list address for a single identifier and says in as many words
  that an identifier the list does not carry will not resolve there. A
  `LicenseRef-` identifier, which SPDX defines as off-list, gets no address at
  all, and neither does a compound expression, which names no one list entry. The
  publication's `name`, `version`, `author`, and `citation` are spliced into these
  generated files verbatim, so each is refused if it carries a control character
  or line separator — C0, DEL, all of C1, `U+2028` and `U+2029`, since a
  licence scanner breaks lines on more of those than JavaScript does — or a line
  that would read as a second `SPDX-…:` tag. In `metadata/spdx.json` a
  source `downloadLocation` that is not a remote URL, and an `author` that is a
  scheme-qualified machine identifier rather than a supplier name, both report
  `NOASSERTION` rather than stating something the record does not support.
- `README.md` — the doctrine, the layout, and the check.

The tree's **git commit hash is the value a freeze announcement pins**. It is
computed in-process from the rendered tree with a fixed identity and a zero
timestamp, so it is a function of the bundle rather than of the machine that ran
the export. Both verbs report it, and the generated `README.md` carries the exact
recipe that commits the tree to that oid:

```sh
export GIT_AUTHOR_NAME=Colophon GIT_AUTHOR_EMAIL=freeze@colophon.invalid
export GIT_COMMITTER_NAME=Colophon GIT_COMMITTER_EMAIL=freeze@colophon.invalid
export GIT_AUTHOR_DATE='@0 +0000' GIT_COMMITTER_DATE='@0 +0000'
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git init --quiet && git add -A -f
git commit --quiet --no-gpg-sign -m 'Colophon freeze <identity>'
```

The configuration neutralization is part of the recipe, not hygiene around it: a
reader's own `commit.gpgsign` adds a `gpgsig` header, `core.autocrlf` rewrites the
bytes, `init.templateDir` and `core.hooksPath` run code, and a `core.excludesFile`
matching `*.bin` makes `git add -A` silently drop every record under `artifacts/`.
Each yields a different oid, the last of them with nothing said. The renderer's own
parity test neutralizes exactly these, and the published recipe states the same.

Every member is mode `100644`. An executable bit, or a member replaced by a
symlink, changes what git records and therefore the pinned commit even though the
bytes read back identical — so `freeze-repo verify` reports both as drift, and it
treats a nested `.git` directory as ordinary content, skipping only the root one.
The symlink half holds everywhere. The executable-bit half holds wherever the
filesystem carries the bit, which the check establishes by probe rather than
assumption; where it does not, or where the probe cannot be run, the mode
dimension is dropped and `executableBitChecked` says so.

The standalone verifier package checks a published tree with no product install:
`colophon-verify <bundle> --freeze-repo <dir>`, exit `1` on drift.

A bundle with no qualification graph has no freeze artifacts, and a Benchmark
record that declares no licence has no licence data to generate scaffolding from.
Both are refusals, not empty repositories.

## Trust, privacy, and limitations

The public keys prove that bundle-carried signatures match the workspace-minted
identities. They do not prove third-party custody or real-world party
independence. Local execution provides reproducibility and preregistration
discipline, not proof of owner honesty. Evaluator majority is not truth, and a
Report is not certification or a universal ranking.

The bundle is intentionally **non-confidential**. Publication authorizes the
fixed public closure. Mutable drafts, grants, audit state, scratch files,
environment data, absolute workspace paths, credentials, and private PEM keys
are excluded, but authenticated Task, Delivery, verdict, Report, and claim
content is public. This is not a generic PII scanner, malware scanner, or
arbitrary-content sanitizer.

Inspect-backed drafts fail publication unless the caller explicitly approves
including native artifacts. That approval includes complete Inspect logs and
transcripts; it is never inferred from locking, launching, reporting, or an
earlier preview.

Filesystem and semantic integrity checks do not protect against a privileged
actor rewriting the running process, memory, or storage after verification.
Distribution must preserve every byte and path. Adding a hosting marker or
editing HTML invalidates the manifest; hosting, permanence, TLS, access control,
and availability remain responsibilities of a future separately authorized
distribution system, not this bundle format.
