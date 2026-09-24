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
- `@colophon-claims/check` — the smaller reader-only checker;
- `@colophon-claims/web` — private source/build input for the local UI.

`@colophon-claims/check` is published to npm, `latest` `0.2.1`. The reader
lines below therefore run straight from the registry; nothing has to be checked
out to verify a received bundle.

`@colophon-claims/cli` and `@colophon-claims/core` are implemented but not
published. Demand-gated registry publication is recorded in DR-2026-08-22-a
and `colophon-npm-publish.yml`; this tree does not publish them on push.
`@colophon-claims/web` is private source/build input by design and is not for
registry release.

There is no hosted service, account, telemetry, billing, or remote publication.
Product `publish` means local immutable bundle emission only.

## Cold public quickstart

The intended packaged command is:

```bash
npx @colophon-claims/cli@0.1
```

It runs the bundled zero-credential comparison, retains its copied bundle and
receipt, verifies the copy, and opens a verified loopback viewer. It is not yet
a registry command because `@colophon-claims/cli` has not been published.

For a received bundle, the smaller reader surface is:

```bash
npx @colophon-claims/check@0.2 ./bundle
```

That line reads the bundle formats through public-bundle/6, and only the claims
that pin it. Reader lines are not forward compatible, and a reader that is too
old refuses with the same code an invalid bundle earns, so before concluding
anything from a refusal, read the line the bundle's own claim package pins in
`verification.command` — the producer named it for that exact bundle. The
per-format table in [`PUBLIC-BUNDLE.md`](PUBLIC-BUNDLE.md) covers the case where
you have only `bundle.json`; the format string alone is not sufficient, because
prompted-screening bundles pin a later line without changing their format.

Reports sealed before the rename pin `@colophon-claims/verify`. That name stays
published permanently as a passthrough alias onto `@colophon-claims/check`, so
every sealed instruction keeps resolving.

To verify a bundle with tools that are not ours, see
[`EXTERNAL-VERIFICATION.md`](EXTERNAL-VERIFICATION.md).

To import results another harness already produced, see
[`EXTERNAL-RUN-IMPORT.md`](EXTERNAL-RUN-IMPORT.md). An imported run
publishes as composed `/10` declaring `external-import`.

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

The service launches Harbor on Colophon's venue.

## Terminal-Bench 2.1

The service launches Terminal-Bench 2.1 on Colophon's venue.

## Terminal-Bench 3.0

The service launches Terminal-Bench 3.0 on Colophon's venue.

## APEX-SWE-dev

The service launches APEX-SWE-dev on Colophon's venue.

## DeepSWE v1.1

The service launches DeepSWE v1.1 on Colophon's venue.

## Inspect eval

The service launches Inspect eval on Colophon's venue.

## Product surfaces

- [Installable CLI](./cli/README.md) — the no-argument sample and local viewer.
- [Core](./core/README.md) — the operations library, complete agent surface,
  typed errors, authority, and real-venue behavior.
- [Reader checker](./check/README.md) — the independent small install for a
  person checking a received bundle.
- [Private web app](./web/README.md) — the server-only human client, local
  configuration, routes, and production browser gate.
- [Public bundle](./PUBLIC-BUNDLE.md) — frozen
  `benchmark-product-public-bundle/2` layout, citation, trust, privacy,
  limitations, and portable verification.
- [External run-record import](./EXTERNAL-RUN-IMPORT.md) — the per-attempt
  record shape, both dump dialects, the closed import vocabulary, the
  `--template` workflow, and how an imported run publishes as composed `/10`
  declaring `external-import`.
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
