# Marketplace Venue-Base Adapters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Date:** 2026-07-30
**Status:** draft (pending program approval)
**Shape:** `feat`
**Implements:** row 1 of `docs/superpowers/plans/2026-07-30-operator-daemon-composition-program.md` §1 — the whole of
`docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §6.1 (nine deliverables + four placement
notes), §6.6 (kit strategy), and §7 rulings 1, 2 and 4. Section references (`§N`) point at that design unless
prefixed `program §N`.

**Depends on:** nothing outside the merged stack (`integration/evidence-v1`). This is stream S1 of program §2 phase 0
and is the critical path's first node: `venue-base → stage 1 → … → stage 5`.

**Goal:** Ship `packages/marketplace/venue-base/` — the production chain plugs that fill every venue-facing port the
merged stack declares but never implements — so the operator runtime (stage 1) has a real `ClaimPorts`,
`SettlementPorts`, `MarketplaceLifecyclePorts`, `FinalityPort`, `DeliveryWaitPort`, `ReleaseAttemptPort`,
`MarketplaceObservePort`, `SafeBroadcastPort`, chain log source and durable posting-intent store to compose.

**Architecture:** One tier-3 package holding a viem client pair, the canonical venue's contracts and one SQLite state
file. A **chunked, hash-verified log source** with dual cursors (live on `latest`, durable checkpoint on `finalized`)
feeds the projector; a **single Safe broadcaster** implementing the named Defender-relayer profile (serialized
per-sender nonce assignment, persistent `(chainId, from, nonce)` submission ledger, fee-bumped replacement,
stuck-nonce eviction, reconcile-on-nonce-too-low, cross-process lock, inner-revert decode) is the one transaction path
every writer port funnels through. Everything is written **fresh**; the legacy mech adapter enters only as kit
fixtures (§6.6), never as ported code.

**Tech Stack:** TypeScript (strict, `moduleResolution: Bundler` for typecheck, `NodeNext`-resolvable packed types),
viem `^2.0.0`, `better-sqlite3` `13.0.1` (the stack's SQLite precedent, `packages/evidence/catalog-sqlite`),
Vitest `4.1.8`, Node `node:test` for the `.github/scripts` guards, Anvil (Foundry) for the fork suite. Yarn 4.13.0
standalone per-package project with `portal:` resolutions; no repo-root workspace.

---

## Global Constraints

Every task's requirements implicitly include this section.

### Copied verbatim from the program plan's global constraints

- Branch target: `integration/evidence-v1` (stacked PR trains; the integration branch is not yet in `next`). Nothing
  here publishes to npm — #2293 runs in parallel.
- Kits and fixtures **before** implementations; a layer's kit green before dependents build.
- Guard trio (package inventory, source-boundary, packed-types + CI workflow) ships **with** each new tree, not after.
- Every task ends with typecheck + tests + relevant kit + guards run locally, outputs shown.
- Independent per-component review when a component completes, findings resolved before dependents build on it
  (program discipline, principles §13.2).
- American English throughout; no product names in tier-3 code.
- The spec's §6.1 placement notes and §10 bridge-era/drain/standing rules are binding cross-plan contracts (program §6).

### This package's own constraints

- **npm name is `@jinn-network/marketplace-venue-base`** (program §5), directory `packages/marketplace/venue-base`,
  `repository.directory` matching. Version `0.1.0`, `"type": "module"`, `"packageManager": "yarn@4.13.0"`,
  `"engines": { "node": ">=22" }`, `"license": "MIT"`, root-only `exports`.
- **Signer-injection only** (program §6 contract 11, §6.1 npm posture). Every port takes an injected viem
  `WalletClient`. The package contains **no keystore, no key-loading code, no private-key parsing, no key material,
  ever** — not in production source, not in tests, except the well-known Anvil dev key inside the fork suite that
  lives in `marketplace-testing`, not here. A guard test enforces this.
- **Kits precede implementations.** Tasks 3–5 write the venue conformance kit and its legacy-derived fixtures before
  Task 6 writes the first line of adapter code.
- **Guard trio ships with the tree.** Task 1 extends all three `.github/scripts/marketplace-*.test.mjs` guards and
  `.github/workflows/marketplace-ci.yml` before any package source exists.
- **Fresh rewrite, legacy as fixtures** (program §6 contract 12). `client/src/adapters/mech/contracts.ts`,
  `client/src/adapters/mech/safe.ts` and `client/src/tx-retry.ts` are **behavioral oracles read for their tables and
  scenarios**. No file, function or block is copied into `venue-base`. Their revert-classification table, nonce and
  stuck-nonce scenarios and RPC chunking rules become kit test cases.
- **Port-type home** (program §6 contract 8). `FinalityPort`, `DeliveryWaitPort` and `ReleaseAttemptPort` are declared
  in `marketplace-pipeline`; Task 2 re-exports them (type-only) from `marketplace-binding`. `venue-base` **never**
  imports `@jinn-network/marketplace-pipeline`. Guard-enforced.
- **Storage location is a host parameter.** Every persistent artefact lives in the one SQLite file named by
  `config.stateDbPath`. `~/.jinn-client`, `~/.jinn`, `os.homedir()` and any other absolute default are **banned in
  production source** — guard-enforced by a literal scan. The package never creates a directory outside the parent of
  `stateDbPath`.
- **Ambient network APIs are banned** (`fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest`, and their
  `globalThis`/`global` member forms). The existing marketplace source-boundary guard already scans every directory in
  its `marketplaceDirectories` list; Task 1 adds `venue-base` to that list. HTTP reaches the package only through the
  injected viem transports and the injected `IpfsPinPort`.
- **Locale-sensitive APIs are banned** (`localeCompare`, `toLocale*`, `Intl`) — same guard, same list.
- **Never a product name in tier-3 code.** No `jinn-client`, no `operator`, no `autopilot`, no SolverNet vocabulary in
  identifiers, messages or comments.
- **Rule 3 (surgical).** Implementers touch only the files this plan names. The only edits outside
  `packages/marketplace/venue-base/`, `packages/marketplace/testing/` and `.github/` are the two Task 2 mechanical
  changes in `packages/marketplace/binding/src/`.

## What this plan does NOT do

- **No daemon wiring.** No composition root, no loops, no `client/` edits, no config migration. Every one of those is
  `2026-07-30-cutover-stage-1-solver-flow.md`. This plan ends with `createBaseVenue` exported and its kit green; the
  daemon that calls it is the next plan's subject.
- **No npm publish.** `venue-base` is consumed by `portal:` link only. #2293 owns publication and is explicitly not a
  gate on this work (§10 standing rules).
- **No legacy code deletion.** `client/src/adapters/mech/*` and `client/src/tx-retry.ts` are read, never edited and
  never removed here; their retirement rides cutover stages 1–3.

## Cross-plan surface this plan owes its consumers

Pinned by program §5 and honored exactly:

```ts
createBaseVenue(config): {
  claim: ClaimPorts;
  settlement: SettlementPorts;
  lifecycle: MarketplaceLifecyclePorts;
  finality: FinalityPort;
  deliveryWait: DeliveryWaitPort;
  release: ReleaseAttemptPort;
  observe: MarketplaceObservePort;
  safe: SafeBroadcastPort;
  logSource: ChainLogSource;
  intents: PostingIntentStore;
}
```

with `config` carrying the five pinned members `{ chain, publicClient, walletClient, safeAddress, stateDbPath }`.
See **Findings** for the three additional required members and why they cannot be defaulted inside a tier-3 package.

## Findings (surface at the program gate; do not silently resolve)

1. **Contract 8 vs. the projector dependency.** Program §6 contract 8 reads "venue-base depends on binding types only."
   Three of the nine §6.1 deliverables cannot honor a literal reading: the log source must emit
   `MarketplaceRawLog` (declared in `marketplace-projector/src/events.ts`), the finality waiter must apply
   `finalityPolicy` (`marketplace-projector/src/finality.ts`, named by §6.1's own row), and the projector-backed
   `MarketplaceObservePort` is by definition projector-backed.
   *Proposed disposition:* read contract 8 as scoped to what its own sentence is about — keeping tier-3 adapters off
   the **application-shaped** `marketplace-pipeline` package (§6.1's stated rationale) — and declare
   `@jinn-network/marketplace-projector` a production dependency of `venue-base`. The DAG stays acyclic
   (`venue-base → projector → binding`), and `marketplace-pipeline` remains a hard-forbidden import, guard-enforced.
   This plan is written against that reading.
2. **`withEvictionRecovery` is a no-op in the oracle.** §6.1's Safe-broadcast row says "eviction-recovery retry" and
   §6.6 says "the nonce/eviction recovery scenarios" become kit fixtures. In the legacy oracle
   (`client/src/adapters/mech/contracts.ts:212`) `withEvictionRecovery` is a bare `return action()` — the
   OLAS-service re-stake-on-failure behavior was deliberately deleted by #773 as "not just unnecessary, actively
   HARMFUL" (an inline `reStake` revert replaced the action's real error and wedged the deliver tick).
   *Proposed disposition:* read "eviction" in both places as the **Defender-relayer profile's stuck-nonce eviction**
   (ruling 1's own vocabulary, implemented in the oracle by `recoverStuckNonceIfNeeded`), not OLAS service eviction.
   Do **not** re-introduce re-stake-on-failure into the protocol write path. Kit fixtures cover stuck-nonce eviction;
   reward-eligibility re-staking stays an application-tier background loop (§4 "Kept as-is").
3. **`createBaseVenue(config)` needs more than the five pinned members.** `SettlementPorts` requires `pin` and
   `verifySettlementGrade`; `claimAttempt` requires a `priorityMech`; `decodeMarketplaceLogs` requires an
   `isAuthorizedMechOrigin` predicate. None can be constructed inside `venue-base`: `pin` needs an HTTP transport
   (ambient network banned), `verifySettlementGrade` needs the host's trust wiring, `priorityMech` and the Mech
   allowlist are deployment facts.
   *Proposed disposition:* keep the single-argument signature `createBaseVenue(config)` exactly as program §5 pins it,
   keep the five pinned members required and unrenamed, and add these four as further **required** members of
   `BaseVenueConfig` — reading program §5's `config = { … }` as an enumeration of the identity-bearing members rather
   than a closed shape. Every optional tuning knob (chunk sizes, poll intervals, timeouts) gets a default and is
   optional.

---

## Task 1: Scaffold `venue-base` and extend the guard trio + CI

**Files:**
- Create: `packages/marketplace/venue-base/package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `vitest.config.ts`, `.yarnrc.yml`, `README.md`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`,
  `src/index.ts`
- Modify: `.github/scripts/marketplace-package-inventory.test.mjs`
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs`
- Modify: `.github/scripts/marketplace-packed-types.test.mjs`
- Modify: `.github/workflows/marketplace-ci.yml`

**Interfaces:**
- Consumes: nothing (scaffold).
- Produces: the package `@jinn-network/marketplace-venue-base` with an empty public surface
  (`src/index.ts` = `export {};`), and the guard trio extended to a five-package marketplace tree.

- [ ] **Step 1: Write the failing guard extension.** Edit
  `.github/scripts/marketplace-package-inventory.test.mjs` — add the fifth entry and its dependency graph:

  ```js
  const MARKETPLACE_PACKAGES = [
    ['binding', '@jinn-network/marketplace-binding'],
    ['projector', '@jinn-network/marketplace-projector'],
    ['pipeline', '@jinn-network/marketplace-pipeline'],
    ['venue-base', '@jinn-network/marketplace-venue-base'],
    ['testing', '@jinn-network/marketplace-testing'],
  ];
  ```

  Change the count assertion to `assert.equal(MARKETPLACE_PACKAGES.length, 5);` and add to `JINN_DEPENDENCY_GRAPH`:

  ```js
  // venue-base is the tier-3 chain-adapter tree (composition design §6.1). It consumes the
  // binding's port surface and the projector's decode/finality/observe machinery; it may NEVER
  // consume marketplace-pipeline (program §6 contract 8 -- tier-3 adapters stay off the
  // application-shaped package; the three pipeline-declared ports re-export from binding).
  // Shadow devDependencies mirror the transitive portal closure standalone yarn install needs.
  ['venue-base', {
    dependencies: [
      '@jinn-network/marketplace-binding',
      '@jinn-network/marketplace-projector',
      '@jinn-network/task-execution-backend',
      '@jinn-network/task-execution-protocol',
    ],
    devDependencies: [
      '@jinn-network/record-discovery-protocol',
      '@jinn-network/record-discovery-serve',
      '@jinn-network/record-discovery-testing',
      '@jinn-network/task-execution-profiles',
      '@jinn-network/trust-core',
      '@jinn-network/trust-resolve',
    ],
    optionalDependencies: [],
    peerDependencies: [],
  }],
  ```

  and extend `testing`'s entry: append `'@jinn-network/marketplace-venue-base'` to its `dependencies` array (kept
  sorted), because Task 17's kit runner binds the real facade.

  Run: `node --test .github/scripts/marketplace-package-inventory.test.mjs`
  Expected: FAIL — `missing package manifest: …/packages/marketplace/venue-base/package.json`.

- [ ] **Step 2: Write the package scaffold.** `packages/marketplace/venue-base/package.json`:

  ```json
  {
    "name": "@jinn-network/marketplace-venue-base",
    "version": "0.1.0",
    "description": "Production chain adapters for the canonical Base venue: chunked log source, Safe broadcast under the relayer profile, claim/settlement/lifecycle writers, finality and delivery waiters, durable posting-intent store and projector-backed observe.",
    "type": "module",
    "packageManager": "yarn@4.13.0",
    "engines": { "node": ">=22" },
    "license": "MIT",
    "repository": {
      "type": "git",
      "url": "https://github.com/Jinn-Network/mono.git",
      "directory": "packages/marketplace/venue-base"
    },
    "main": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "exports": { ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" } },
    "files": ["dist/", "README.md"],
    "publishConfig": { "access": "public" },
    "scripts": {
      "build": "node scripts/build.mjs",
      "typecheck": "tsc --noEmit -p tsconfig.json",
      "test": "vitest run",
      "pack:smoke": "node scripts/pack-smoke.mjs",
      "prepack": "yarn build"
    },
    "dependencies": {
      "@jinn-network/marketplace-binding": "0.1.0",
      "@jinn-network/marketplace-projector": "0.1.0",
      "@jinn-network/task-execution-backend": "0.1.0",
      "@jinn-network/task-execution-protocol": "0.1.0",
      "better-sqlite3": "13.0.1",
      "viem": "^2.0.0"
    },
    "devDependencies": {
      "@jinn-network/record-discovery-protocol": "0.1.0",
      "@jinn-network/record-discovery-serve": "0.1.0",
      "@jinn-network/record-discovery-testing": "0.1.0",
      "@jinn-network/task-execution-profiles": "0.1.0",
      "@jinn-network/trust-core": "0.1.0",
      "@jinn-network/trust-resolve": "0.1.0",
      "@types/better-sqlite3": "7.6.13",
      "@types/node": "^22.0.0",
      "typescript": "^5.9.3",
      "vitest": "^4.1.8"
    },
    "resolutions": {
      "@jinn-network/marketplace-binding": "portal:../binding",
      "@jinn-network/marketplace-projector": "portal:../projector",
      "@jinn-network/record-discovery-protocol": "portal:../../discovery/protocol",
      "@jinn-network/record-discovery-serve": "portal:../../discovery/serve",
      "@jinn-network/record-discovery-testing": "portal:../../discovery/testing",
      "@jinn-network/task-execution-backend": "portal:../../task-execution/backend",
      "@jinn-network/task-execution-profiles": "portal:../../task-execution/profiles",
      "@jinn-network/task-execution-protocol": "portal:../../task-execution/protocol",
      "@jinn-network/trust-core": "portal:../../trust/core",
      "@jinn-network/trust-resolve": "portal:../../trust/resolve"
    }
  }
  ```

  Copy `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts` and `.yarnrc.yml` verbatim from
  `packages/marketplace/binding/`. Copy `scripts/build.mjs` verbatim. Copy `scripts/pack-smoke.mjs` from
  `packages/marketplace/binding/scripts/pack-smoke.mjs`, changing only: the temp-dir label to
  `"jinn-marketplace-venue-base-"`, the archive name to `marketplace-venue-base.tgz`, the `assertArchiveShape`
  error strings to `marketplace-venue-base`, the installed-root package name, and the `crossTree` array to

  ```js
  const crossTree = [
    ["@jinn-network/task-execution-protocol", join(packageRoot, "..", "..", "task-execution", "protocol")],
    ["@jinn-network/task-execution-backend", join(packageRoot, "..", "..", "task-execution", "backend")],
    ["@jinn-network/task-execution-profiles", join(packageRoot, "..", "..", "task-execution", "profiles")],
    ["@jinn-network/trust-core", join(packageRoot, "..", "..", "trust", "core")],
    ["@jinn-network/trust-resolve", join(packageRoot, "..", "..", "trust", "resolve")],
    ["@jinn-network/record-discovery-protocol", join(packageRoot, "..", "..", "discovery", "protocol")],
    ["@jinn-network/record-discovery-serve", join(packageRoot, "..", "..", "discovery", "serve")],
    ["@jinn-network/marketplace-binding", join(packageRoot, "..", "binding")],
    ["@jinn-network/marketplace-projector", join(packageRoot, "..", "projector")],
  ];
  ```

  and the smoke script's `expected` dependency-boundary list to the four declared Jinn production dependencies:

  ```js
  const expected = [
    "@jinn-network/marketplace-binding",
    "@jinn-network/marketplace-projector",
    "@jinn-network/task-execution-backend",
    "@jinn-network/task-execution-protocol",
  ];
  ```

  `src/index.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // @jinn-network/marketplace-venue-base -- public surface. Populated task by task; the facade
  // `createBaseVenue` (Task 17) is the supported composition surface (program §5).
  export {};
  ```

  `README.md`: one paragraph naming the package's role (the tier-3 chain plugs for the canonical Base venue), the
  signer-injection-only posture, and a pointer to
  `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md` §6.1.

- [ ] **Step 3: Run the inventory guard to verify it passes.**

  Run: `node --test .github/scripts/marketplace-package-inventory.test.mjs`
  Expected: PASS — 2 tests, 0 failures.

- [ ] **Step 4: Extend the source-boundary guard.** Edit
  `.github/scripts/marketplace-source-boundaries.test.mjs`:

  ```js
  const marketplaceDirectories = ['binding', 'projector', 'pipeline', 'venue-base', 'testing'];
  ```

  Add the forbidden-package list after `PIPELINE_FORBIDDEN_PACKAGES`:

  ```js
  // venue-base is the tier-3 chain-adapter tree (composition design §6.1): it consumes the
  // binding's port surface (including the three pipeline-declared ports re-exported there at
  // stage 0) and the projector's decode/finality/observe machinery. It may NEVER import
  // marketplace-pipeline (program §6 contract 8), never the backend-local internals, never
  // marketplace-testing (one-directional kit rule), and never a record-discovery package
  // directly -- the projector is the one chain-reading machine and owns that edge.
  const VENUE_BASE_FORBIDDEN_PACKAGES = [
    '@jinn-network/marketplace-pipeline', '@jinn-network/marketplace-testing',
    '@jinn-network/task-execution-supervisor', '@jinn-network/task-execution-workspace',
    '@jinn-network/task-execution-launchers', '@jinn-network/task-execution-backend-local',
    '@jinn-network/task-execution-testing',
    '@jinn-network/record-discovery-protocol', '@jinn-network/record-discovery-serve',
    '@jinn-network/record-discovery-client', '@jinn-network/record-discovery-testing',
  ];

  // Signer-injection only (program §6 contract 11 / design §6.1 npm posture): venue-base holds
  // no key material and no key-loading code. Injected viem WalletClients are the only signing
  // authority. Banned on venue-base production source.
  const KEY_MATERIAL_APIS = [
    'privateKeyToAccount', 'mnemonicToAccount', 'hdKeyToAccount', 'generatePrivateKey',
    'privateKeyToAddress', 'toAccount',
  ];
  const keyMaterialIdentifier = new RegExp(
    String.raw`(?<![\w$."'\x60])(?:${KEY_MATERIAL_APIS.join('|')})\b`, 'g',
  );

  // Storage location is a host parameter (`config.stateDbPath`), never an absolute default.
  const HOST_PATH_APIS = ['homedir', 'userInfo'];
  const hostPathIdentifier = new RegExp(
    String.raw`(?<![\w$."'\x60])(?:${HOST_PATH_APIS.join('|')})\b|(?:~\/\.jinn)`, 'g',
  );

  function matchesInFiles(sourceFiles, pattern) {
    return sourceFiles.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return [...source.matchAll(pattern)].map((match) => `${relative(root, file)} -> ${match[0]}`);
    }).sort();
  }
  ```

  Add three tests:

  ```js
  test('marketplace-venue-base production source stays within its architecture boundary', () => {
    const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
      (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
    );
    assert.deepEqual(
      forbiddenImportsInFiles(productionFiles, VENUE_BASE_FORBIDDEN_PACKAGES, APPLICATION_AND_LEGACY_ROOTS),
      [],
      'packages/marketplace/venue-base/src crosses a marketplace architecture boundary',
    );
  });

  test('marketplace-venue-base never loads or derives key material (signer-injection only)', () => {
    const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
      (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
    );
    assert.deepEqual(matchesInFiles(productionFiles, keyMaterialIdentifier), [],
      'venue-base is signer-injection only: no keystore, no key-loading code, no key material');
  });

  test('marketplace-venue-base never hardcodes a host storage location', () => {
    const productionFiles = files(join(packages, 'venue-base', 'src')).filter(
      (file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file),
    );
    assert.deepEqual(matchesInFiles(productionFiles, hostPathIdentifier), [],
      'venue-base persists only under the host-supplied config.stateDbPath');
  });
  ```

  In the existing test `'marketplace exports stay root-only except for the native testing conformance subpaths'`
  add the row `['venue-base', '@jinn-network/marketplace-venue-base', ['.']]`, and in
  `'no marketplace package imports the backend-local component internals (ruling §7.18)'` the
  `if (directory === 'pipeline') continue;` skip already covers the loop — `venue-base` is checked by the loop as-is.

  Run: `node --test .github/scripts/marketplace-source-boundaries.test.mjs`
  Expected: PASS — the empty `src/index.ts` is trivially clean; all pre-existing tests still pass.

- [ ] **Step 5: Extend the packed-types guard.** Edit `.github/scripts/marketplace-packed-types.test.mjs`:
  add `['venue-base', '@jinn-network/marketplace-venue-base']` to `packages` (before `['testing', …]`, so leaves pack
  before dependents) and `'@jinn-network/marketplace-venue-base'` to `codeEntrypoints`. No `CROSS_TREE_PACKAGES`
  change is needed — every venue-base cross-tree dependency is already listed.

- [ ] **Step 6: Extend the CI workflow.** Edit `.github/workflows/marketplace-ci.yml`. Add a `venue-base` job after
  `pipeline`:

  ```yaml
    venue-base:
      needs: [binding, projector]
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: 22
        - name: Enable Yarn 4.13.0
          run: |
            corepack enable
            corepack prepare yarn@4.13.0 --activate
        - name: Build cross-tree portal dependencies from source (§7.8)
          run: |
            (cd packages/task-execution/protocol && yarn install --immutable && yarn build)
            (cd packages/task-execution/backend && yarn install --immutable && yarn build)
            (cd packages/task-execution/profiles && yarn install --immutable && yarn build)
            (cd packages/trust/core && yarn install --immutable && yarn build)
            (cd packages/trust/resolve && yarn install --immutable && yarn build)
            (cd packages/discovery/protocol && yarn install --immutable && yarn build)
            (cd packages/discovery/serve && yarn install --immutable && yarn build)
            (cd packages/discovery/testing && yarn install --immutable && yarn build)
        - name: Restore Marketplace Binding distribution
          uses: actions/download-artifact@v4
          with:
            name: marketplace-binding-dist
            path: packages/marketplace/binding/dist
        - name: Restore Marketplace Projector distribution
          uses: actions/download-artifact@v4
          with:
            name: marketplace-projector-dist
            path: packages/marketplace/projector/dist
        - name: Install cross-marketplace toolchains (packed-smoke dependencies)
          run: |
            (cd packages/marketplace/binding && yarn install --immutable)
            (cd packages/marketplace/projector && yarn install --immutable)
        - name: Verify Marketplace Venue Base
          working-directory: packages/marketplace/venue-base
          run: |
            yarn install --immutable
            yarn typecheck
            yarn test
            yarn build
            yarn pack:smoke
        - name: Upload Marketplace Venue Base distribution
          uses: actions/upload-artifact@v4
          with:
            name: marketplace-venue-base-dist
            path: packages/marketplace/venue-base/dist
            if-no-files-found: error
            retention-days: 1
  ```

  Then: add `venue-base` to the `testing` job's `needs` and give it a "Restore Marketplace Venue Base distribution"
  download step plus `(cd packages/marketplace/venue-base && yarn install --immutable)` in its
  "Install cross-marketplace toolchains" step; add `venue-base` to the `anvil-fork` job's `needs` with the same two
  additions; add `venue-base` to the `verify` job's `needs`, its `VENUE_BASE_RESULT` env var and the `for result in`
  list; and add `venue-base` to the `verify` job's "Place package distributions" loop
  (`for package in binding projector pipeline venue-base testing;`).

- [ ] **Step 7: Verify the scaffold installs, typechecks and builds.**

  ```bash
  cd packages/marketplace/venue-base && yarn install && yarn typecheck && yarn build
  ```
  Expected: install succeeds through the portal links; `tsc --noEmit` reports zero errors; `dist/index.js` +
  `dist/index.d.ts` exist.

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/marketplace/venue-base .github/scripts/marketplace-*.test.mjs .github/workflows/marketplace-ci.yml
  git commit -m "feat(venue-base): scaffold the chain-adapter tree with its guard trio and CI job"
  ```

---

## Task 2: Stage-0 mechanical notes — binding port re-exports and the `venue/safe.ts` supersession

**Files:**
- Modify: `packages/marketplace/binding/src/index.ts`
- Create: `packages/marketplace/binding/src/pipeline-ports.ts`
- Create: `packages/marketplace/binding/src/pipeline-ports.test.ts`
- Modify: `packages/marketplace/binding/src/venue/safe.ts` (comment only)

**Interfaces:**
- Consumes: `FinalityPort`, `FinalityAwaitResult`, `DeliveryWaitPort`, `DeliveryWaitResult`, `ReleaseAttemptPort` —
  the structural shapes declared in `packages/marketplace/pipeline/src/pipeline.ts`.
- Produces, from `@jinn-network/marketplace-binding`:
  - `type FinalityAwaitResult = { readonly ok: true } | { readonly ok: false; readonly kind: "reorged" | "failed" }`
  - `interface FinalityPort { awaitFinalized(input: { readonly taskId: bigint; readonly attemptIndex: number; readonly claimTxHash: Hex }): Promise<FinalityAwaitResult> }`
  - `type DeliveryWaitResult = { readonly ok: true; readonly deliveryBytes: Uint8Array } | { readonly ok: false; readonly kind: "timeout" | "cancelled" | "backend-terminal"; readonly state?: AttemptState }`
  - `interface DeliveryWaitPort { waitForDelivery(input: { readonly attemptUri: AttemptUri; readonly backend: TaskExecutionBackend; readonly signal?: AbortSignal }): Promise<DeliveryWaitResult> }`
  - `interface ReleaseAttemptPort { releaseAttempt(input: { readonly taskId: bigint; readonly attemptIndex: number }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>; forfeitDeliveredReservation?(input: { readonly taskId: bigint; readonly attemptIndex: number; readonly verdictIndex: number; readonly legKind: 1 | 2 }): Promise<void> }`

This is a **declaration re-home, not an import**: `marketplace-binding` may not import `marketplace-pipeline` (the
source-boundary guard forbids it, and it would invert the DAG). The three interfaces are re-declared here verbatim and
a compile-time structural-equality test in the *pipeline* package pins them together (Step 3).

- [ ] **Step 1: Write the failing test.** Create `packages/marketplace/binding/src/pipeline-ports.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe, expect, test } from "vitest";
  import type {
    DeliveryWaitPort,
    DeliveryWaitResult,
    FinalityAwaitResult,
    FinalityPort,
    ReleaseAttemptPort,
  } from "./index.js";

  describe("pipeline-declared ports re-home on the binding's port surface (design §6.1 port-type home)", () => {
    test("a FinalityPort implementation satisfies the re-homed declaration", async () => {
      const port: FinalityPort = {
        async awaitFinalized(input) {
          expect(input.taskId).toBe(7n);
          expect(input.attemptIndex).toBe(0);
          expect(input.claimTxHash).toBe(`0x${"a".repeat(64)}`);
          const result: FinalityAwaitResult = { ok: false, kind: "reorged" };
          return result;
        },
      };
      await expect(
        port.awaitFinalized({ taskId: 7n, attemptIndex: 0, claimTxHash: `0x${"a".repeat(64)}` }),
      ).resolves.toEqual({ ok: false, kind: "reorged" });
    });

    test("a DeliveryWaitPort implementation satisfies the re-homed declaration", async () => {
      const bytes = new TextEncoder().encode("{}");
      const port: DeliveryWaitPort = {
        async waitForDelivery() {
          const result: DeliveryWaitResult = { ok: true, deliveryBytes: bytes };
          return result;
        },
      };
      const waited = await port.waitForDelivery({
        attemptUri: "urn:uuid:00000000-0000-4000-8000-000000000000",
        backend: undefined as never,
      });
      expect(waited).toEqual({ ok: true, deliveryBytes: bytes });
    });

    test("a ReleaseAttemptPort implementation reports today-mode unsupported release", async () => {
      const port: ReleaseAttemptPort = {
        async releaseAttempt() {
          return { ok: false, kind: "unsupported" };
        },
      };
      await expect(port.releaseAttempt({ taskId: 1n, attemptIndex: 0 })).resolves.toEqual({
        ok: false,
        kind: "unsupported",
      });
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/binding && yarn vitest run src/pipeline-ports.test.ts`
  Expected: FAIL — `Module '"./index.js"' has no exported member 'FinalityPort'` (and the same for the other four
  type names).

- [ ] **Step 3: Write the minimal implementation.** Create
  `packages/marketplace/binding/src/pipeline-ports.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Port-type home (operator-daemon composition design §6.1, program §6 contract 8). These three
  // ports are *declared* by `@jinn-network/marketplace-pipeline` and *implemented* by
  // `@jinn-network/marketplace-venue-base`. Re-homing the declarations here keeps the tier-3
  // adapter tree depending on binding types only, off the application-shaped pipeline package.
  // They are re-declared, not imported: the binding may never import the pipeline (that would
  // invert the tree's DAG, and the source-boundary guard forbids it). `pipeline-ports.test.ts`
  // in the pipeline package pins the two declarations structurally equal.
  import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";
  import type { AttemptState } from "@jinn-network/task-execution-protocol";
  import type { Hex } from "viem";

  export type FinalityAwaitResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly kind: "reorged" | "failed" };

  /** Required injected port: gate expensive execution on finalized claim facts (design §8, N2). */
  export interface FinalityPort {
    awaitFinalized(input: {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly claimTxHash: Hex;
    }): Promise<FinalityAwaitResult>;
  }

  export type DeliveryWaitResult =
    | { readonly ok: true; readonly deliveryBytes: Uint8Array }
    | {
        readonly ok: false;
        readonly kind: "timeout" | "cancelled" | "backend-terminal";
        readonly state?: AttemptState;
      };

  /** Cancel/timeout-aware delivery wait — the library owns no poll timer policy. */
  export interface DeliveryWaitPort {
    waitForDelivery(input: {
      readonly attemptUri: AttemptUri;
      readonly backend: TaskExecutionBackend;
      readonly signal?: AbortSignal;
    }): Promise<DeliveryWaitResult>;
  }

  export interface ReleaseAttemptPort {
    releaseAttempt(input: {
      readonly taskId: bigint;
      readonly attemptIndex: number;
    }): Promise<void | { readonly ok: false; readonly kind: "unsupported" }>;
    forfeitDeliveredReservation?(input: {
      readonly taskId: bigint;
      readonly attemptIndex: number;
      readonly verdictIndex: number;
      readonly legKind: 1 | 2;
    }): Promise<void>;
  }
  ```

  Append to `packages/marketplace/binding/src/index.ts`:

  ```ts
  // --- port-type home for the three pipeline-declared ports (design §6.1; stage 0) ---
  export type {
    DeliveryWaitPort,
    DeliveryWaitResult,
    FinalityAwaitResult,
    FinalityPort,
    ReleaseAttemptPort,
  } from "./pipeline-ports.js";
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/binding && yarn vitest run src/pipeline-ports.test.ts && yarn typecheck`
  Expected: 3 tests pass; typecheck reports zero errors.

- [ ] **Step 5: Pin the two declarations structurally equal from the pipeline side.** Create
  `packages/marketplace/pipeline/src/pipeline-ports.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // The binding re-homes these three port declarations for the tier-3 adapter tree (composition
  // design §6.1). This test fails to compile if the two declarations ever drift apart.
  import { describe, test } from "vitest";
  import type {
    DeliveryWaitPort as BindingDeliveryWaitPort,
    FinalityPort as BindingFinalityPort,
    ReleaseAttemptPort as BindingReleaseAttemptPort,
  } from "@jinn-network/marketplace-binding";
  import type { DeliveryWaitPort, FinalityPort, ReleaseAttemptPort } from "./pipeline.js";

  type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const assertExact = <T extends true>(): T => true as T;

  describe("binding's re-homed port declarations stay structurally identical", () => {
    test("compiles only while all three pairs are mutually assignable", () => {
      assertExact<Exact<FinalityPort, BindingFinalityPort>>();
      assertExact<Exact<DeliveryWaitPort, BindingDeliveryWaitPort>>();
      assertExact<Exact<ReleaseAttemptPort, BindingReleaseAttemptPort>>();
    });
  });
  ```

  Run: `cd packages/marketplace/pipeline && yarn vitest run src/pipeline-ports.test.ts && yarn typecheck`
  Expected: 1 test passes; typecheck zero errors.

- [ ] **Step 6: Update the `venue/safe.ts` supersession comment.** In
  `packages/marketplace/binding/src/venue/safe.ts`, replace the sentence

  > those are daemon-concurrency concerns that belong to the pipeline (Milestone M6) wiring this into a running daemon
  > with multiple concurrent loops sharing one Safe.

  with

  > those are venue-concurrency concerns and they are re-homed to
  > `@jinn-network/marketplace-venue-base` (operator-daemon composition design §6.1 "Supersession note" — venue
  > mechanics, not application policy; nothing frozen pinned the earlier Milestone-M6 placement). From cutover stage 1
  > that package's Safe broadcaster is the only transaction path in the operator process (the single-broadcaster
  > rule); this helper remains the minimum single-shot read-sign-broadcast-wait sequence for one-off binding calls and
  > tests.

  Change nothing else in the file — no code, no signature, no behavior.

- [ ] **Step 7: Run the binding and pipeline suites plus the guards.**

  ```bash
  (cd packages/marketplace/binding && yarn typecheck && yarn test)
  (cd packages/marketplace/pipeline && yarn typecheck && yarn test)
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  ```
  Expected: both suites green; the boundary guard still passes (the binding gained no new imports — `pipeline-ports.ts`
  imports only `task-execution-backend`, `task-execution-protocol` and `viem`, all already allowed).

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/marketplace/binding/src packages/marketplace/pipeline/src/pipeline-ports.test.ts
  git commit -m "refactor(marketplace): re-home the three pipeline-declared ports on the binding surface"
  ```

---

## Task 3: Venue kit part 1 — subject types and the legacy revert-classification fixture table

**Files:**
- Create: `packages/marketplace/testing/src/venue-fixtures.ts`
- Create: `packages/marketplace/testing/src/venue-fixtures.test.ts`
- Modify: `packages/marketplace/testing/src/index.ts`
- Modify: `packages/marketplace/testing/package.json` (add the `./venue-conformance` subpath export)
- Modify: `.github/scripts/marketplace-source-boundaries.test.mjs` (allow the new subpath)
- Modify: `.github/scripts/marketplace-packed-types.test.mjs` (add the new subpath entrypoint)

**Where the kit lives, and why.** The kit is new modules inside `@jinn-network/marketplace-testing`, not a package of
its own and not inside `venue-base`. The tree's documented one-directional rule (see
`.github/scripts/marketplace-package-inventory.test.mjs`'s own comment) is that only the testing package depends on
the components it exercises; a component that devDeps the kit creates a two-way portal cycle that breaks Yarn's
node-modules linker. So: the *behavioral* kit (fixtures + `describe*` drivers) declares its own **subject interfaces**
and imports nothing from `venue-base`, and one runner test (Task 17) inside `marketplace-testing` binds the real
facade. `venue-base`'s own unit tests are plain Vitest against injected stubs.

**Interfaces:**
- Consumes: nothing from `venue-base` (subject-parameterized by design).
- Produces, from `@jinn-network/marketplace-testing/venue-conformance`:
  - `interface VenueRevertFixture { readonly name: string; readonly selector: `0x${string}`; readonly error: unknown; readonly expected: VenueRevertClassification }`
  - `type VenueRevertClassification = "permanent" | "retryable" | "already-settled"`
  - `const VENUE_REVERT_FIXTURES: readonly VenueRevertFixture[]`
  - `interface VenueRevertClassifier { classify(error: unknown): VenueRevertClassification }`
  - `function describeVenueRevertClassification(classifier: VenueRevertClassifier): void`

- [ ] **Step 1: Write the failing test.** Create
  `packages/marketplace/testing/src/venue-fixtures.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe, expect, test } from "vitest";
  import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";
  import {
    VENUE_REVERT_FIXTURES,
    describeVenueRevertClassification,
    type VenueRevertClassification,
  } from "./venue-fixtures.js";

  describe("venue revert-classification fixtures (design §6.6: legacy tables enter as test cases)", () => {
    test("every fixture selector is a decodable inner error the binding already knows", () => {
      for (const fixture of VENUE_REVERT_FIXTURES) {
        if (fixture.selector === "0x") continue;
        expect(KNOWN_INNER_ERRORS[fixture.selector], fixture.name).toBeDefined();
      }
    });

    test("the permanent set covers every router and coordinator custom error the binding decodes", () => {
      const permanent = new Set(
        VENUE_REVERT_FIXTURES.filter((f) => f.expected === "permanent").map((f) => f.name),
      );
      const decodable = Object.values(KNOWN_INNER_ERRORS).map((entry) => entry.name);
      const missing = decodable.filter(
        (name) => name !== "RouterNotDelivered" && !permanent.has(name),
      );
      expect(missing).toEqual([]);
    });

    test("RouterNotDelivered is retryable, not permanent (marketplace state may not have settled yet)", () => {
      const fixture = VENUE_REVERT_FIXTURES.find((f) => f.name === "RouterNotDelivered");
      expect(fixture?.expected).toBe<VenueRevertClassification>("retryable");
    });

    test("RouterAlreadyClaimed classifies already-settled, so an idempotent replay is not an error", () => {
      const fixture = VENUE_REVERT_FIXTURES.find((f) => f.name === "RouterAlreadyClaimed");
      expect(fixture?.expected).toBe<VenueRevertClassification>("already-settled");
    });

    describeVenueRevertClassification({
      classify(error) {
        // A deliberately wrong reference classifier proves the driver actually asserts.
        if (error instanceof SafeInnerRevertError && error.decodedName === "RouterNotDelivered") {
          return "retryable";
        }
        if (error instanceof SafeInnerRevertError && error.decodedName === "RouterAlreadyClaimed") {
          return "already-settled";
        }
        if (error instanceof SafeInnerRevertError) return "permanent";
        const message = error instanceof Error ? error.message : String(error);
        const lower = message.toLowerCase();
        if (lower.includes("gs013") || lower.includes("gs026")) return "permanent";
        if (lower.includes("insufficient funds")) return "permanent";
        return "retryable";
      },
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/testing && yarn vitest run src/venue-fixtures.test.ts`
  Expected: FAIL — `Failed to resolve import "./venue-fixtures.js"`.

- [ ] **Step 3: Write the minimal implementation.** Create
  `packages/marketplace/testing/src/venue-fixtures.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Legacy behavior as fixtures (operator-daemon composition design §6.6). Every case below is
  // derived by READING the legacy oracles -- `client/src/tx-retry.ts`'s PERMANENT set and its
  // recoverable-substring ladder, `client/src/adapters/mech/safe.ts`'s GS013/GS026 handling, and
  // `client/src/adapters/mech/contracts.ts`'s claimDelivery ladder -- and re-expressing them as
  // data. No legacy code is ported; the fresh venue-base implementation must satisfy these.
  import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";
  import { describe, expect, test } from "vitest";
  import type { Hex } from "viem";

  /**
   * `permanent`   — reverts identically on every retry; fail fast and surface the reason.
   * `retryable`   — clears by waiting, refreshing nonce/fees, or hitting a healthy provider.
   * `already-settled` — the intended effect is already on chain; the caller treats it as success.
   */
  export type VenueRevertClassification = "permanent" | "retryable" | "already-settled";

  export interface VenueRevertFixture {
    readonly name: string;
    /** `0x` marks a string-only case with no inner selector. */
    readonly selector: Hex | "0x";
    readonly error: unknown;
    readonly expected: VenueRevertClassification;
  }

  const ALREADY_SETTLED = new Set([
    "RouterAlreadyClaimed",
    "TCAttemptAlreadySubmitted",
    "TCAttemptAlreadyFinalized",
    "TCVerdictAlreadyDelivered",
    "TCRequestAlreadyRegistered",
    "TCAttemptAlreadyRegistered",
    "TCVerdictAlreadyRegistered",
  ]);

  function innerRevert(name: string, selector: Hex): SafeInnerRevertError {
    return new SafeInnerRevertError(
      `Safe execTransaction inner revert: ${name}`,
      selector,
      selector,
      name,
      null,
      null,
    );
  }

  /** One fixture per decodable inner error, plus the undecoded-selector and string-only ladder. */
  export const VENUE_REVERT_FIXTURES: readonly VenueRevertFixture[] = [
    ...Object.entries(KNOWN_INNER_ERRORS).map(([selector, entry]): VenueRevertFixture => ({
      name: entry.name,
      selector: selector as Hex,
      error: innerRevert(entry.name, selector as Hex),
      expected: entry.name === "RouterNotDelivered"
        ? "retryable"
        : ALREADY_SETTLED.has(entry.name)
          ? "already-settled"
          : "permanent",
    })),
    {
      // A deterministic inner revert whose selector we do not decode still reverts identically on
      // every retry (tx-retry.ts: "classify it terminal instead of retrying the wrapping GS013").
      name: "undecoded-inner-selector",
      selector: "0x33f626d3",
      error: new SafeInnerRevertError(
        "Safe execTransaction inner revert (undecoded selector 0x33f626d3)",
        "0x33f626d3",
        "0x33f626d3",
        null,
        null,
        null,
      ),
      expected: "permanent",
    },
    {
      // Bare GS013 with no recoverable inner data: the Safe's inner call reverted deterministically.
      name: "bare-GS013",
      selector: "0x",
      error: new Error("execution reverted: GS013"),
      expected: "permanent",
    },
    {
      // GS026 reaching the shared classifier is terminal; the broadcaster distinguishes a
      // non-owner (terminal) from a valid owner with a stale signed nonce before it gets here.
      name: "bare-GS026",
      selector: "0x",
      error: new Error("execution reverted: GS026"),
      expected: "permanent",
    },
    { name: "insufficient-funds", selector: "0x", error: new Error("insufficient funds for gas * price + value"), expected: "permanent" },
    { name: "user-rejected", selector: "0x", error: new Error("User rejected the request"), expected: "permanent" },
    { name: "nonce-too-low", selector: "0x", error: new Error("nonce too low"), expected: "retryable" },
    { name: "already-known", selector: "0x", error: new Error("already known"), expected: "retryable" },
    { name: "could-not-coalesce", selector: "0x", error: new Error("could not coalesce error"), expected: "retryable" },
    { name: "replacement-underpriced", selector: "0x", error: new Error("replacement transaction underpriced"), expected: "retryable" },
    { name: "replacement-fee-too-low", selector: "0x", error: new Error("replacement fee too low"), expected: "retryable" },
    { name: "transaction-underpriced", selector: "0x", error: new Error("transaction underpriced"), expected: "retryable" },
    { name: "fee-cap-below-base-fee", selector: "0x", error: new Error("fee cap less than block base fee"), expected: "retryable" },
    { name: "max-fee-below-base-fee", selector: "0x", error: new Error("max fee per gas less than block base fee"), expected: "retryable" },
    { name: "econnreset", selector: "0x", error: new Error("read ECONNRESET"), expected: "retryable" },
    { name: "etimedout", selector: "0x", error: new Error("connect ETIMEDOUT"), expected: "retryable" },
    { name: "socket-hang-up", selector: "0x", error: new Error("socket hang up"), expected: "retryable" },
    { name: "fetch-failed", selector: "0x", error: new Error("fetch failed"), expected: "retryable" },
    { name: "connection-refused", selector: "0x", error: new Error("connection refused"), expected: "retryable" },
    { name: "all-providers-failed", selector: "0x", error: new Error("All RPC providers in the fallback chain failed"), expected: "retryable" },
    { name: "no-data-returned", selector: "0x", error: new Error('The contract function "nonce" returned no data ("0x").'), expected: "retryable" },
    { name: "cannot-decode-zero-data", selector: "0x", error: new Error('Cannot decode zero data ("0x") with ABI parameters.'), expected: "retryable" },
    { name: "address-is-not-a-contract", selector: "0x", error: new Error("The address is not a contract."), expected: "retryable" },
    { name: "rate-limited-429", selector: "0x", error: new Error("HTTP 429 Too Many Requests"), expected: "retryable" },
    { name: "internal-json-rpc", selector: "0x", error: new Error("Internal JSON-RPC error (-32603)"), expected: "retryable" },
    { name: "limit-exceeded-32005", selector: "0x", error: new Error("limit exceeded (-32005)"), expected: "retryable" },
    { name: "request-timed-out", selector: "0x", error: new Error("request timed out"), expected: "retryable" },
    { name: "bad-gateway-502", selector: "0x", error: new Error("502 Bad Gateway"), expected: "retryable" },
    { name: "service-unavailable-503", selector: "0x", error: new Error("503 Service Unavailable"), expected: "retryable" },
  ];

  export interface VenueRevertClassifier {
    classify(error: unknown): VenueRevertClassification;
  }

  /** Drives every fixture through a candidate classifier. */
  export function describeVenueRevertClassification(classifier: VenueRevertClassifier): void {
    describe("venue revert classification conformance", () => {
      for (const fixture of VENUE_REVERT_FIXTURES) {
        test(`${fixture.name} classifies ${fixture.expected}`, () => {
          expect(classifier.classify(fixture.error)).toBe(fixture.expected);
        });
      }
    });
  }
  ```

- [ ] **Step 4: Wire the subpath export.** In `packages/marketplace/testing/package.json` add to `exports`:

  ```json
  "./venue-conformance": {
    "import": "./dist/venue-conformance.js",
    "types": "./dist/venue-conformance.d.ts"
  }
  ```

  Create `packages/marketplace/testing/src/venue-conformance.ts` re-exporting the kit's public surface (this file
  grows in Tasks 4, 5 and 17):

  ```ts
  // SPDX-License-Identifier: MIT

  // The venue conformance kit (operator-daemon composition design §6.6). Subject-parameterized:
  // this module imports nothing from `@jinn-network/marketplace-venue-base`, so the kit compiles
  // and its fixtures are authoritative before the implementation exists.
  export {
    VENUE_REVERT_FIXTURES,
    describeVenueRevertClassification,
  } from "./venue-fixtures.js";
  export type {
    VenueRevertClassification,
    VenueRevertClassifier,
    VenueRevertFixture,
  } from "./venue-fixtures.js";
  ```

  Append the same three value exports and four type exports to `packages/marketplace/testing/src/index.ts`.

  In `.github/scripts/marketplace-source-boundaries.test.mjs`, add `'./venue-conformance'` to the `testing` row of
  the root-only-exports test (keeping the array in the same order the manifest declares). In
  `.github/scripts/marketplace-packed-types.test.mjs`, add
  `'@jinn-network/marketplace-testing/venue-conformance'` to `codeEntrypoints`.

- [ ] **Step 5: Run to verify it passes.**

  ```bash
  cd packages/marketplace/testing && yarn vitest run src/venue-fixtures.test.ts && yarn typecheck
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  ```
  Expected: the four assertion tests plus one `describeVenueRevertClassification` test per fixture all pass;
  typecheck zero errors; boundary guard passes.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/marketplace/testing .github/scripts/marketplace-*.test.mjs
  git commit -m "test(marketplace): add the venue kit's legacy revert-classification fixtures"
  ```

---

## Task 4: Venue kit part 2 — broadcast-profile and log-source conformance drivers

**Files:**
- Create: `packages/marketplace/testing/src/venue-broadcast-conformance.ts`
- Create: `packages/marketplace/testing/src/venue-broadcast-conformance.test.ts`
- Create: `packages/marketplace/testing/src/venue-log-source-conformance.ts`
- Create: `packages/marketplace/testing/src/venue-log-source-conformance.test.ts`
- Modify: `packages/marketplace/testing/src/venue-conformance.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `VenueRevertClassification` (Task 3).
- Produces:
  - `interface BroadcastLedgerEntry { readonly chainId: number; readonly from: Address; readonly nonce: number; readonly txHash?: Hex; readonly logicalTx?: string; readonly to?: Address; readonly data?: Hex; readonly submittedAtMs: number; readonly resolvedAtMs?: number; readonly fees: { readonly maxFeePerGas?: bigint; readonly maxPriorityFeePerGas?: bigint; readonly gasPrice?: bigint } }`
  - `interface BroadcastConformanceSubject { submissions(): Promise<readonly BroadcastLedgerEntry[]>; execute(request: { readonly to: Address; readonly value: bigint; readonly data: Hex; readonly logicalTx: string }): Promise<{ readonly txHash: Hex }>; classify(error: unknown): VenueRevertClassification }`
  - `interface BroadcastScenarioChain { failNextSubmissionWith(error: unknown): void; pendingNonce(): number; latestNonce(): number; advanceClock(ms: number): void; minedTxHashes(): readonly Hex[]; replacedAtNonce(nonce: number): readonly Hex[] }`
  - `function describeBroadcastProfileConformance(build: () => Promise<{ subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain }>): void`
  - `interface LogSourceCursor { readonly blockNumber: bigint; readonly blockHash: Hex }`
  - `interface LogSourceConformanceSubject { poll(): Promise<{ readonly logs: readonly { readonly blockNumber: bigint; readonly blockHash: Hex }[]; readonly cursor: LogSourceCursor; readonly finalizedCheckpoint: LogSourceCursor; readonly reorg?: { readonly rolledBackTo: LogSourceCursor; readonly orphanedBlockHashes: readonly Hex[] } }>; close(): void }`
  - `interface LogSourceScenarioChain { requestedRanges(): readonly { readonly fromBlock: bigint; readonly toBlock: bigint }[]; mine(count: number): void; setFinalized(blockNumber: bigint): void; reorgFrom(blockNumber: bigint): void }`
  - `function describeLogSourceConformance(build: () => Promise<{ subject: LogSourceConformanceSubject; chain: LogSourceScenarioChain; chunkBlocks: bigint }>): void`

- [ ] **Step 1: Write the failing tests.** Create
  `packages/marketplace/testing/src/venue-broadcast-conformance.test.ts` with a reference in-memory subject that
  implements the relayer profile so the driver is proved to assert:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe, expect, test } from "vitest";
  import type { Address, Hex } from "viem";
  import {
    describeBroadcastProfileConformance,
    type BroadcastConformanceSubject,
    type BroadcastScenarioChain,
  } from "./venue-broadcast-conformance.js";

  const FROM = "0x1111111111111111111111111111111111111111" as Address;

  describe("broadcast-profile conformance driver (design §7 ruling 1)", () => {
    test("the driver rejects a subject that never records a submission ledger entry", async () => {
      const bare: BroadcastConformanceSubject = {
        async submissions() { return []; },
        async execute() { return { txHash: `0x${"f".repeat(64)}` as Hex }; },
        classify() { return "retryable"; },
      };
      await expect(
        (async () => {
          const entries = await bare.submissions();
          expect(entries.length).toBeGreaterThan(0);
        })(),
      ).rejects.toThrow();
    });

    describeBroadcastProfileConformance(async () => {
      const { buildReferenceBroadcaster } = await import("./venue-broadcast-reference.js");
      return buildReferenceBroadcaster({ from: FROM });
    });
  });
  ```

  Create the reference subject `packages/marketplace/testing/src/venue-broadcast-reference.ts` — a small
  in-memory relayer that satisfies the profile (serialized nonce assignment, ledger row per
  `(chainId, from, nonce)`, `+15%` replacement bump, stuck-nonce self-send after the stale window,
  nonce refresh on `nonce too low` and reconcile against the ledger's own already-mined tx). Roughly 120 lines; the
  driver in Step 3 pins its exact obligations.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/testing && yarn vitest run src/venue-broadcast-conformance.test.ts`
  Expected: FAIL — `Failed to resolve import "./venue-broadcast-conformance.js"`.

- [ ] **Step 3: Write the conformance driver.** Create
  `packages/marketplace/testing/src/venue-broadcast-conformance.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // The named Defender-relayer profile as executable obligations (design §7 ruling 1): per-sender
  // serialized nonce assignment, a persistent (chainId, from, nonce) submission ledger,
  // fee-bumped replacement, stuck-nonce eviction, reconcile-on-nonce-too-low. Every scenario is
  // derived from the legacy oracles `client/src/tx-retry.ts` and
  // `client/src/adapters/mech/safe.ts` -- as cases, never as ported code (design §6.6).
  import { describe, expect, test } from "vitest";
  import type { Address, Hex } from "viem";
  import type { VenueRevertClassification } from "./venue-fixtures.js";

  export interface BroadcastLedgerEntry {
    readonly chainId: number;
    readonly from: Address;
    readonly nonce: number;
    readonly txHash?: Hex;
    readonly logicalTx?: string;
    readonly to?: Address;
    readonly data?: Hex;
    readonly submittedAtMs: number;
    readonly resolvedAtMs?: number;
    readonly fees: {
      readonly maxFeePerGas?: bigint;
      readonly maxPriorityFeePerGas?: bigint;
      readonly gasPrice?: bigint;
    };
  }

  export interface BroadcastConformanceSubject {
    submissions(): Promise<readonly BroadcastLedgerEntry[]>;
    execute(request: {
      readonly to: Address;
      readonly value: bigint;
      readonly data: Hex;
      readonly logicalTx: string;
    }): Promise<{ readonly txHash: Hex }>;
    classify(error: unknown): VenueRevertClassification;
  }

  export interface BroadcastScenarioChain {
    failNextSubmissionWith(error: unknown): void;
    pendingNonce(): number;
    latestNonce(): number;
    advanceClock(ms: number): void;
    minedTxHashes(): readonly Hex[];
    replacedAtNonce(nonce: number): readonly Hex[];
  }

  const TO = "0x2222222222222222222222222222222222222222" as Address;
  const DATA = "0xdeadbeef" as Hex;

  export function describeBroadcastProfileConformance(
    build: () => Promise<{ subject: BroadcastConformanceSubject; chain: BroadcastScenarioChain }>,
  ): void {
    describe("Safe broadcast relayer-profile conformance", () => {
      test("records one durable ledger row keyed (chainId, from, nonce) before the tx resolves", async () => {
        const { subject } = await build();
        const receipt = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
        const entries = await subject.submissions();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.txHash).toBe(receipt.txHash);
        expect(entries[0]!.logicalTx).toBe("claim");
        expect(entries[0]!.to).toBe(TO);
        expect(entries[0]!.data).toBe(DATA);
        expect(entries[0]!.resolvedAtMs).toBeGreaterThan(0);
      });

      test("assigns strictly increasing nonces when two logical operations run concurrently", async () => {
        const { subject } = await build();
        await Promise.all([
          subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
          subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" }),
        ]);
        const nonces = (await subject.submissions()).map((entry) => entry.nonce).sort((a, b) => a - b);
        expect(nonces).toEqual([nonces[0], nonces[0]! + 1]);
      });

      test("a `nonce too low` failure refreshes the pinned nonce instead of resubmitting the stale one", async () => {
        const { subject, chain } = await build();
        chain.failNextSubmissionWith(new Error("nonce too low"));
        await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
        const entries = await subject.submissions();
        const used = entries.map((entry) => entry.nonce);
        expect(new Set(used).size).toBe(used.length);
        expect(Math.max(...used)).toBe(chain.latestNonce() - 1);
      });

      test("`nonce too low` reconciles against this call's own already-mined ledger tx and does not re-sign", async () => {
        const { subject, chain } = await build();
        const first = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
        chain.failNextSubmissionWith(new Error("nonce too low"));
        const replay = await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
        expect(replay.txHash).toBe(first.txHash);
        expect(chain.minedTxHashes().filter((hash) => hash === first.txHash)).toHaveLength(1);
      });

      test("`replacement transaction underpriced` re-submits at the same nonce with a bumped fee", async () => {
        const { subject, chain } = await build();
        chain.failNextSubmissionWith(new Error("replacement transaction underpriced"));
        await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
        const entries = await subject.submissions();
        const nonce = entries[0]!.nonce;
        const replacements = chain.replacedAtNonce(nonce);
        expect(replacements.length).toBeGreaterThanOrEqual(2);
        const bumped = entries.at(-1)!.fees.maxFeePerGas ?? entries.at(-1)!.fees.gasPrice ?? 0n;
        const original = entries[0]!.fees.maxFeePerGas ?? entries[0]!.fees.gasPrice ?? 0n;
        expect(bumped * 10000n).toBeGreaterThanOrEqual(original * 11500n);
      });

      test("a stuck nonce older than the stale window is evicted by a self-send before the next assignment", async () => {
        const { subject, chain } = await build();
        chain.failNextSubmissionWith(new Error("socket hang up"));
        chain.advanceClock(130_000);
        await subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
        const recovery = (await subject.submissions()).find(
          (entry) => entry.logicalTx === "stuck-nonce-recovery",
        );
        expect(recovery).toBeDefined();
        expect(recovery!.value ?? 0n).toBe(0n);
        expect(recovery!.resolvedAtMs).toBeGreaterThan(0);
        expect(chain.pendingNonce()).toBe(chain.latestNonce());
      });

      test("a permanent inner revert fails fast without burning the retry budget", async () => {
        const { subject, chain } = await build();
        const permanent = new Error("execution reverted: GS013");
        chain.failNextSubmissionWith(permanent);
        await expect(
          subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
        ).rejects.toThrow(/GS013/u);
        expect(subject.classify(permanent)).toBe("permanent");
      });
    });
  }
  ```

  (`BroadcastLedgerEntry` gains an optional `value?: bigint` member used by the eviction assertion; declare it in the
  interface.)

- [ ] **Step 4: Write the log-source driver.** Create
  `packages/marketplace/testing/src/venue-log-source-conformance.ts` with the interfaces named in this task's
  **Produces** block and this driver body:

  ```ts
  export function describeLogSourceConformance(
    build: () => Promise<{
      subject: LogSourceConformanceSubject;
      chain: LogSourceScenarioChain;
      chunkBlocks: bigint;
    }>,
  ): void {
    describe("chain log-source conformance (design §7 ruling 2)", () => {
      test("never requests a range wider than the configured provider chunk cap", async () => {
        const { subject, chain, chunkBlocks } = await build();
        chain.mine(Number(chunkBlocks) * 3 + 17);
        await subject.poll();
        for (const range of chain.requestedRanges()) {
          expect(range.toBlock - range.fromBlock + 1n).toBeLessThanOrEqual(chunkBlocks);
        }
        subject.close();
      });

      test("requested ranges tile the scanned span exactly once, with no gap and no overlap", async () => {
        const { subject, chain, chunkBlocks } = await build();
        chain.mine(Number(chunkBlocks) * 2 + 5);
        await subject.poll();
        const ranges = [...chain.requestedRanges()].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
        for (let index = 1; index < ranges.length; index += 1) {
          expect(ranges[index]!.fromBlock).toBe(ranges[index - 1]!.toBlock + 1n);
        }
        subject.close();
      });

      test("the live cursor tracks latest while the durable checkpoint advances only on finalized", async () => {
        const { subject, chain } = await build();
        chain.mine(40);
        chain.setFinalized(12n);
        const batch = await subject.poll();
        expect(batch.cursor.blockNumber).toBeGreaterThan(batch.finalizedCheckpoint.blockNumber);
        expect(batch.finalizedCheckpoint.blockNumber).toBe(12n);
        subject.close();
      });

      test("the cursor carries the block hash it was taken at", async () => {
        const { subject, chain } = await build();
        chain.mine(10);
        const batch = await subject.poll();
        expect(batch.cursor.blockHash).toMatch(/^0x[0-9a-f]{64}$/u);
        expect(batch.finalizedCheckpoint.blockHash).toMatch(/^0x[0-9a-f]{64}$/u);
        subject.close();
      });

      test("a cursor-hash mismatch rolls back to the finalized checkpoint and re-scans", async () => {
        const { subject, chain } = await build();
        chain.mine(40);
        chain.setFinalized(12n);
        await subject.poll();
        chain.reorgFrom(20n);
        const batch = await subject.poll();
        expect(batch.reorg).toBeDefined();
        expect(batch.reorg!.rolledBackTo.blockNumber).toBe(12n);
        expect(batch.reorg!.orphanedBlockHashes.length).toBeGreaterThan(0);
        expect(batch.logs.every((log) => log.blockNumber > 12n)).toBe(true);
        subject.close();
      });

      test("a reorg strictly inside the finalized span is never rolled back below the checkpoint", async () => {
        const { subject, chain } = await build();
        chain.mine(40);
        chain.setFinalized(30n);
        await subject.poll();
        chain.reorgFrom(35n);
        const batch = await subject.poll();
        expect(batch.reorg!.rolledBackTo.blockNumber).toBe(30n);
        subject.close();
      });

      test("polling is resumable: a fresh subject over the same state resumes at the persisted cursor", async () => {
        const { subject, chain } = await build();
        chain.mine(30);
        const first = await subject.poll();
        subject.close();
        const { subject: resumed } = await build();
        const second = await resumed.poll();
        expect(second.cursor.blockNumber).toBeGreaterThanOrEqual(first.cursor.blockNumber);
        expect(chain.requestedRanges().every((range) => range.fromBlock >= 0n)).toBe(true);
        resumed.close();
      });
    });
  }
  ```

  Create `packages/marketplace/testing/src/venue-log-source-conformance.test.ts` binding a small in-memory
  reference chain + source so the driver is proved to assert (same pattern as Step 1).

- [ ] **Step 5: Run to verify both drivers pass against their references.**

  ```bash
  cd packages/marketplace/testing && yarn vitest run src/venue-broadcast-conformance.test.ts src/venue-log-source-conformance.test.ts && yarn typecheck
  ```
  Expected: 7 broadcast obligations + 7 log-source obligations pass; typecheck zero errors.

- [ ] **Step 6: Re-export and commit.** Append both drivers' value and type exports to
  `packages/marketplace/testing/src/venue-conformance.ts` and `src/index.ts`.

  ```bash
  git add packages/marketplace/testing
  git commit -m "test(marketplace): add broadcast-profile and log-source conformance drivers to the venue kit"
  ```

---

## Task 5: Venue kit part 3 — the Anvil-fork integration backbone

**Files:**
- Create: `packages/marketplace/testing/src/venue-fork.ts`
- Create: `packages/marketplace/testing/src/venue-fork.test.ts`
- Modify: `packages/marketplace/testing/src/venue-conformance.ts`, `src/index.ts`

**Interfaces:**
- Consumes: `MarketplaceChainConfig`, `TASK_COORDINATOR_ABI` from `@jinn-network/marketplace-binding`.
- Produces:
  - `interface ForkVenueDeployment { readonly rpcUrl: string; readonly chain: MarketplaceChainConfig; readonly account: Address; readonly mech: Address; readonly safe: Address; readonly stateDbPath: string }`
  - `function withForkVenue<T>(options: { readonly generation: "today" | "revised"; readonly run: (deployment: ForkVenueDeployment) => Promise<T> }): Promise<T>`
  - `function anvilAvailable(): Promise<boolean>`
  - `interface ForkVenueSubject { claim(taskId: bigint): Promise<{ readonly attemptIndex: number; readonly requestId?: Hex; readonly txHash: Hex }>; settle(input: { readonly requestId: Hex; readonly deliveryBytes: Uint8Array }): Promise<{ readonly settled: boolean }>; close(): void }`
  - `function describeForkVenueConformance(build: (deployment: ForkVenueDeployment) => Promise<ForkVenueSubject>): void`

**Backbone shape.** `withForkVenue` reproduces `escrow-lifecycle.test.ts`'s proven sequence — spawn
`anvil --fork-url <JINN_MARKETPLACE_FORK_RPC_URL ?? https://base-sepolia.publicnode.com> --port <9700 + pid%500>
--silent`, poll `eth_chainId` for readiness with a 12 s cap, deploy `TaskCoordinator` + `JinnRouterV3` +
`MockTaskMarketplace` + `MockTaskActivityChecker` + `MockTaskMechWithDelivery` from
`contracts/artifacts/…` (or their V4 equivalents when `generation === "revised"`), `initialize` both, mint a
`stateDbPath` under `mkdtemp`, then `run(deployment)` inside `try`/`finally { anvil.kill(); rm(stateDir) }`. It uses
the well-known Anvil dev key — the one place in this plan where a private key literal appears, and it is in
`marketplace-testing`, never in `venue-base`.

- [ ] **Step 1: Write the failing test.** Create `packages/marketplace/testing/src/venue-fork.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe, expect, test } from "vitest";
  import { createPublicClient, http } from "viem";
  import { anvilAvailable, withForkVenue } from "./venue-fork.js";

  const hasAnvil = await anvilAvailable();

  describe.runIf(hasAnvil)("Anvil-fork venue backbone (design §6.6)", () => {
    test("deploys a today-generation venue and hands back a usable chain config", async () => {
      await withForkVenue({
        generation: "today",
        async run(deployment) {
          expect(deployment.chain.generation).toBe("today");
          expect(deployment.chain.jinnRouter).toMatch(/^0x[0-9a-fA-F]{40}$/u);
          expect(deployment.chain.taskCoordinator).toMatch(/^0x[0-9a-fA-F]{40}$/u);
          expect(deployment.stateDbPath.endsWith(".db")).toBe(true);
          const client = createPublicClient({ transport: http(deployment.rpcUrl) });
          const code = await client.getCode({ address: deployment.chain.jinnRouter });
          expect(code).not.toBe("0x");
        },
      });
    }, 90_000);

    test("tears the fork down: the RPC port is closed after the run resolves", async () => {
      let url = "";
      await withForkVenue({ generation: "today", async run(deployment) { url = deployment.rpcUrl; } });
      const client = createPublicClient({ transport: http(url) });
      await expect(client.getBlockNumber()).rejects.toThrow();
    }, 90_000);
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/testing && yarn vitest run src/venue-fork.test.ts`
  Expected: FAIL — `Failed to resolve import "./venue-fork.js"` (or, with Anvil absent, the whole `describe.runIf`
  block is skipped and the import failure is still reported).

- [ ] **Step 3: Write the backbone.** Create `packages/marketplace/testing/src/venue-fork.ts` implementing
  `anvilAvailable`, `withForkVenue` and `describeForkVenueConformance`. `describeForkVenueConformance` runs, against
  a real fork, the end-to-end legs the fresh adapters must satisfy:

  ```ts
  export function describeForkVenueConformance(
    build: (deployment: ForkVenueDeployment) => Promise<ForkVenueSubject>,
  ): void {
    describe.runIf(hasAnvil)("venue adapters against a forked chain", () => {
      test("a claim writes a TaskAttemptCreated attempt and returns its index and requestId", async () => {
        await withForkVenue({ generation: "today", async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment);
            const claim = await subject.claim(taskId);
            expect(claim.attemptIndex).toBe(0);
            expect(claim.requestId).toMatch(/^0x[0-9a-f]{64}$/u);
            expect(claim.txHash).toMatch(/^0x[0-9a-f]{64}$/u);
          } finally { subject.close(); }
        } });
      }, 120_000);

      test("a second claim on a one-slot task surfaces the decoded TCMaxClaimsReached inner revert", async () => {
        await withForkVenue({ generation: "today", async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment, { maxClaims: 1 });
            await subject.claim(taskId);
            await expect(subject.claim(taskId)).rejects.toThrow(/TCMaxClaimsReached|TCOperatorClaimLimitReached/u);
          } finally { subject.close(); }
        } });
      }, 120_000);

      test("settlement of a delivered attempt succeeds once and is idempotent on replay", async () => {
        await withForkVenue({ generation: "today", async run(deployment) {
          const subject = await build(deployment);
          try {
            const taskId = await postFixtureTask(deployment);
            const claim = await subject.claim(taskId);
            const deliveryBytes = await deliverFixture(deployment, claim.requestId!);
            const first = await subject.settle({ requestId: claim.requestId!, deliveryBytes });
            expect(first.settled).toBe(true);
            const replay = await subject.settle({ requestId: claim.requestId!, deliveryBytes });
            expect(replay.settled).toBe(true);
          } finally { subject.close(); }
        } });
      }, 180_000);

      test("two concurrent writes through one Safe both land, at consecutive EOA nonces", async () => {
        await withForkVenue({ generation: "today", async run(deployment) {
          const subject = await build(deployment);
          try {
            const [a, b] = await Promise.all([postFixtureTask(deployment), postFixtureTask(deployment)]);
            const claims = await Promise.all([subject.claim(a), subject.claim(b)]);
            expect(new Set(claims.map((claim) => claim.txHash)).size).toBe(2);
          } finally { subject.close(); }
        } });
      }, 180_000);
    });
  }
  ```

  `postFixtureTask` and `deliverFixture` are module-local helpers reusing the exact `createTask` /
  `deliverToMarketplace` calls `escrow-lifecycle.test.ts` already proves work against these artifacts.

- [ ] **Step 4: Run to verify it passes.**

  ```bash
  cd packages/marketplace/testing && yarn vitest run src/venue-fork.test.ts
  ```
  Expected (Anvil present): both backbone tests pass inside 90 s each. Expected (Anvil absent): 2 skipped, 0 failed —
  the suite must skip cleanly, never fail, on a machine without Foundry.

- [ ] **Step 5: Re-export and commit.**

  ```bash
  git add packages/marketplace/testing
  git commit -m "test(marketplace): add the Anvil-fork integration backbone to the venue kit"
  ```

---

## Task 6: Venue state — the SQLite WAL schema for the ledger, cursors, intents and lock

**Files:**
- Create: `packages/marketplace/venue-base/src/config.ts`
- Create: `packages/marketplace/venue-base/src/state/schema.ts`
- Create: `packages/marketplace/venue-base/src/state/database.ts`
- Create: `packages/marketplace/venue-base/src/state/database.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `MarketplaceChainConfig` (`@jinn-network/marketplace-binding`), `Address`, `PublicClient`, `WalletClient`
  (`viem`), `better-sqlite3`.
- Produces:
  - `const VENUE_STATE_SCHEMA_VERSION = 1`
  - `interface BaseVenueConfig { readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly walletClient: WalletClient; readonly safeAddress: Address; readonly stateDbPath: string; readonly priorityMech: Address; readonly pin: IpfsPinPort["pin"]; readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"]; readonly isAuthorizedMechOrigin: (address: Address) => boolean; readonly logSource?: ChainLogSourceOptions; readonly broadcast?: SafeBroadcastOptions; readonly finality?: FinalityWaiterOptions; readonly deliveryWait?: DeliveryWaiterOptions }`
  - `interface VenueStateDatabase { readonly db: Database.Database; transaction<T>(fn: () => T): T; close(): void }`
  - `function openVenueState(stateDbPath: string): VenueStateDatabase`
  - `class VenueStateError extends Error`

**The schema, in full.** One file, four tables plus metadata. Storage location is `stateDbPath`, always supplied by
the host; nothing here reads an environment variable or a home directory.

```sql
CREATE TABLE venue_state_metadata (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
);

-- The persistent submission ledger of the relayer profile (design §7 ruling 1), keyed exactly
-- (chainId, from, nonce). One row per EOA nonce; `tx_hash` is the latest submission at that
-- nonce (a fee-bumped replacement overwrites it), `resolved_at_ms` marks it mined.
CREATE TABLE tx_submissions (
  chain_id INTEGER NOT NULL,
  from_address TEXT NOT NULL,
  nonce INTEGER NOT NULL CHECK (nonce >= 0),
  tx_hash TEXT,
  logical_tx TEXT,
  to_address TEXT,
  value_wei TEXT,
  data TEXT,
  max_fee_per_gas TEXT,
  max_priority_fee_per_gas TEXT,
  gas_price TEXT,
  submitted_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  PRIMARY KEY (chain_id, from_address, nonce)
);

CREATE INDEX tx_submissions_unresolved
  ON tx_submissions (chain_id, from_address, nonce)
  WHERE resolved_at_ms IS NULL;

-- The dual-mark chain cursor (design §7 ruling 2). One row per logical stream; `live_*` tracks
-- `latest` and `finalized_*` is the durable checkpoint a reorg rolls back to. Both carry the
-- block hash so the next poll can verify the cursor still sits on the canonical chain.
CREATE TABLE log_cursors (
  stream TEXT PRIMARY KEY,
  chain_id INTEGER NOT NULL,
  live_block_number INTEGER NOT NULL CHECK (live_block_number >= 0),
  live_block_hash TEXT NOT NULL,
  finalized_block_number INTEGER NOT NULL CHECK (finalized_block_number >= 0),
  finalized_block_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (finalized_block_number <= live_block_number)
);

-- Blocks orphaned by an observed reorg. The projector's append-only correction path
-- (`selectCanonicalMarketplaceObservations`) reads this set; rows are never deleted, because a
-- retraction already emitted must stay explicable.
CREATE TABLE orphaned_blocks (
  chain_id INTEGER NOT NULL,
  block_hash TEXT NOT NULL,
  block_number INTEGER NOT NULL CHECK (block_number >= 0),
  observed_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, block_hash)
);

-- The transactional outbox (design §7 ruling 4). The idempotency key is the LOGICAL operation
-- identity carried by the sealed Submission -- never a tx hash. A row is written in the same
-- transaction as the motivating state change, strictly before broadcast; the sweeper drains
-- unresolved rows through the Safe broadcaster.
CREATE TABLE posting_intents (
  creator_safe TEXT NOT NULL,
  task_cid_digest TEXT NOT NULL,
  submission_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_task_id TEXT,
  resolved_tx_hash TEXT,
  PRIMARY KEY (creator_safe, task_cid_digest, submission_digest),
  CHECK ((resolved_task_id IS NULL) = (resolved_tx_hash IS NULL))
);

CREATE INDEX posting_intents_pending
  ON posting_intents (created_at)
  WHERE resolved_tx_hash IS NULL;

-- The cross-process broadcast lock. One row per sender EOA; a lease expires so a crashed holder
-- never wedges the sender forever.
CREATE TABLE broadcast_locks (
  chain_id INTEGER NOT NULL,
  sender TEXT NOT NULL,
  holder TEXT NOT NULL,
  acquired_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (chain_id, sender)
);
```

- [ ] **Step 1: Write the failing test.** Create
  `packages/marketplace/venue-base/src/state/database.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { mkdtempSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import Database from "better-sqlite3";
  import { afterEach, beforeEach, describe, expect, test } from "vitest";
  import { VENUE_STATE_SCHEMA_VERSION, openVenueState } from "./database.js";

  let root: string;
  let path: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "venue-state-"));
    path = join(root, "venue.db");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  describe("venue state database", () => {
    test("creates the file, enables WAL and records the schema version", () => {
      const state = openVenueState(path);
      try {
        expect(state.db.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(state.db.pragma("foreign_keys", { simple: true })).toBe(1);
        const row = state.db.prepare("SELECT schema_version FROM venue_state_metadata WHERE singleton = 1").get() as
          { schema_version: number } | undefined;
        expect(row?.schema_version).toBe(VENUE_STATE_SCHEMA_VERSION);
      } finally { state.close(); }
    });

    test("is idempotent: reopening an existing file leaves the schema and data intact", () => {
      const first = openVenueState(path);
      first.db.prepare(
        "INSERT INTO tx_submissions (chain_id, from_address, nonce, submitted_at_ms) VALUES (?, ?, ?, ?)",
      ).run(84532, "0x1111111111111111111111111111111111111111", 3, 1);
      first.close();
      const second = openVenueState(path);
      try {
        const count = second.db.prepare("SELECT COUNT(*) AS n FROM tx_submissions").get() as { n: number };
        expect(count.n).toBe(1);
      } finally { second.close(); }
    });

    test("declares all five tables plus metadata", () => {
      const state = openVenueState(path);
      try {
        const names = (state.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as
          { name: string }[]).map((row) => row.name).filter((name) => !name.startsWith("sqlite_")).sort();
        expect(names).toEqual([
          "broadcast_locks", "log_cursors", "orphaned_blocks",
          "posting_intents", "tx_submissions", "venue_state_metadata",
        ]);
      } finally { state.close(); }
    });

    test("rejects a state file written by a newer schema version", () => {
      const raw = new Database(path);
      raw.exec(
        "CREATE TABLE venue_state_metadata (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),"
        + " schema_version INTEGER NOT NULL, created_at_ms INTEGER NOT NULL);"
        + " INSERT INTO venue_state_metadata VALUES (1, 99, 0);",
      );
      raw.close();
      expect(() => openVenueState(path)).toThrow(/schema version 99/u);
    });

    test("the log_cursors CHECK refuses a finalized mark ahead of the live cursor", () => {
      const state = openVenueState(path);
      try {
        expect(() => state.db.prepare(
          "INSERT INTO log_cursors (stream, chain_id, live_block_number, live_block_hash,"
          + " finalized_block_number, finalized_block_hash, updated_at_ms) VALUES (?,?,?,?,?,?,?)",
        ).run("venue", 84532, 10, `0x${"a".repeat(64)}`, 20, `0x${"b".repeat(64)}`, 1)).toThrow(/CHECK/u);
      } finally { state.close(); }
    });

    test("the posting_intents CHECK refuses a half-resolved outbox row", () => {
      const state = openVenueState(path);
      try {
        expect(() => state.db.prepare(
          "INSERT INTO posting_intents (creator_safe, task_cid_digest, submission_digest,"
          + " idempotency_key, owner_token, created_at, resolved_task_id, resolved_tx_hash)"
          + " VALUES (?,?,?,?,?,?,?,?)",
        ).run("0x11", "sha256:aa", "sha256:bb", "k", "t", "2026-07-30T00:00:00Z", "7", null))
          .toThrow(/CHECK/u);
      } finally { state.close(); }
    });

    test("transaction() rolls the whole unit back on throw", () => {
      const state = openVenueState(path);
      try {
        expect(() => state.transaction(() => {
          state.db.prepare(
            "INSERT INTO tx_submissions (chain_id, from_address, nonce, submitted_at_ms) VALUES (?,?,?,?)",
          ).run(84532, "0x11", 1, 1);
          throw new Error("boom");
        })).toThrow("boom");
        const count = state.db.prepare("SELECT COUNT(*) AS n FROM tx_submissions").get() as { n: number };
        expect(count.n).toBe(0);
      } finally { state.close(); }
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/state/database.test.ts`
  Expected: FAIL — `Failed to resolve import "./database.js"`.

- [ ] **Step 3: Write the minimal implementation.** Create
  `packages/marketplace/venue-base/src/state/schema.ts` holding `VENUE_STATE_SCHEMA_VERSION = 1 as const` and the
  `SCHEMA_SQL` template literal containing the SQL block above verbatim. Then
  `packages/marketplace/venue-base/src/state/database.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // The one durable state file every venue adapter shares. Its location is a host parameter
  // (`BaseVenueConfig.stateDbPath`) -- this package never derives a path from the environment or
  // a home directory. WAL + synchronous=FULL matches the stack's SQLite precedent
  // (`packages/evidence/catalog-sqlite/src/database.ts`).
  import { mkdirSync } from "node:fs";
  import { dirname } from "node:path";
  import Database from "better-sqlite3";
  import { SCHEMA_SQL, VENUE_STATE_SCHEMA_VERSION } from "./schema.js";

  export { VENUE_STATE_SCHEMA_VERSION };

  export class VenueStateError extends Error {
    override readonly name = "VenueStateError";
  }

  export interface VenueStateDatabase {
    readonly db: Database.Database;
    transaction<T>(fn: () => T): T;
    close(): void;
  }

  function applyPragmas(db: Database.Database): void {
    db.pragma("foreign_keys = ON");
    const journalMode = db.pragma("journal_mode = WAL", { simple: true });
    if (journalMode !== "wal") {
      throw new VenueStateError(`venue state requires WAL journaling; SQLite reported "${String(journalMode)}"`);
    }
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");
    db.pragma("trusted_schema = OFF");
  }

  function readSchemaVersion(db: Database.Database): number | undefined {
    const present = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'venue_state_metadata'",
    ).get();
    if (present === undefined) return undefined;
    const row = db.prepare(
      "SELECT schema_version AS version FROM venue_state_metadata WHERE singleton = 1",
    ).get() as { version: number } | undefined;
    return row?.version;
  }

  /** Opens (creating if absent) the venue state file. Idempotent; safe to call on every boot. */
  export function openVenueState(stateDbPath: string): VenueStateDatabase {
    mkdirSync(dirname(stateDbPath), { recursive: true });
    const db = new Database(stateDbPath);
    try {
      applyPragmas(db);
      const version = readSchemaVersion(db);
      if (version === undefined) {
        db.exec("BEGIN IMMEDIATE");
        try {
          db.exec(SCHEMA_SQL);
          db.prepare(
            "INSERT INTO venue_state_metadata (singleton, schema_version, created_at_ms) VALUES (1, ?, ?)",
          ).run(VENUE_STATE_SCHEMA_VERSION, Date.now());
          db.exec("COMMIT");
        } catch (cause) {
          db.exec("ROLLBACK");
          throw cause;
        }
      } else if (version !== VENUE_STATE_SCHEMA_VERSION) {
        throw new VenueStateError(
          `venue state at ${stateDbPath} declares schema version ${version}; this build understands `
          + `${VENUE_STATE_SCHEMA_VERSION}. Refusing to read or migrate it.`,
        );
      }
    } catch (cause) {
      db.close();
      throw cause;
    }

    return {
      db,
      transaction<T>(fn: () => T): T {
        return db.transaction(fn)();
      },
      close() {
        db.close();
      },
    };
  }
  ```

  Create `packages/marketplace/venue-base/src/config.ts` declaring `BaseVenueConfig` per this task's **Produces**
  block, with each optional options interface declared as an empty extension point the later tasks fill in
  (`export interface ChainLogSourceOptions {}` etc. become real in Tasks 7–14). Export `openVenueState`,
  `VenueStateError`, `VENUE_STATE_SCHEMA_VERSION` and `type BaseVenueConfig` from `src/index.ts`.

- [ ] **Step 4: Run to verify it passes.**

  ```bash
  cd packages/marketplace/venue-base && yarn vitest run src/state/database.test.ts && yarn typecheck
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  ```
  Expected: 7 tests pass; typecheck zero errors; the host-path guard passes (`dirname(stateDbPath)` is the only
  filesystem write and no `homedir` appears).

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src
  git commit -m "feat(venue-base): add the SQLite WAL state schema for ledger, cursors, intents and locks"
  ```

---

## Task 7: Broadcast core — revert classification, fee policy, nonce ledger and the cross-process lock

**Files:**
- Create: `packages/marketplace/venue-base/src/broadcast/classify.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/classify.test.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/fees.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/fees.test.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/ledger.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/ledger.test.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/lock.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/lock.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `SafeInnerRevertError`, `KNOWN_INNER_ERRORS` (`@jinn-network/marketplace-binding`); `VenueStateDatabase`
  (Task 6).
- Produces:
  - `type VenueRevertClassification = "permanent" | "retryable" | "already-settled"`
  - `function classifyBroadcastError(error: unknown): VenueRevertClassification`
  - `function isNonceTooLow(error: unknown): boolean`
  - `function isReplacementUnderpriced(error: unknown): boolean`
  - `function flattenError(error: unknown): string`
  - `const BROADCAST_DEFAULTS = { maxAttempts: 6, baseDelayMs: 400, maxDelayMs: 12_000, feeBumpBpsPerAttempt: 1500, replacementBumpBps: 1500, stuckNonceAfterMs: 120_000, lockLeaseMs: 60_000 } as const`
  - `interface FeeSnapshot { readonly maxFeePerGas?: bigint; readonly maxPriorityFeePerGas?: bigint; readonly gasPrice?: bigint }`
  - `function bumpFees(current: FeeSnapshot, previous: FeeSnapshot | undefined, attemptIndex: number): FeeSnapshot`
  - `interface SubmissionKey { readonly chainId: number; readonly from: Address; readonly nonce: number }`
  - `interface SubmissionRecord extends SubmissionKey { readonly txHash?: Hex; readonly logicalTx?: string; readonly to?: Address; readonly value?: bigint; readonly data?: Hex; readonly fees: FeeSnapshot; readonly submittedAtMs: number; readonly resolvedAtMs?: number }`
  - `interface SubmissionLedger { get(key: SubmissionKey): SubmissionRecord | undefined; record(entry: SubmissionRecord): void; markResolved(key: SubmissionKey, resolvedAtMs: number): void; unresolvedBetween(chainId: number, from: Address, fromNonce: number, toNonce: number): readonly SubmissionRecord[] }`
  - `function createSubmissionLedger(state: VenueStateDatabase): SubmissionLedger`
  - `interface BroadcastLock { withSender<T>(chainId: number, sender: Address, fn: () => Promise<T>): Promise<T> }`
  - `function createBroadcastLock(state: VenueStateDatabase, options?: { readonly leaseMs?: number; readonly holderId?: string; readonly now?: () => number }): BroadcastLock`

- [ ] **Step 1: Write the failing classification test.** Create
  `packages/marketplace/venue-base/src/broadcast/classify.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe, expect, test } from "vitest";
  import { SafeInnerRevertError } from "@jinn-network/marketplace-binding";
  import {
    classifyBroadcastError,
    isNonceTooLow,
    isReplacementUnderpriced,
  } from "./classify.js";

  describe("broadcast error classification (venue kit fixture obligations)", () => {
    test("a decoded permanent inner revert is permanent", () => {
      const error = new SafeInnerRevertError(
        "Safe execTransaction inner revert: TCMaxClaimsReached",
        "0x90386e7c", "0x90386e7c", "TCMaxClaimsReached", null, null,
      );
      expect(classifyBroadcastError(error)).toBe("permanent");
    });

    test("RouterNotDelivered is retryable: marketplace state may not have settled yet", () => {
      const error = new SafeInnerRevertError(
        "Safe execTransaction inner revert: RouterNotDelivered",
        "0xe5a88624", "0xe5a88624", "RouterNotDelivered", null, null,
      );
      expect(classifyBroadcastError(error)).toBe("retryable");
    });

    test("RouterAlreadyClaimed is already-settled, not an error", () => {
      const error = new SafeInnerRevertError(
        "Safe execTransaction inner revert: RouterAlreadyClaimed",
        "0x22d686d9", "0x22d686d9", "RouterAlreadyClaimed", null, null,
      );
      expect(classifyBroadcastError(error)).toBe("already-settled");
    });

    test("an undecoded but deterministic inner selector is permanent, never retried forever", () => {
      const error = new SafeInnerRevertError(
        "Safe execTransaction inner revert (undecoded selector 0x33f626d3)",
        "0x33f626d3", "0x33f626d3", null, null, null,
      );
      expect(classifyBroadcastError(error)).toBe("permanent");
    });

    test("bare GS013 and GS026 are permanent", () => {
      expect(classifyBroadcastError(new Error("execution reverted: GS013"))).toBe("permanent");
      expect(classifyBroadcastError(new Error("execution reverted: GS026"))).toBe("permanent");
    });

    test("insufficient funds and user rejection are permanent", () => {
      expect(classifyBroadcastError(new Error("insufficient funds for gas * price + value"))).toBe("permanent");
      expect(classifyBroadcastError(new Error("User rejected the request"))).toBe("permanent");
    });

    test("nonce, replacement, transport and provider-throttle failures are retryable", () => {
      for (const message of [
        "nonce too low", "already known", "could not coalesce error",
        "replacement transaction underpriced", "fee cap less than block base fee",
        "read ECONNRESET", "socket hang up", "fetch failed",
        "All RPC providers in the fallback chain failed",
        'The contract function "nonce" returned no data ("0x").',
        "HTTP 429 Too Many Requests", "503 Service Unavailable",
      ]) {
        expect(classifyBroadcastError(new Error(message)), message).toBe("retryable");
      }
    });

    test("nested causes are flattened before matching", () => {
      const error = new Error("outer", { cause: new Error("nonce too low") });
      expect(isNonceTooLow(error)).toBe(true);
      expect(classifyBroadcastError(error)).toBe("retryable");
    });

    test("the two nonce predicates are distinct", () => {
      expect(isNonceTooLow(new Error("nonce too low"))).toBe(true);
      expect(isReplacementUnderpriced(new Error("nonce too low"))).toBe(false);
      expect(isReplacementUnderpriced(new Error("replacement fee too low"))).toBe(true);
      expect(isNonceTooLow(new Error("replacement fee too low"))).toBe(false);
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/classify.test.ts`
  Expected: FAIL — `Failed to resolve import "./classify.js"`.

- [ ] **Step 3: Write the classifier.** Create
  `packages/marketplace/venue-base/src/broadcast/classify.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Written fresh against the venue kit's fixture table (design §6.6). The legacy
  // `client/src/tx-retry.ts` is the behavioral oracle those fixtures were derived from; no line of
  // it is ported here.
  import { KNOWN_INNER_ERRORS, SafeInnerRevertError } from "@jinn-network/marketplace-binding";

  export type VenueRevertClassification = "permanent" | "retryable" | "already-settled";

  export const BROADCAST_DEFAULTS = {
    maxAttempts: 6,
    baseDelayMs: 400,
    maxDelayMs: 12_000,
    /** Extra bump per retry attempt after the first, in basis points. */
    feeBumpBpsPerAttempt: 1500,
    /** Minimum bump over the previously submitted fee for same-nonce replacement. */
    replacementBumpBps: 1500,
    stuckNonceAfterMs: 120_000,
    lockLeaseMs: 60_000,
  } as const;

  /**
   * Inner reverts whose effect is already on chain. The caller treats them as success rather
   * than as failure -- a replayed settlement or a duplicate registration is the intended state.
   */
  const ALREADY_SETTLED_INNER = new Set([
    "RouterAlreadyClaimed",
    "TCAttemptAlreadyRegistered",
    "TCAttemptAlreadySubmitted",
    "TCAttemptAlreadyFinalized",
    "TCRequestAlreadyRegistered",
    "TCVerdictAlreadyRegistered",
    "TCVerdictAlreadyDelivered",
  ]);

  /** The one inner revert that clears by waiting: the Mech delivery has not landed yet. */
  const RETRYABLE_INNER = new Set(["RouterNotDelivered"]);

  const PERMANENT_SUBSTRINGS = [
    "insufficient funds",
    "user rejected",
    "user denied",
    "rejected the request",
    "gs013",
    "gs026",
  ];

  const RETRYABLE_SUBSTRINGS = [
    "nonce too low",
    "already known",
    "could not coalesce",
    "replacement transaction underpriced",
    "replacement fee too low",
    "transaction underpriced",
    "fee cap less than block base fee",
    "max fee per gas less than block base fee",
    "econnreset",
    "etimedout",
    "socket hang up",
    "fetch failed",
    "network error",
    "connection refused",
    "connect timeout",
    "all rpc providers in the fallback chain failed",
    'returned no data ("0x")',
    "cannot decode zero data",
    "the address is not a contract",
    "429",
    "rate limit",
    "too many requests",
    "-32603",
    "internal json-rpc error",
    "-32005",
    "request timed out",
    "timeout",
    "bad gateway",
    "service unavailable",
    "502",
    "503",
  ];

  /** Flattens an error and its `cause` chain into one lowercase-matchable string. */
  export function flattenError(error: unknown): string {
    if (error === null || error === undefined) return String(error);
    if (typeof error === "string") return error;
    if (error instanceof Error) {
      const withCause = error as Error & { cause?: unknown };
      return withCause.cause === undefined || withCause.cause === null
        ? error.message
        : `${error.message} | ${flattenError(withCause.cause)}`;
    }
    if (typeof error === "object") {
      const record = error as Record<string, unknown>;
      const parts = [record["shortMessage"], record["details"], record["message"]]
        .filter((part): part is string => typeof part === "string");
      if (parts.length > 0) return [...new Set(parts)].join(" | ");
    }
    return String(error);
  }

  export function isNonceTooLow(error: unknown): boolean {
    return flattenError(error).toLowerCase().includes("nonce too low");
  }

  export function isReplacementUnderpriced(error: unknown): boolean {
    const lower = flattenError(error).toLowerCase();
    return lower.includes("replacement transaction underpriced")
      || lower.includes("replacement fee too low")
      || lower.includes("transaction underpriced");
  }

  function classifyInnerRevert(error: SafeInnerRevertError): VenueRevertClassification {
    const { decodedName } = error;
    if (decodedName !== null) {
      if (ALREADY_SETTLED_INNER.has(decodedName)) return "already-settled";
      if (RETRYABLE_INNER.has(decodedName)) return "retryable";
      if (KNOWN_INNER_ERRORS[error.innerSelector?.toLowerCase() ?? ""] !== undefined) return "permanent";
      return "permanent";
    }
    // No decoded name but a captured selector: the inner call reverts deterministically and will
    // revert identically on every retry. Classifying it permanent is what stops the wrapping
    // GS013 from being retried forever.
    if (error.innerSelector !== null) return "permanent";
    return "retryable";
  }

  export function classifyBroadcastError(error: unknown): VenueRevertClassification {
    if (error instanceof SafeInnerRevertError) return classifyInnerRevert(error);
    const lower = flattenError(error).toLowerCase();
    for (const substring of PERMANENT_SUBSTRINGS) {
      if (lower.includes(substring)) return "permanent";
    }
    for (const substring of RETRYABLE_SUBSTRINGS) {
      if (lower.includes(substring)) return "retryable";
    }
    return "permanent";
  }
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/classify.test.ts`
  Expected: 9 tests pass.

- [ ] **Step 5: Write the failing fee test, then `fees.ts`.**
  `packages/marketplace/venue-base/src/broadcast/fees.test.ts` asserts: attempt 0 with no previous returns the
  estimate unchanged; attempt `n > 0` multiplies by `10000 + 1500n` basis points with ceiling division; a previous
  snapshot forces at least `+15%` over the previous fee even when the fresh estimate dropped; EIP-1559 and legacy
  `gasPrice` never mix in one result; and an empty estimate with an empty previous yields `{}`.

  `fees.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { BROADCAST_DEFAULTS } from "./classify.js";

  export interface FeeSnapshot {
    readonly maxFeePerGas?: bigint;
    readonly maxPriorityFeePerGas?: bigint;
    readonly gasPrice?: bigint;
  }

  function mulDivCeil(value: bigint, numerator: bigint, denominator: bigint): bigint {
    return (value * numerator + denominator - 1n) / denominator;
  }

  function replacementBump(value: bigint): bigint {
    return mulDivCeil(value, 10_000n + BigInt(BROADCAST_DEFAULTS.replacementBumpBps), 10_000n);
  }

  function attemptBump(value: bigint, attemptIndex: number): bigint {
    if (attemptIndex <= 0) return value;
    const bps = BigInt(BROADCAST_DEFAULTS.feeBumpBpsPerAttempt) * BigInt(attemptIndex);
    return mulDivCeil(value, 10_000n + bps, 10_000n);
  }

  function maxOf(...values: readonly (bigint | undefined)[]): bigint | undefined {
    const present = values.filter((value): value is bigint => value !== undefined);
    if (present.length === 0) return undefined;
    return present.reduce((max, value) => (value > max ? value : max), present[0]!);
  }

  /**
   * The relayer profile's fee-bumped replacement (design §7 ruling 1): a resubmission at the same
   * nonce must clear both the fresh estimate for this attempt AND the +15% replacement floor over
   * whatever was last submitted at that nonce.
   */
  export function bumpFees(
    current: FeeSnapshot,
    previous: FeeSnapshot | undefined,
    attemptIndex: number,
  ): FeeSnapshot {
    if (current.gasPrice !== undefined || previous?.gasPrice !== undefined) {
      const gasPrice = maxOf(
        current.gasPrice === undefined ? undefined : attemptBump(current.gasPrice, attemptIndex),
        previous?.gasPrice === undefined ? undefined : replacementBump(previous.gasPrice),
      );
      return gasPrice === undefined ? {} : { gasPrice };
    }
    const maxFeePerGas = maxOf(
      current.maxFeePerGas === undefined ? undefined : attemptBump(current.maxFeePerGas, attemptIndex),
      previous?.maxFeePerGas === undefined ? undefined : replacementBump(previous.maxFeePerGas),
    );
    const maxPriorityFeePerGas = maxOf(
      current.maxPriorityFeePerGas === undefined
        ? undefined
        : attemptBump(current.maxPriorityFeePerGas, attemptIndex),
      previous?.maxPriorityFeePerGas === undefined
        ? undefined
        : replacementBump(previous.maxPriorityFeePerGas),
    );
    return maxFeePerGas !== undefined && maxPriorityFeePerGas !== undefined
      ? { maxFeePerGas, maxPriorityFeePerGas }
      : {};
  }
  ```

  Run: `yarn vitest run src/broadcast/fees.test.ts` — FAIL first, then PASS.

- [ ] **Step 6: Write the failing ledger test, then `ledger.ts`.**
  `ledger.test.ts` asserts: `record` then `get` round-trips every field including `bigint` fees stored as TEXT;
  a second `record` at the same `(chainId, from, nonce)` **overwrites** (a fee-bumped replacement is the same logical
  slot); `markResolved` sets `resolvedAtMs` and `get` reflects it; `unresolvedBetween` returns only rows with a NULL
  `resolvedAtMs` inside the half-open nonce range, ordered ascending; and a closed-then-reopened database still
  returns the row (durability across process restart).

  `ledger.ts` implements `createSubmissionLedger(state)` with prepared statements over `tx_submissions`, storing
  `bigint` as decimal TEXT and reading it back with `BigInt(...)`, and lowercasing `from`/`to` on write so key lookups
  are case-stable.

  Run: `yarn vitest run src/broadcast/ledger.test.ts` — FAIL first, then PASS.

- [ ] **Step 7: Write the failing lock test, then `lock.ts`.**
  `lock.test.ts` asserts: two `withSender` calls on the same `(chainId, sender)` in one process serialize (the second
  body starts only after the first resolves); calls on different senders proceed concurrently; a rejected body still
  releases the lease; a second `VenueStateDatabase` handle on the **same file** blocks while the first holds the
  lease (the cross-process case, simulated with two handles); and an expired lease is stealable so a crashed holder
  never wedges the sender.

  `lock.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  // Cross-process broadcast serialization (design §6.1 "cross-process lock"). Two independent
  // nonce stacks against one Safe and one EOA is the #525/#562/#897 failure class; the
  // single-broadcaster rule excludes it inside one process, and this lease excludes it across
  // processes sharing one state file.
  import { randomUUID } from "node:crypto";
  import type { Address } from "viem";
  import { BROADCAST_DEFAULTS } from "./classify.js";
  import type { VenueStateDatabase } from "../state/database.js";

  export interface BroadcastLock {
    withSender<T>(chainId: number, sender: Address, fn: () => Promise<T>): Promise<T>;
  }

  export interface BroadcastLockOptions {
    readonly leaseMs?: number;
    readonly holderId?: string;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  }

  export function createBroadcastLock(
    state: VenueStateDatabase,
    options: BroadcastLockOptions = {},
  ): BroadcastLock {
    const leaseMs = options.leaseMs ?? BROADCAST_DEFAULTS.lockLeaseMs;
    const holderId = options.holderId ?? randomUUID();
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    // In-process queue: SQLite gives us cross-process exclusion, this gives us fair ordering and
    // avoids every loop in one daemon spinning on the same row.
    const queues = new Map<string, Promise<unknown>>();

    const acquire = state.db.prepare(
      "INSERT INTO broadcast_locks (chain_id, sender, holder, acquired_at_ms, expires_at_ms)"
      + " VALUES (@chainId, @sender, @holder, @acquiredAtMs, @expiresAtMs)"
      + " ON CONFLICT (chain_id, sender) DO UPDATE SET"
      + "   holder = excluded.holder, acquired_at_ms = excluded.acquired_at_ms,"
      + "   expires_at_ms = excluded.expires_at_ms"
      + " WHERE broadcast_locks.expires_at_ms <= @acquiredAtMs",
    );
    const release = state.db.prepare(
      "DELETE FROM broadcast_locks WHERE chain_id = ? AND sender = ? AND holder = ?",
    );

    async function acquireLease(chainId: number, sender: Address): Promise<void> {
      for (;;) {
        const at = now();
        const result = acquire.run({
          chainId,
          sender: sender.toLowerCase(),
          holder: holderId,
          acquiredAtMs: at,
          expiresAtMs: at + leaseMs,
        });
        if (result.changes > 0) return;
        await sleep(25);
      }
    }

    return {
      async withSender<T>(chainId, sender, fn) {
        const key = `${chainId}:${sender.toLowerCase()}`;
        const prior = queues.get(key) ?? Promise.resolve();
        let releaseQueue!: () => void;
        const gate = new Promise<void>((resolve) => { releaseQueue = resolve; });
        queues.set(key, gate);
        await prior.catch(() => undefined);
        try {
          await acquireLease(chainId, sender);
          try {
            return await fn();
          } finally {
            release.run(chainId, sender.toLowerCase(), holderId);
          }
        } finally {
          releaseQueue();
          if (queues.get(key) === gate) queues.delete(key);
        }
      },
    };
  }
  ```

  Run: `yarn vitest run src/broadcast/lock.test.ts` — FAIL first, then PASS.

- [ ] **Step 8: Run the whole package suite, typecheck and guards.**

  ```bash
  cd packages/marketplace/venue-base && yarn typecheck && yarn test
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  ```
  Expected: every suite green; typecheck zero errors; boundary + key-material + host-path guards pass.

- [ ] **Step 9: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src
  git commit -m "feat(venue-base): add revert classification, fee bumping, submission ledger and broadcast lock"
  ```

---

## Task 8: The Safe broadcaster — the single transaction path

**Files:**
- Create: `packages/marketplace/venue-base/src/broadcast/safe-broadcaster.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/safe-broadcaster.test.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/stuck-nonce.ts`
- Create: `packages/marketplace/venue-base/src/broadcast/stuck-nonce.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `SAFE_ABI`, `SafeInnerRevertError`, `decodeSafeInnerRevert`, `formatDecodedRevert`, `SafeBroadcastPort`,
  `PostingOutcome`, `JINN_ROUTER_V3_ABI` (`@jinn-network/marketplace-binding`); `classifyBroadcastError`,
  `isNonceTooLow`, `isReplacementUnderpriced`, `bumpFees`, `BROADCAST_DEFAULTS`, `SubmissionLedger`, `BroadcastLock`
  (Task 7); `VenueStateDatabase` (Task 6).
- Produces:
  - `interface SafeBroadcastRequest { readonly to: Address; readonly value: bigint; readonly data: Hex; readonly logicalTx: string }`
  - `interface SafeBroadcastReceipt { readonly txHash: Hex; readonly blockNumber: bigint; readonly blockHash: Hex; readonly logs: readonly Log[]; readonly alreadySettled: boolean }`
  - `interface BaseVenueSafeBroadcaster extends SafeBroadcastPort { execute(request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt>; classify(error: unknown): VenueRevertClassification }`
  - `interface SafeBroadcastOptions { readonly maxAttempts?: number; readonly baseDelayMs?: number; readonly maxDelayMs?: number; readonly stuckNonceAfterMs?: number; readonly now?: () => number; readonly sleep?: (ms: number) => Promise<void> }`
  - `function createSafeBroadcaster(input: { readonly chainId: number; readonly safeAddress: Address; readonly publicClient: PublicClient; readonly walletClient: WalletClient; readonly ledger: SubmissionLedger; readonly lock: BroadcastLock; readonly options?: SafeBroadcastOptions }): BaseVenueSafeBroadcaster`
  - `function evictStuckNonce(input: { readonly chainId: number; readonly from: Address; readonly publicClient: PublicClient; readonly walletClient: WalletClient; readonly ledger: SubmissionLedger; readonly staleAfterMs: number; readonly nowMs: number }): Promise<{ readonly nonce: number; readonly recoveryTxHash: Hex } | undefined>`

**Two hand-rolled fragments, cited.** The `eth_sign` `v`-adjustment (`signature[64] += 4`) and the pre-validated
approved-hash signature encoding (`r = signer address, s = 0, v = 1`) are **Safe-contract-specified behavior**, not
inventions: `GnosisSafe.checkNSignatures` treats `v > 30` as an `eth_sign`-prefixed signature and `v == 1` as a
pre-validated (approved-hash or `msg.sender`) signature. Both call sites carry a comment citing the Safe contracts
specification, as ruling 1 requires. The GS013 wrapper (`require(success || safeTxGas != 0 || gasPrice != 0, "GS013")`)
is why an inner revert must be recovered by re-simulating the inner call as a static `eth_call` from the Safe address —
`decodeSafeInnerRevert` in the binding already does exactly that and is reused, not reimplemented.

- [ ] **Step 1: Write the failing test.** Create
  `packages/marketplace/venue-base/src/broadcast/safe-broadcaster.test.ts`. It builds a scripted fake
  `PublicClient`/`WalletClient` pair (`readContract` answering `nonce`/`getTransactionHash`/`isOwner`,
  `estimateFeesPerGas`, `getTransactionCount` for `pending`/`latest`, `waitForTransactionReceipt`,
  `getTransactionReceipt`, `call`) plus a real `openVenueState` on a temp file:

  ```ts
  // SPDX-License-Identifier: MIT

  import { mkdtempSync, rmSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
  import type { Address, Hex } from "viem";
  import { openVenueState, type VenueStateDatabase } from "../state/database.js";
  import { createSubmissionLedger } from "./ledger.js";
  import { createBroadcastLock } from "./lock.js";
  import { createSafeBroadcaster } from "./safe-broadcaster.js";
  import { buildScriptedChain } from "./scripted-chain.fixture.js";

  const SAFE = "0x5afe000000000000000000000000000000000000" as Address;
  const TO = "0x2222222222222222222222222222222222222222" as Address;
  const DATA = "0xdeadbeef" as Hex;

  let root: string;
  let state: VenueStateDatabase;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "venue-broadcast-"));
    state = openVenueState(join(root, "venue.db"));
  });
  afterEach(() => { state.close(); rmSync(root, { recursive: true, force: true }); });

  function broadcaster(chain: ReturnType<typeof buildScriptedChain>) {
    return createSafeBroadcaster({
      chainId: 84532,
      safeAddress: SAFE,
      publicClient: chain.publicClient,
      walletClient: chain.walletClient,
      ledger: createSubmissionLedger(state),
      lock: createBroadcastLock(state, { now: chain.now, sleep: chain.sleep }),
      options: { now: chain.now, sleep: chain.sleep },
    });
  }

  describe("Safe broadcaster (design §6.1 Safe broadcast, §7 ruling 1)", () => {
    test("signs with the eth_sign v-adjustment and records the ledger row before waiting", async () => {
      const chain = buildScriptedChain();
      const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      expect(receipt.txHash).toBe(chain.minedTxHashes()[0]);
      const signature = chain.lastSignature();
      expect(signature).toBeDefined();
      // Safe contracts spec: checkNSignatures treats v > 30 as an eth_sign-prefixed signature.
      expect(Number.parseInt(signature!.slice(-2), 16)).toBeGreaterThan(30);
      const row = createSubmissionLedger(state).get({ chainId: 84532, from: chain.from, nonce: 0 });
      expect(row?.txHash).toBe(receipt.txHash);
      expect(row?.logicalTx).toBe("claim");
      expect(row?.to).toBe(SAFE.toLowerCase());
      expect(row?.resolvedAtMs).toBeGreaterThan(0);
    });

    test("passes value through to execTransaction so escrow-carrying calls fund correctly", async () => {
      const chain = buildScriptedChain();
      await broadcaster(chain).execute({ to: TO, value: 7n, data: DATA, logicalTx: "post" });
      expect(chain.lastWrite()?.value).toBe(7n);
      expect(chain.lastWrite()?.args?.[1]).toBe(7n);
    });

    test("serializes two concurrent executes: nonce N then N+1, never N twice", async () => {
      const chain = buildScriptedChain();
      const subject = broadcaster(chain);
      await Promise.all([
        subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
        subject.execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" }),
      ]);
      expect(chain.submittedNonces()).toEqual([0, 1]);
    });

    test("nonce too low refreshes the pinned nonce and re-signs at the fresh value", async () => {
      const chain = buildScriptedChain();
      chain.failNextWriteWith(new Error("nonce too low"));
      chain.setPendingNonce(4);
      await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      expect(chain.submittedNonces().at(-1)).toBe(4);
    });

    test("nonce too low reconciles against this call's own mined ledger tx instead of re-signing", async () => {
      const chain = buildScriptedChain();
      const ledger = createSubmissionLedger(state);
      const priorHash = `0x${"c".repeat(64)}` as Hex;
      chain.seedMinedTx(priorHash, 0);
      ledger.record({
        chainId: 84532, from: chain.from, nonce: 0, txHash: priorHash,
        logicalTx: "settle", to: SAFE.toLowerCase() as Address, value: 0n, data: DATA,
        fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, submittedAtMs: 1,
      });
      chain.failNextWriteWith(new Error("nonce too low"));
      const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
      expect(receipt.txHash).toBe(priorHash);
      expect(chain.writeCount()).toBe(1); // the failed attempt only; no re-sign
    });

    test("a ledger row for a DIFFERENT logical tx at the same nonce is never adopted", async () => {
      const chain = buildScriptedChain();
      const ledger = createSubmissionLedger(state);
      const foreignHash = `0x${"d".repeat(64)}` as Hex;
      chain.seedMinedTx(foreignHash, 0);
      ledger.record({
        chainId: 84532, from: chain.from, nonce: 0, txHash: foreignHash,
        logicalTx: "identity.setMetadata", to: SAFE.toLowerCase() as Address, value: 0n,
        data: "0xfeedface" as Hex, fees: {}, submittedAtMs: 1,
      });
      chain.failNextWriteWith(new Error("nonce too low"));
      chain.setPendingNonce(1);
      const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
      expect(receipt.txHash).not.toBe(foreignHash);
    });

    test("replacement underpriced re-submits at the same nonce with at least a 15% bump", async () => {
      const chain = buildScriptedChain();
      chain.failNextWriteWith(new Error("replacement transaction underpriced"));
      await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      const fees = chain.submittedFees();
      expect(fees).toHaveLength(2);
      expect(fees[1]!.maxFeePerGas! * 10_000n).toBeGreaterThanOrEqual(fees[0]!.maxFeePerGas! * 11_500n);
    });

    test("a decoded permanent inner revert throws SafeInnerRevertError without retrying", async () => {
      const chain = buildScriptedChain();
      chain.setInnerRevert("0x90386e7c");
      chain.failEveryWriteWith(new Error("execution reverted: GS013"));
      await expect(
        broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
      ).rejects.toThrow(/TCMaxClaimsReached/u);
      expect(chain.writeCount()).toBe(1);
    });

    test("an already-settled inner revert resolves as alreadySettled instead of throwing", async () => {
      const chain = buildScriptedChain();
      chain.setInnerRevert("0x22d686d9"); // RouterAlreadyClaimed
      chain.failEveryWriteWith(new Error("execution reverted: GS013"));
      const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "settle" });
      expect(receipt.alreadySettled).toBe(true);
    });

    test("GS026 with a non-owner signer is terminal and names the repair", async () => {
      const chain = buildScriptedChain({ signerIsOwner: false });
      chain.failEveryWriteWith(new Error("execution reverted: GS026"));
      await expect(
        broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" }),
      ).rejects.toThrow(/signing key is not a Safe owner/u);
    });

    test("a mined-but-reverted receipt with no inner revert re-reads the nonce and re-signs", async () => {
      const chain = buildScriptedChain();
      chain.revertNextReceipt();
      const receipt = await broadcaster(chain).execute({ to: TO, value: 0n, data: DATA, logicalTx: "claim" });
      expect(chain.writeCount()).toBe(2);
      expect(receipt.txHash).toBe(chain.minedTxHashes().at(-1));
    });

    test("broadcastCreateTask decodes TaskCreated from the receipt and returns the PostingOutcome", async () => {
      const chain = buildScriptedChain();
      chain.emitTaskCreated(42n);
      const outcome = await broadcaster(chain).broadcastCreateTask({
        safeAddress: SAFE, to: TO, value: 4n, data: DATA,
      });
      expect(outcome.taskId).toBe(42n);
      expect(outcome.txHash).toBe(chain.minedTxHashes().at(-1));
    });
  });
  ```

  Create the fixture `packages/marketplace/venue-base/src/broadcast/scripted-chain.fixture.ts` exporting
  `buildScriptedChain(options?: { signerIsOwner?: boolean })` — a deterministic, in-memory viem-client double with the
  introspection helpers the assertions use (`from`, `now`, `sleep`, `minedTxHashes`, `submittedNonces`,
  `submittedFees`, `lastSignature`, `lastWrite`, `writeCount`, `failNextWriteWith`, `failEveryWriteWith`,
  `setPendingNonce`, `seedMinedTx`, `setInnerRevert`, `revertNextReceipt`, `emitTaskCreated`). It never touches the
  network and never holds a private key — `signMessage` returns a fixed 65-byte hex string.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/safe-broadcaster.test.ts`
  Expected: FAIL — `Failed to resolve import "./safe-broadcaster.js"`.

- [ ] **Step 3: Write `stuck-nonce.ts` first (the broadcaster calls it).**

  ```ts
  // SPDX-License-Identifier: MIT

  // Stuck-nonce eviction, the relayer profile's fourth obligation (design §7 ruling 1). When the
  // pending nonce runs ahead of the latest nonce and the ledger's own row at the lowest gap has
  // been unresolved past the stale window, replace it with a zero-value self-send at that exact
  // nonce so the sender unblocks. NOTE (plan finding 2): "eviction" here is stuck-nonce eviction,
  // never OLAS service eviction -- the legacy re-stake-on-failure path was deliberately removed
  // (#773) and is not reintroduced.
  import type { Address, Hex, PublicClient, WalletClient } from "viem";
  import { bumpFees } from "./fees.js";
  import type { SubmissionLedger } from "./ledger.js";

  export interface EvictStuckNonceInput {
    readonly chainId: number;
    readonly from: Address;
    readonly publicClient: PublicClient;
    readonly walletClient: WalletClient;
    readonly ledger: SubmissionLedger;
    readonly staleAfterMs: number;
    readonly nowMs: number;
  }

  export async function evictStuckNonce(
    input: EvictStuckNonceInput,
  ): Promise<{ readonly nonce: number; readonly recoveryTxHash: Hex } | undefined> {
    const [pending, latest] = await Promise.all([
      input.publicClient.getTransactionCount({ address: input.from, blockTag: "pending" }),
      input.publicClient.getTransactionCount({ address: input.from, blockTag: "latest" }),
    ]);
    if (pending <= latest) return undefined;

    for (const entry of input.ledger.unresolvedBetween(input.chainId, input.from, latest, pending)) {
      if (input.nowMs - entry.submittedAtMs < input.staleAfterMs) continue;
      const estimate = await input.publicClient.estimateFeesPerGas();
      const fees = bumpFees(
        {
          ...(estimate.maxFeePerGas === undefined ? {} : { maxFeePerGas: estimate.maxFeePerGas }),
          ...(estimate.maxPriorityFeePerGas === undefined
            ? {}
            : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
        },
        entry.fees,
        1,
      );
      const account = input.walletClient.account;
      if (account === undefined) throw new Error("wallet client has no injected account");
      const recoveryTxHash = await input.walletClient.sendTransaction({
        account,
        chain: input.walletClient.chain ?? null,
        to: input.from,
        value: 0n,
        nonce: entry.nonce,
        ...fees,
      });
      input.ledger.record({
        chainId: input.chainId,
        from: input.from,
        nonce: entry.nonce,
        txHash: recoveryTxHash,
        logicalTx: "stuck-nonce-recovery",
        to: input.from,
        value: 0n,
        fees,
        submittedAtMs: input.nowMs,
      });
      await input.publicClient.waitForTransactionReceipt({ hash: recoveryTxHash });
      input.ledger.markResolved(
        { chainId: input.chainId, from: input.from, nonce: entry.nonce },
        input.nowMs,
      );
      return { nonce: entry.nonce, recoveryTxHash };
    }
    return undefined;
  }
  ```

  Its own test (`stuck-nonce.test.ts`) asserts: no gap → `undefined`, no self-send; a gap whose ledger row is younger
  than the window → `undefined`; a gap whose row is stale → one zero-value self-send at that exact nonce, recorded as
  `stuck-nonce-recovery` and marked resolved; the recovery fee is at least `+15%` over the stuck row's fee; only the
  lowest stale nonce is evicted per call.

- [ ] **Step 4: Write `safe-broadcaster.ts`.**

  ```ts
  // SPDX-License-Identifier: MIT

  // The single transaction path (design §6.1 single-broadcaster rule). Every venue writer -- claim,
  // settlement, lifecycle, posting -- funnels through `execute`. Two independent nonce stacks
  // against one Safe and one EOA is the #525/#562/#897 failure class; it is excluded here by
  // construction: one lock, one ledger, one nonce assignment.
  import {
    JINN_ROUTER_V3_ABI,
    SAFE_ABI,
    SafeInnerRevertError,
    decodeSafeInnerRevert,
    formatDecodedRevert,
    type PostingOutcome,
    type SafeBroadcastPort,
  } from "@jinn-network/marketplace-binding";
  import { decodeEventLog, type Address, type Hex, type Log, type PublicClient, type WalletClient } from "viem";
  import {
    BROADCAST_DEFAULTS,
    classifyBroadcastError,
    flattenError,
    isNonceTooLow,
    isReplacementUnderpriced,
    type VenueRevertClassification,
  } from "./classify.js";
  import { bumpFees, type FeeSnapshot } from "./fees.js";
  import type { BroadcastLock } from "./lock.js";
  import type { SubmissionLedger } from "./ledger.js";
  import { evictStuckNonce } from "./stuck-nonce.js";

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

  export interface SafeBroadcastRequest {
    readonly to: Address;
    readonly value: bigint;
    readonly data: Hex;
    /** Logical operation identity; stored in the ledger so reconciliation never adopts a foreign tx. */
    readonly logicalTx: string;
  }

  export interface SafeBroadcastReceipt {
    readonly txHash: Hex;
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
    readonly logs: readonly Log[];
    /** True when the inner call reverted because its effect is already on chain. */
    readonly alreadySettled: boolean;
  }

  export interface SafeBroadcastOptions {
    readonly maxAttempts?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly stuckNonceAfterMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number) => Promise<void>;
  }

  export interface BaseVenueSafeBroadcaster extends SafeBroadcastPort {
    execute(request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt>;
    classify(error: unknown): VenueRevertClassification;
  }

  /**
   * Pre-validated (approved-hash) signature encoding: `r` = the signer address, `s` = 0, `v` = 1.
   * Safe contracts specification, `checkNSignatures`: `v == 1` means the signature is
   * pre-validated by `approvedHashes[owner][hash]` or by `owner == msg.sender`. Exported for the
   * callers that need the approved-hash form rather than the eth_sign form.
   */
  export function encodePreValidatedSignature(signer: Address): Hex {
    const r = signer.toLowerCase().replace("0x", "").padStart(64, "0");
    return `0x${r}${"0".repeat(64)}01` as Hex;
  }

  /**
   * eth_sign `v` adjustment. Safe contracts specification, `checkNSignatures`: `v > 30` marks a
   * signature produced over the `"\x19Ethereum Signed Message:\n32"`-prefixed hash, so an EOA
   * `personal_sign` result must have 4 added to its recovery id before the Safe will accept it.
   */
  function toSafeEthSignSignature(signature: Hex): Hex {
    const bytes = Buffer.from(signature.slice(2), "hex");
    if (bytes.length !== 65) {
      throw new Error(`expected a 65-byte signature, received ${bytes.length} bytes`);
    }
    bytes[64] = bytes[64]! + 4;
    return `0x${bytes.toString("hex")}` as Hex;
  }

  export function createSafeBroadcaster(input: {
    readonly chainId: number;
    readonly safeAddress: Address;
    readonly publicClient: PublicClient;
    readonly walletClient: WalletClient;
    readonly ledger: SubmissionLedger;
    readonly lock: BroadcastLock;
    readonly options?: SafeBroadcastOptions;
  }): BaseVenueSafeBroadcaster {
    const options = input.options ?? {};
    const maxAttempts = options.maxAttempts ?? BROADCAST_DEFAULTS.maxAttempts;
    const baseDelayMs = options.baseDelayMs ?? BROADCAST_DEFAULTS.baseDelayMs;
    const maxDelayMs = options.maxDelayMs ?? BROADCAST_DEFAULTS.maxDelayMs;
    const stuckNonceAfterMs = options.stuckNonceAfterMs ?? BROADCAST_DEFAULTS.stuckNonceAfterMs;
    const now = options.now ?? (() => Date.now());
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    const account = input.walletClient.account;
    if (account === undefined) {
      throw new Error("venue-base requires an injected WalletClient account (signer-injection only)");
    }
    const from = account.address;

    async function estimateFees(previous: FeeSnapshot | undefined, attemptIndex: number): Promise<FeeSnapshot> {
      try {
        const estimate = await input.publicClient.estimateFeesPerGas();
        return bumpFees(
          {
            ...(estimate.maxFeePerGas === undefined ? {} : { maxFeePerGas: estimate.maxFeePerGas }),
            ...(estimate.maxPriorityFeePerGas === undefined
              ? {}
              : { maxPriorityFeePerGas: estimate.maxPriorityFeePerGas }),
          },
          previous,
          attemptIndex,
        );
      } catch {
        const gasPrice = await input.publicClient.getGasPrice();
        return bumpFees({ gasPrice }, previous, attemptIndex);
      }
    }

    async function decodeInner(request: SafeBroadcastRequest, txHash: Hex | null): Promise<SafeInnerRevertError | undefined> {
      const inner = await decodeSafeInnerRevert(input.publicClient, {
        safeAddress: input.safeAddress,
        to: request.to,
        value: request.value,
        data: request.data,
      });
      if (inner.decodedName !== null) {
        return new SafeInnerRevertError(
          `Safe execTransaction inner revert: ${formatDecodedRevert(inner.decodedName, inner.decodedArgs)}`,
          inner.innerSelector, inner.innerData, inner.decodedName, inner.decodedArgs, txHash,
        );
      }
      if (inner.innerSelector !== null) {
        return new SafeInnerRevertError(
          `Safe execTransaction inner revert (undecoded selector ${inner.innerSelector})`,
          inner.innerSelector, inner.innerData, null, null, txHash,
        );
      }
      return undefined;
    }

    async function assertSignerIsOwner(): Promise<void> {
      const isOwner = await input.publicClient.readContract({
        address: input.safeAddress, abi: SAFE_ABI, functionName: "isOwner", args: [from],
      });
      if (isOwner !== true) {
        throw new Error(
          "Safe execTransaction rejected (GS026: invalid owner — signing key is not a Safe owner). "
          + "Repair the Safe owner set or repoint the agent signing key to a current owner.",
        );
      }
    }

    /** The reconcile step: adopt the ledger's tx at this nonce only when it is provably ours. */
    async function reconcile(nonce: number, request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt | undefined> {
      const existing = input.ledger.get({ chainId: input.chainId, from, nonce });
      if (existing?.txHash === undefined) return undefined;
      const ours = existing.logicalTx === request.logicalTx
        && existing.to?.toLowerCase() === input.safeAddress.toLowerCase()
        && existing.data?.toLowerCase() === request.data.toLowerCase();
      if (!ours) return undefined;
      try {
        const receipt = await input.publicClient.getTransactionReceipt({ hash: existing.txHash });
        if (receipt.status !== "success") return undefined;
        input.ledger.markResolved({ chainId: input.chainId, from, nonce }, now());
        return {
          txHash: existing.txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
          logs: receipt.logs, alreadySettled: false,
        };
      } catch {
        return undefined;
      }
    }

    async function executeInner(request: SafeBroadcastRequest): Promise<SafeBroadcastReceipt> {
      await evictStuckNonce({
        chainId: input.chainId, from, publicClient: input.publicClient,
        walletClient: input.walletClient, ledger: input.ledger,
        staleAfterMs: stuckNonceAfterMs, nowMs: now(),
      });
      let pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
      let lastError: unknown;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const previous = input.ledger.get({ chainId: input.chainId, from, nonce: pinnedNonce });
        const fees = await estimateFees(previous?.resolvedAtMs === undefined ? previous?.fees : undefined, attempt);
        const safeNonce = await input.publicClient.readContract({
          address: input.safeAddress, abi: SAFE_ABI, functionName: "nonce",
        });
        const safeTxHash = await input.publicClient.readContract({
          address: input.safeAddress, abi: SAFE_ABI, functionName: "getTransactionHash",
          args: [request.to, request.value, request.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, safeNonce],
        });
        const signature = toSafeEthSignSignature(
          await input.walletClient.signMessage({ account, message: { raw: safeTxHash as Hex } }) as Hex,
        );

        let txHash: Hex;
        try {
          txHash = await input.walletClient.writeContract({
            address: input.safeAddress, abi: SAFE_ABI, functionName: "execTransaction",
            args: [request.to, request.value, request.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, signature],
            account, chain: input.walletClient.chain, value: request.value, nonce: pinnedNonce, ...fees,
          });
        } catch (writeError) {
          lastError = writeError;
          const message = flattenError(writeError);
          if (message.includes("GS026")) await assertSignerIsOwner();
          if (message.includes("GS013") || message.includes("GS026")) {
            const inner = await decodeInner(request, null);
            if (inner !== undefined) {
              if (classifyBroadcastError(inner) === "already-settled") {
                return { txHash: "0x" as Hex, blockNumber: 0n, blockHash: "0x" as Hex, logs: [], alreadySettled: true };
              }
              throw inner;
            }
          }
          if (isNonceTooLow(writeError) || isReplacementUnderpriced(writeError)) {
            // The ledger lookup MUST use the ORIGINAL pinned nonce, before it is refreshed: the
            // tx already submitted at that nonce may have mined mid-retry, and re-signing a NEW
            // Safe execTransaction at the advanced Safe nonce is NOT idempotent.
            const reconciled = await reconcile(pinnedNonce, request);
            if (reconciled !== undefined) return reconciled;
            pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
          }
          if (classifyBroadcastError(writeError) !== "retryable" || attempt === maxAttempts - 1) throw writeError;
          await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
          continue;
        }

        input.ledger.record({
          chainId: input.chainId, from, nonce: pinnedNonce, txHash, logicalTx: request.logicalTx,
          to: input.safeAddress, value: request.value, data: request.data, fees, submittedAtMs: now(),
        });

        const receipt = await input.publicClient.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status === "success") {
          input.ledger.markResolved({ chainId: input.chainId, from, nonce: pinnedNonce }, now());
          return {
            txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
            logs: receipt.logs, alreadySettled: false,
          };
        }

        await assertSignerIsOwner();
        const inner = await decodeInner(request, txHash);
        if (inner !== undefined) {
          if (classifyBroadcastError(inner) === "already-settled") {
            input.ledger.markResolved({ chainId: input.chainId, from, nonce: pinnedNonce }, now());
            return {
              txHash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
              logs: receipt.logs, alreadySettled: true,
            };
          }
          throw inner;
        }
        // Re-simulation found no inner revert: a stale Safe nonce or signature race. Re-read and
        // re-sign inside the retry loop; it self-heals.
        lastError = new Error(`Safe execTransaction reverted with no inner revert (txHash=${txHash})`);
        if (attempt === maxAttempts - 1) throw lastError;
        pinnedNonce = await input.publicClient.getTransactionCount({ address: from, blockTag: "pending" });
        await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** attempt));
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    return {
      classify: classifyBroadcastError,

      async execute(request) {
        return input.lock.withSender(input.chainId, from, () => executeInner(request));
      },

      async broadcastCreateTask(createTask): Promise<PostingOutcome> {
        const receipt = await this.execute({
          to: createTask.to, value: createTask.value, data: createTask.data, logicalTx: "posting.createTask",
        });
        for (const log of receipt.logs) {
          try {
            const decoded = decodeEventLog({
              abi: JINN_ROUTER_V3_ABI, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
            });
            if (decoded.eventName === "TaskCreated") {
              const args = decoded.args as unknown as { taskId: bigint };
              return { taskId: args.taskId, txHash: receipt.txHash };
            }
          } catch {
            // Not a router event; the Safe receipt carries unrelated logs too.
          }
        }
        throw new Error(`no TaskCreated event in the posting receipt (txHash=${receipt.txHash})`);
      },
    };
  }
  ```

- [ ] **Step 5: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/broadcast/ && yarn typecheck`
  Expected: 12 broadcaster tests + 5 stuck-nonce tests + the Task 7 suites all pass; typecheck zero errors.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/broadcast
  git commit -m "feat(venue-base): add the single Safe broadcaster under the named relayer profile"
  ```

---

## Task 9: The chain log source

**Files:**
- Create: `packages/marketplace/venue-base/src/log-source/cursor-store.ts`
- Create: `packages/marketplace/venue-base/src/log-source/cursor-store.test.ts`
- Create: `packages/marketplace/venue-base/src/log-source/chain-log-source.ts`
- Create: `packages/marketplace/venue-base/src/log-source/chain-log-source.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `MarketplaceRawLog` (`@jinn-network/marketplace-projector`), `MarketplaceChainConfig`
  (`@jinn-network/marketplace-binding`), `VenueStateDatabase` (Task 6).
- Produces:
  - `interface ChainLogCursor { readonly blockNumber: bigint; readonly blockHash: Hex }`
  - `interface ChainLogBatch { readonly logs: readonly MarketplaceRawLog[]; readonly cursor: ChainLogCursor; readonly finalizedCheckpoint: ChainLogCursor; readonly reorg?: { readonly rolledBackTo: ChainLogCursor; readonly orphanedBlockHashes: readonly Hex[] } }`
  - `interface ChainLogSource { poll(): Promise<ChainLogBatch>; cursor(): ChainLogCursor | undefined; finalizedCheckpoint(): ChainLogCursor | undefined; logsInRange(fromBlock: bigint, toBlock: bigint): Promise<readonly MarketplaceRawLog[]>; orphanedBlockHashes(): ReadonlySet<string>; close(): void }`
  - `interface ChainLogSourceOptions { readonly chunkBlocks?: bigint; readonly startBlock?: bigint; readonly stream?: string; readonly finalityDepthFallback?: bigint }`
  - `const DEFAULT_LOG_CHUNK_BLOCKS = 1000n`
  - `function createChainLogSource(input: { readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly state: VenueStateDatabase; readonly addresses: readonly Address[]; readonly options?: ChainLogSourceOptions }): ChainLogSource`
  - `interface CursorStore { read(stream: string): { readonly live: ChainLogCursor; readonly finalized: ChainLogCursor } | undefined; write(stream: string, chainId: number, live: ChainLogCursor, finalized: ChainLogCursor): void; recordOrphaned(chainId: number, blocks: readonly ChainLogCursor[]): void; orphanedHashes(chainId: number): ReadonlySet<string> }`
  - `function createCursorStore(state: VenueStateDatabase): CursorStore`

**Why 1000 blocks.** `DEFAULT_LOG_CHUNK_BLOCKS = 1000n` is the legacy oracle's own value and rationale
(`client/src/adapters/mech/contracts.ts:1188–1197`, issues #807/#801/#803): a 9999-block `getLogs` over a
delivery-dense range returns megabytes, is rejected or timed out by publicnode/Tenderly, and exceeds the free Base
Sepolia endpoint's 2k range cap — one failing chunk wedges the cursor forever. 1000 fits every vetted provider.

- [ ] **Step 1: Write the failing cursor-store test, then `cursor-store.ts`.**
  `cursor-store.test.ts` asserts: `read` on an unknown stream is `undefined`; `write` then `read` round-trips both
  marks with exact `bigint` block numbers and `0x`-prefixed hashes; a second `write` on the same stream replaces
  (never duplicates) the row; `recordOrphaned` is idempotent by `(chainId, blockHash)` and `orphanedHashes` returns
  every recorded hash lowercased; and a closed-then-reopened database still returns the cursor.

  `cursor-store.ts` implements the four methods with prepared statements over `log_cursors` and `orphaned_blocks`,
  storing block numbers as INTEGER (the schema `CHECK`s already refuse a finalized mark ahead of the live cursor) and
  hashes lowercased.

  Run: `yarn vitest run src/log-source/cursor-store.test.ts` — FAIL first, then PASS.

- [ ] **Step 2: Write the failing log-source test.** `chain-log-source.test.ts` drives a scripted
  `PublicClient` (`getBlock` for `latest`/`finalized`/by-number, `getLogs` recording every requested range) and
  asserts, in this order: the first poll starts at `options.startBlock`; no requested range exceeds
  `chunkBlocks`; ranges tile without gap or overlap; every emitted log carries `chainId`, `finalityTier`,
  `blockHash`, `transactionHash` and `logIndex` (so `decodeMarketplaceLogs` accepts it); logs at or below the
  finalized head carry `finalityTier: "finalized"` and later ones `"safe"`; the live cursor advances to `latest` and
  the durable checkpoint only to `finalized`; a hash change at the persisted cursor's height produces a
  `reorg` batch whose `rolledBackTo` is the finalized checkpoint and whose `orphanedBlockHashes` are non-empty; the
  rescan after a reorg re-requests every block above the checkpoint; a reorg never rolls the checkpoint backwards;
  a provider that serves a stale `finalized` tag (finalized == latest) falls back to
  `latest - finalityDepthFallback`; and a second source over the same state file resumes at the persisted cursor
  without re-requesting already-scanned ranges.

  Run: `yarn vitest run src/log-source/chain-log-source.test.ts`
  Expected: FAIL — `Failed to resolve import "./chain-log-source.js"`.

- [ ] **Step 3: Write `chain-log-source.ts`.**

  ```ts
  // SPDX-License-Identifier: MIT

  // The thin reader profile of design §7 ruling 2: chunked `getLogs` sized to provider caps; a
  // hash-verified `(blockNumber, blockHash)` high-water mark; dual marks -- a live cursor tracking
  // `latest`, a durable checkpoint advancing only on Base's `finalized` tag; cursor-hash mismatch
  // = reorg = roll back to the finalized checkpoint and re-scan. Rollback governs projector STATE
  // only: announcements already emitted from pre-finality blocks are corrected append-only through
  // signed retractions (binding §8), never rewritten -- which is why orphaned hashes are recorded
  // and returned rather than deleted.
  import type { MarketplaceChainConfig } from "@jinn-network/marketplace-binding";
  import type { MarketplaceRawLog } from "@jinn-network/marketplace-projector";
  import type { Address, Hex, PublicClient } from "viem";
  import type { VenueStateDatabase } from "../state/database.js";
  import { createCursorStore, type CursorStore } from "./cursor-store.js";

  /** 1000-block chunks: the legacy oracle's cap (#807/#801/#803) -- fits every vetted provider. */
  export const DEFAULT_LOG_CHUNK_BLOCKS = 1000n;
  /** Used only when a provider serves a stale `finalized` tag equal to `latest` (OP-stack §7 note). */
  export const DEFAULT_FINALITY_DEPTH_FALLBACK = 120n;

  export interface ChainLogCursor {
    readonly blockNumber: bigint;
    readonly blockHash: Hex;
  }

  export interface ChainLogBatch {
    readonly logs: readonly MarketplaceRawLog[];
    readonly cursor: ChainLogCursor;
    readonly finalizedCheckpoint: ChainLogCursor;
    readonly reorg?: {
      readonly rolledBackTo: ChainLogCursor;
      readonly orphanedBlockHashes: readonly Hex[];
    };
  }

  export interface ChainLogSourceOptions {
    readonly chunkBlocks?: bigint;
    readonly startBlock?: bigint;
    readonly stream?: string;
    readonly finalityDepthFallback?: bigint;
  }

  export interface ChainLogSource {
    poll(): Promise<ChainLogBatch>;
    cursor(): ChainLogCursor | undefined;
    finalizedCheckpoint(): ChainLogCursor | undefined;
    logsInRange(fromBlock: bigint, toBlock: bigint): Promise<readonly MarketplaceRawLog[]>;
    orphanedBlockHashes(): ReadonlySet<string>;
    close(): void;
  }

  export function createChainLogSource(input: {
    readonly chain: MarketplaceChainConfig;
    readonly publicClient: PublicClient;
    readonly state: VenueStateDatabase;
    readonly addresses: readonly Address[];
    readonly options?: ChainLogSourceOptions;
  }): ChainLogSource {
    const options = input.options ?? {};
    const chunkBlocks = options.chunkBlocks ?? DEFAULT_LOG_CHUNK_BLOCKS;
    const stream = options.stream ?? `venue:${input.chain.chainId}:${input.chain.jinnRouter.toLowerCase()}`;
    const depthFallback = options.finalityDepthFallback ?? DEFAULT_FINALITY_DEPTH_FALLBACK;
    const store: CursorStore = createCursorStore(input.state);
    const addresses = input.addresses.map((address) => address.toLowerCase() as Address);

    async function headAt(blockTag: "latest" | "finalized"): Promise<ChainLogCursor> {
      const block = await input.publicClient.getBlock({ blockTag });
      return { blockNumber: block.number ?? 0n, blockHash: block.hash ?? ("0x" as Hex) };
    }

    async function hashAt(blockNumber: bigint): Promise<Hex | undefined> {
      const block = await input.publicClient.getBlock({ blockNumber });
      return block.hash ?? undefined;
    }

    async function fetchChunked(
      fromBlock: bigint,
      toBlock: bigint,
      finalizedHeight: bigint,
    ): Promise<MarketplaceRawLog[]> {
      const collected: MarketplaceRawLog[] = [];
      for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
        const end = start + chunkBlocks - 1n > toBlock ? toBlock : start + chunkBlocks - 1n;
        // eslint-disable-next-line no-await-in-loop -- chunks are strictly sequential by design.
        const logs = await input.publicClient.getLogs({ address: addresses, fromBlock: start, toBlock: end });
        for (const log of logs) {
          if (log.blockNumber === null || log.blockHash === null
            || log.transactionHash === null || log.logIndex === null) {
            continue;
          }
          collected.push({
            chainId: input.chain.chainId,
            address: log.address,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionHash: log.transactionHash,
            logIndex: log.logIndex,
            finalityTier: log.blockNumber <= finalizedHeight ? "finalized" : "safe",
            topics: log.topics,
            data: log.data,
          });
        }
      }
      return collected;
    }

    return {
      cursor: () => store.read(stream)?.live,
      finalizedCheckpoint: () => store.read(stream)?.finalized,
      orphanedBlockHashes: () => store.orphanedHashes(input.chain.chainId),
      close: () => undefined,

      async logsInRange(fromBlock, toBlock) {
        const finalized = await headAt("finalized");
        return fetchChunked(fromBlock, toBlock, finalized.blockNumber);
      },

      async poll(): Promise<ChainLogBatch> {
        const latest = await headAt("latest");
        const rawFinalized = await headAt("finalized");
        // A provider serving a stale `finalized` tag equal to `latest` would let decision-grade
        // compute run on unfinalized facts. Depth is the fallback, never the primary signal.
        const finalized = rawFinalized.blockNumber >= latest.blockNumber && latest.blockNumber > depthFallback
          ? {
              blockNumber: latest.blockNumber - depthFallback,
              blockHash: (await hashAt(latest.blockNumber - depthFallback)) ?? rawFinalized.blockHash,
            }
          : rawFinalized;

        const persisted = store.read(stream);
        if (persisted === undefined) {
          const start = options.startBlock ?? finalized.blockNumber;
          const logs = await fetchChunked(start, latest.blockNumber, finalized.blockNumber);
          store.write(stream, input.chain.chainId, latest, finalized);
          return { logs, cursor: latest, finalizedCheckpoint: finalized };
        }

        const canonicalAtCursor = await hashAt(persisted.live.blockNumber);
        if (canonicalAtCursor !== undefined
          && canonicalAtCursor.toLowerCase() !== persisted.live.blockHash.toLowerCase()) {
          const rolledBackTo = persisted.finalized.blockNumber > finalized.blockNumber
            ? persisted.finalized
            : finalized;
          const orphaned: ChainLogCursor[] = [{ ...persisted.live }];
          store.recordOrphaned(input.chain.chainId, orphaned);
          const logs = await fetchChunked(rolledBackTo.blockNumber + 1n, latest.blockNumber, finalized.blockNumber);
          store.write(stream, input.chain.chainId, latest, rolledBackTo);
          return {
            logs,
            cursor: latest,
            finalizedCheckpoint: rolledBackTo,
            reorg: { rolledBackTo, orphanedBlockHashes: orphaned.map((block) => block.blockHash) },
          };
        }

        if (latest.blockNumber <= persisted.live.blockNumber) {
          return { logs: [], cursor: persisted.live, finalizedCheckpoint: persisted.finalized };
        }
        const logs = await fetchChunked(
          persisted.live.blockNumber + 1n,
          latest.blockNumber,
          finalized.blockNumber,
        );
        // The checkpoint is monotone: a provider that regresses its `finalized` tag never moves it back.
        const checkpoint = finalized.blockNumber > persisted.finalized.blockNumber ? finalized : persisted.finalized;
        store.write(stream, input.chain.chainId, latest, checkpoint);
        return { logs, cursor: latest, finalizedCheckpoint: checkpoint };
      },
    };
  }
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/log-source/ && yarn typecheck`
  Expected: the cursor-store suite and all twelve log-source obligations pass; typecheck zero errors.

- [ ] **Step 5: Bind the kit's log-source driver to the real source.** Add
  `packages/marketplace/venue-base/src/log-source/chain-log-source.conformance.test.ts` — no, the kit driver lives in
  `marketplace-testing` and cannot be imported here (one-directional rule). Instead, record in the README that the
  kit binding lands in Task 17, and verify the shape compatibility locally with a type-only assertion in
  `chain-log-source.test.ts`:

  ```ts
  test("the batch shape matches what the projector's decoder consumes", async () => {
    const { logs } = await source.poll();
    const events = decodeMarketplaceLogs(logs, marketplaceEventOriginAuthority(chain, () => true));
    expect(Array.isArray(events)).toBe(true);
  });
  ```

  Run: `yarn vitest run src/log-source/chain-log-source.test.ts`
  Expected: PASS — the emitted logs are accepted by `decodeMarketplaceLogs` without a cast.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/log-source
  git commit -m "feat(venue-base): add the chunked, hash-verified chain log source with dual finality marks"
  ```

---

## Task 10: The finality waiter

**Files:**
- Create: `packages/marketplace/venue-base/src/waiters/finality.ts`
- Create: `packages/marketplace/venue-base/src/waiters/finality.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `FinalityPort`, `FinalityAwaitResult` (`@jinn-network/marketplace-binding`, re-homed in Task 2);
  `finalityPolicy` (`@jinn-network/marketplace-projector`); `ChainLogSource` (Task 9).
- Produces:
  - `interface FinalityWaiterOptions { readonly pollIntervalMs?: number; readonly timeoutMs?: number; readonly sleep?: (ms: number) => Promise<void> }`
  - `function createFinalityWaiter(input: { readonly publicClient: PublicClient; readonly logSource: ChainLogSource; readonly options?: FinalityWaiterOptions }): FinalityPort`

- [ ] **Step 1: Write the failing test.** `finality.test.ts` asserts:

  - the claim tx's block at or below the log source's finalized checkpoint resolves `{ ok: true }` on the first poll,
    with **no** extra `getBlock` round trip beyond the receipt read;
  - a claim tx above the checkpoint polls until the checkpoint advances past it, then resolves `{ ok: true }`;
  - a claim tx whose receipt block hash no longer matches the canonical hash at that height resolves
    `{ ok: false, kind: "reorged" }` — never `failed`, because the distinction drives whether the pipeline releases;
  - a claim tx whose block hash appears in `logSource.orphanedBlockHashes()` resolves `{ ok: false, kind: "reorged" }`
    without waiting for the height comparison;
  - a claim tx receipt with `status: "reverted"` resolves `{ ok: false, kind: "failed" }`;
  - a receipt lookup that never resolves within `timeoutMs` resolves `{ ok: false, kind: "failed" }` (never throws —
    the pipeline's `finality-failed` branch is the honest surface);
  - `finalityPolicy({ finalityTier: "safe" }).gateExecution === false` and
    `finalityPolicy({ finalityTier: "finalized" }).gateExecution === true` are the exact gate this waiter applies, so
    it never returns `ok: true` on a merely-`safe` block.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/waiters/finality.test.ts`
  Expected: FAIL — `Failed to resolve import "./finality.js"`.

- [ ] **Step 3: Write the implementation.**

  ```ts
  // SPDX-License-Identifier: MIT

  // A real waiter over the log source applying the projector's finality policy (design §6.1). The
  // policy is not re-derived here: `finalityPolicy` is the single owner of "decision-grade compute
  // remains finalized-gated", and this waiter's only job is to decide, honestly, whether the claim
  // fact has reached that tier -- or was reorged out from under it.
  import type { FinalityAwaitResult, FinalityPort } from "@jinn-network/marketplace-binding";
  import { finalityPolicy } from "@jinn-network/marketplace-projector";
  import type { Hex, PublicClient } from "viem";
  import type { ChainLogSource } from "../log-source/chain-log-source.js";

  export interface FinalityWaiterOptions {
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  }

  export const DEFAULT_FINALITY_POLL_INTERVAL_MS = 4_000;
  export const DEFAULT_FINALITY_TIMEOUT_MS = 900_000;

  export function createFinalityWaiter(input: {
    readonly publicClient: PublicClient;
    readonly logSource: ChainLogSource;
    readonly options?: FinalityWaiterOptions;
  }): FinalityPort {
    const options = input.options ?? {};
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_FINALITY_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FINALITY_TIMEOUT_MS;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    async function claimBlock(
      claimTxHash: Hex,
    ): Promise<{ readonly blockNumber: bigint; readonly blockHash: Hex } | "failed" | "missing"> {
      try {
        const receipt = await input.publicClient.getTransactionReceipt({ hash: claimTxHash });
        if (receipt.status !== "success") return "failed";
        return { blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
      } catch {
        return "missing";
      }
    }

    return {
      async awaitFinalized({ claimTxHash }): Promise<FinalityAwaitResult> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const block = await claimBlock(claimTxHash);
          if (block === "failed") return { ok: false, kind: "failed" };
          if (block !== "missing") {
            if (input.logSource.orphanedBlockHashes().has(block.blockHash.toLowerCase())) {
              return { ok: false, kind: "reorged" };
            }
            const checkpoint = input.logSource.finalizedCheckpoint();
            if (checkpoint !== undefined && checkpoint.blockNumber >= block.blockNumber) {
              const canonical = await input.publicClient.getBlock({ blockNumber: block.blockNumber });
              if ((canonical.hash ?? "").toLowerCase() !== block.blockHash.toLowerCase()) {
                return { ok: false, kind: "reorged" };
              }
              // The tier is now `finalized`; the policy is the authority on what that permits.
              return finalityPolicy({ finalityTier: "finalized" }).gateExecution
                ? { ok: true }
                : { ok: false, kind: "failed" };
            }
          }
          if (Date.now() >= deadline) return { ok: false, kind: "failed" };
          await sleep(pollIntervalMs);
          await input.logSource.poll();
        }
      },
    };
  }
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/waiters/finality.test.ts && yarn typecheck`
  Expected: 7 tests pass; typecheck zero errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/waiters
  git commit -m "feat(venue-base): add the finality waiter over the log source's finalized checkpoint"
  ```

---

## Task 11: The claim writer

**Files:**
- Create: `packages/marketplace/venue-base/src/writers/claim.ts`
- Create: `packages/marketplace/venue-base/src/writers/claim.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `ClaimPorts`, `PreClaimResult`, `JINN_ROUTER_V3_ABI`, `JINN_ROUTER_V4_ABI`, `MarketplaceChainConfig`
  (`@jinn-network/marketplace-binding`); `BaseVenueSafeBroadcaster` (Task 8).
- Produces:
  - `interface ClaimWriterInput { readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly safeAddress: Address; readonly broadcaster: BaseVenueSafeBroadcaster; readonly priorityMech: Address }`
  - `function createClaimWriter(input: ClaimWriterInput): Pick<ClaimPorts, "claimTask" | "preflight" | "priorityMech">`
  - `function encodeClaimTaskCalldata(chain: MarketplaceChainConfig, taskId: bigint, priorityMech: Address): Hex`
  - `function decodeAttemptFromLogs(chain: MarketplaceChainConfig, logs: readonly Log[]): { readonly attemptIndex: number; readonly requestId?: Hex }`

`ClaimPorts` also declares `taskDigest`, `submission`, `nonce` and `capabilityMatch` — those are **per-engagement,
host-supplied** values, and `runPipeline` already spreads them over `ports.claim` per engagement. The writer supplies
exactly the chain-facing members; the facade (Task 17) exposes it as a `ClaimPorts` whose per-engagement fields the
host fills in, matching how `pipeline.ts` calls `claimAttempt({ ...ports.claim, taskDigest, submission, nonce, priorityMech })`.

- [ ] **Step 1: Write the failing test.** `claim.test.ts` asserts:

  - today generation encodes `JinnRouterV3.claimTask(taskId, priorityMech)` and broadcasts it to `chain.jinnRouter`
    with `value: 0n` and `logicalTx: "claim.claimTask"`;
  - revised generation encodes the V4 `claimTask` selector, not the V3 one (the two ABIs never mix — projector
    §"V3 router topics are never composed into revised mode");
  - the returned `attemptIndex` and `requestId` are decoded from the receipt's `TaskAttemptCreated` log;
  - a today-generation claim whose receipt carries no `TaskAttemptCreated` throws, naming the tx hash — never returns
    a fabricated index;
  - a **revised**-generation claim returns `requestId: undefined`, because `claimAttempt` throws when a revised
    `claimTask` returns one;
  - `preflight` runs `simulateContract` from the Safe address and returns `{ ok: true }` on success;
  - `preflight` returns `{ ok: false, reason }` carrying the decoded revert name (`TCMaxClaimsReached`), not a raw
    hex blob, so the pipeline's `preflight-not-ready` branch is legible;
  - a broadcast that resolves `alreadySettled` (a replayed claim) still decodes its attempt from the on-chain
    coordinator read rather than from empty logs.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/claim.test.ts`
  Expected: FAIL — `Failed to resolve import "./claim.js"`.

- [ ] **Step 3: Write the implementation.**

  ```ts
  // SPDX-License-Identifier: MIT

  import {
    JINN_ROUTER_V3_ABI,
    JINN_ROUTER_V4_ABI,
    formatKnownRevertDetail,
    type ClaimPorts,
    type MarketplaceChainConfig,
    type PreClaimResult,
  } from "@jinn-network/marketplace-binding";
  import {
    decodeEventLog, encodeFunctionData, type Address, type Hex, type Log, type PublicClient,
  } from "viem";
  import { flattenError } from "../broadcast/classify.js";
  import type { BaseVenueSafeBroadcaster } from "../broadcast/safe-broadcaster.js";

  function routerAbi(chain: MarketplaceChainConfig) {
    return chain.generation === "revised" ? JINN_ROUTER_V4_ABI : JINN_ROUTER_V3_ABI;
  }

  export function encodeClaimTaskCalldata(
    chain: MarketplaceChainConfig,
    taskId: bigint,
    priorityMech: Address,
  ): Hex {
    return encodeFunctionData({
      abi: routerAbi(chain),
      functionName: "claimTask",
      args: [taskId, priorityMech],
    });
  }

  export function decodeAttemptFromLogs(
    chain: MarketplaceChainConfig,
    logs: readonly Log[],
  ): { readonly attemptIndex: number; readonly requestId?: Hex } | undefined {
    for (const log of logs) {
      try {
        const decoded = decodeEventLog({
          abi: routerAbi(chain), data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true,
        });
        if (decoded.eventName !== "TaskAttemptCreated") continue;
        const args = decoded.args as unknown as { attemptIndex: number | bigint; requestId?: Hex };
        return {
          attemptIndex: Number(args.attemptIndex),
          // Today claims bind a requestId; revised claims bind only monotonic attempt identity.
          ...(chain.generation === "today" && args.requestId !== undefined
            ? { requestId: args.requestId }
            : {}),
        };
      } catch {
        // Not a router event; a Safe receipt carries unrelated logs.
      }
    }
    return undefined;
  }

  export interface ClaimWriterInput {
    readonly chain: MarketplaceChainConfig;
    readonly publicClient: PublicClient;
    readonly safeAddress: Address;
    readonly broadcaster: BaseVenueSafeBroadcaster;
    readonly priorityMech: Address;
  }

  export function createClaimWriter(
    input: ClaimWriterInput,
  ): Pick<ClaimPorts, "claimTask" | "preflight" | "priorityMech"> {
    return {
      priorityMech: input.priorityMech,

      async preflight(): Promise<PreClaimResult> {
        return { ok: true };
      },

      async claimTask({ taskId, priorityMech }) {
        const data = encodeClaimTaskCalldata(input.chain, taskId, priorityMech);
        const receipt = await input.broadcaster.execute({
          to: input.chain.jinnRouter, value: 0n, data, logicalTx: `claim.claimTask:${taskId}`,
        });
        const attempt = decodeAttemptFromLogs(input.chain, receipt.logs);
        if (attempt === undefined) {
          throw new Error(
            `no TaskAttemptCreated event for task ${taskId} (txHash=${receipt.txHash}) — refusing to `
            + "fabricate an attempt index",
          );
        }
        return { attemptIndex: attempt.attemptIndex, ...(attempt.requestId === undefined ? {} : { requestId: attempt.requestId }), txHash: receipt.txHash };
      },
    };
  }

  /** Builds the pre-claim simulation the pipeline runs before spending a claim slot. */
  export function createClaimPreflight(
    input: ClaimWriterInput,
    taskId: bigint,
  ): () => Promise<PreClaimResult> {
    return async () => {
      try {
        await input.publicClient.simulateContract({
          account: input.safeAddress,
          address: input.chain.jinnRouter,
          abi: routerAbi(input.chain),
          functionName: "claimTask",
          args: [taskId, input.priorityMech],
        });
        return { ok: true };
      } catch (error) {
        const detail = formatKnownRevertDetail(error);
        return { ok: false, reason: detail?.reason ?? flattenError(error) };
      }
    };
  }
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/claim.test.ts && yarn typecheck`
  Expected: 8 tests pass; typecheck zero errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/writers
  git commit -m "feat(venue-base): add the claim writer over the single Safe broadcaster"
  ```

---

## Task 12: Settlement reads and writes

**Files:**
- Create: `packages/marketplace/venue-base/src/writers/settlement.ts`
- Create: `packages/marketplace/venue-base/src/writers/settlement.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `SettlementPorts`, `MechDeliveryFacts`, `RouterDeliveryFacts`, `MECH_ABI`, `JINN_ROUTER_V3_ABI`,
  `JINN_ROUTER_V4_ABI`, `MarketplaceChainConfig`, `decodeRawCodecCidDigestHex`, `encodeRevisedSolutionRequestData`
  (`@jinn-network/marketplace-binding`); `ChainLogSource` (Task 9); `BaseVenueSafeBroadcaster` (Task 8).
- Produces:
  - `interface SettlementWriterInput { readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly safeAddress: Address; readonly broadcaster: BaseVenueSafeBroadcaster; readonly logSource: ChainLogSource; readonly pin: SettlementPorts["pin"]; readonly verifySettlementGrade: SettlementPorts["verifySettlementGrade"] }`
  - `function createSettlementPorts(input: SettlementWriterInput): SettlementPorts`

**The four chain surfaces this fills.** `readMechDeliveryFacts` (scan the Mech `Deliver` event for the requestId and
recompute its sha256 raw-CID digest), `readRouterDeliveryFacts` (read the router's recorded delivery — today's
keccak evidence hash, revised's sha256 digest plus `(taskId, attemptIndex)`), `claimSolutionDelivery` (today: one
`claimSolutionDelivery(requestId, solutionDigest)` Safe call, classified into the port's four-value status), and
`settleRevisedSolutionDelivery` (revised: the prepare → signed Marketplace `Deliver` → router claim sequence executed
as **one revert-on-failure Safe batch**, from which `requestId` first emerges).

- [ ] **Step 1: Write the failing test.** `settlement.test.ts` asserts:

  - `readMechDeliveryFacts` scans through the log source (never a bare unbounded `getLogs`) and returns the
    `Deliver` event's `requestId` plus the sha256 raw-CID digest decoded by `decodeRawCodecCidDigestHex`;
  - `readMechDeliveryFacts` throws, naming the requestId, when no `Deliver` event exists — the binding's gate depends
    on the fact being independently available, so an invented zero digest is forbidden;
  - `readRouterDeliveryFacts` in today generation returns `{ generation: "today", requestId, keccakEvidenceHash }`
    read from the router;
  - `readRouterDeliveryFacts` in revised generation returns `{ generation: "revised", requestId, taskId, attemptIndex, sha256Digest }`;
  - `claimSolutionDelivery` returns `"settled"` on a successful broadcast;
  - `claimSolutionDelivery` returns `"already-settled"` when the broadcaster reports `alreadySettled` **or** when the
    router's `claimed(requestId)` view already reads true before broadcasting — the pre-read short-circuit means a
    replayed settlement spends no gas;
  - `claimSolutionDelivery` returns `"rejected"` on a decoded permanent inner revert that is not an
    already-claimed variant (a lost race), and `"delivered-unsettled"` when the delivery exists but the router
    refuses this claimant (`RouterWrongDeliveryOperator`);
  - `settleRevisedSolutionDelivery` submits exactly **one** Safe transaction (asserted by counting broadcaster
    `execute` calls), and returns the `requestId` decoded from its `SolutionDeliveryPrepared`/`SolutionDeliveryClaimed`
    logs;
  - `settleRevisedSolutionDelivery` is **absent** (`undefined`) when `chain.generation === "today"`, so
    `settleDelivery`'s own "revised settlement requires settleRevisedSolutionDelivery port" guard stays reachable;
  - `pin` and `verifySettlementGrade` are passed through unchanged — this package never re-implements either.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/settlement.test.ts`
  Expected: FAIL — `Failed to resolve import "./settlement.js"`.

- [ ] **Step 3: Write the implementation.** Shape (the status mapping is the load-bearing part):

  ```ts
  // SPDX-License-Identifier: MIT

  import {
    JINN_ROUTER_V3_ABI, JINN_ROUTER_V4_ABI, MECH_ABI, SafeInnerRevertError,
    decodeRawCodecCidDigestHex,
    type MarketplaceChainConfig, type MechDeliveryFacts, type RouterDeliveryFacts, type SettlementPorts,
  } from "@jinn-network/marketplace-binding";
  import { decodeEventLog, type Address, type Hex, type PublicClient } from "viem";
  import type { BaseVenueSafeBroadcaster } from "../broadcast/safe-broadcaster.js";
  import type { ChainLogSource } from "../log-source/chain-log-source.js";

  const CLAIMED_VIEW_ABI = [{
    name: "claimed", type: "function", stateMutability: "view",
    inputs: [{ name: "requestId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  }] as const;

  /** Inner reverts that mean "the delivery exists but this claimant may not settle it". */
  const DELIVERED_UNSETTLED_INNER = new Set([
    "RouterWrongDeliveryOperator", "RouterWrongRequester", "RouterWrongRequestKind",
  ]);
  const ALREADY_SETTLED_INNER = new Set(["RouterAlreadyClaimed", "TCVerdictAlreadyDelivered"]);

  function classifySettlementRevert(
    error: unknown,
  ): "already-settled" | "delivered-unsettled" | "rejected" | undefined {
    if (!(error instanceof SafeInnerRevertError) || error.decodedName === null) return undefined;
    if (ALREADY_SETTLED_INNER.has(error.decodedName)) return "already-settled";
    if (DELIVERED_UNSETTLED_INNER.has(error.decodedName)) return "delivered-unsettled";
    return "rejected";
  }
  ```

  `createSettlementPorts` composes: a `claimed(requestId)` pre-read short-circuit; `broadcaster.execute` with
  `logicalTx: "settlement.claimSolutionDelivery:<requestId>"`; `classifySettlementRevert` in the `catch`, rethrowing
  anything it cannot classify (a transport failure is not a settlement verdict); `readMechDeliveryFacts` scanning
  `logSource.logsInRange(checkpoint - lookback, latest)` for `MECH_ABI`'s `Deliver` and decoding the CID digest;
  `readRouterDeliveryFacts` reading the generation-appropriate router view; and, only when
  `chain.generation === "revised"`, `settleRevisedSolutionDelivery` encoding the three-call batch as one
  `execTransaction` payload through the Safe's `MultiSend`-style batch calldata builder and decoding the emerging
  `requestId` from the receipt.

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/settlement.test.ts && yarn typecheck`
  Expected: 11 tests pass; typecheck zero errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/writers
  git commit -m "feat(venue-base): add settlement delivery-fact readers and the generation-specific settle writers"
  ```

---

## Task 13: Lifecycle writes and the release port

**Files:**
- Create: `packages/marketplace/venue-base/src/writers/lifecycle.ts`
- Create: `packages/marketplace/venue-base/src/writers/lifecycle.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `MarketplaceLifecyclePorts`, `ReleaseAttemptPort` (`@jinn-network/marketplace-binding`);
  `BaseVenueSafeBroadcaster` (Task 8); `VenueStateDatabase` (Task 6).
- Produces:
  - `function createLifecyclePorts(input: { readonly chain: MarketplaceChainConfig; readonly publicClient: PublicClient; readonly broadcaster: BaseVenueSafeBroadcaster; readonly state: VenueStateDatabase; readonly resolveAttempt: (attempt: `urn:uuid:${string}`) => Promise<{ readonly taskId: bigint; readonly attemptIndex: number }> }): MarketplaceLifecyclePorts`
  - `function createReleasePort(input: { readonly chain: MarketplaceChainConfig; readonly broadcaster: BaseVenueSafeBroadcaster }): ReleaseAttemptPort`
  - schema addition: a `cancel_signals` table (below), created by the Task 6 schema — add it there in this task and
    bump `VENUE_STATE_SCHEMA_VERSION` to `2`.

```sql
-- Requester cancellation is a durable, idempotent signal; it never revokes a live attempt.
-- The row IS the signal: a restart or replay reads it back and returns `already-requested`
-- without emitting a second one.
CREATE TABLE cancel_signals (
  attempt TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_index INTEGER NOT NULL CHECK (attempt_index >= 0),
  reason TEXT NOT NULL,
  requested_at_ms INTEGER NOT NULL
);
```

- [ ] **Step 1: Write the failing test.** `lifecycle.test.ts` asserts:

  - today generation: `refundUnusedTaskBudget` is defined, `closeTask` and `releaseAttempt` are **undefined** on the
    lifecycle ports, so `closeSubmission`'s "today refundUnusedTaskBudget port is required" branch is the one taken;
  - revised generation: `closeTask` and `releaseAttempt` are defined and `refundUnusedTaskBudget` is undefined;
  - `releaseAttempt` on the **release** port returns `{ ok: false, kind: "unsupported" }` in today generation without
    broadcasting anything — the pipeline's `promptRelease` then reports `released: false`, which is exactly the
    unreleased-attempt state message §4 requires;
  - `releaseAttempt` in revised generation broadcasts `releaseAttempt(taskId, attemptIndex)` and resolves `undefined`,
    which `promptRelease` reads as released;
  - `forfeitDeliveredReservation` is defined only in revised generation and encodes all four arguments including
    `legKind`;
  - `requestCancel` writes the `cancel_signals` row and returns `"requested"` the first time;
  - a second `requestCancel` for the same attempt returns `"already-requested"` and does **not** rewrite the row's
    `requested_at_ms` (idempotent across restart and replay);
  - `withdrawAnnouncement` is a no-op that resolves — the announcement withdrawal is the projector's append-only
    signed retraction, not a chain write, and this port must not invent one;
  - `resolveAttempt` delegates to the injected resolver and propagates its `{ taskId, attemptIndex }` unchanged.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/lifecycle.test.ts`
  Expected: FAIL — `Failed to resolve import "./lifecycle.js"`.

- [ ] **Step 3: Write the implementation** — generation-conditional port assembly (properties present only when the
  generation supports them, never a stub that throws), `broadcaster.execute` for every chain write with
  `logicalTx: "lifecycle.<verb>:<taskId>"`, and the `cancel_signals` insert as
  `INSERT … ON CONFLICT(attempt) DO NOTHING` with the `changes` count deciding
  `"requested"` vs `"already-requested"`.

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/writers/ src/state/ && yarn typecheck`
  Expected: 9 lifecycle tests pass, the Task 6 schema suite passes with the added table and version 2, typecheck zero
  errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src
  git commit -m "feat(venue-base): add generation-conditional lifecycle writers and the release port"
  ```

---

## Task 14: The delivery waiter

**Files:**
- Create: `packages/marketplace/venue-base/src/waiters/delivery.ts`
- Create: `packages/marketplace/venue-base/src/waiters/delivery.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `DeliveryWaitPort`, `DeliveryWaitResult` (`@jinn-network/marketplace-binding`); `TaskExecutionBackend`,
  `DeliveryRef` (`@jinn-network/task-execution-backend`).
- Produces:
  - `interface DeliveryWaiterOptions { readonly pollIntervalMs?: number; readonly timeoutMs?: number; readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }`
  - `function createDeliveryWaiter(options?: DeliveryWaiterOptions): DeliveryWaitPort`

**Event-watch with poll fallback and cancellation** (§6.1). The Delivery this port waits on is produced by the
*embedded backend*, not the chain: `runPipeline` calls it between `backend.submit` and `convergeDelivery`. So the
watch surface is `backend.watch?.(attemptUri, cursor)` — an optional TEP capability — and the fallback is polling
`backend.observe(attemptUri)`. Both paths end at `backend.deliveries(attempt)` → `backend.fetchDelivery(ref)`.

- [ ] **Step 1: Write the failing test.** `delivery.test.ts` asserts:

  - a backend exposing `watch` is watched, not polled (the poll path's `observe` is never called);
  - the watch path returns `{ ok: true, deliveryBytes }` as soon as a
    `network.jinn.task-execution.delivery-recorded.v1` observation arrives, fetching the bytes via
    `deliveries` + `fetchDelivery`;
  - a backend **without** `watch` falls back to polling `observe` at `pollIntervalMs` and returns the same result;
  - a terminal attempt with no recorded Delivery returns `{ ok: false, kind: "backend-terminal", state }` carrying the
    derived state, so `runPipeline`'s `delivery-wait-failed` branch can release with an honest reason;
  - a terminal attempt **with** a recorded Delivery returns `{ ok: true, … }` — terminal is not automatically failure;
  - an aborted `signal` resolves `{ ok: false, kind: "cancelled" }` promptly and stops watching (the async iterator's
    `return()` is called);
  - exceeding `timeoutMs` resolves `{ ok: false, kind: "timeout" }` and never throws;
  - a `watch` iterator that throws mid-stream degrades to the poll path instead of failing the engagement;
  - `fetchDelivery` throwing `result-unavailable` for a terminal attempt propagates as
    `{ ok: false, kind: "backend-terminal", state }` with the loud error's message preserved on the returned state —
    never a silent shrug.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/waiters/delivery.test.ts`
  Expected: FAIL — `Failed to resolve import "./delivery.js"`.

- [ ] **Step 3: Write the implementation.**

  ```ts
  // SPDX-License-Identifier: MIT

  // Event-watch with poll fallback and cancellation (design §6.1). The Delivery is produced by the
  // EMBEDDED backend, not the chain -- `runPipeline` calls this between `submit` and
  // `convergeDelivery` -- so the watch surface is TEP's optional `watch` capability and the
  // fallback is `observe`. This port owns the timer policy the library deliberately does not.
  import type { DeliveryWaitPort, DeliveryWaitResult } from "@jinn-network/marketplace-binding";
  import type { AttemptUri, TaskExecutionBackend } from "@jinn-network/task-execution-backend";

  export const DEFAULT_DELIVERY_POLL_INTERVAL_MS = 2_000;
  export const DEFAULT_DELIVERY_TIMEOUT_MS = 21_600_000;

  export interface DeliveryWaiterOptions {
    readonly pollIntervalMs?: number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  }

  async function firstDelivery(
    backend: TaskExecutionBackend,
    attemptUri: AttemptUri,
  ): Promise<Uint8Array | undefined> {
    const refs = await backend.deliveries(attemptUri);
    if (refs.length === 0) return undefined;
    return backend.fetchDelivery(refs[0]!);
  }

  export function createDeliveryWaiter(options: DeliveryWaiterOptions = {}): DeliveryWaitPort {
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_DELIVERY_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    const sleep = options.sleep
      ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    return {
      async waitForDelivery({ attemptUri, backend, signal }): Promise<DeliveryWaitResult> {
        const deadline = Date.now() + timeoutMs;

        if (backend.watch !== undefined) {
          const iterator = backend.watch(attemptUri)[Symbol.asyncIterator]();
          try {
            for (;;) {
              if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
              if (Date.now() >= deadline) return { ok: false, kind: "timeout" };
              const next = await iterator.next();
              if (next.done === true) break;
              if (next.value.type === "network.jinn.task-execution.delivery-recorded.v1") {
                const bytes = await firstDelivery(backend, attemptUri);
                if (bytes !== undefined) return { ok: true, deliveryBytes: bytes };
              }
              if (next.value.type === "network.jinn.task-execution.attempt-terminal.v1") break;
            }
          } catch {
            // A watch stream that faults degrades to polling; it never fails the engagement.
          } finally {
            await iterator.return?.();
          }
        }

        for (;;) {
          if (signal?.aborted === true) return { ok: false, kind: "cancelled" };
          const snapshot = await backend.observe(attemptUri);
          if (snapshot.descriptor.derived.deliveries.length > 0) {
            const bytes = await firstDelivery(backend, attemptUri);
            if (bytes !== undefined) return { ok: true, deliveryBytes: bytes };
          }
          if (snapshot.descriptor.derived.terminal) {
            const bytes = await firstDelivery(backend, attemptUri).catch(() => undefined);
            return bytes === undefined
              ? { ok: false, kind: "backend-terminal", state: snapshot.descriptor.derived.state }
              : { ok: true, deliveryBytes: bytes };
          }
          if (Date.now() >= deadline) return { ok: false, kind: "timeout" };
          await sleep(pollIntervalMs, signal);
        }
      },
    };
  }
  ```

- [ ] **Step 4: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/waiters/ && yarn typecheck`
  Expected: 9 delivery tests + the Task 10 finality tests pass; typecheck zero errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/waiters
  git commit -m "feat(venue-base): add the delivery waiter with event watch, poll fallback and cancellation"
  ```

---

## Task 15: The durable posting-intent store (transactional outbox)

**Files:**
- Create: `packages/marketplace/venue-base/src/intents/intent-store.ts`
- Create: `packages/marketplace/venue-base/src/intents/intent-store.test.ts`
- Create: `packages/marketplace/venue-base/src/intents/drain.ts`
- Create: `packages/marketplace/venue-base/src/intents/drain.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `PostingIntentStore`, `PostingIntent`, `PostingIntentKey`, `PostingIntentClaim`, `PostingIntentRecord`,
  `PostingOwnerToken`, `PostingOutcome`, `ScanForOnChainMatch`, `recoverPostingIntents`
  (`@jinn-network/marketplace-binding`); `VenueStateDatabase` (Task 6); `ChainLogSource` (Task 9);
  `BaseVenueSafeBroadcaster` (Task 8).
- Produces:
  - `function createSqlitePostingIntentStore(state: VenueStateDatabase): PostingIntentStore`
  - `function createOnChainPostingScan(input: { readonly chain: MarketplaceChainConfig; readonly logSource: ChainLogSource; readonly lookbackBlocks?: bigint }): ScanForOnChainMatch`
  - `function drainPostingIntents(input: { readonly store: PostingIntentStore; readonly scan: ScanForOnChainMatch }): Promise<readonly PostingIntent[]>`

**This supersedes `createInMemoryPostingIntentStore`** (§6.1 "replaces the in-memory crash WAL"). The binding's
in-memory implementation stays exported for its own unit tests and the conformance stub; production hosts take this
one. The idempotency key is the **logical operation identity** carried by the sealed Submission
(`submission.idempotencyKey`), never a tx hash — ruling 4 is explicit about that, and the intent is written in the
same transaction as the motivating state change, strictly before broadcast (program §6 contract 2:
ledger-before-broadcast).

- [ ] **Step 1: Write the failing test.** `intent-store.test.ts` asserts the four-way `claim` contract plus durability:

  - `claim` on an unseen key returns `{ kind: "owner", intent, ownerToken }` and persists the row **atomically** —
    two concurrent `claim` calls for the same key yield exactly one `owner` and one `pending-other`;
  - `claim` on a pending key owned elsewhere returns `{ kind: "pending-other", intent }` with the **stored** intent
    (its original `createdAt`), not the caller's;
  - `claim` on a resolved key returns `{ kind: "resolved", outcome }` with the exact `taskId` (a `bigint` round-tripped
    through TEXT) and `txHash`;
  - `fence` returns `true` only for the live owner token, `false` after `resolve`, and `false` for a foreign token;
  - `resolve` with a foreign token throws; `resolve` twice with the same outcome is a no-op; `resolve` twice with a
    **different** outcome throws (the store must never silently re-point a landed post);
  - `lookup` returns the record **without** the owner token (the token is authority, not data);
  - `scanPending` returns only unresolved rows, each carrying its owner token so recovery can resume the same
    ownership;
  - a closed-then-reopened database returns identical `lookup` and `scanPending` results — crash recovery resumes the
    same ownership, which the in-memory store cannot do;
  - the store never writes a half-resolved row (the schema `CHECK` from Task 6 is exercised through the public API by
    a `resolve` with a malformed outcome).

  `drain.test.ts` asserts: a pending intent whose post is found on chain by `scan` is resolved idempotently and drops
  out of `scanPending`; a pending intent with no on-chain match stays pending and is **returned** to the caller
  (never silently retried or re-broadcast); `createOnChainPostingScan` matches by `(creatorSafe, taskCidDigest)`
  against `TaskCreated` events read through the log source's chunked range reader, and returns `null` — not a
  throw — when the lookback window contains no match.

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/intents/`
  Expected: FAIL — `Failed to resolve import "./intent-store.js"`.

- [ ] **Step 3: Write `intent-store.ts`.**

  ```ts
  // SPDX-License-Identifier: MIT

  // The durable transactional outbox (design §7 ruling 4), superseding the binding's in-memory
  // crash WAL. The intent row is written in the same SQLite transaction that admits the operation
  // and strictly before broadcast (program §6 contract 2); the sweeper drains pending rows through
  // the Safe broadcaster; "broadcast-but-unrecorded" is the one state the recovery scan reconciles
  // against the tx-submission ledger. The idempotency key is the LOGICAL operation identity from
  // the sealed Submission -- never a tx hash.
  import { randomUUID } from "node:crypto";
  import type {
    PostingIntent, PostingIntentClaim, PostingIntentKey, PostingIntentRecord,
    PostingIntentStore, PostingOutcome, PostingOwnerToken,
  } from "@jinn-network/marketplace-binding";
  import type { VenueStateDatabase } from "../state/database.js";

  interface IntentRow {
    readonly creator_safe: string;
    readonly task_cid_digest: string;
    readonly submission_digest: string;
    readonly idempotency_key: string;
    readonly owner_token: string;
    readonly created_at: string;
    readonly resolved_task_id: string | null;
    readonly resolved_tx_hash: string | null;
  }

  function toIntent(row: IntentRow): PostingIntent {
    return {
      creatorSafe: row.creator_safe as `0x${string}`,
      taskCidDigest: row.task_cid_digest as `sha256:${string}`,
      submissionDigest: row.submission_digest as `sha256:${string}`,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    };
  }

  function toOutcome(row: IntentRow): PostingOutcome | undefined {
    if (row.resolved_task_id === null || row.resolved_tx_hash === null) return undefined;
    return { taskId: BigInt(row.resolved_task_id), txHash: row.resolved_tx_hash as `0x${string}` };
  }

  export function createSqlitePostingIntentStore(state: VenueStateDatabase): PostingIntentStore {
    const select = state.db.prepare(
      "SELECT * FROM posting_intents WHERE creator_safe = ? AND task_cid_digest = ? AND submission_digest = ?",
    );
    const insert = state.db.prepare(
      "INSERT INTO posting_intents (creator_safe, task_cid_digest, submission_digest, idempotency_key,"
      + " owner_token, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
    );
    const resolveRow = state.db.prepare(
      "UPDATE posting_intents SET resolved_task_id = ?, resolved_tx_hash = ?"
      + " WHERE creator_safe = ? AND task_cid_digest = ? AND submission_digest = ? AND owner_token = ?"
      + " AND resolved_tx_hash IS NULL",
    );
    const pending = state.db.prepare("SELECT * FROM posting_intents WHERE resolved_tx_hash IS NULL ORDER BY created_at");

    const keyArgs = (key: PostingIntentKey): readonly [string, string, string] =>
      [key.creatorSafe.toLowerCase(), key.taskCidDigest, key.submissionDigest];

    return {
      async claim(intent: PostingIntent): Promise<PostingIntentClaim> {
        const ownerToken = `posting-owner:${randomUUID()}` as PostingOwnerToken;
        return state.transaction((): PostingIntentClaim => {
          const inserted = insert.run(
            intent.creatorSafe.toLowerCase(), intent.taskCidDigest, intent.submissionDigest,
            intent.idempotencyKey, ownerToken, intent.createdAt,
          );
          if (inserted.changes === 1) {
            return { kind: "owner", intent, ownerToken };
          }
          const row = select.get(...keyArgs(intent)) as IntentRow;
          const outcome = toOutcome(row);
          return outcome === undefined
            ? { kind: "pending-other", intent: toIntent(row) }
            : { kind: "resolved", outcome };
        });
      },

      async fence(key, ownerToken) {
        const row = select.get(...keyArgs(key)) as IntentRow | undefined;
        return row !== undefined && row.resolved_tx_hash === null && row.owner_token === ownerToken;
      },

      async resolve(key, ownerToken, outcome) {
        state.transaction(() => {
          const row = select.get(...keyArgs(key)) as IntentRow | undefined;
          if (row === undefined) throw new Error("cannot resolve an intent that was never claimed");
          if (row.owner_token !== ownerToken) throw new Error("only the posting intent owner token may resolve");
          const existing = toOutcome(row);
          if (existing !== undefined) {
            if (existing.taskId !== outcome.taskId || existing.txHash !== outcome.txHash) {
              throw new Error("posting intent is already resolved to a different outcome");
            }
            return;
          }
          resolveRow.run(outcome.taskId.toString(), outcome.txHash, ...keyArgs(key), ownerToken);
        });
      },

      async lookup(key): Promise<PostingIntentRecord | undefined> {
        const row = select.get(...keyArgs(key)) as IntentRow | undefined;
        if (row === undefined) return undefined;
        const outcome = toOutcome(row);
        return outcome === undefined ? toIntent(row) : { ...toIntent(row), resolved: outcome };
      },

      async scanPending() {
        return (pending.all() as IntentRow[]).map((row) => ({
          ...toIntent(row),
          ownerToken: row.owner_token as PostingOwnerToken,
        }));
      },
    };
  }
  ```

- [ ] **Step 4: Write `drain.ts`** — `createOnChainPostingScan` reading `TaskCreated` events through
  `logSource.logsInRange(latest - lookbackBlocks, latest)` and matching `(creator === intent.creatorSafe,
  taskCidDigest === decodeRawCodecCidDigestHex(intent.taskCidDigest))`, plus `drainPostingIntents` delegating to the
  binding's `recoverPostingIntents(store, scan)` (the recovery semantics are already owned there; this package
  supplies only the chain-side `scan`).

- [ ] **Step 5: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/intents/ && yarn typecheck`
  Expected: 10 store tests + 4 drain tests pass; typecheck zero errors.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src/intents
  git commit -m "feat(venue-base): add the durable SQLite posting-intent outbox and its drain scan"
  ```

---

## Task 16: Projector-backed observe

**Files:**
- Create: `packages/marketplace/venue-base/src/observe/observe-store.ts`
- Create: `packages/marketplace/venue-base/src/observe/observe-store.test.ts`
- Create: `packages/marketplace/venue-base/src/observe/projector-observe.ts`
- Create: `packages/marketplace/venue-base/src/observe/projector-observe.test.ts`
- Modify: `packages/marketplace/venue-base/src/state/schema.ts` (two tables; bump to schema version 3)
- Modify: `packages/marketplace/venue-base/src/index.ts`

**Interfaces:**
- Consumes: `MarketplaceObservePort`, `SubmissionScopeRecord`, `SubmissionScopeClaim`, `SubmissionScopeOwnerToken`,
  `RecordSubmissionInput` (`@jinn-network/marketplace-binding`); `ObservationSnapshot`, `ReconciliationReport`,
  `DeliveryRef`, `SubmissionUri`, `AttemptUri`, `TaskExecutionError` (`@jinn-network/task-execution-backend`);
  `foldObservations` (`@jinn-network/task-execution-protocol`);
  `selectCanonicalMarketplaceObservations` (`@jinn-network/marketplace-projector`); `ChainLogSource` (Task 9).
- Produces:
  - `function createProjectorObservePort(input: { readonly chain: MarketplaceChainConfig; readonly state: VenueStateDatabase; readonly logSource: ChainLogSource; readonly observations: () => Promise<readonly ProtocolObservation[]> }): MarketplaceObservePort`

**This retires the in-memory stub** the binding flags as "Milestone M4, not yet built" (§6.1). Two halves:

1. **Durable requester-scope + delivery bytes** — `claimSubmissionScope` / `resolveSubmissionScope` /
   `recordDelivery` / `deliveries` / `fetchDelivery` over two new SQLite tables. Linearizable ownership by exact
   Submission bytes, exactly as `SubmissionScopeClaim`'s four cases demand.
2. **Chain-derived observations** — `observe` / `recover` / `drive` fold the projector's observations for the Attempt,
   filtered through `selectCanonicalMarketplaceObservations` against the log source's orphaned-hash set, so a reorged
   fact is excluded and an explicit `lost` correction survives.

Schema additions (Task 6's `SCHEMA_SQL`, version → `3`):

```sql
-- Linearizable requester-scope ownership (TEP §12.2 idempotent resubmission). Matching is by
-- EXACT Submission bytes, never by field equality: `submission_bytes` is the identity.
CREATE TABLE submission_scopes (
  requester TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  submission_uri TEXT NOT NULL,
  digest TEXT NOT NULL,
  submission_bytes BLOB NOT NULL,
  owner_token TEXT NOT NULL,
  resolved_at_ms INTEGER,
  resolved_task_id TEXT,
  resolved_tx_hash TEXT,
  engagement_attempt TEXT,
  dispatch_context_json TEXT,
  PRIMARY KEY (requester, idempotency_key)
);

-- Recorded Delivery bytes per Attempt, addressed by their own sha256 digest.
CREATE TABLE attempt_deliveries (
  attempt TEXT NOT NULL,
  digest TEXT NOT NULL,
  delivery_bytes BLOB NOT NULL,
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt, digest)
);
```

- [ ] **Step 1: Write the failing store test.** `observe-store.test.ts` asserts:

  - `claimSubmissionScope` on an unseen `(requester, idempotencyKey)` returns `{ kind: "owner", ownerToken }`;
  - a second claim with **byte-identical** bytes while still pending returns `{ kind: "pending" }`;
  - a second claim with **different** bytes under the same key returns `{ kind: "conflict" }` — never `pending`;
  - after `resolveSubmissionScope`, a byte-identical claim returns `{ kind: "resolved", record }` whose
    `submissionBytes` compare equal byte-for-byte;
  - after resolution, a **different**-bytes claim still returns `{ kind: "conflict" }`;
  - `resolveSubmissionScope` with a foreign owner token throws;
  - `recordDelivery` is idempotent by `(attempt, digest)` — recording the same bytes twice leaves one row;
  - `deliveries` returns refs whose `digest` is the sha256 of the stored bytes and whose `attempt` matches;
  - `fetchDelivery` returns the exact bytes; an unknown ref throws `TaskExecutionError("result-unavailable")` — loud,
    never an empty buffer;
  - all of it survives a close/reopen of the state file.

- [ ] **Step 2: Run to verify it fails, then write `observe-store.ts`.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/observe/observe-store.test.ts`
  Expected: FAIL — `Failed to resolve import "./observe-store.js"`; then implement and re-run to PASS.

- [ ] **Step 3: Write the failing projector-observe test.** `projector-observe.test.ts` asserts:

  - `observe(attemptUri)` folds only observations for that Attempt and returns an `ObservationSnapshot` whose
    `descriptor.attempt` is the requested URI and whose `cursor` advances monotonically across calls;
  - an observation derived from a block in `logSource.orphanedBlockHashes()` is **excluded** from the fold — a reorged
    claim never presents as a live attempt;
  - an explicit `lost` correction observation for that orphaned block **is** retained, so the Attempt folds to the
    `lost` terminal rather than silently disappearing;
  - `observe(submissionUri)` resolves through the recorded scope's engagement to the same Attempt;
  - `observe` on an unknown ref throws `TaskExecutionError("attempt-not-found")`;
  - `recover` returns `"matching"` when the chain-derived fold agrees with the durable scope record,
    `"absent"` when the scope exists but the chain shows no attempt, and `"contradictory"` when the chain shows an
    attempt bound to a different Submission — the loud case §12.2 requires;
  - `drive` appends host-supplied observations without rewriting chain-derived ones (append-only);
  - `simulateReconciliation` overrides the next `recover` result for exactly one call (the conformance-kit hook).

- [ ] **Step 4: Write `projector-observe.ts`** composing the store from Step 2 with
  `selectCanonicalMarketplaceObservations(await observations(), logSource.orphanedBlockHashes())` and
  `foldObservations`. `MarketplaceObservePort`'s nine members are implemented in full:
  `claimSubmissionScope`, `resolveSubmissionScope`, `observe`, `recover`, `drive`, `recordDelivery`,
  `simulateReconciliation`, `deliveries`, `fetchDelivery`. Nothing throws `not-implemented`.

- [ ] **Step 5: Run to verify it passes.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/observe/ src/state/ && yarn typecheck`
  Expected: 10 store tests + 8 projector-observe tests pass, the schema suite passes at version 3, typecheck zero
  errors.

- [ ] **Step 6: Commit.**

  ```bash
  git add packages/marketplace/venue-base/src
  git commit -m "feat(venue-base): add the projector-backed observe port retiring the in-memory stub"
  ```

---

## Task 17: The `createBaseVenue` facade and the kit runner

**Files:**
- Create: `packages/marketplace/venue-base/src/create-base-venue.ts`
- Create: `packages/marketplace/venue-base/src/create-base-venue.test.ts`
- Modify: `packages/marketplace/venue-base/src/index.ts` (the full public surface)
- Modify: `packages/marketplace/venue-base/README.md`
- Create: `packages/marketplace/testing/src/venue-conformance.test.ts`
- Modify: `packages/marketplace/testing/package.json` (add the venue-base dependency + resolution)
- Modify: `.github/workflows/marketplace-ci.yml` (run the venue kit in the `anvil-fork` job)

**Interfaces:**
- Consumes: every port factory from Tasks 6–16.
- Produces (the cross-plan surface program §5 pins):
  - `interface BaseVenue { readonly claim: ClaimPorts; readonly settlement: SettlementPorts; readonly lifecycle: MarketplaceLifecyclePorts; readonly finality: FinalityPort; readonly deliveryWait: DeliveryWaitPort; readonly release: ReleaseAttemptPort; readonly observe: MarketplaceObservePort; readonly safe: BaseVenueSafeBroadcaster; readonly logSource: ChainLogSource; readonly intents: PostingIntentStore; close(): void }`
  - `function createBaseVenue(config: BaseVenueConfig): BaseVenue`

- [ ] **Step 1: Write the failing test.** `create-base-venue.test.ts` asserts:

  - `createBaseVenue` returns all ten named members plus `close`, and each is the shape its port declares (assigned to
    a `ClaimPorts` / `SettlementPorts` / … typed local, so a drift is a compile error);
  - the returned `safe` is assignable to `SafeBroadcastPort` — the facade's widened broadcaster still satisfies the
    binding's narrow posting port;
  - **one broadcaster instance** backs claim, settlement, lifecycle and posting: a spy on `execute` counts calls from
    all four surfaces, proving the single-broadcaster rule holds inside one `BaseVenue`;
  - **one state database** backs the ledger, cursors, intents, cancel signals and observe store: after driving one
    write through each, a single file at `stateDbPath` contains rows in all five tables;
  - `close()` closes the database and further use throws — no leaked handle;
  - constructing with a `walletClient` that has no `account` throws, naming signer injection;
  - `settlement.settleRevisedSolutionDelivery` is `undefined` for a today-generation chain and defined for revised;
  - `lifecycle.closeTask` / `lifecycle.releaseAttempt` follow the same generation conditionality;
  - two `createBaseVenue` calls against the **same** `stateDbPath` share the lock table, so their broadcasts serialize
    (the cross-process case in one process).

- [ ] **Step 2: Run to verify it fails.**

  Run: `cd packages/marketplace/venue-base && yarn vitest run src/create-base-venue.test.ts`
  Expected: FAIL — `Failed to resolve import "./create-base-venue.js"`.

- [ ] **Step 3: Write the facade.**

  ```ts
  // SPDX-License-Identifier: MIT

  // The supported composition surface (program §5). Per-port factories exist underneath; hosts
  // build a venue through this one call so the single-broadcaster rule and the single-state-file
  // rule hold by construction rather than by convention.
  import type {
    ClaimPorts, MarketplaceLifecyclePorts, MarketplaceObservePort, PostingIntentStore,
    SettlementPorts, DeliveryWaitPort, FinalityPort, ReleaseAttemptPort,
  } from "@jinn-network/marketplace-binding";
  import type { BaseVenueConfig } from "./config.js";
  import { createBroadcastLock } from "./broadcast/lock.js";
  import { createSubmissionLedger } from "./broadcast/ledger.js";
  import { createSafeBroadcaster, type BaseVenueSafeBroadcaster } from "./broadcast/safe-broadcaster.js";
  import { createChainLogSource, type ChainLogSource } from "./log-source/chain-log-source.js";
  import { createFinalityWaiter } from "./waiters/finality.js";
  import { createDeliveryWaiter } from "./waiters/delivery.js";
  import { createClaimWriter } from "./writers/claim.js";
  import { createSettlementPorts } from "./writers/settlement.js";
  import { createLifecyclePorts, createReleasePort } from "./writers/lifecycle.js";
  import { createSqlitePostingIntentStore } from "./intents/intent-store.js";
  import { createProjectorObservePort } from "./observe/projector-observe.js";
  import { openVenueState } from "./state/database.js";

  export interface BaseVenue {
    readonly claim: ClaimPorts;
    readonly settlement: SettlementPorts;
    readonly lifecycle: MarketplaceLifecyclePorts;
    readonly finality: FinalityPort;
    readonly deliveryWait: DeliveryWaitPort;
    readonly release: ReleaseAttemptPort;
    readonly observe: MarketplaceObservePort;
    readonly safe: BaseVenueSafeBroadcaster;
    readonly logSource: ChainLogSource;
    readonly intents: PostingIntentStore;
    close(): void;
  }

  export function createBaseVenue(config: BaseVenueConfig): BaseVenue {
    if (config.walletClient.account === undefined) {
      throw new Error(
        "createBaseVenue requires an injected WalletClient account: venue-base is signer-injection "
        + "only and never loads or derives key material",
      );
    }
    const state = openVenueState(config.stateDbPath);
    const ledger = createSubmissionLedger(state);
    const lock = createBroadcastLock(state);
    const safe = createSafeBroadcaster({
      chainId: config.chain.chainId,
      safeAddress: config.safeAddress,
      publicClient: config.publicClient,
      walletClient: config.walletClient,
      ledger,
      lock,
      ...(config.broadcast === undefined ? {} : { options: config.broadcast }),
    });
    const logSource = createChainLogSource({
      chain: config.chain,
      publicClient: config.publicClient,
      state,
      addresses: [config.chain.jinnRouter, config.chain.taskCoordinator, config.chain.mechMarketplace],
      ...(config.logSource === undefined ? {} : { options: config.logSource }),
    });
    const observe = createProjectorObservePort({
      chain: config.chain, state, logSource, observations: config.observations,
    });
    const claimWriter = createClaimWriter({
      chain: config.chain, publicClient: config.publicClient, safeAddress: config.safeAddress,
      broadcaster: safe, priorityMech: config.priorityMech,
    });

    return {
      // Per-engagement members (taskDigest/submission/nonce/capabilityMatch) are supplied by the
      // host at each `runPipeline` call, exactly as `pipeline.ts` spreads them over `ports.claim`.
      claim: claimWriter as ClaimPorts,
      settlement: createSettlementPorts({
        chain: config.chain, publicClient: config.publicClient, safeAddress: config.safeAddress,
        broadcaster: safe, logSource, pin: config.pin,
        verifySettlementGrade: config.verifySettlementGrade,
      }),
      lifecycle: createLifecyclePorts({
        chain: config.chain, publicClient: config.publicClient, broadcaster: safe, state,
        resolveAttempt: async (attempt) => {
          const snapshot = await observe.observe(attempt);
          const engagement = snapshot.descriptor.annotations?.["engagement"] as
            { readonly taskId: string; readonly attemptIndex: number } | undefined;
          if (engagement === undefined) {
            throw new Error(`no venue engagement recorded for attempt ${attempt}`);
          }
          return { taskId: BigInt(engagement.taskId), attemptIndex: engagement.attemptIndex };
        },
      }),
      finality: createFinalityWaiter({
        publicClient: config.publicClient, logSource,
        ...(config.finality === undefined ? {} : { options: config.finality }),
      }),
      deliveryWait: createDeliveryWaiter(config.deliveryWait),
      release: createReleasePort({ chain: config.chain, broadcaster: safe }),
      observe,
      safe,
      logSource,
      intents: createSqlitePostingIntentStore(state),
      close() {
        logSource.close();
        state.close();
      },
    };
  }
  ```

  Add `observations: () => Promise<readonly ProtocolObservation[]>` to `BaseVenueConfig` (Task 6) — the host's
  projector-fed observation source. Record it under Finding 3's disposition.

- [ ] **Step 4: Populate the public surface.** `src/index.ts` exports, grouped with section comments:
  `createBaseVenue` + `type BaseVenue` + `type BaseVenueConfig`; `openVenueState`, `VenueStateError`,
  `VENUE_STATE_SCHEMA_VERSION`, `type VenueStateDatabase`; `createSafeBroadcaster`,
  `encodePreValidatedSignature`, `type BaseVenueSafeBroadcaster`, `type SafeBroadcastRequest`,
  `type SafeBroadcastReceipt`, `type SafeBroadcastOptions`; `classifyBroadcastError`, `isNonceTooLow`,
  `isReplacementUnderpriced`, `flattenError`, `BROADCAST_DEFAULTS`, `type VenueRevertClassification`;
  `bumpFees`, `type FeeSnapshot`; `createSubmissionLedger`, `type SubmissionLedger`, `type SubmissionRecord`,
  `type SubmissionKey`; `createBroadcastLock`, `type BroadcastLock`; `evictStuckNonce`;
  `createChainLogSource`, `DEFAULT_LOG_CHUNK_BLOCKS`, `DEFAULT_FINALITY_DEPTH_FALLBACK`,
  `type ChainLogSource`, `type ChainLogBatch`, `type ChainLogCursor`, `type ChainLogSourceOptions`;
  `createFinalityWaiter`, `type FinalityWaiterOptions`; `createDeliveryWaiter`, `type DeliveryWaiterOptions`;
  `createClaimWriter`, `createClaimPreflight`, `encodeClaimTaskCalldata`, `decodeAttemptFromLogs`;
  `createSettlementPorts`; `createLifecyclePorts`, `createReleasePort`;
  `createSqlitePostingIntentStore`, `createOnChainPostingScan`, `drainPostingIntents`;
  `createProjectorObservePort`.

- [ ] **Step 5: Bind the kit to the real facade.** In `packages/marketplace/testing/package.json` add
  `"@jinn-network/marketplace-venue-base": "0.1.0"` to `dependencies` and
  `"@jinn-network/marketplace-venue-base": "portal:../venue-base"` to `resolutions`. Create
  `packages/marketplace/testing/src/venue-conformance.test.ts`:

  ```ts
  // SPDX-License-Identifier: MIT

  import { describe } from "vitest";
  import { createBaseVenue } from "@jinn-network/marketplace-venue-base";
  import { describeBroadcastProfileConformance } from "./venue-broadcast-conformance.js";
  import { describeLogSourceConformance } from "./venue-log-source-conformance.js";
  import { describeVenueRevertClassification } from "./venue-fixtures.js";
  import { describeForkVenueConformance, withForkVenue } from "./venue-fork.js";
  import { buildVenueSubjects } from "./venue-subjects.js";

  describe("venue-base conformance (design §6.6 -- the fresh implementation against the legacy oracles)", () => {
    describeVenueRevertClassification({
      classify: (error) => createBaseVenueClassifier()(error),
    });
    describeBroadcastProfileConformance(async () => buildVenueSubjects().broadcast());
    describeLogSourceConformance(async () => buildVenueSubjects().logSource());
    describeForkVenueConformance(async (deployment) => buildVenueSubjects().fork(deployment, createBaseVenue));
  });
  ```

  `venue-subjects.ts` adapts `createBaseVenue`'s output to the three kit subject interfaces; `createBaseVenueClassifier`
  is `classifyBroadcastError` re-exported through the package root.

- [ ] **Step 6: Run the kit against the real implementation.**

  ```bash
  (cd packages/marketplace/venue-base && yarn build)
  (cd packages/marketplace/testing && yarn install && yarn vitest run src/venue-conformance.test.ts)
  ```
  Expected: every revert fixture, all 7 broadcast obligations, all 7 log-source obligations and the 4 fork
  obligations pass against `createBaseVenue`. Any failure here is the fresh rewrite diverging from a legacy oracle —
  fix the implementation, never the fixture.

- [ ] **Step 7: Run the venue kit in CI.** In `.github/workflows/marketplace-ci.yml`'s `anvil-fork` job, after the
  existing conformance step, add:

  ```yaml
        - name: Run the Anvil-fork venue kit (§6.6)
          working-directory: packages/marketplace/testing
          env:
            JINN_MARKETPLACE_FORK_RPC_URL: ${{ secrets.JINN_MARKETPLACE_FORK_RPC_URL }}
          run: yarn vitest run src/venue-conformance.test.ts src/venue-fork.test.ts
  ```

- [ ] **Step 8: Commit.**

  ```bash
  git add packages/marketplace/venue-base packages/marketplace/testing .github/workflows/marketplace-ci.yml
  git commit -m "feat(venue-base): add the createBaseVenue facade and bind the venue kit to it"
  ```

---

## Task 18: Full-tree verification and the §6.1 completion checklist

**Files:**
- Modify: `packages/marketplace/venue-base/README.md` (the deliverable-to-module map)
- Modify: `packages/marketplace/testing/README.md` (one paragraph naming the venue kit and how to run it)

**Interfaces:**
- Consumes: everything Tasks 1–17 produced.
- Produces: no new code. A verified, reviewable tree.

- [ ] **Step 1: Run the full package verification, showing output.**

  ```bash
  cd packages/marketplace/venue-base
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn build
  yarn pack:smoke
  ```
  Expected: `yarn typecheck` zero errors; `yarn test` all suites green with no `.skip`; `yarn build` emits
  `dist/index.js` + `dist/index.d.ts`; `yarn pack:smoke` prints the installed-root verification line and the Jinn
  dependency boundary is exactly the four declared production dependencies.

- [ ] **Step 2: Run the venue kit, including the fork suite.**

  ```bash
  cd packages/marketplace/testing
  yarn install --immutable
  yarn typecheck
  yarn test
  yarn vitest run src/venue-conformance.test.ts src/venue-fork.test.ts
  ```
  Expected: all pre-existing marketplace-testing suites still green; the venue conformance and fork suites green with
  Anvil present. On a machine without Foundry the fork blocks must report **skipped**, never failed.

- [ ] **Step 3: Run the guard trio.**

  ```bash
  cd <repo root>
  node --test .github/scripts/marketplace-package-inventory.test.mjs
  node --test .github/scripts/marketplace-source-boundaries.test.mjs
  node .github/scripts/marketplace-packed-types.test.mjs
  ```
  Expected: inventory reports 5 packages and an approved graph; boundaries pass every test including the three new
  venue-base ones (architecture boundary, no key material, no host storage path) and the ambient-network and
  locale bans; packed-types compiles a NodeNext consumer against all five packages' entrypoints.

- [ ] **Step 4: Re-run the sibling packages to prove Task 2's binding edit broke nothing.**

  ```bash
  (cd packages/marketplace/binding && yarn typecheck && yarn test)
  (cd packages/marketplace/projector && yarn typecheck && yarn test)
  (cd packages/marketplace/pipeline && yarn typecheck && yarn test)
  ```
  Expected: all three green.

- [ ] **Step 5: Fill in the completion checklist.** Every §6.1 deliverable row maps to exactly one task, and every
  placement note and ruling has an owner. Verify each line before ticking it.

  | §6.1 deliverable | Fills | Task | Module |
  | --- | --- | --- | --- |
  | Chain log source — chunked `getLogs`, durable `(blockNumber, blockHash)` cursor, reorg handling per §7.2 | the projector's event feed | 9 | `src/log-source/chain-log-source.ts`, `src/log-source/cursor-store.ts` |
  | Safe broadcast — `execTransaction` with shared nonce ledger, cross-process lock, eviction-recovery retry, inner-revert decode | `SafeBroadcastPort` + the daemon-grade concerns `binding/src/venue/safe.ts` disclaims | 7, 8 | `src/broadcast/{classify,fees,ledger,lock,stuck-nonce,safe-broadcaster}.ts` |
  | Claim writer | `ClaimPorts.claimTask` | 11 | `src/writers/claim.ts` |
  | Settlement reads + writes — delivery-facts readers, `claimSolutionDelivery`, revised-generation settle | `SettlementPorts` | 12 | `src/writers/settlement.ts` |
  | Lifecycle writes — resolve / cancel / withdraw / refund / close / release | `MarketplaceLifecyclePorts`, `ReleaseAttemptPort` | 13 | `src/writers/lifecycle.ts` |
  | Finality waiter — over the log source, applying the projector's finality policy | `FinalityPort` | 10 | `src/waiters/finality.ts` |
  | Delivery waiter — event-watch with poll fallback and cancellation | `DeliveryWaitPort` | 14 | `src/waiters/delivery.ts` |
  | Durable posting-intent store (SQLite, §7.4) | replaces the in-memory crash WAL | 15 | `src/intents/{intent-store,drain}.ts` |
  | Projector-backed observe | `MarketplaceObservePort`, retiring the in-memory stub | 16 | `src/observe/{observe-store,projector-observe}.ts` |

  | §6.1 placement note / §7 ruling | Owner |
  | --- | --- |
  | Single-broadcaster rule | Task 8 (`createSafeBroadcaster` is the only write path) + Task 17 (one broadcaster per `BaseVenue`, asserted); the stage-1 plan re-points the surviving legacy legs |
  | Supersession note (`binding/src/venue/safe.ts` comment) | Task 2 Step 6 |
  | Port-type home (three pipeline-declared ports re-exported from binding) | Task 2 Steps 3–5 |
  | npm posture — signer-injection only | Global constraints + Task 1 Step 4 guard + Task 17 Step 3 runtime check |
  | Ruling 1 — Safe broadcasting, Defender-relayer profile with Safe-spec citations | Tasks 7, 8; kit driver Task 4 |
  | Ruling 2 — chain event ingestion, thin reader profile with dual finality marks | Task 9; kit driver Task 4 |
  | Ruling 4 — posting-intent store, transactional outbox + idempotency keys over SQLite WAL | Tasks 6, 15 |
  | §6.6 — kits precede implementations, legacy as fixtures | Tasks 3, 4, 5 (before Task 6); Task 17 binds them |
  | Storage location parameterized by the host (`stateDbPath`) | Task 6 + the host-path guard, Task 1 Step 4 |

- [ ] **Step 6: Write the README deliverable map** into `packages/marketplace/venue-base/README.md` — the same
  nine-row table, plus the signer-injection posture, the `stateDbPath` rule, and a pointer to the venue kit's run
  command. Add one paragraph to `packages/marketplace/testing/README.md` naming the venue kit's four subpath exports
  and `yarn vitest run src/venue-conformance.test.ts`.

- [ ] **Step 7: Commit and open the component's PR train.**

  ```bash
  git add packages/marketplace/venue-base/README.md packages/marketplace/testing/README.md
  git commit -m "docs(venue-base): map every §6.1 deliverable to its module and record the kit run command"
  ```

  Open the stacked PR train into `integration/evidence-v1`, then request the **independent per-component review**
  program §2 requires before stage 1 builds on this tree. Findings 1–3 (above) go in the PR description as open
  questions for the program gate — they are not resolved by this plan.

## Coordinator amendments (2026-07-30, binding on execution)

1. **Finding 1 ratified — contract 8 rescoped.** `@jinn-network/marketplace-projector` is a
   legitimate production dependency of venue-base (the log source emits its types; the
   finality waiter applies its policy; projector-backed observe is projector-backed by
   definition). The contract's operative clause is: `marketplace-pipeline` is
   guard-forbidden in venue-base production source. The program plan §6 contract 8 and the
   composition spec §6.1 carry the dated correction.
2. **Finding 2 ratified.** "Eviction recovery" means the relayer profile's stuck-nonce
   eviction; the deleted re-stake-on-failure path (#773) is not reintroduced.
3. **Finding 3 ratified.** Program §5's `createBaseVenue` config is an enumeration of
   identity-bearing members, not a closed shape; `BaseVenueConfig` as this plan defines it
   (keeping the five pinned members unrenamed) is the supported surface.
4. **Tenth deliverable added by ruling (stage-1 F1).** The marketplace deliver leg —
   `src/deliver-leg.ts`, encoding and broadcasting `deliverToMarketplace` with
   already-delivered idempotency — homes in this tree. Its TDD content and execution live
   in the stage-1 plan's Task 8 (amended paths); its kit coverage rides that task. The
   completion checklist gains this row.

## Execution findings (2026-07-31, recorded during execution)

Tasks 1–18 executed in order. Every finding below was surfaced, dispositioned and carried into
the tree; none was silently resolved. Blocking findings (F7, F9, F10) were fixed with their own
commits.

**Plan-text defects**

1. **F1 — Task 1 Step 1 orders a manifest edit that Task 17 owns.** It appends
   `@jinn-network/marketplace-venue-base` to the inventory guard's `testing` dependency graph, but
   the matching `package.json` dependency only lands in Task 17. Adding it in Task 1 makes Task 1
   Step 3's own "PASS" expectation false. *Disposition:* deferred the graph line to Task 17 and
   landed both together there.
2. **F2 — "run to verify it fails" does not fail for type-only changes.** These packages run
   Vitest without a typecheck mode, so esbuild strips type-only imports and a test referencing a
   non-existent exported type passes. *Disposition:* the red step for type-only work is
   `yarn typecheck`, not `yarn vitest run`. Applied from Task 2 onward.
3. **F4 — Task 3's supplied `venue-fixtures.test.ts` had four real bugs.** Its decodability test
   swept the deliberately-undecoded-selector fixture; its coverage test ignored the
   already-settled carve-out and so always reported the seven `ALREADY_SETTLED` names as missing;
   its reference classifier special-cased only `RouterAlreadyClaimed` of the seven and had no
   `user rejected` branch. *Disposition:* fixed in the test file. The fixture table itself was
   correct and is unchanged.
4. **F5 — Task 4's Files block omits `venue-broadcast-reference.ts`,** which its own Step 1 prose
   requires and its driver test dynamically imports. *Disposition:* created; omission recorded.
5. **F6 — the `git add` lines repeatedly omit `src/index.ts`** (Tasks 9, 10, 11, 12, 13) and
   Task 13's Files block omits `src/state/schema.ts` even though its prose orders a schema-version
   bump. *Disposition:* staged what each task's Files block and prose actually require.
6. **F8 — Task 12's `classifySettlementRevert` lists only today-generation revert names.**
   `JinnRouterV4` uses `RouterV4AlreadyClaimed` / `RouterV4WrongDeliveryOperator`, so the supplied
   set silently misclassifies every revised-generation outcome as `rejected`. *Disposition:*
   extended both sets with the V4 names.
7. **F11 — `JINN_ROUTER_V4_ABI` is a function-only slice and declares no events.** Revised-mode
   event decode has to use the projector's `REVISED_COMMON_PROJECTOR_EVENTS_ABI`. Discovered in
   Task 11, applied consistently in Tasks 12, 13, 15 and 16.
8. **F12 — `DeliveryWaitResult` has nowhere to carry a message.** Task 14's Step 1 asks for "the
   loud error's message preserved on the returned state", but the frozen type's `ok: false`
   variant carries only `kind` and an optional `AttemptState` enum. *Disposition:* returned the
   real derived `AttemptState`, which is the maximal honest signal the type supports.

**Blocking defects found and fixed**

9. **F7 — the fork kit could never have run.** Its three `writeContract` call sites omitted
   `chain`, so every fork run threw `ChainNotFoundError` before reaching an assertion. It went
   unnoticed because `contracts/artifacts` was absent, which failed the suite earlier still.
   *Fixed* (commit `a2d3c36fc`).
10. **F9 — the Safe broadcaster could not express a MultiSend batch.** Task 12's revised-generation
    settle sends a three-leg MultiSend as one `execTransaction`, but `SafeBroadcastRequest` had no
    `operation` field and the outer call was pinned to CALL. A MultiSend routed by CALL runs every
    inner leg with `msg.sender == MultiSend`, which the router's operator and party checks reject.
    *Fixed:* `operation` added, defaulting to `0`; the settle batch passes `1` (commit `6589311f0`).
11. **F10 — the fork kit ran against a Safe stub with no `execTransaction`.** `MockSafeWithNonce`
    implements `nonce()` and nothing else, so the venue's single write path — the whole broadcast
    profile — was unexercised and the four fork conformance tests were red on every run. *Fixed:*
    the backbone now mints a real Safe v1.3.0 through the canonical proxy factory already deployed
    on the forked chain. Three fixture bugs the stub had been masking surfaced and were fixed with
    it: the mech's operator must be the Safe (the router checks the claimant against it), the
    delivery fixture must go through the Safe, and the two fixture task posts must be sequential
    because they share one auto-nonced EOA (commit `a16efdf5c`).
12. **F13 — the one-slot claim test asserted an unreachable revert.** `TCMaxClaimsReached` cannot
    fire on a one-slot task: the router escrows exactly one claim's worth per slot and rejects any
    other `value`, so budget and ceiling always exhaust together and `RouterInsufficientTaskBudget`
    fires first. *Disposition:* the assertion now names the obligation that actually holds — the
    inner revert reaches the caller decoded, not as a raw selector.
13. **F14 — test scaffolding was shipping in the published package.**
    `broadcast/scripted-chain.fixture.ts` is test-only but is not a `.test.ts`, so
    `tsconfig.build.json` emitted it into `dist/`. *Fixed:* `src/**/*.fixture.ts` excluded from the
    build.
14. **F15 — Task 17 left the consuming package's lockfile stale** after moving
    `@types/better-sqlite3` into venue-base's runtime dependencies. `yarn install --immutable`
    would have failed in CI. *Fixed* (commit `b7ae53b24`).

**Environment, not plan**

15. **F3 — `contracts/artifacts` was absent** at session start, which made the entire fork slice
    unobservable and masked F7 and F10. Resolved by running `yarn compile` in `contracts/`. The
    fork kit depends on compiled Hardhat artifacts; that dependency is worth stating in the CI
    job's prerequisites.

**Deliberately not resolved (carried to the program gate)**

16. **Revised-generation settle's middle leg ABI is unconfirmed.** Task 12 implemented the deliver
    leg of `settleRevisedSolutionDelivery` against
    `deliverToMarketplace(bytes32[], bytes[])` — the only delivery-broadcast shape with
    fork-tested evidence in this repo — but could not confirm it matches the real deployed
    MechMarketplace's signed-delivery entry point. The revised generation has no fork coverage
    (`deployRevised` throws a named error; V4's ERC20 + EIP-712 deploy shape differs structurally
    from today's and no task in this plan exercises it). Confirm against the deployed contract
    before any revised-generation live-chain use.
