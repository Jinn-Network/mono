# Benchmark Product (placeholder name)

This Tier 4 product compares agent configurations on the same tasks and emits a
credible, portable benchmark claim. Humans use the private local web app;
authorized agents use the operations library or CLI. Both surfaces operate the
same workspace, permissions, records, and evidence. The product is incubating
under the internal `benchmark-product` codename and has no final public brand.

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
status is **none**: there is no hosted app, account service, remote API, report
host, package release, or authorization to deploy. Product `publish` means
local immutable bundle emission only.

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

The product design authority is the
[standalone benchmark product design](../../docs/superpowers/specs/2026-08-05-benchmark-product-design.md).
The current extraction dry run is
[not green](../../docs/superpowers/plans/2026-08-09-benchmark-product-extraction-readiness.md)
and is evidence only, never authorization to move this tree.
