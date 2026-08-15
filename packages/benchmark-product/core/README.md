# Colophon core — `@colophon-claims/core`

The public Tier 4 core package is the single trusted product boundary. It owns
workspace and draft state, lifecycle transitions, authority checks, the audit
journal, real local-venue composition, Report and claim production, and local
public-bundle emission. Portable verification is owned by the smaller
`@colophon-claims/verify` package and re-exported here. The CLI and private web app
are clients of these public operations; neither is a second implementation.
The user-facing `colophon` executable is owned by `@colophon-claims/cli`; core
retains the advanced command library used by that endpoint.

Authority: [product design](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
Start at the [product overview](../README.md); see the
[public-bundle guide](../PUBLIC-BUNDLE.md), [Inspect runtime guide](../INSPECT-RUNTIME.md),
[threat model](../SECURITY.md), and
[Demo-1 E4 adapter runbook](../../../docs/superpowers/plans/demo-report-1/E4-preregistration-adapter.md).

This package is public-shaped, not yet published, and requires Node 22. The complete
portal dependency graph must be built from source before core. The exact
dependency order is maintained in
[Benchmark Product CI](../../../.github/workflows/benchmark-product-ci.yml);
the old two-dependency build recipe is insufficient.

```bash
yarn install --immutable
yarn typecheck
yarn test
yarn build
yarn check:parity
yarn pack:smoke
```

`yarn public-quickstart` then exercises the built CLI on the real local venue
and proves copied-bundle verification after source-workspace deletion.

The opt-in `yarn publication-release-rehearsal` is the complementary external
release gate. With `COLOPHON_PUBLICATION_RELEASE_HARBOR` set to an exact Harbor
0.21 executable, it runs the pinned no-network fixture through real Harbor and
Docker, then proves prospective registration, six public-before-Harbor
Submissions, complete runtime evidence, Accounting/Matrix v2, signed Report v2,
exact public retrieval, and no publication-triggered rerun. It uses Harbor's
built-in Oracle agent and does not use model credentials. See the
[product overview](../README.md#real-harbor-publication-rehearsal) for the exact
operator command.

## Operations library and CLI parity

The generated [parity artifact](./parity-matrix.v1.json) is authoritative. It
contains **41 generated operations**, all shipped through the library and CLI
with an explicit shipped/deferred GUI disposition:

| Library operation | CLI command | Purpose |
|---|---|---|
| `armAdd` | `colophon arm add` | Add a pinned solver arm. |
| `armList` | `colophon arm list` | List a draft's arms. |
| `armRemove` | `colophon arm remove` | Remove an arm. |
| `armUpdate` | `colophon arm update` | Update arm pinning or notes. |
| `authorityGrant` | `colophon authority grant` | Sponsor-only membership or grant change. |
| `authorityRevoke` | `colophon authority revoke` | Sponsor-only grant or membership revocation. |
| `authorityShow` | `colophon authority show` | Read the authority policy. |
| `bindInspectBinaryJudge` | `colophon runtime inspect bind-judge` | Bind sealed binary-judge instruments to exact Run-arm requirements. |
| `createDraft` | `colophon draft create` | Create a draft, optionally from JSON. |
| `getDraft` | `colophon draft show` | Read one draft. |
| `createHumanReviewPackets` | `colophon human-review packet create` | Create blind item packets and visibility receipts before lock. |
| `signHumanReviewResponse` | `colophon human-review response sign` | Seal a response as compact Result Evaluation evidence with a configured evaluator signer. |
| `admitHumanTruth` | `colophon human-review admit` | Derive two-person unanimous or explicitly operator-only truth records, including exclusion/replacement accounting. |
| `importBinaryItemBank` | `colophon import item-bank` | Import admitted binary-judgment items from three canonical JSONL manifests. |
| `importSweBenchRows` | `colophon import swebench` | Import SWE-bench-shaped rows through interop. |
| `initWorkspace` | `colophon init` | Create a workspace and founding sponsor. |
| `inspectDraft` | `colophon inspect` | Resolve benchmark, arms, and assurance facts. |
| `listDrafts` | `colophon draft list` | List drafts. |
| `migrateTerminalBenchLegacyTask` | `colophon runtime terminal-bench migrate` | Transform legacy Terminal-Bench material with pinned Harbor and preserve both byte histories. |
| `publicationConfigure` | `colophon publication configure` | Configure the public locator and opt into prospective disclosure. |
| `publicationRegister` | `colophon publication register` | Store, announce, and exact-probe the registration closure. |
| `publicationStatus` | `colophon publication status` | Read timing assurance, stage receipts, compatibility, and recovery guidance without backend calls. |
| `publicationAccounting` | `colophon publication accounting` | Publish retained complete or partial accounting and Matrix v2 without a Report or rerun. |
| `publicationReport` | `colophon publication report` | Produce, verify, and publish the signed Report v2 envelope from the accounting closure. |
| `runCancel` | `colophon cancel` | Durably request or finalize cancellation. |
| `runCollect` | `colophon collect` | Seal the terminal Matrix. |
| `runLaunch` | `colophon launch` | Drive the real local venue. |
| `runLock` | `colophon lock` | Seal the preregistered Run. |
| `runPreview` | `colophon preview` | Run a disclosed, non-official rehearsal. |
| `runPublish` | `colophon publish` | Verify and emit one immutable local bundle. |
| `runQuote` | `colophon quote` | Present size, coverage, cap, and honest estimates. |
| `runReport` | `colophon report` | Produce the signed Report and claim package. |
| `runResults` | `colophon results` | Read the sealed Matrix result projection. |
| `runResume` | `colophon resume` | Resume only outstanding real-venue work. |
| `runStatus` | `colophon status` | Read durable per-cell and driver status. |
| `runVerify` | `colophon verify` | Re-derive Matrix, Report, and claim consistency. |
| `sampleInit` | `colophon sample init` | Attach the bundled three-task benchmark. |
| `selectInspectEvaluation` | `colophon runtime inspect select` | Select and bind a real Inspect evaluation. |
| `selectHarborRuntime` | `colophon runtime harbor select` | Select and bind the managed Harbor runtime. |
| `selectTerminalBench2Runtime` | `colophon runtime terminal-bench-2 select` | Resolve and bind one immutable Terminal-Bench 2 task through Harbor. |
| `updateDraft` | `colophon draft update` | Apply a validated JSON draft patch. |

The path-oriented portable verifier is intentionally outside workspace/GUI
parity. A reader installs only the smaller verifier package. Use the exact
version sealed into a report to reproduce publication, or its compatible major
line to receive fixes without changing the bundle-format contract:

```text
npx @colophon-claims/verify@1.0.0 <dir>
npx @colophon-claims/verify@1 <dir>
```

It reads only the caller-selected immutable bundle, needs no workspace or
principal, and returns the six checks documented in the
[public-bundle guide](../PUBLIC-BUNDLE.md).

The full installed product delegates to the same verifier implementation with
`colophon bundle verify --bundle <dir> --json`.

Demo-1's second read-only standalone verifier is the explicit post-lock/pre-dispatch E4 gate:

```text
colophon demo1 prereg verify --workspace <dir> --draft <draftId> \
  --witness <witness.json> --method-summary-sha256 <sha256> \
  --grader-program-sha256 <sha256> --source-commit <full-git-oid> --json
```

It reads the locked Run and empty run journal, verifies the exact external-anchor witness, and
performs no network or credential access. It is an ordering gate, not publication; the exact
contract and post-dispatch ordering check are in the
[E4 runbook](../../../docs/superpowers/plans/demo-report-1/E4-preregistration-adapter.md).

Every workspace command accepts `--workspace <dir>`, `--principal <id>`, and
`--json`; command-specific flags are listed by `colophon help`.

Human-review commands are intentionally CLI/core-only: they handle licensed local files and
machine-local signing keys, so browser uploads and browser key custody are unavailable. Reviewer
responses select an identity from a configured signer inventory; no command accepts raw private
key material. Publication-grade truth requires two complete, matching reviews from distinct keys
and roster-attested distinct people with no declared conflicts. Disagreement, incomplete review,
or `indeterminate` excludes the item and requires a later same-class/stratum reserve before lock.
Operator-only truth is sealed and signed for auditability but is always reported as
non-publication-grade.

Binary item-bank intake composes that admission boundary with the existing Task,
EvaluationSpec, Benchmark, and sealed-store contracts:

```text
colophon import item-bank --workspace <dir> --principal <id> \
  --profile binary-judgment@1 --draft <draftId> \
  --items <items.jsonl> --sources <sources.jsonl> \
  --admissions <admissions.jsonl>
```

Each file is canonical JSONL: UTF-8, LF-only, one canonical JSON object per line, a final LF,
and rows sorted by their contract key. `items.jsonl` carries the strict solver-visible payload
only. `sources.jsonl` maps each payload provenance digest to full source, license, and attribution
descriptors without importing source bytes. `admissions.jsonl` indexes the exact F2-sealed
admission manifest, label resolution, and analysis context records already in the workspace.
The operation rejects missing or extra admission records, digest or item-id drift, truth/class/
stratum mismatches, wrong-draft evidence, invalid replacement accounting, and non-canonical files.
Only admitted replacements become Tasks; excluded and unselected reserve rows are accounted but
not dispatched. No model, Inspect, Harbor, network, or licensed-data backend is reimplemented.

## Authority and lifecycle behavior

The **nine gated operations** are `lock`, `launch`, `cancel`, `report`,
`publish`, `publication.configure`, `publication.register`,
`publication.accounting`, and `publication.report`. The founding sponsor receives all nine grants. A delegated agent may perform any of them
only after a sponsor grants it. `authority grant` and
`authority revoke` are separately sponsor-only, so a delegated agent cannot
self-escalate. This is local-process policy and attribution, not operating-system
or hosted authentication.

Lock is irreversible. `launch` and `resume` use the real local backend;
`resume` re-dispatches only outstanding cells. Cancellation is two-phase: a
successful call may return `requested` while the active driver drains, and a
later `cancel` call returns terminal `cancelled` only after a fully accounted
Matrix is sealed. An interrupted cancel must resume through `cancel`, not
`resume`.

`collect` and `cancel` share one cross-process finalizer. Concurrent ownership,
unknown liveness, or a live finalizer returns typed `conflict` contention; it
never steals the writer or reports false completion. Only judged cells enter
score denominators. Task failure, infrastructure failure, unscorable, expired,
missing, conflicted, and cancellation-drained work remain distinct.

## Typed errors, JSON, and process exits

There are **11 typed error codes**:

- `validation`
- `illegal-transition`
- `authority-denied`
- `record-integrity`
- `journal-integrity`
- `not-found`
- `conflict`
- `invalid-invocation`
- `venue-unavailable`
- `venue-unverifiable`
- `execution`

In JSON mode success is one compact
`{"ok":true,"result":...}` line on stdout; failure is one compact
`{"ok":false,"error":...}` line on stdout. Stderr is empty. An error contains
`code`, `detail`, and optional structured `issues`; callers branch on the code
and issue path, never prose.

Process classes are: **exit 0** success/help, **exit 1** any typed error other than the next two, **exit 2** `invalid-invocation`, and **exit 3** `authority-denied`.

In human mode final success uses stdout and errors use stderr. The long-running
`launch` and `resume` commands may stream progress lines to stderr, while their
final result remains on stdout. JSON mode suppresses that progress so stdout is
always exactly one final envelope.

## Workspace and publication boundary

Mutable drafts, grants, journals, scratch state, and private signing keys remain
inside the workspace. Sealed records are stored as exact digest-addressed bytes.
`publish` is **local immutable emission only: no upload, no hosting, no deployment**, package publication, or remote write. The emitted closure is
public and not a general PII or confidentiality scrubber.

For staged publication, `publicBaseUrl` is the exact archive mount, not merely an origin. For
example, `https://example.test/publication` resolves records beneath
`https://example.test/publication/records/...`; an origin-root mount remains supported.
