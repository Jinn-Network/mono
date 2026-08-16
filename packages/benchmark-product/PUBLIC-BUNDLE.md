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
candidate-class and core/stress slice, parser-invalid and instability facts,
truth-admission status, exclusions/replacements, and stored limitations. Its
badge, social card, and share text are narrower signposts: verified state, exact
scope, full Report digest, and relative links only. They carry no rate,
instrument conclusion, preference, selection, or ordering.

## Portable verification

Use the smaller reader package, without the product or source workspace:

```bash
npx @colophon-claims/verify@1 <bundle-dir>
```

Binary qualification v4 pins the new verifier contract instead:

```bash
npx @colophon-claims/verify@2 <bundle-dir>
```

Claim-package/1 and public-bundle/2 continue to carry the literal
`@1.0.0`/`@1` commands. Claim-package/2 and public-bundle/4 carry the literal
`@2.0.0`/`@2` commands. Both lines return the same six top-level check names in
the order below; v4 expands those checks internally rather than adding a seventh
top-level result.

The full installed product exposes the same implementation through:

```bash
colophon bundle verify --bundle <bundle-dir> --json
```

Success returns the bundle identity, record digests, an Inspect runtime-method
summary when applicable, and exactly **six checks**
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
