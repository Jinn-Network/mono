# Layer Package Extraction Design

- **Date:** 2026-07-20
- **Issue:** [#1837](https://github.com/Jinn-Network/mono/issues/1837)
- **Shape:** `refactor`
- **Governing design:** `docs/superpowers/specs/2026-07-17-stage2-architecture-design.md` §§4.2–4.3, 7, 9
- **Onboarding seam:** `docs/superpowers/specs/2026-07-17-jinn-plugin-onboarding-design.md` §3.1

## Decision

Extract one real `@jinn-network/jinn-layer` package at `packages/layer` and make it the sole owner of the `jinn-layer` process binary, process-contract implementation, plugin port adapters, local evidence and distillation composition, seed-import machinery, and CLI dispatch. The package depends only on `@jinn-network/plugin`, `@jinn-network/core`, and declared public npm dependencies, emits ESM and declarations with plain `tsc`, and has architecture tests that reject `client/src`, `client/packages`, and undeclared bare imports. `@jinn-network/client` consumes `core` and `plugin` directly and no longer ships either `jinn-layer` binary; client-only wallet and chain-writing composition remains behind injected ports instead of becoming a layer dependency.

This is the strangler layer in the already-ratified C1→C2→C5→C6→C7→C8 train. During C6, compatibility re-exports may remain under `client/packages/harness-layer` only where current client tests or the later C7/C8 units still require them; new implementation and tests live under `packages/layer`. The C7 tee retirement and mineable-store slimming are not pulled forward, and the C11 `jinn.episode.v1` payload and C4 index/reindex behavior are carried byte- and contract-compatibly.

## Alternatives considered

1. **Recommended: source extraction plus injected client adapters.** This creates the intended dependency direction and lets npm install normal dependencies. It requires explicit seams for the few legacy CLI operations that still need wallet or chain-writing code, but those seams make the parked outbound posture honest.
2. **Publish a thin wrapper around the client bundle.** This is mechanically smaller, but it preserves the bespoke esbuild lane, makes `@jinn-network/client` a hidden runtime dependency, and recreates the release-coupling failure C6 exists to remove.
3. **Duplicate a minimal contract-only layer and leave the harness layer in place.** This could satisfy a narrow onboarding smoke, but would create two process implementations and two CLIs whose behavior can drift before C8. It fails the ownership acceptance criterion.

## Plugin-to-layer handshake

The plugin resolves the executable in this order:

1. a plugin-local, version-pinned artifact described by `layer-runtime.json`;
2. `JINN_LAYER_BIN`, reported as a development override;
3. `jinn-layer` on `PATH`, reported as a development override.

The plugin-local artifact is an npm-shaped installation of exact package `@jinn-network/jinn-layer` and exact version matching `packages/layer/package.json`. Its discovered executable is `node_modules/.bin/jinn-layer` (with the platform-appropriate npm bin form). The resolver validates that the path is a regular executable file before spawning it. The v1 handshake remains `jinn-layer contract --json` and succeeds only when JSON contains `contractVersion: 1`; nonzero exit, unreadable JSON, and version mismatch retain actionable `hermes plugins update jinn` remediation. Development overrides never alter the expected contract version.

No esbuild output is accepted as the published layer. npm installs the layer with its declared dependencies, which is the condition under which externalized imports resolve. Local proof therefore packs the package, installs the tarball into a pristine prefix, and drives the installed bin. Public npm publication is intentionally not performed by this issue session.

## Verification design

- Architecture: package manifest completeness, exports boundary, forbidden import scan, and a source scan proving no layer build/bundle script invokes esbuild.
- Contract: existing plugin contract kits and process-contract tests run from `packages/layer`; Python/TypeScript contract constants and pinned package versions remain equal.
- Compatibility: golden envelope fixture, C4 reindex/repair tests, C5 corpus/scrub/trajectory tests, and C11 episode/public-payload tests remain green.
- Packaging: `yarn build`, `yarn typecheck`, `yarn test`, `npm pack --dry-run`, tarball install in a clean prefix, installed `jinn-layer contract --json`, and a session pickup/end rehearsal with sandboxed state directories.
- Client: client build/typecheck/test and pack smoke prove `@jinn-network/client` no longer advertises or contains the layer bin while its daemon behavior remains unchanged.
- Workflow: paths-filtered layer CI and canary workflow, actionlint, workflow unit assertions, and no publish invocation during local verification.

## Residual human proof

Two gates require authority or public state this implementation session does not have and must remain open: publishing the independent npm canary through the trusted-publisher workflow, and installing the public slim plugin plus public layer in a pristine stock-Hermes environment. The draft PR records exact commands, prerequisites, expected evidence, and rollback for both.
