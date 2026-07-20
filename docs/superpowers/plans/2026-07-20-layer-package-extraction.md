# Layer Package Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the independent plain-`tsc` `@jinn-network/jinn-layer` package and implement the version-pinned plugin-to-layer handshake without changing the v1 process contract.

**Architecture:** Move layer-owned source and tests to `packages/layer`, with dependencies only on plugin/core/public npm packages. Keep wallet and chain-writing composition client-owned behind injected interfaces. Resolve the plugin-local npm artifact before development overrides and rehearse the packed package from a pristine install prefix.

**Tech Stack:** TypeScript 5, Node.js 22 ESM, Yarn 4, npm pack/install, Vitest, Python 3.11/pytest, GitHub Actions.

## Global Constraints

- Base is `origin/next` at `03dd6f75ae73898864021021aa03c46bd90bfb4e`.
- Process contract remains exactly v1; schema changes are out of scope.
- Layer resolution is plugin-local artifact → `JINN_LAYER_BIN` → PATH; the latter two are development overrides.
- `packages/layer` builds with plain `tsc`; no esbuild or bespoke bundler in the lane.
- No `packages/layer` source import may resolve into `client/src` or `client/packages`.
- Do not publish npm artifacts, use publication credentials, mutate production, or claim the stock-Hermes public gate.
- C4 evidence-index/reindex, C5 core extraction, and C11 public episode-payload behavior must remain green.

---

### Task 1: Pin and resolve the plugin-local layer artifact

**Files:**
- Create: `apps/jinn-agent/plugins/jinn/layer-runtime.json`
- Modify: `apps/jinn-agent/plugins/jinn/jinn_layer.py`
- Modify: `apps/jinn-agent/plugins/jinn/doctor.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_layer.py`
- Test: `apps/jinn-agent/tests/plugins/test_jinn_doctor.py`

**Interfaces:**
- Produces: `LayerResolution(source, argv, detail)` and `resolve_binary()` with source `plugin-local | env | path`.
- Consumes later: `layer-runtime.json` fields `package`, `version`, and `bin`.

- [ ] Write tests proving plugin-local npm bin wins over `JINN_LAYER_BIN`, env wins when the local artifact is absent, PATH is last, non-executable local artifacts fail closed, and doctor reports the active source.
- [ ] Run the focused pytest files and confirm failures name the missing resolver behavior.
- [ ] Implement the resolver and update every spawn path to consume its argv without shell interpolation.
- [ ] Re-run focused pytest and the contract/version parity tests.
- [ ] Commit as `refactor(plugin): define pinned layer handshake`.

### Task 2: Scaffold the independently buildable layer package

**Files:**
- Create: `packages/layer/package.json`
- Create: `packages/layer/tsconfig.json`
- Create: `packages/layer/vitest.config.ts`
- Create: `packages/layer/test/architecture/import-scan.ts`
- Create: `packages/layer/test/architecture/forbidden-imports.test.ts`
- Create: `packages/layer/test/architecture/manifest-completeness.test.ts`
- Create: `packages/layer/test/architecture/plain-tsc.test.ts`
- Create: `packages/layer/test/architecture/package-contract.test.ts`
- Create: `packages/layer/yarn.lock`

**Interfaces:**
- Produces: package `@jinn-network/jinn-layer@0.1.0`, bin `jinn-layer -> dist/bin/jinn-layer.js`, and public root exports.
- Consumes: `@jinn-network/plugin@0.1.0`, `@jinn-network/core@0.1.0`.

- [ ] Write architecture and package-contract tests first; confirm they fail because the package is absent/incomplete.
- [ ] Add the package manifest and compiler config using only `tsc -p tsconfig.json`.
- [ ] Generate the immutable Yarn lock and run architecture tests, typecheck, and build.
- [ ] Commit as `refactor(layer): scaffold independent package`.

### Task 3: Move the process contract, adapters, distillation, seed import, and CLI

**Files:**
- Move implementation from: `client/packages/harness-layer/src/**`
- Move tests from: `client/packages/harness-layer/test/**`
- Create/modify: `packages/layer/src/**`, `packages/layer/test/**`
- Modify: `packages/core/src/index.ts` and narrowly shared core modules where layer-owned code currently reaches client-only utility types.
- Modify: client compatibility imports only where required to preserve C4/C5/C11 consumers.

**Interfaces:**
- Produces: `runJinnLayerCli`, `PROCESS_CONTRACT_VERSION`, `buildPluginFromEnv`, process request/envelope schemas, corpus/evidence/contribution/local-learning/skills adapters, distillation APIs, and seed plan/execute APIs from the layer package.
- Keeps client-only: wallet loading, Safe/IPFS chain writer creation, daemon capture drain, and on-chain anchoring composition.

- [ ] Move the focused contract/adapter tests first, repoint them to package imports, and confirm they fail before source ownership moves.
- [ ] Move process-contract and adapter source; make the focused tests pass.
- [ ] Move distillation and seed-import tests/source in small dependency-closure slices, replacing client imports with core/plugin contracts or injected ports; run each focused group after its slice.
- [ ] Move CLI/bin source, remove direct client imports, and make parked client-only operations return explicit injected-adapter errors instead of importing the client.
- [ ] Run the whole layer suite, plugin contract kits, golden-envelope test, C4 reindex tests, and C11 payload tests.
- [ ] Commit as `refactor(layer): move harness process ownership`.

### Task 4: Remove client packaging ownership and add compatibility coverage

**Files:**
- Delete: `client/scripts/bundle-jinn-layer.mjs`
- Delete: `client/scripts/jinn-layer-entry.ts`
- Delete: `client/tsconfig.jinn-layer-entry.json`
- Modify: `client/package.json`
- Modify: `client/yarn.lock`
- Modify: `client/Dockerfile`
- Modify: `client/scripts/smoke-test-pack.mjs`
- Modify: `client/test/scripts/pack-workflows.test.ts`
- Modify: affected client and agent CI references.

**Interfaces:**
- Produces: client tarball with no `jinn-layer` or `jinn-distill-mcp` bin and no `dist/bin/jinn-layer.js`.
- Consumes: layer package only in development/test jobs, never as a client runtime dependency.

- [ ] Change pack-workflow tests first to require absence of client layer packaging and confirm the old configuration fails.
- [ ] Remove the bundler/entry/bin ownership and update Docker/build/typecheck/test scripts.
- [ ] Run client build, typecheck, focused pack tests, and both client pack-smoke variants.
- [ ] Commit as `refactor(client): release layer binary ownership`.

### Task 5: Add independent CI, canary, and clean-install rehearsal

**Files:**
- Create: `.github/workflows/layer-ci.yml`
- Create: `.github/workflows/layer-npm-publish.yml`
- Create: `packages/layer/scripts/pack-smoke.mjs`
- Modify: `.github/scripts/npm-publish-workflow.test.mjs`
- Modify: `.github/workflows/jinn-agent-ci.yml`
- Modify: `apps/jinn-agent/scripts/cold-stock-e2e.sh`
- Test: layer workflow and pack-smoke tests.

**Interfaces:**
- Produces: paths-filtered layer checks and a trusted-publisher canary job that publishes only on `next`, plus a local command that never publishes.

- [ ] Write workflow assertions and the clean-install rehearsal first; confirm they fail before workflows/scripts exist.
- [ ] Add layer CI and canary workflow with Node 22, immutable installs, build/typecheck/test/pack-smoke, exact canary version `<version>-canary.<sha8>`, and `npm publish --tag canary` only inside the workflow.
- [ ] Pack the layer, install the tarball under a pristine temporary prefix, run the installed contract handshake and sandboxed session pickup/end rehearsal, and assert the client tarball has no layer bin.
- [ ] Run actionlint and all workflow unit tests.
- [ ] Commit as `chore(layer): add independent canary lane`.

### Task 6: Final verification and draft PR

**Files:**
- Modify only findings from review/security/verification.

- [ ] Run layer/plugin/core/client builds, typechecks, tests, package dry-runs, clean-install smoke, agent plugin tests, cold-stock local rehearsal, actionlint, diff check, and secret scan.
- [ ] Run simplification/code review, independent review, and security review; fix findings test-first and re-run gates.
- [ ] Push `refactor/1837-layer-package-extraction`.
- [ ] Open a draft PR against `next`, label `engine:review`, use `Refs #1837`, and record exact human residual publication/stock-Hermes commands, prerequisites, evidence, rollback, and why the issue remains open.
- [ ] Confirm the PR externally and move Project Status to `In Review`.
