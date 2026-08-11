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
- A checkout with the portal dependency distributions built in the order used
  by [Benchmark Product CI](../../.github/workflows/benchmark-product-ci.yml).
- No account, network venue, API credential, or funds for the bundled sample
  and default real local venue.

Both packages are private, `publishPolicy: never`, and not released. Deployment
status is **none today**: the hosted account, team, billing, registry, and public
report experiences shown in the preview catalog are deliberate views of the
planned service, not available SaaS capabilities. Product `publish` currently
means local immutable bundle emission only. The previews stay in the product so
the intended hosted experience can be evaluated before its services exist.

## Cold public quickstart

After the portal build order above has been completed, start from an empty
product workspace using the built CLI:

```bash
cd packages/benchmark-product/core
yarn install --immutable
yarn public-quickstart
```

The command clean-builds core, creates a uniquely owned temporary workspace,
uses the two bundled real subprocess arms, and drives sample → quote → lock →
launch → status → resume → collect → results → Report → publish. It copies the
bundle outside the source workspace, deletes that source, and requires the
shipped standalone CLI to return all six portable-verification checks from the
copy. It prints a final JSON evidence envelope and removes only its exact
owner-marked temporary root. It accepts no caller-selected filesystem path and
does not use the in-memory kit backend.

## Product surfaces

- [Core and CLI](./core/README.md) — the operations library, complete agent
  surface, typed errors, authority, and real-venue behavior.
- [Private web app](./web/README.md) — the server-only human client, local
  configuration, routes, and production browser gate.
- [Public bundle](./PUBLIC-BUNDLE.md) — frozen
  `benchmark-product-public-bundle/1` layout, citation, trust, privacy,
  limitations, and portable verification.
- [Security and threat model](./SECURITY.md) — protected assets, boundaries,
  hardening evidence, residuals, and deployment truth.
- [Colophon design system](./design-system/ADAPTATION.md) — the curated source,
  production-token adapter, real brand assets, and deliberate runtime changes.

The product design authority is the
[standalone benchmark product design](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
The current extraction dry run is
[not green](../../docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md)
and is evidence only, never authorization to move this tree.
