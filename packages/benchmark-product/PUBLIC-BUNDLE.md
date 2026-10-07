# Public benchmark bundle

The frozen format is `benchmark-product-public-bundle/2`. It is an immutable,
digest-addressed directory containing a Report, the exact evidence needed to
check it, public trust material, and five deterministic presentation assets.
Its evidence remains verifiable after the originating product workspace and
private keys are gone.

The served public archive may also contain `/lock-index.json`, a generated
listing of that workspace's announced locks with archive paths and carried
anchors. The index is rewritten on regeneration; everything it points at is
immutable. It is never a bundle member and is never part of portable
verification. See
[Serving the Colophon announcement source](../../docs/runbooks/colophon-announcement-source-serving.md).

`publish` means local immutable emission, not hosting. It does **not** upload, host, deploy,
register, release, or write remotely. Deployment status is none.

## Reader vocabulary

This document quotes contract spellings. The table maps each contract term to the
reader-facing name that
[`docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md`](../../docs/superpowers/specs/2026-09-02-reader-facing-vocabulary.md)
§5 rules for reader surfaces. That is the ruled vocabulary, not a record of what every
surface prints today: a generated report page or other checker output may still print an
older label until its rename lands. Body text below keeps the contract spellings.

| Contract spelling | Reader-facing name |
| --- | --- |
| `benchmark-product-public-bundle/N` | bundle |
| `arm`, `armId` | configuration |
| `cell`, `cellKey` | run |
| `replicate` | repeat |
| `Matrix`, `matrix.json` | the runs |
| `Report`, `report.json` | the result |
| `claim-package.json` | the claim |
| `method.id` (`jinn.benchmarking.method/…`), `method.version` | method |
| `preregistered` | preregistered |
| `records/<sha256>.bin` | evidence file |
| `instrument`, evaluator | judge |
| `conflicted`, assembly dissent | runs the judges disagreed on |
| `disagreements` (pairwise-disagreement) | decided differently |
| `sha256`, digest | fingerprint |
| `anchor` | timestamp proof |
| `verify`, `verification.checks` | recompute |
| `venue` | where it ran |
| `venueHonesty` | who ran this |
| `disclosure`, six-variable disclosure | what was pinned |
| `qualification.configuration` | how the judges were qualified |
| `instability` | answer changed on rerun |
| `parserInvalid`, `parser-invalid` | answer could not be read |

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
`verification.command` rather than inferring it from the format string.

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
screening was prompted pins `@0.2.1` instead, with `@0.2` as the compatible line
and `@0.1` refusing outright. `0.2.1` accepts the historical `@0.2.0` command as
well as its own, so the compatible line reads a prompted v4 materialized before
`0.2.1` existed too:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir>
```

The format string does not record that difference — prompted screening is a
fourth axis, and only anchoring, qualification, and disclosure select the format
— so take the line from the claim package's own `verification.command`, or read
`method.parameters.promptedScreeningProfile`, which is
`"prompted-codex-screening/v1"` on a prompted bundle and absent otherwise. The
refusal a prompted v4 earns from a reader too old for it is not v7's: v7 is
refused on the format, before the claim is read, while a prompted v4 is a format
`0.1.0` and `0.2.0` both support and is refused on the claim inside it. That
case is described in
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

**The two lines above are an exact pin and a range.** `@0.2.1` names one
release, for byte-for-byte reproduction. `@0.2` names the newest `0.2.x`
release at the time it is run; it reads a v7 bundle through any `0.2.x` from
`0.2.1` on, since a newer reader keeps every earlier format, and refuses one
through `0.2.0`. An explicit `@0.2.0`, and any line at `@0.1`, refuses a v7
bundle with the version-mismatch described in [Reading a bundle with a reader
that is too old](#reading-a-bundle-with-a-reader-that-is-too-old), which is a
fact about the reader and not a verdict about the bundle.

The installed product exposes the same reader implementation,

```bash
colophon bundle verify --bundle <bundle-dir> --json
```

but it is the longer route rather than the fallback: the `npx` line above needs
nothing installed, while the product verb needs the product itself, and how
that is obtained is stated in the product [`README.md`](README.md). The
product verb also takes no trust-material flags and passes none, so under it a
well-formed anchor reports `present` and never `verified`; only the `npx` reader
can carry an anchor further.

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
bundle instructs its readers to use, so **nothing may publish a metadata-first bundle until its
claim package pins a reader release that declares the profile** — a claim naming a reader that
cannot read it is an instruction to fail. That rule is satisfiable rather than closed:
`@colophon-claims/verify@0.2.1` lists the metadata-first profile among the ones its manifest
parse accepts; `@0.2.0` and every earlier line refuse a metadata-first bundle there. What a `/5`
producer writes today still does not satisfy the gate:
`PUBLIC_BUNDLE_V5_COMPATIBLE_VERIFICATION_COMMAND` — the one line a `/5` claim states, since
claim-package/3 has a single `command` field — resolves to the `@0.1` line, and there is no
metadata-first-specific command constant, so a metadata-first bundle whose claim pins `@0.1`
remains an instruction to fail. The gate is open and unexercised — the profile is a format
definition and a local derivation of an already-published full-evidence bundle, and no producer
emits one. The local viewer, which is the one surface that can be pointed at a hand-derived
metadata-first bundle, offers the local `colophon bundle verify` command; a reader handed such a
bundle can also run `npx @colophon-claims/verify@0.2.1 <bundle-dir>`.

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
v6. The two lines are the pin and the range stated for v7, and they behave the
same here: `@0.2.1` and `@0.2` both read a v8 bundle, while an explicit `@0.2.0`
refuses one with the same version-mismatch refusal it gives a v7 one. `colophon
bundle verify --bundle <bundle-dir> --json` wraps the same reader; as for v7, it
is the longer route, and the product [`README.md`](README.md) states how the
product is obtained.

### Composed bundle v10

`benchmark-product-public-bundle/10` is the composed generation. Every earlier
closure says what it carries by its format number, so each new pairing of
features cost a new number, a new member list, a new check array, and a new
claim-package id. A v10 bundle **states** what it carries instead. Its
`bundle.json` is v2's --- `format` and `files` --- plus one required member, the
capability vector:

```json
{
  "capabilities": ["anchoring", "binary-qualification"],
  "files": [{ "bytes": 0, "path": "...", "sha256": "..." }],
  "format": "benchmark-product-public-bundle/10"
}
```

The vector is a list of lower-kebab tokens, unique and sorted by code unit. It
may be empty: `"capabilities": []` is the plain base graph, spelled rather than
omitted. The manifest object is closed, so an unknown top-level member is
refused. `bundle.json` is the authenticated root, so the vector is exactly as
tamper-evident as the file list beside it: editing it changes the bundle
identity.

Every token is **must-understand**. A reader that does not implement a token in
the vector refuses the bundle whole, naming the token, before it reads any
member. There is no tier of tokens a reader may ignore.

Seven capabilities are registered. Each one's members, checks, and claim section
are exactly what the closure it came from carries, except `external-import`,
`task-selection`, `owner-controlled-publication`, and
`terminal-bench-2-1-comparability`, which are new with this generation:

| Token | Adds | Check it appends | Claim section |
| --- | --- | --- | --- |
| `binary-qualification` | `qualification.json`, and the v4 grammar for `evidence.json` and `trust/public-keys.json` | none --- it expands the existing checks, as v4 does | `qualification` |
| `anchoring` | `anchors/<sha256>.bin`, which may be empty under the declared-but-absent rule stated for v6 | `integrity-anchors` | `anchors` |
| `disclosure-specification` | no member of its own; the sealed record travels at `records/<sha256>.bin`, named by the Report extension stated for v8 | `disclosure-specification` | `disclosure` |
| `external-import` | `external-import.json`, the dump digest plus one row per sealed Matrix cell | `external-import` | `externalImport` |
| `task-selection` | no member of its own; the declaration is the Run's `task-selection/v1` extension, and the report face states it as a header fact row (see [Task-selection provenance](#task-selection-provenance)) | none; its refusals run under `claim-consistency` | `taskSelection` |
| `owner-controlled-publication` | no member; a sixth sealed venue sentence, stated below | none; `claim-consistency` rebuilds the sentence and the section | `ownerControlledPublication` |
| `terminal-bench-2-1-comparability` | no member; one sealed sentence in the Report limitations, stated below, for a run imported onto the official Terminal-Bench 2.1 slate | none; `claim-consistency` checks the Benchmark against the pinned slate and rebuilds the sentence and the section | `terminalBench21Comparability` |

`disclosure-specification` requires `binary-qualification`, because the evidence
role that carries its record exists only in the v4 grammar. It does not require
`anchoring`. `terminal-bench-2-1-comparability` requires `external-import`,
because its sentence states a fact about an imported run.

Everything else is derived from the vector. The mandatory members are v2's plus
each declared capability's. The checks are v2's **six**, then each declared
capability's in the order of the table above --- so `["anchoring"]` runs v6's
seven and all three pre-composition tokens run v8's eight. The vector naming `anchoring` alone
is v6's closure exactly, the vector naming `anchoring` and
`binary-qualification` is v7's, and the vector naming those three is v8's.
`external-import`, `task-selection`, `owner-controlled-publication`, and
`terminal-bench-2-1-comparability` are additive and have no pre-composition cell.
`task-selection`, `owner-controlled-publication`, and
`terminal-bench-2-1-comparability` append no check, so a vector keeps its check
list with or without them.

`owner-controlled-publication` states where the publication source stands. The
[interoperability profile](../../docs/superpowers/specs/2026-08-13-benchmark-publication-interoperability-profile.md)
(section 9.3) requires a self-run publisher to disclose
that its publication source, not only its dispatch source, is owner-controlled,
and the five sealed venue sentences cover dispatch. A bundle that declares it
seals a sixth sentence right after the five, in the Report `limitations` (and so
in the claim's copy of them) and in `venueHonesty.limits`, and its claim carries
the same sentence as the `ownerControlledPublication` section:

> This venue's publication source is owner-controlled and has no witness: the owner holds its signing key and hosts its archive, so it can rewrite what it published before a reader first fetches it, and only a reader who kept an earlier copy can detect a later rewrite.

It composes with the other rewrites of the venue sentences: on an imported run
it follows the import-aware five, and on an anchored run the anchor lines follow
it. A bundle that does not declare the capability keeps the five sentences byte
for byte: every earlier format, and a v10 bundle whose vector omits it.
`claim-consistency` refuses the sentence in the Report, the venue sentences, or
the claim without the declaration, and the declaration without the sentence in
each of them.

`terminal-bench-2-1-comparability` is declared by a run that was made outside
this product, imported from a Harbor jobs directory, and bound to the official
Terminal-Bench 2.1 slate with `method terminal-bench-2.1`. Such a run cannot show
that it met the leaderboard's protocol: this product did not run it, and no
record in the bundle establishes the conditions it ran under. So its signed
Report carries one more limitation, once, after the venue sentences and any
binary-instrument lines and before the paired-estimate line, and the claim's
`limitations` copy it:

> This run is not a Terminal-Bench 2.1 leaderboard submission: it was run outside Colophon and imported from a Harbor jobs directory, and nothing in this bundle shows that it met the leaderboard's protocol. The pass rate is taken over the cells that reached a pass or fail verdict. A trial with no reward is left out of that rate and counted in the accounting, so the rate can be higher than Harbor's mean for the same job, which counts such a trial as 0.

The claim's `terminalBench21Comparability` section carries the slate facts a
reader of the claim needs, each one projected from the Benchmark's
`official-suite-slate/v1` extension after the checker has verified it, and the
sentence again:

| Field | Meaning |
| --- | --- |
| `datasetId`, `datasetRevision` | the dataset, and the revision of it the leaderboard pins |
| `upstreamCommit` | the commit of the dataset's source repository where the official task list was read; it does not identify a task package's bytes, which the package ref does |
| `slateDigest` | the digest of the slate: every official task name with its package ref |
| `coverage` | `one_task`, `ten_task`, `full`, or `custom`, recomputed from the selected names |
| `selectedTaskCount`, `datasetTaskCount` | how many of the dataset's tasks this Benchmark carries |
| `limit` | the sentence above |

The upstream commit and the package refs say two different things. Each official
Task seals both, as `payload.upstreamCommit` and `payload.packageRef`, and the
Benchmark's extension seals the repository and the commit. The commit names
where the task list was read: the 89 task names, in slate order, are the entries
of `tasks/dataset.toml` in the dataset's source repository at that commit, and
the dataset revision is the one that repository's leaderboard code pins there. A
package ref is the content hash Harbor gives the package it publishes for that
dataset revision. It is the value a Harbor trial records, and it is what
identifies a package's bytes.

The two agree for 88 of the 89 tasks and differ for one. For 88 tasks the
repository at the upstream commit lists the same ref and holds the same files as
the published package, once the `.gitignore` at the root of each task directory
in the repository, which Harbor does not publish, is left out. For
`sanitize-git-repo` one file differs, `tests/test_outputs.py`: the repository
writes five placeholder credentials as two joined string literals each, and the
published package writes each as one literal, 25 bytes fewer in all. So the
repository at that commit lists
`sha256:73c94a21ebe370bae843adbeeaaa9e991374867b18483aaf56c7cd470dcddea7` for
that task, and the slate pins
`sha256:6e86297715fae62cd499fbdd27013e11a38d05d7e05b7f661cb50b4ecead128f`, the
package Harbor publishes and runs. A reader who hashes the repository's task
directories at the upstream commit by Harbor's rule, leaving out the
`.gitignore` at the root of each task directory and nothing else, reproduces 88
of the slate's refs and not that one. One package, `install-windows-3.11`,
publishes a nested `environment/isos/.gitignore`; that file stays in.

A bundle is on the official slate because its records are, not because its
vector says so. The checker carries its own copy of the slate: the dataset
constants and, for each of the 89 official tasks, the SHA-256 of the Task record
this product seals for it. A declaring bundle is refused under
`claim-consistency` unless its extension equals those constants, its selected
names are distinct official names, its coverage word is the one those names
recompute to, each Benchmark item is the pinned Task of the name in the same
position, and its import marker names `harbor` as the source. A Task digest
covers the Task's profile, payload, instructions, author, outputs, and the
digest of the EvaluationSpec it binds, so one comparison per item settles which
Task it is. The checker requires the marker to name Harbor. It cannot prove that
a Harbor process wrote the rewards.

The same pin settles how each cell is scored. Each official Task binds an
`external-verifier` EvaluationSpec, the grader family of proposal 0002
(`proposals/0002-external-verifier-grader-family.md`), and that spec names the
task package as the grader by the content hash Harbor gives it, the package's
own `tests/` files by digest, the image reference and verifier timeout the
package declares, and the verdict rule over Harbor's `reward`. A spec that
passed at another reward, named another package, or belonged to another grader
family would have another digest, so its Task would be off the pin and the
bundle refused. The spec states an image reference as the package declares it,
which is a tag. It pins no image, no platform, and nothing the verifier
downloads when it runs.

The rule passes at a reward of 1, fails at 0, and answers inconclusive for any
other value. The threshold is not this product's choice. Every one of the 89
task packages ships a verifier script, `tests/test.sh`, that writes `1` to the
reward file when every exit code it checks is zero and `0` otherwise, in one
place, and no other file under the package's `tests/`, `environment/` or
`solution/` directory names a reward file.
`core/scripts/generate-terminal-bench-2-1-verifier-pins.mjs` asserts that of
every package before it writes the values the specs are sealed from, and
`core/test/fixtures/terminal-bench-2-1-packages/manifest.json` lists every
package file by path and SHA-256, so the chain from a spec's digests to the
slate's package refs can be recomputed without the packages. The manifest lists
the packages as Harbor publishes them for the pinned dataset revision, which is
what the package refs name. It does not list the repository's files at the
upstream commit, which differ for one task as stated above.

Each spec names one required evidence reference, `trial-result.json`. That is
the name under which the Harbor reader carries the `result.json` Harbor wrote
for the trial, the file that holds Harbor's raw reward map. This checker
recomputes each verdict from the sealed measurement. It does not read the
reward back out of that file, and it does not require a cell to carry it.

The capability is bound to the records both ways. A v10 bundle whose Benchmark
carries the extension for Terminal-Bench 2.1 and whose vector declares
`external-import` must declare it, and a bundle declaring it must be both.
Either mismatch is refused on the vector. The sentence in a Report whose bundle
does not declare it is refused, and so is a declaring bundle whose Report omits
the sentence, repeats it, or seals it anywhere but its slot. A run on the slate
that was not imported declares nothing here, and its bundle is unchanged.

The report page of a declaring bundle names its tasks. The task-by-task
comparison labels each task by its official name, read from the sealed Task's
`taskName`, and states the dataset with the first 12 hexadecimal digits of the
dataset revision and of the task's Harbor package ref. Each cell is headed by
the task's name and states its verdict, and its score is the `reward`
measurement when every verdict on the cell carries the same one. A cell with no
verdict states neither. This naming is keyed on the verified
`terminalBench21Comparability` section, never on the Task's profile. So a bundle
that does not declare the capability renders the page it rendered before, with
each task labelled by its Task digest: every earlier format, and a slate run
this product drove itself.

The same page says how much of the dataset the run covers, before it states any
rate. `index.html` carries a `Tasks` fact in its header, directly under the
scope line, reading `<selected> of the <dataset count> in Terminal-Bench 2.1`,
for example `3 of the 89 in Terminal-Bench 2.1`, or
`all 89 in Terminal-Bench 2.1` when the Benchmark carries every task of the
dataset. `README.md` carries the same words as one line under its scope line,
`Tasks: 3 of the 89 in Terminal-Bench 2.1.`, and `share.txt` carries that
sentence directly after its scope. Both numbers are the verified section's
`selectedTaskCount` and `datasetTaskCount`, and nothing else is read. A page
without the section carries no such line. The badge and the social card do not
carry it.

The same page names its rate by what was judged, and every v10 page states no
rate where nothing was. On a declaring bundle the rate column of the per-arm
tables reads `Terminal-Bench 2.1 accuracy` only when the Benchmark carries all
89 tasks of the dataset and every arm's judged `n` equals its planned slots and
is not zero. Otherwise, a slice included, it reads `Pass rate over judged
cells`, and a page without the section keeps `Pass rate`. The comparison is
against the rate's own denominator and never the Matrix's judged count: a cell
whose reward is neither 0 nor 1 carries a valid `inconclusive` verdict, which
the Matrix counts as judged and `wilson@1` leaves out of the rate. The Report
table and the Claim table are each named from their own record. Separately, on
every v10 page, declaring or not, a `wilson@1` arm whose judged `n` is 0 prints
`No rate is stated` for its rate and `Not stated` for both interval bounds, and
the adverse facts on the page and in `README.md`, and `share.txt`, each say
`No rate is stated for arm <arm id>: none of its cells reached a pass or fail
verdict.` The sealed `0.0000` strings stay in `report.json` and
`claim-package.json`, because the claim package schema requires them, and only
what is shown changes. The badge and the social card carry no rate and do not
move, and every format before v10 prints the sealed strings.

Declaration is authoritative, and presence is derived from it, never the
reverse. A member of a capability the vector does not declare --- an
`anchors/...` file, a `qualification.json` --- is a non-allowlisted file. A
declared capability whose members were stripped fails as a missing member.
Stripping a declaration never produces a quieter bundle that still passes; it
produces a different bundle identity that is refused. `task-selection` has no
member to strip, so it is bound to the Run instead: a v10 bundle whose Run
carries `task-selection/v1` must declare it, and a bundle declaring it must have
a Run that carries it. Either mismatch is refused on the vector.

Its claim package is `benchmark-product.claim-package/7`, one id for every
vector: `claim-package/1`'s base plus one section per capability, present
exactly when the capability is declared. `claim-consistency` rebuilds the claim
from the vector `bundle.json` declares, so a section without its declaration and
a declaration without its section are both refused on the field that disagrees.
Section contents are unchanged from the closures they came from, and
`qualification.json` keeps its frozen `benchmark-product.claim-package/2`
literal. The claim's `verification.checks` is the derived check list, and its
reader line is the latest release any declared capability needs.

The report page is byte-pinned: `verifyPublicBundleSnapshot` rebuilds every
presentation asset and refuses the bundle on any mismatch, and every published
claim seals the exact reader line that performs that rebuild. Changing a
rendered string in place would therefore break every already-published bundle
under the command printed on its own page, which is why a prose revision took a
format number rather than an edit. What v10 renders is the four report-prose
rulings of issue #3016: each of the page's statements is made once, in the
highest-priority slot that carries it, and the narrated control above the
per-cell disclosures is cut. No disclosure the v6 page carries is absent from
the v10 page. Later presentation features register as presentation capability
entries inside this generation rather than taking a further format number.

v10 pins neither v6's first public `@0.1` line nor the `verify` `0.2.1` line v7
and v8 pin: both readers predate the format and refuse it at manifest parse, so
a claim naming either would be an instruction to fail. Every vector registered
today pins the first `@colophon-claims/check` release, `0.2.1`, under the
checker's own name, with the checker's `@0.2` as the compatible line. That line
covers no release before `0.2.1`, so it names no reader that refuses v10:

```bash
npx @colophon-claims/check@0.2.1 <bundle-dir>
```

A v10 bundle that declares `anchoring` takes the trust-material form too:

```bash
npx @colophon-claims/check@0.2.1 <bundle-dir> \
  --tsa-root ./authority-root.pem \
  --ots-headers ./bitcoin-headers.txt
```

`--tsa-root` and `--ots-headers` carry the meaning and the defaults stated for
v6.

**New bundles emit v10.** Decision D1 is a clean cutover: the `report` operation defaults to
the composed generation, so a run that does not ask otherwise publishes on
`benchmark-product-public-bundle/10` with the capability vector derived from the run's own
facts: an anchored run declares `anchoring`, a run projecting a binary qualification
declares `binary-qualification`, a qualification run with a sealed disclosure
declaration declares `disclosure-specification`, anchored or not, a run whose
evidence was imported (`run import`) declares `external-import`, a run that sealed a
task-selection declaration at lock declares `task-selection` on every bundle it publishes, and
a run imported onto the official Terminal-Bench 2.1 slate declares
`terminal-bench-2-1-comparability`. Every run declares
`owner-controlled-publication`, imported runs included: this product publishes only
from its self-run venue, whose workspace mints the key that signs the Report and whose
owner hosts the bundle. The enumerated v2, v4,
v6, v7, and v8 producer paths remain behind `composedFormat: false` on `report` --- that is
the rollback. The verifier's legacy path for those formats remains forever.

The `verify` `0.2.1` reader is immutable and predates this format, so it refuses v10 at
manifest parse --- which is why a v10 bundle's sealed instruction names the checker's
`0.2.1` instead. One run is treated differently, not only renumbered: a qualification run with
a sealed disclosure declaration and no anchor is refused at `report` on the rollback path,
because v8 is the only disclosed enumerated cell and it is anchored, and on the default
composed path it is admitted and declares `binary-qualification` and
`disclosure-specification`.

## Portable verification

Verification with your own tools — no Jinn code at all — is specified in
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md), split by format. For
`benchmark-product-public-bundle/2` that document names the check split, the
DSSE and digest rules, the JSON Schemas shipped under the reader package's
`schemas/`, and the conformance kit under
`check/fixtures/public-bundle-conformance-v1/` whose tampered variants an
external verifier must reject. For `benchmark-product-public-bundle/5` those
`/2` artifacts do not apply: see
[Evidence-native bundle v5](EXTERNAL-VERIFICATION.md#evidence-native-bundle-v5)
for the seven-check table and the two `npx` lines. There is no v5 key-format or
binding recipe, no walkthrough, and no `external-verify.py` coverage.

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
| `benchmark-product-public-bundle/2`, prompted screening | `@0.2.1` (`@0.2.0` on a bundle materialized before `0.2.1` existed) | `@0.2`; `@0.1` also verifies, since claim-package/1 states no reader requirement | six | not applicable |
| `benchmark-product-public-bundle/4`, unprompted | `@0.1.0` | `@0.1` | six | not applicable |
| `benchmark-product-public-bundle/4`, prompted screening | `@0.2.1` (`@0.2.0` on a bundle materialized before `0.2.1` existed) | `@0.2`, which reads either pin; `@0.1` refuses | six | not applicable |
| `benchmark-product-public-bundle/5` | `@0.1` | none pinned | seven | not applicable |
| `benchmark-product-public-bundle/6` | `@0.1.0` | `@0.1` | seven | `--tsa-root`, `--ots-headers` |
| `benchmark-product-public-bundle/7` | `@0.2.1` | `@0.2` | seven | `--tsa-root`, `--ots-headers` |
| `benchmark-product-public-bundle/8` | `@0.2.1` | `@0.2` | eight | `--tsa-root`, `--ots-headers` |
| `benchmark-product-public-bundle/10` | `@colophon-claims/check@0.2.1` | `@colophon-claims/check@0.2` | six to nine, by declared capability | `--tsa-root`, `--ots-headers`, when `anchoring` is declared |

Prompted screening is why the format string is not sufficient for the first four rows. It is a
fourth axis: the format is selected by anchoring, qualification, and disclosure only, so a
prompted run emits `.../2` or `.../4` exactly as an unprompted one does while pinning a later
reader. What distinguishes it is inside the claim package: its
`method.parameters.promptedScreeningProfile` is `"prompted-codex-screening/v1"` on a prompted
bundle and absent otherwise. That is the second reason to take the line from the claim package
rather than from the format.

Every row but `.../10` runs as `npx @colophon-claims/verify<line> <bundle-dir>`. The `.../10` row
states its package in full and runs as `npx <line> <bundle-dir>`. Append the anchor flags where
the row lists them.

From `@colophon-claims/check@0.2.1` on, the reader's report names the run it checked: under
`Format:` it prints a `Run:` line, on every format but `.../5`. The `verify` releases the earlier
rows pin print no such line; for those, compute the value yourself with `shasum -a 256 run.json`.
The value is the SHA-256 of the bundle's `run.json`, as 64 hex characters, and it is the digest
`lock` printed when the method was sealed. A claimant who made that digest public before the run
gives a reader something to hold this line against.
[`CLAIMANT-WALKTHROUGH.md`](CLAIMANT-WALKTHROUGH.md) has that step, and every other command of a
run brought from Harbor.

Every row above but `.../10` names `@colophon-claims/verify`, because that is the name those
formats sealed. `.../10` is the first format sealed under the checker's own name,
`@colophon-claims/check`. A bundle's reader line is the one its own format sealed; run the line
the row lists for that format, not a renamed successor.

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

**This binding is a `0.2.1` guarantee.** An earlier reader does not make the relabeled bundle
verify: `0.1.0` and `0.2.0` still stop the `.../7` and `.../4` downgrades, because their
presentation projection dispatches on the sealed Report's method too and finds a binary Report
where the comparison profile was expected. But they stop it as an untyped crash from the last step
of the run rather than as this named refusal, so do not read a missing
`record-integrity`-at-`bundle.json` signature on an older line as the check not having fired.

**`@0.2.1` is a pin and `@0.2` is a range.** The `0.2.1` reader that public-bundle/7,
public-bundle/8, and every prompted bundle pin reads public-bundle/2, /4, /5, /6, /7, and /8.
`@0.2.1` names exactly that release. `@0.2` names the newest `0.2.x` release at the time it is
run: through any release from `0.2.1` on it reads at least that set, since a newer reader keeps
every earlier format, and through `0.2.0` it stops at the `0.2.0` support set. `colophon bundle
verify --bundle <bundle-dir> --json` wraps the same reader; the `npx` line needs nothing
installed, and how the product itself is obtained is stated in the product
[`README.md`](README.md).

An explicitly pinned `@0.2.0` is the reader too old for a `@0.2.1`-pinned bundle, and a
prompted /4 fails differently under it from a /7 or /8. `0.2.0` supports the /4 format and carries
the prompted-screening branch, so it parses `bundle.json`; what it requires of claim-package/2 is
the command `@0.2.0` exactly, so it accepts a prompted bundle materialized before `0.2.1` existed
and refuses a newer one on the claim, with `binary claim package must pin verifier 0.2.0/@0.2`.
That is a reader-too-old refusal, not a fact about the bundle. `0.2.1` accepts both commands, so it
refuses neither. A prompted /2 is refused by no line at all: claim-package/1 carries no reader
requirement, so even `@0.1` verifies it while the bundle's own assets name `@0.2.1`.

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
who runs `@0.1`, or an explicitly pinned `@0.2.0`, against a public-bundle/7 or public-bundle/8
bundle sees exactly this, and the bundle is fine. The `@0.2` range produces it only through
`0.2.0`; from `0.2.1` on it reads both formats. The `verify` `0.2.1` line and every line before
it refuse a public-bundle/10 bundle the same way, which is why its claim pins `check@0.2.1`.

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
`binary claim package must pin verifier 0.2.0/@0.2` under an explicitly pinned `@0.2.0`. The `@0.2`
range is one of them only through `0.2.0`; from `0.2.1` on it accepts that claim. A refusal that
names the pinned verifier is that mismatch, not a fact about the bytes. Before treating any
refusal as a failing bundle, check that the line you ran is the one the claim package's
`verification.command` names.

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

**On v10 the declaration is on the report face, at headline weight.** The
composed generation carries it as the capability `task-selection` (issue #3416,
operator ruling of 2026-09-24). A run whose Run carries `task-selection/v1`
declares the capability on every bundle it publishes. The bundle's
`claim-package/7` then carries a `taskSelection` section holding the declared
mode, `{ "mode": "claimant-chosen" }`, and the report face states that mode as
a header fact row, printed as its own token so a claimant-chosen selection reads
`claimant-chosen`:

- `index.html` renders a `Task selection` fact directly under the scope line in
  the page header;
- `README.md` renders `Task selection: claimant-chosen.` directly under its
  `Scope:` line;
- `share.txt` renders the same sentence directly after the scope.

`badge.svg` and `social-card.svg` do not carry it: their layout is fixed, and
each links to the page that does. The declaration adds no member and no check,
and the claim pins the same reader line, `@colophon-claims/check@0.2.1`, as the
undeclared vector.

On v10 the declaration cannot be hidden. The verifier binds the vector to the Run both
ways and refuses either mismatch on `bundle.manifest.capabilities`, before any
check runs:

- a v10 bundle whose Run carries `task-selection/v1` but whose vector does not
  declare `task-selection` is refused, so a bundle cannot pass while hiding who
  chose its tasks, even with the claim section and the header row stripped to
  match;
- a v10 bundle declaring `task-selection` over a Run that carries no
  declaration is refused, because there is nothing for the section or the row
  to state.

`claim-consistency` rebuilds the section from the sealed Run, never from the
claim under test, so a section naming another mode is refused on
`taskSelection.mode`. The report face is byte-compared like every other page, so
a page that drops or rewrites the row is refused on that asset.

**Earlier formats are unchanged.** On v2, v4, v6, v7, and v8, nothing about the
declaration reaches the published face: `index.html`, `README.md`, `share.txt`,
`badge.svg`, and `social-card.svg` are exactly what a reader that has never
heard of `task-selection/v1` rebuilds from the same records. (A declaring
bundle's Run *digest* still differs, as it would for any other Run field.) This is a compatibility
requirement rather than an editorial choice: each of those formats pins a reader
release that byte-compares every presentation asset against its own rebuild and
predates the row, so a bundle that rendered it would instruct its reader to run
a verifier that refuses it. Only `claim-package/7` carries a `taskSelection`
section, so their claims are unchanged, and so are the per-allocation checks on
their pinned reader lines. On those formats the declaration is
readable where it is sealed, in the Run record, and enforced where it is
checked, under `claim-consistency`.

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
`benchmark-product-public-bundle/4`, `benchmark-product-public-bundle/7`,
`benchmark-product-public-bundle/8`, and a `benchmark-product-public-bundle/10`
bundle whose capability vector declares `binary-qualification`. Every other closure
is refused rather than projected into an empty repository. The accepted set is a
table keyed by every enumerated bundle format, so a new closure version cannot land
without stating what it means to this projection; the composed generation has no
row, because what a v10 bundle means here is read from the vector it declares.

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
version reaches the tree. A renderer change that alters or withholds the tree an
already-acceptable bundle renders is therefore a format bump, not silent drift.
Opening the projection to a previously refused closure does not bump the format:
there is no prior tree for the new output to differ from.

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
  (`Apache-2.0 OR MIT`) is accepted. The grammar is not the whole licence check:
  an expression nesting parentheses more than 64 deep is refused as well, though
  it satisfies that grammar, because the renderer parses the expression by
  recursive descent and will not present a value it cannot parse — real
  expressions nest one or two deep. The grammar is not the SPDX licence list
  either, and the export deliberately does not carry a list that would date — so
  `LICENSE` cites the SPDX list address for a single identifier and says in as
  many words that an identifier the list does not carry will not resolve there. A
  `LicenseRef-` identifier, which SPDX defines as off-list, gets no address at
  all, and neither does a compound expression, which names no one list entry. The
  publication's `name`, `version`, `author`, and `citation` are spliced into these
  generated files verbatim, so each is refused if it carries a control character
  or line separator — C0, DEL, all of C1, `U+2028` and `U+2029`, since a
  licence scanner breaks lines on more of those than JavaScript does — or text
  that would read as a second `SPDX-…:` tag. That tag refusal is not line-shaped:
  a tag is refused wherever it sits in the value, in any casing, since the
  scanners that matter match case-insensitively; at any position on the line,
  since the short-form identifier is specified to live inside a source comment and
  so every reader that implements it accepts an arbitrary prefix; and separated
  from its colon by any Unicode whitespace rather than only a space or a tab. A
  tag mid-line in a single-line `name` is refused with no line terminator involved
  at all. The sealed source-manifest descriptors spliced into these generated
  files — `source.uri`, `license.uri` and `attribution.uri` into `NOTICE`,
  `source.name` into `metadata/spdx.json` — are held to that same rule, and
  refuse an embedded line terminator outright as well, unlike `citation`, which
  is legitimately multi-line: `NOTICE` renders each descriptor it carries as one
  fixed-column row, so a line break inside one would emit a second row-shaped
  line that no source-manifest row stands behind. In
  `metadata/spdx.json` a source `downloadLocation` that is not a remote URL, and
  an `author` that is a scheme-qualified machine identifier rather than a
  supplier name, both report `NOASSERTION` rather than stating something the
  record does not support.
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

The standalone checker package checks a published tree with no product install:
`colophon-check <bundle> --freeze-repo <dir>`, exit `1` on drift. `colophon-check` is the command
that package installs.

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
