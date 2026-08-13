# Colophon core — `@jinn-network/benchmark-product-core`

The private Tier 4 core package is the single trusted product boundary. It owns
workspace and draft state, lifecycle transitions, authority checks, the audit
journal, real local-venue composition, Report and claim production, local
public-bundle emission, and portable verification. The CLI and private web app
are clients of these public operations; neither is a second implementation.
The preferred CLI command is `colophon`; `benchmark-product` remains an
internal compatibility alias while packages keep their established names.

Authority: [product design](../../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
Start at the [product overview](../README.md); see the
[public-bundle guide](../PUBLIC-BUNDLE.md), [Inspect runtime guide](../INSPECT-RUNTIME.md),
[threat model](../SECURITY.md), and
[Demo-1 E4 adapter runbook](../../../docs/superpowers/plans/demo-report-1/E4-preregistration-adapter.md).

This package is `private: true`, unpublished, and requires Node 22. The complete
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

## Operations library and CLI parity

The generated [parity artifact](./parity-matrix.v1.json) is authoritative. It
contains **28 generated operations**, all shipped through the library, CLI, and
GUI:

| Library operation | CLI command | Purpose |
|---|---|---|
| `armAdd` | `colophon arm add` | Add a pinned solver arm. |
| `armList` | `colophon arm list` | List a draft's arms. |
| `armRemove` | `colophon arm remove` | Remove an arm. |
| `armUpdate` | `colophon arm update` | Update arm pinning or notes. |
| `authorityGrant` | `colophon authority grant` | Sponsor-only membership or grant change. |
| `authorityRevoke` | `colophon authority revoke` | Sponsor-only grant or membership revocation. |
| `authorityShow` | `colophon authority show` | Read the authority policy. |
| `createDraft` | `colophon draft create` | Create a draft, optionally from JSON. |
| `getDraft` | `colophon draft show` | Read one draft. |
| `importSweBenchRows` | `colophon import swebench` | Import SWE-bench-shaped rows through interop. |
| `initWorkspace` | `colophon init` | Create a workspace and founding sponsor. |
| `inspectDraft` | `colophon inspect` | Resolve benchmark, arms, and assurance facts. |
| `listDrafts` | `colophon draft list` | List drafts. |
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
| `updateDraft` | `colophon draft update` | Apply a validated JSON draft patch. |

The path-oriented portable verifier is intentionally outside workspace/GUI
parity:

The exact machine command is
`colophon bundle verify --bundle <dir> --json`.

```text
colophon bundle verify --bundle <dir> --json
```

It reads only the caller-selected immutable bundle, needs no workspace or
principal, and returns the six checks documented in the
[public-bundle guide](../PUBLIC-BUNDLE.md).

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

## Authority and lifecycle behavior

The **five gated operations** are `lock`, `launch`, `cancel`, `report`, and
`publish`. The founding sponsor receives all five grants. A delegated agent may
perform any of them only after a sponsor grants it. `authority grant` and
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
