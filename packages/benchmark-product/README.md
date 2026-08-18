# Colophon

**Compare agents on the same work.** Colophon is benchmark publishing for agent
configurations: it turns a preregistered comparison into a portable claim that
people can inspect and verify. Humans use the local workspace; authorized agents
use the same operations library or the `colophon` CLI. All surfaces operate the
same permissions, records, evidence, and lifecycle. `benchmark-product` remains
the internal package codename and a compatibility CLI alias.

Public promise: **Publish benchmark claims people can check.** Built on Jinn.

The implemented path is public-first and local: create or import a benchmark,
configure at least two arms, quote and lock the method, run the real local
venue, inspect complete accounting, produce and verify a Report, then emit an
immutable public bundle. Local pre-registration is discipline, not proof
against the run owner, and distinct evaluator keys do not prove independent
real-world custody.

## Status and prerequisites

- Node.js 22 (the verified runtime is 22.23.1) and Yarn 4.13.0.
- The packaged zero-Docker sample, reader verifier, and loopback viewer are
  qualified on Ubuntu x64 and Apple-silicon macOS arm64. Windows and Intel
  macOS remain unsupported; real agent, Docker, and Inspect paths have separate gates.
- A checkout with the portal dependency distributions built in the order used
  by [Benchmark Product CI](../../.github/workflows/benchmark-product-ci.yml) is
  still required for mono development until the Jinn packages are public.
- No account, API credential, funds, Docker, or provider call for the bundled sample.

The self-serve source is now split into Colophon-owned Tier 4 packages:

- `@colophon-claims/cli` — the installable `colophon` command;
- `@colophon-claims/core` — product operations and local composition;
- `@colophon-claims/verify` — the smaller reader-only verifier;
- `@colophon-claims/web` — private source/build input for the local UI.

They are implemented but not published. Registry publication remains held until
the `@colophon-claims` organization and publisher custody are established and
the exact Jinn dependency set is available from npm. There is no hosted service,
account, telemetry, billing, or remote publication. Product `publish` means
local immutable bundle emission only.

## Cold public quickstart

The intended packaged command is:

```bash
npx @colophon-claims/cli@1
```

It runs the bundled zero-credential comparison, retains its copied bundle and
receipt, verifies the copy, and opens a verified loopback viewer. It is not yet
a registry command because the packages have not been published.

For a received bundle, the smaller reader surface is:

```bash
npx @colophon-claims/verify@2 ./bundle
```

The contributor proof remains available from the mono:

After the portal build order above has been completed, start from an empty
product workspace using the built CLI:

```bash
cd packages/benchmark-product/core
yarn install --immutable
yarn public-quickstart
```

The contributor command clean-builds core, creates a uniquely owned temporary workspace,
uses the two bundled real subprocess arms, and drives sample → quote → lock →
launch → status → resume → collect → results → Report → publish. It copies the
bundle outside the source workspace, deletes that source, and requires the
shipped standalone CLI to return all six portable-verification checks from the
copy. It prints a final JSON evidence envelope and removes only its exact
owner-marked temporary root. It accepts no caller-selected filesystem path and
does not use the in-memory kit backend.

## Real Harbor publication rehearsal

Before a release, run the opt-in external rehearsal in addition to the cold
quickstart. It uses the operator-selected Harbor 0.21 executable and the local
Docker daemon to run six real trials with Harbor's built-in `oracle` agent. The
fixture is pinned to an immutable Ubuntu image, container networking is
disabled, and no model API or model credential is used.

```bash
cd packages/benchmark-product/core
COLOPHON_PUBLICATION_RELEASE_HARBOR="$(command -v harbor)" \
  yarn publication-release-rehearsal
yarn public-quickstart
```

The rehearsal fails unless registration is publicly retrievable before the
first Submission reaches Harbor. It then requires all six Deliveries, complete
Harbor Job/Trial evidence, pre-dispatch Accounting and Matrix v2, a signed
Report v2, exact public `HEAD`/`GET` retrieval, and no Harbor invocation caused
by publication. The first run may fetch the pinned container image. Set
`COLOPHON_PUBLICATION_RELEASE_DOCKER` only when `docker` is not on `PATH`.
Because this is an explicit local release gate, it is skipped by ordinary CI.

## Terminal-Bench 2.1 `one_task` operator qualify

An operator-only campaign against the official Terminal-Bench 2.1 leaderboard
pin with real Harbor 0.21, Docker, and two oracle arms. It proves protocol
identity (`one_task`, conforming, not leaderboard-ready, Hub
`inspection-upload`). It does not download the 89-task tree in CI and is not
part of default `yarn test`. Procedure, receipt checklist, and the fail-closed
`yarn tb21-one-task-qualify` gate:
[docs/runbooks/tb21-official-one-task.md](../../docs/runbooks/tb21-official-one-task.md).

## Inspect-as-specified `one_task` operator qualify

An operator-only campaign against an in-repo Inspect Task (`hermetic_eval`,
samples `alpha` / `bravo`) with local Python and `inspect-ai==0.3.255`. It
proves protocol identity (`one_task` = one sample, conforming, not as-specified
complete, View export `inspection-upload`). It does not download GAIA, Cybench,
or other large eval datasets, and is not part of default `yarn test`.
Procedure, receipt checklist, and the fail-closed
`yarn inspect-as-specified-one-task-qualify` gate:
[docs/runbooks/inspect-as-specified-one-task.md](../../docs/runbooks/inspect-as-specified-one-task.md).

## Product surfaces

- [Installable CLI](./cli/README.md) — the no-argument sample and local viewer.
- [Core](./core/README.md) — the operations library, complete agent surface,
  typed errors, authority, and real-venue behavior.
- [Reader verifier](./verify/README.md) — the independent small install for a
  person checking a received bundle.
- [Private web app](./web/README.md) — the server-only human client, local
  configuration, routes, and production browser gate.
- [Public bundle](./PUBLIC-BUNDLE.md) — frozen
  `benchmark-product-public-bundle/2` layout, citation, trust, privacy,
  limitations, and portable verification.
- [Inspect runtime](./INSPECT-RUNTIME.md) — optional real Inspect selection,
  execution, scorer attribution, native logs, and security limitations.
- [Security and threat model](./SECURITY.md) — protected assets, boundaries,
  hardening evidence, residuals, and deployment truth.
- [Colophon design system](./design-system/ADAPTATION.md) — the curated source,
  production-token adapter, real brand assets, and deliberate runtime changes.

The product design authority is the
[standalone benchmark product design](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
The current extraction dry run is
[not green](../../docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md)
and is evidence only, never authorization to move this tree.
