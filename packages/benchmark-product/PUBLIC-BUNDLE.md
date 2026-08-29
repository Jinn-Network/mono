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

Anchored bundles pin the same first public line:

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

Anchored bundles return **seven checks**: the six above, in the same order,
followed by `integrity-anchors`. That check is always present for this format —
an anchored bundle whose anchors were stripped is a closure failure, not a
shorter list. An `invalid` anchor fails the whole verification; every other
status is a disclosed fact that prints and passes.

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
released reader before `0.2.1` understands the format, so its claim pins:

```bash
npx @colophon-claims/verify@0.2.1 <bundle-dir>
```

with `@0.2` as the compatible line. It returns the same **seven checks** as v6,
in the same order.

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
non-empty array whose entries each bind one normalized relative `path`, its lowercase `sha256`,
and its `bytes` length, sorted and unique by path. The bundle identity is the lowercase SHA-256 of
those exact manifest bytes. Missing, extra, reordered, duplicate, absolute, dot, parent, symlink,
hardlink, special-file, or changed members fail closed exactly as they do on v2.

Its stored claim is `benchmark-product.claim-package/3`: the v5 evidence graph is addressed from
`records.evidence` and `records.artifacts`, both sorted and unique, and its `verification.checks`
is the exact seven-name tuple above rather than the six-name one every v2-derived closure carries.
V5 carries no presentation assets — there is no `index.html`, `badge.svg`, `social-card.svg`,
`README.md`, or `share.txt` in the member list, so the asset byte-compare below has nothing to
compare and the citation rules about badges and cards do not apply to it.

A full-evidence v5 bundle stamps the same first public line as v2 and v4. Unlike the v2-derived
claim packages, `claim-package/3` carries one `verification.command` and no separate compatible
line, and what it pins is the compatible `@0.1` line:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

`@0.1.0` is the exact producer-side release inside that line, for byte-for-byte reproduction.

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

## Portable verification

Verification with your own tools — no Jinn code at all — is specified in
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md): the check split, the
DSSE and digest rules, the JSON Schemas shipped under the reader package's
`schemas/`, and the conformance kit under
`verify/fixtures/public-bundle-conformance-v1/` whose tampered variants an
external verifier must reject.

Use the smaller reader package, without the product or source workspace:

```bash
npx @colophon-claims/verify@0.1 <bundle-dir>
```

Claim-package/1, claim-package/2, claim-package/3, public-bundle/2, public-bundle/4, and
public-bundle/5 stamp the same first public line: `@0.1.0` / `@0.1`. Public-bundle/2 and
public-bundle/4 return the same six top-level check names in the order below; v4 expands those
checks internally rather than adding a seventh top-level result. The three closures that return
a seventh top-level check name their own lists where they are defined: v5 above, v6 and v7 with
`integrity-anchors`. V7 is the one format the `@0.1` line cannot read and pins `@0.2.1`.

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

## Presentation and citation

This section describes the five deterministic presentation assets of the v2-derived closures
(v2, v4, v6, and v7). Public-bundle/5 carries none of them; its citation rules are the shared
list below, minus every sentence about a badge, card, or share text.

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
