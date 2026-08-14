# Colophon web — `@jinn-network/benchmark-product-web`

This private Next.js App Router application is Colophon's human surface. It is a server-only, in-process client of the public
`@jinn-network/benchmark-product-core` entry. It contains no second lifecycle,
orchestrator, statistic, verifier, record reader, HTTP API route, or browser-side
core import.

Read the [product overview](../README.md),
[app specification](./BENCHMARK-PRODUCT-WEB-SPEC.md),
[public-bundle guide](../PUBLIC-BUNDLE.md), and [security note](../SECURITY.md).
Real Inspect selection and native-artifact behavior are documented in the
[Inspect runtime guide](../INSPECT-RUNTIME.md).

## Required local configuration

Both values are mandatory before `dev` or `start`:

- `BENCHMARK_PRODUCT_WORKSPACE_DIR` — an explicit absolute local workspace
  path selected by the server process.
- `BENCHMARK_PRODUCT_PRINCIPAL` — the acting workspace member id.

The browser never supplies either path, an arbitrary bundle path, a credential,
or private key. The two `BENCHMARK_PRODUCT_*TEST*` variables in server source
are dual-opt-in production-browser test controls only; they are not product
settings and must not be enabled for normal use.

The core package and its complete portal dependency graph must already be
built, following
[Benchmark Product CI](../../../.github/workflows/benchmark-product-ci.yml).

## Commands

Available package commands are `yarn dev`, `yarn build`, `yarn lint`,
`yarn typecheck`, `yarn test`, and `yarn test:browser`.

```bash
yarn install --immutable
yarn lint
yarn typecheck
yarn test
yarn build
yarn test:browser
```

Use `yarn dev` for local development. For the production path that the browser
gate accepts, run `yarn build`, then:

```bash
BENCHMARK_PRODUCT_WORKSPACE_DIR=/absolute/path/to/workspace \
BENCHMARK_PRODUCT_PRINCIPAL=sponsor-1 \
yarn next start
```

`yarn test:browser:production` performs the optimized build plus the complete
production browser gate. `yarn test:browser` expects that optimized build to
exist and is the direct Playwright command.

## Routes

- `/` — neutral product landing page.
- `/preview/[surface]` — clearly labeled, read-only previews of the future
  hosted reports, registries, account, billing, documentation, and pricing
  experience; previews never claim a service is live and invoke no operations.
- `/workspace/new` — workspace initialization.
- `/workspace` — workspace, drafts, and audit summary.
- `/workspace/[draftId]` — native/SWE-bench intake, real Inspect runtime
  selection, arms, authority, preview, quote, and lock.
- `/workspace/[draftId]/run` — launch, durable status, resume, cancel, collect.
- `/workspace/[draftId]/results` — Matrix, Report, claim, verification, and local
  publication.
- `/publication/[...path]` — fixed same-workspace exact-byte public archive; the browser
  never selects a workspace.

Set `BENCHMARK_PRODUCT_PUBLICATION_PUBLIC_BASE_URL` to the externally visible origin plus
`/publication` when a proxy means the server cannot safely derive its public URL. It is only a
locator: configure/register consent and exact-byte probes remain core operation gates.
The GUI displays and uses this server-owned exact archive mount; it never accepts a browser URL.
The CLI retains `--public-base-url` for deliberate remote/archive operation outside the GUI.

All displayed facts and action receipts come from public core operations.
Known failures preserve their typed recovery category. Unexpected errors,
runtime diagnostics, absolute paths, identifiers that are not deliberate
public facts, and secret-bearing command material are redacted at the
server/browser boundary.

## Privacy, security, and deployment

The operational app is **private and local today**. Deployment status is
**none**; it has no hosted authentication, tenant isolation, TLS/HSTS claim,
public API, report hosting, or authorization to deploy. The future-service
previews deliberately remain visible and are permanently labeled as previews,
so the eventual SaaS experience can be judged without simulating its backend.
Every private HTML and Server Action
response is `no-store` and carries the CSP, frame denial, nosniff, no-referrer,
and empty Permissions Policy documented in the security note.

The optimized Chromium gate audits every route and material lifecycle/error
state at desktop and 390 px, requires zero axe violations without waivers,
checks keyboard/focus/reflow behavior, scans browser and bundle surfaces for
runtime secrets and generated private keys, deletes the source workspace, and
verifies the copied bundle with the shipped standalone CLI.
