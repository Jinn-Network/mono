# Colophon core — `@colophon-claims/core`

The public Tier 4 core package is the single trusted product boundary. It owns
workspace and draft state, lifecycle transitions, authority checks, the audit
journal, real local-venue composition, Report and claim production, and local
public-bundle emission. Portable verification is owned by the smaller
`@colophon-claims/check` package and re-exported here. The CLI and private web app
are clients of these public operations; neither is a second implementation.
The user-facing `colophon` executable is owned by `@colophon-claims/cli`; core
retains the advanced command library used by that endpoint.

Authority: [product design](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
Start at the [product overview](../README.md); see the
[public-bundle guide](../PUBLIC-BUNDLE.md), [Inspect runtime guide](../INSPECT-RUNTIME.md),
and [threat model](../SECURITY.md).

This package is the operations library the published CLI depends on, and requires Node 22. The complete
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
built-in Oracle agent and does not use model credentials. The
[product overview](../README.md#real-harbor-publication-rehearsal) names this as
a service launch.

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
| `anchoringConfigure` | `colophon anchoring configure` | Replace or clear the workspace anchor provider and endpoint configuration. |
| `identityBind` | `colophon identity bind` | Bind the workspace report-signing key to a domain, and name the record to publish there. |
| `disclosureDeclare` | `colophon disclosure declare` | Seal this run's six-variable disclosure-specification record over its sealed Matrix. |
| `disclosureShow` | `colophon disclosure show` | Read the sealed disclosure-specification record back out of the workspace store. |
| `createDraft` | `colophon draft create` | Create a draft, optionally from JSON. |
| `getDraft` | `colophon draft show` | Read one draft. |
| `importSweBenchRows` | `colophon import swebench` | Import SWE-bench-shaped rows through interop. |
| `importRunRecords` | `colophon run import` | Turn a locked run into a run from an external harness's per-attempt records over the whole sealed slate. `--from harbor` reads Harbor 0.21 jobs and trials; `--from inspect` reads Inspect EvalLogs. |
| `initWorkspace` | `colophon init` | Create a workspace and founding sponsor. |
| `inspectDraft` | `colophon inspect` | Resolve benchmark, arms, and assurance facts. |
| `listDrafts` | `colophon draft list` | List drafts. |
| `publicationConfigure` | `colophon publication configure` | Configure the public locator and opt into prospective disclosure. |
| `publicationRegister` | `colophon publication register` | Store, announce, and exact-probe the registration closure. |
| `publicationStatus` | `colophon publication status` | Read timing assurance, stage receipts, compatibility, and recovery guidance without backend calls. |
| `publicationAccounting` | `colophon publication accounting` | Publish retained complete or partial accounting and Matrix v2 without a Report or rerun. |
| `publicationReport` | `colophon publication report` | Produce, verify, and publish the signed Report v2 envelope from the accounting closure. |
| `runCancel` | `colophon cancel` | Durably request or finalize cancellation. |
| `runCollect` | `colophon collect` | Seal the terminal Matrix. |
| `runLaunch` | `colophon launch` | Drive the real local venue, serially by default or with `--concurrency 1-32`. |
| `runLock` | `colophon lock` | Seal the preregistered Run. |
| `runAnchor` | `colophon anchor` | Obtain, verify, and store third-party time evidence over the sealed Run or Matrix digest. |
| `runBind` | `colophon bind` | Bind the sealed, not-yet-launched Run to a public beacon value that postdates its seal, sealing the derived execution order. On a scheduled source the seal names exactly one admissible round — the first published strictly after it — and every other is refused. |
| `runPreview` | `colophon preview` | Run a disclosed, non-official rehearsal. |
| `runPublish` | `colophon publish` | Verify and emit one immutable local bundle. |
| `runQuote` | `colophon quote` | Present size, coverage, cap, and honest estimates. |
| `runReport` | `colophon report` | Produce the signed Report and claim package. |
| `runResults` | `colophon results` | Read the sealed Matrix result projection. |
| `runResume` | `colophon resume` | Resume only outstanding real-venue work with the same optional concurrency bound. |
| `runStatus` | `colophon status` | Read durable per-cell and driver status. |
| `runVerify` | `colophon verify` | Re-derive Matrix, Report, and claim consistency. |
| `sampleInit` | `colophon sample init` | Attach the bundled three-task benchmark. |
| `selectMethod` | `colophon method` | Bind a catalog suite or a method-document file onto a draft. |
| `exportDerivedBundle` | `colophon export` | Package the locked method's suite-named derived bundle, or refuse. |
| `updateDraft` | `colophon draft update` | Apply a validated JSON draft patch. |

The path-oriented portable verifier is intentionally outside workspace/GUI
parity. A reader installs only the smaller verifier package. Use the exact
version sealed into a report to reproduce publication, or its compatible major
line to receive fixes without changing the bundle-format contract. The first
public line, illustrated below, is the one the formats through public-bundle/6
pin:

```text
npx @colophon-claims/check@0.2.1 <dir>
npx @colophon-claims/check@0.2 <dir>
```

Reader lines are not forward compatible, and a reader that is too old refuses
with the same code an invalid bundle earns, so take the line from the bundle's
own claim package `verification.command` rather than from this illustration.
The per-format table in the [public-bundle guide](../PUBLIC-BUNDLE.md) covers
the case where you have only `bundle.json`.

It reads only the caller-selected immutable bundle, needs no workspace or
principal, and returns the check list its format's closure defines, which that
same guide states per format.

The full installed product delegates to the same verifier implementation with
`colophon bundle verify --bundle <dir> --json`.

The second standalone pair projects a sealed bundle's freeze artifacts into a
deterministic public repository, and checks a published tree against the bundle
it claims to be derived from:

```text
colophon freeze-repo export --bundle <dir> --out <dir> --json
colophon freeze-repo verify --bundle <dir> --repo <dir> --json
```

Both read only the caller-selected immutable bundle and need no workspace or
principal. The repository is a derived artifact, never the claim of record; the
layout, the licence scaffolding, and the commit hash an announcement pins are in
the [public-bundle guide](../PUBLIC-BUNDLE.md).

Every workspace command accepts `--workspace <dir>`, `--principal <id>`, and
`--json`; command-specific flags are listed by `colophon help`.

Published binary-instrument bundles still carry a sealed admission closure. Readers
authenticate it through
`verifyBinaryJudgmentAdmissionClosureInWorkspace({ workspaceDir, admissionManifestSha256, expectedDraftId })`.
It replays the exact manifest, resolutions, analysis contexts, item bytes, exclusion/replacement
ledger, reviewer Result Evaluations, and role-separated authority evidence before returning
derived publication status, classes, strata, accepted/excluded items, and the complete reachable
digest inventory. Portable readers can call `verifyBinaryJudgmentAdmissionClosure` from
`@colophon-claims/check/admission` with their own exact-record resolver and reviewer/authority
trust ports; neither API accepts caller-authored candidate truth.

## Authority and lifecycle behavior

The **ten gated operations** are `lock`, `launch`, `cancel`, `report`,
`publish`, `publication.configure`, `publication.register`,
`publication.accounting`, `publication.report`, and `anchoring.configure`. The founding sponsor receives all ten grants. A delegated agent may perform any of them
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
public and not a general PII or confidentiality scrubber. `publication serve` is
the separate, explicitly invoked verb that puts the already-emitted public
archive tree on a socket; it announces nothing and writes no workspace record.
See `docs/runbooks/colophon-announcement-source-serving.md`.

For staged publication, `publicBaseUrl` is the exact archive mount, not merely an origin. For
example, `https://example.test/publication` resolves records beneath
`https://example.test/publication/records/...`; an origin-root mount remains supported.

For this release, `@jinn-network/*` is pinned to the exact
`0.1.0-canary.sha.0533a224cf99f06d7facf0c23455f2781a5b9e62` receipt.
It is not a floating `@canary` dependency and is not a stable stack release.

## What this does not yet prove

Protocol identifiers in the installed platform packages are names, not addresses.
This package fetches nothing from them. Checks run against the exact
`@jinn-network/*` platform bytes installed from npm.
