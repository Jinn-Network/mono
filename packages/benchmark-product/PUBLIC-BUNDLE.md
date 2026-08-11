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
record in the authenticated evidence graph. A cancelled run additionally has
the optional `verification/cancel-requested.json`. When publication explicitly
authorizes native Inspect content, each delivered native log is duplicated
byte-for-byte as `native/inspect/<sha256>.eval`. The verifier requires that set
to exactly match the Inspect log outputs in the authenticated delivery graph;
the `.eval` extension makes the artifact directly usable by the pinned Inspect
reader and Inspect View. No other role is permitted in
`benchmark-product-public-bundle/2`; an incompatible closure requires a new
format version.

Version 2 is the first format that permits runtime-native artifacts and
same-execution scorer relationships. Version 1 remains a historical native-only
format; this implementation emits and verifies version 2 rather than changing
version 1's closed schema in place.

## Portable verification

Use the shipped built CLI, without the source workspace:

```bash
colophon bundle verify --bundle <bundle-dir> --json
```

Success returns the bundle identity, record digests, and exactly **six checks**
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

Do not cite a badge, card, or headline as if it were the full result. The current
method states no comparative winner; no asset may infer one from point estimates.

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
