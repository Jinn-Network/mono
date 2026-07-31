# C3 — Tier-4 Product Tree Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** create `plugin/` — the clean-slate product's home at the repository root, sibling of the future `operator/` — containing the `@jinn-network/plugin-runtime` package, a guard trio scoped to the new tree with its own CI workflow, and a runnable process skeleton that starts, reports health, and exits cleanly. **No product capabilities are wired.** The deliverable is a tree that later components (C4 capture, C5 mirror + retrieval, C6 relevance, C7 MCP + adapter) can build into without inventing structure, and whose guards refuse the frozen trio from the first commit.

**Architecture:** one self-contained Yarn project (`plugin/runtime`) following the stack's per-package conventions exactly — no root workspace, committed `yarn.lock`, `portal:` resolutions for in-repo dependencies. Its shape is a **capability container**: typed configuration resolved from an *injected* source (custody law C2 — the library never reaches for the ambient environment), a logger and health-report surface that are the doctor contract C7 renders, and a lifecycle (`start` / `health` / `stop`) over an array of `RuntimeCapability` objects that is empty today. The guard trio is what makes the tree's boundaries real: an inventory guard over the tree's manifests, a source-boundary guard whose headline assertion is the **frozen-trio refusal** (program gate C3), and a packed-types canary compiling a consumer against the published tarball.

**Tech stack:** TypeScript 5.9 / Node 22 / Yarn 4.13.0 (self-contained project, `portal:` resolution); zod 4.4.3; vitest 4; `node:test` for the guard scripts; GitHub Actions.

## Global constraints

- **Branch:** `plugin/c3-product-tree`. **Base branch:** `integration/evidence-v1`. C3 is a **stack root** — it has no component dependencies. Stacked PRs, no self-merge.
- The package is **tier 4**. Per spec §9.4 it carries **no conformance kit**: kits gate tiers 1–3, the §9.3 four-layer channel gate is the product's acceptance harness, and the tree runs its own tests plus the kits of the stack packages it consumes (none yet — C4/C5/C6 add those runs to the workflow as they add dependencies). There is therefore **no `./testing` export** and no `describe*Conformance` surface in this tree, deliberately.
- The tree does **NOT** enter the operator image. `client/Dockerfile` copies `client/` plus `packages/{sdk,core,plugin,layer}` only (lines 27–57); `ci.yml`'s path filters name `client/**`, `packages/sdk/**`, `packages/core/**`, `packages/plugin/**`. Nothing in this plan touches either, and no task may add `plugin/` to them (spec §9.4, program §Global constraints).
- Node `>=22`; package `"type": "module"`; every relative import carries the `.js` extension.
- **Custody law C2/C3** is made structural, not aspirational: `process.env`, `process.argv`, and `process.stdout` appear in exactly one file (`src/bin.ts`), enforced by the boundary guard; key-construction helpers and key-material parameter names are refused tree-wide.
- **Custody law C5:** `publishConfig.provenance` is `true` from the first commit.
- American English throughout. The identifier `plugin` **is** permitted here — this is tier 4, and the program's no-product-names rule (§Global constraints) binds C1/C2 only.
- Every task ends with the package's `yarn typecheck && yarn test` plus the guard scripts, outputs shown.

## Path ownership — C3 versus C0 (binding; read before Task 1)

C0 (`plugin/c0-adapter-relocation`) is a **sibling stack root**, also based on `integration/evidence-v1`, and it also creates content under `plugin/`. Neither branch may assume the other has landed. Ownership is disjoint by path:

| Path | Owner | Note |
| --- | --- | --- |
| `plugin/README.md` | **C3** | Written so it is correct whether or not C0 has landed: it *reserves and describes* `plugin/frozen/`, it does not describe its contents. C0 must not create or edit this file; if C0 wants prose for the frozen directory it writes `plugin/frozen/README.md`. |
| `plugin/runtime/**` | **C3** | |
| `plugin/frozen/**` | **C0** | C3 never creates it, never reads it, and **forbids importing from it**. |
| `plugin/adapter-hermes/**` | **C7** | Python, mirrored to the slim repo, **not** npm-published. C3 does not create it (git cannot track an empty directory); it is reserved in `plugin/README.md` and asserted manifest-free by the inventory guard. |
| `.github/scripts/plugin-tree-*.test.mjs` | **C3** | Four new files; no existing script is modified. |
| `.github/workflows/plugin-tree-ci.yml` | **C3** | New file. |
| `.github/workflows/jinn-plugin-split.yml`, `.github/scripts/{jinn-plugin-split,verify-layer-stable-version}.mjs` | **C0** | C3 does not touch them. |
| root `.gitignore` — the `plugin/` block | **C3** | C0's relocation moves a Python directory and one JSON file; it produces no build output and needs no ignore rule. If C0 nonetheless needs one it appends a separate line, which merges cleanly with C3's contiguous block. |

**The two roots therefore share no file.** A textual merge conflict between them is impossible; the only coupling is C3's forbidden-root entry for `plugin/frozen`, and that entry is **pure path arithmetic**. The boundary helper resolves it through `insideForbiddenRoot(path, forbiddenRoot)`, which falls back to `inside(path, forbiddenRoot)` — a `relative()` computation — when the root does not exist on disk (`.github/scripts/evidence-source-boundaries.test.mjs:377-381`). Task 2 Step 6 proves this with a fixture that runs green while `plugin/frozen/` is absent. Nothing in C3 waits for C0, and C0 landing later changes no C3 behavior.

**One shared consequence to state:** `plugin-tree-ci.yml`'s path filter is `plugin/**`, so once both have landed, C0's frozen directory is also covered by C3's architecture job. That is desirable (the inventory guard asserts the frozen directory stays manifest-free) and requires no coordination.

---

## Naming decision — `plugin-tree-*`, not `plugin-*` (finding F-C3-1)

The task brief specifies `.github/workflows/plugin-ci.yml`. **That file already exists** and belongs to the frozen `packages/plugin` (`.github/workflows/plugin-ci.yml:1-54`, `paths: ['packages/plugin/**']`, plus a `client-compat` job running `yarn build:plugin`/`build:core`/`build:layer`). It is dismantled by C9, not by C3, so the name is unavailable for the entire program.

**Ruling:** all four artifacts take the `plugin-tree-` prefix — `.github/scripts/plugin-tree-{package-inventory,source-boundaries,packed-types}.test.mjs` and `.github/workflows/plugin-tree-ci.yml`. Rejected alternatives: renaming the frozen workflow (a freeze violation under spec §4.1 and it would churn branch protection twice); shipping scripts as `plugin-*` and the workflow as `plugin-tree-ci.yml` (a split prefix invites a wrong path filter); waiting for C9 (would leave the tree unguarded through five components). The prefix also disambiguates the new tree from the frozen package for a human reading a red check. Recorded in §Findings.

---

## File structure

Paths relative to the repository root.

| File | Responsibility |
| --- | --- |
| `plugin/README.md` | tree map: what `plugin/` is, which component owns which subdirectory |
| `plugin/runtime/{package.json,tsconfig.json,tsconfig.build.json,.yarnrc.yml,.gitignore,README.md}` | package scaffold |
| `plugin/runtime/src/errors.ts` | `PluginRuntimeError`, `RUNTIME_ERROR_CODES` |
| `plugin/runtime/src/logger.ts` | `RuntimeLogger`, `createLineLogger` |
| `plugin/runtime/src/config.ts` | `RuntimeConfig`, `RuntimeConfigSource`, `resolveRuntimeConfig` |
| `plugin/runtime/src/health.ts` | `HealthCheck`, `HealthReport`, `summarizeHealth` |
| `plugin/runtime/src/capability.ts` | `RuntimeCapability`, `CapabilityContext` |
| `plugin/runtime/src/runtime.ts` | `PluginRuntime`, `createPluginRuntime` |
| `plugin/runtime/src/version.ts` | `RUNTIME_VERSION` |
| `plugin/runtime/src/bin.ts` | the process skeleton — the only file touching `process` |
| `plugin/runtime/src/index.ts` | public surface |
| `plugin/runtime/scripts/pack-smoke.mjs` | tarball shape + isolated-consumer smoke |
| `.github/scripts/plugin-tree-package-inventory.test.mjs` | guard 1 — manifests, dependency graph, portal resolutions |
| `.github/scripts/plugin-tree-source-boundaries.test.mjs` | guard 2 — frozen-trio refusal, allowlist, custody, locale canary |
| `.github/scripts/plugin-tree-packed-types.test.mjs` | guard 3 — packed public entrypoint compiles |
| `.github/workflows/plugin-tree-ci.yml` | the tree's CI |

Repo file this plan also edits: root `.gitignore` (one contiguous block).

---

### Task 1: Create the tree, scaffold `plugin/runtime`, and register it with the inventory guard

**Files:**
- Create: `.github/scripts/plugin-tree-package-inventory.test.mjs`
- Create: `plugin/README.md`, `plugin/runtime/package.json`, `plugin/runtime/tsconfig.json`, `plugin/runtime/tsconfig.build.json`, `plugin/runtime/.yarnrc.yml`, `plugin/runtime/.gitignore`, `plugin/runtime/README.md`, `plugin/runtime/src/index.ts`
- Modify: root `.gitignore` (insert after line 69, `packages/marketplace/*/.yarn/install-state.gz`)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the directory `plugin/runtime` publishing `@jinn-network/plugin-runtime@0.1.0` with a single export `"."` and a `bin` entry `jinn-plugin-runtime`; the guard constants `PLUGIN_PACKAGES`, `NON_NPM_DIRECTORIES`, `SIBLING_TREE_DIRS`, `JINN_DEPENDENCY_GRAPH` that every later component extends.

- [x] **Step 1: Write the inventory guard so it fails**

Create `.github/scripts/plugin-tree-package-inventory.test.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'plugin');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// The tier-4 product tree (plugin reconciliation design §6.1, program §4). Every npm
// package under plugin/ is declared here; the discovery test below proves the list is
// complete rather than trusting it.
const PLUGIN_PACKAGES = [
  ['runtime', '@jinn-network/plugin-runtime'],
];

// Directories inside plugin/ that are deliberately NOT npm packages:
//   frozen         — C0's relocated Hermes adapter (Python; frozen per spec §4.1)
//   adapter-hermes — C7's clean-slate Hermes adapter (Python; mirrored, never published)
// Both are asserted manifest-free rather than listed above. Absence is fine: this guard
// must pass whether or not C0 or C7 has landed.
const NON_NPM_DIRECTORIES = ['frozen', 'adapter-hermes'];

// Cross-tree Jinn dependencies live outside plugin/; map name -> absolute directory so a
// later component adding one only adds its JINN_DEPENDENCY_GRAPH row
// (benchmarking-package-inventory.test.mjs precedent). Pre-seeded with the whole
// composition table of design §6.1 plus the two packages C1 and C2 commission — an entry
// here grants nothing on its own; the graph is what admits a dependency.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/evidence-protocol', join(root, 'packages', 'evidence', 'protocol')],
  ['@jinn-network/evidence-repository', join(root, 'packages', 'evidence', 'repository')],
  ['@jinn-network/evidence-repository-ipfs', join(root, 'packages', 'evidence', 'repository-ipfs')],
  ['@jinn-network/evidence-catalog-sqlite', join(root, 'packages', 'evidence', 'catalog-sqlite')],
  // Local Runtime re-exports `EvidenceCatalogReader` only as a type
  // (packages/evidence/local-runtime/src/types.ts:4), and it is declared in Discovery
  // (packages/evidence/discovery/src/catalog/types.ts). Any consumer of
  // `LocalEvidenceRuntime.catalog` needs Discovery resolvable for tsc.
  ['@jinn-network/evidence-discovery', join(root, 'packages', 'evidence', 'discovery')],
  ['@jinn-network/evidence-local-runtime', join(root, 'packages', 'evidence', 'local-runtime')],
  ['@jinn-network/evidence-retrieval', join(root, 'packages', 'evidence', 'retrieval')],
  ['@jinn-network/evidence-derivation', join(root, 'packages', 'evidence', 'derivation')],
  ['@jinn-network/evidence-trajectory', join(root, 'packages', 'evidence', 'trajectory')],
  ['@jinn-network/evidence-trace-decode', join(root, 'packages', 'evidence', 'trace-decode')],
  ['@jinn-network/execution-recorder', join(root, 'packages', 'evidence', 'execution-recorder')],
  ['@jinn-network/record-discovery-protocol', join(root, 'packages', 'discovery', 'protocol')],
  ['@jinn-network/record-discovery-client', join(root, 'packages', 'discovery', 'client')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
  ['@jinn-network/trust-resolve', join(root, 'packages', 'trust', 'resolve')],
]);

// C3 wires no capability, so the runtime declares no Jinn dependency yet. C4/C5/C6/C7
// each add their row here together with a matching portal: resolution.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['runtime', {
    dependencies: [], devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === 'node_modules') return [];
    const child = join(directory, entry.name);
    const packageJson = join(child, 'package.json');
    return [
      ...(existsSync(packageJson) ? [packageJson] : []),
      ...packageManifests(child),
    ];
  });
}

function jinnDependencyNames(manifest, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => name.startsWith('@jinn-network/')).sort();
}

function expectedPortal(directory, dependencyName) {
  const inTree = PLUGIN_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the plugin tree inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `plugin/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(packageRoot)
    .map((packageJson) => [
      relative(packageRoot, dirname(packageJson)),
      JSON.parse(readFileSync(packageJson, 'utf8')).name,
    ])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  assert.deepEqual(
    actual,
    [...PLUGIN_PACKAGES].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    'every package.json under plugin/ must be a declared plugin-tree package',
  );
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /PLUGIN_PACKAGES\.length\s*,\s*\d+/);
});

test('the Python adapter directories carry no npm manifest', () => {
  for (const directory of NON_NPM_DIRECTORIES) {
    const candidate = join(packageRoot, directory);
    if (!existsSync(candidate)) continue;
    assert.deepEqual(
      packageManifests(candidate).map((path) => relative(root, path)),
      [],
      `plugin/${directory} is a Python directory (C0 frozen adapter / C7 clean-slate adapter); `
        + 'it is mirrored, never npm-published, and must not grow a package manifest',
    );
  }
});

test('plugin tree Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS
      .flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions)
      .filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, declared, `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of declared) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});

test('every plugin tree package publishes with trusted-publisher provenance', () => {
  for (const [directory] of PLUGIN_PACKAGES) {
    const manifest = readPackage(directory);
    assert.deepEqual(
      manifest.publishConfig,
      { access: 'public', provenance: true },
      `${directory} must publish publicly with provenance (custody law C5)`,
    );
  }
});
```

- [x] **Step 2: Run the guard to verify it fails**

Run: `node --test .github/scripts/plugin-tree-package-inventory.test.mjs`
Expected: FAIL — `missing package manifest: <repo>/plugin/runtime/package.json` on the first, fourth, and fifth tests. (The cardinality self-test and the non-npm-directory test pass; 3 of 5 fail.)

- [x] **Step 3: Create the tree README**

`plugin/README.md`:

```markdown
# plugin/

The Jinn Plugin — the host-side evidence integration that makes an interactive agent a
first-class participant on the evidence plane. It captures sessions as standard Execution
Evidence records into a local archive, and retrieves relevant evidence into the agent's
context from both the operator's own archive and the public corpus.

This is a **tier-4 product tree**: it composes stack packages through their public
interfaces and carries no conformance kit of its own. Kits gate tiers 1–3; this tree's
acceptance harness is the channel-cutover gate.

See `../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md`.

## Layout

| Directory | What it is |
| --- | --- |
| `runtime/` | `@jinn-network/plugin-runtime` — the stack-composed MCP runtime. npm-published; the artifact the Hermes adapter acquires by exact pin. |
| `adapter-hermes/` | The clean-slate Hermes adapter. Python; mirrored to the `Jinn-Network/jinn-plugin` channel repository; **never** npm-published. |
| `frozen/` | The superseded 0.1.2-era Hermes adapter and its `layer-runtime.json`, relocated here content-unchanged so the `apps/jinn-agent` fork can be removed. Frozen: critical fixes only, no feature work. Removed when the published trio retires. |

`runtime/` must never import from `frozen/`, and the source-boundary guard enforces it.

## Guards

`.github/scripts/plugin-tree-package-inventory.test.mjs`,
`.github/scripts/plugin-tree-source-boundaries.test.mjs`,
`.github/scripts/plugin-tree-packed-types.test.mjs`, run by
`.github/workflows/plugin-tree-ci.yml`.

Adding a dependency to a package in this tree means adding it to the inventory guard's
dependency graph with a matching `portal:` resolution; the source-boundary guard's
allowlist already admits the composition table of the design's §6.1.
```

- [x] **Step 4: Create the package scaffold**

`plugin/runtime/package.json`:

```json
{
  "name": "@jinn-network/plugin-runtime",
  "version": "0.1.0",
  "description": "The Jinn Plugin runtime — host-side capture and federated retrieval over the evidence plane.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "plugin/runtime"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": {
    "jinn-plugin-runtime": "./dist/bin.js"
  },
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public",
    "provenance": true
  },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  },
  "resolutions": {
    "vite": "6.4.3"
  }
}
```

`plugin/runtime/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2022", "DOM"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`plugin/runtime/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`plugin/runtime/.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

`plugin/runtime/.gitignore`:

```
dist/
node_modules/
*.tgz
```

`plugin/runtime/src/index.ts` (placeholder, replaced in Task 10):

```ts
// SPDX-License-Identifier: Apache-2.0

export {};
```

`plugin/runtime/README.md`:

```markdown
# @jinn-network/plugin-runtime

The Jinn Plugin's runtime: one small stack-composed process that captures the host
session as a standard Execution Evidence record into a local archive, and retrieves
relevant evidence back into the agent's context from the local archive and the public
corpus.

The runtime is a **capability container**. Configuration is typed and injected — the
library never reads the ambient environment; only the binary does, and it passes what it
read. Capabilities register against a lifecycle (`start` / `health` / `stop`) and
contribute health checks in the `{ name, ok, detail, remedy }` shape the host adapter's
doctor renders.

**The local evidence archive is opened per operation, never held across `start`/`stop`.**
`openLocalEvidenceRuntime` takes an exclusive lock on the runtime root, and a session may
run two runtime instances at once; a capability holding the archive open would starve its
sibling for the session.

**stdout is reserved** for the MCP stdio transport. Every diagnostic goes to stderr; the
only stdout write in this package is the `health` subcommand's single JSON line.

The binary is `jinn-plugin-runtime`. The host adapter acquires it by exact pin.

See `../../docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md` §6.
```

- [x] **Step 5: Add the tree's build artefacts to the root `.gitignore`**

In the root `.gitignore`, insert immediately after line 69 (`packages/marketplace/*/.yarn/install-state.gz`) and before line 70 (`examples/external-restorer-impls/*/node_modules/`):

```
plugin/*/dist/
plugin/*/.yarn/cache/
plugin/*/.yarn/install-state.gz
plugin/*/.pnp.cjs
plugin/*/.pnp.loader.mjs
plugin/.plugin-tree-*/
```

The last line covers the in-repo boundary fixture Task 2 creates under `plugin/` (the fixture removes itself in a `finally`; this is insurance against a crashed run leaving cruft, matching the `repository-ipfs` in-repo-fixture precedent).

- [x] **Step 6: Install and re-run the inventory guard**

Run: `cd plugin/runtime && yarn install && cd - && node --test .github/scripts/plugin-tree-package-inventory.test.mjs`
Expected: PASS — `# pass 5`, `# fail 0`. `plugin/runtime/yarn.lock` now exists and is committed.

- [x] **Step 7: Verify the placeholder typechecks and builds**

Run: `cd plugin/runtime && yarn typecheck && yarn build && ls dist`
Expected: no diagnostics; `dist` contains `index.js` and `index.d.ts`.

- [x] **Step 8: Commit**

```bash
git add plugin .gitignore .github/scripts/plugin-tree-package-inventory.test.mjs
git commit -m "feat(plugin-runtime): create the tier-4 product tree and its inventory guard"
```

---

### Task 2: The source-boundary guard and the frozen-trio refusal (program gate C3)

**Files:**
- Create: `.github/scripts/plugin-tree-source-boundaries.test.mjs`

**Interfaces:**
- Consumes: the tree created in Task 1.
- Produces: the tree's boundary contract — `PERMITTED_PACKAGES`, `FORBIDDEN_PACKAGES`, `FORBIDDEN_ROOTS`, and the helpers `files`, `specifiers`, `inside`, `insideForbiddenRoot`, `packageSpecifierMatches`, `forbiddenImportsInFiles`, `forbiddenImports`, `assertBoundary`, `manifest`. The custody and stdout assertions are added to this file in Task 9.

The allowlist is installed **now**, before any dependency exists, so that C4–C7 add dependencies without renegotiating the boundary — and so that the packages the design deliberately parks (the outbound publication lane) cannot arrive as a silent import. It anticipates exactly the composition table of design §6.1 plus the two packages the program commissions.

- [x] **Step 1: Write the guard**

Create `.github/scripts/plugin-tree-source-boundaries.test.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const tree = join(root, 'plugin');
const runtimeSource = join(tree, 'runtime', 'src');

// Floor on how many files the real-tree scan visits, so a future source move cannot make
// the scan silently pass zero files (custody-boundaries.test.mjs precedent).
const MIN_SCANNED_FILES = 8;

// The frozen trio (spec §4). Nothing in this tree may import them, ever: the clean-slate
// product supersedes them rather than migrating them. They are banned by package name,
// by subpath, and by relative path into their source trees.
const FROZEN_TRIO = [
  '@jinn-network/core',
  '@jinn-network/jinn-layer',
  '@jinn-network/plugin',
];
const FROZEN_TRIO_ROOTS = [
  join(root, 'packages', 'core'),
  join(root, 'packages', 'layer'),
  join(root, 'packages', 'plugin'),
];

// The composition table of design §6.1, plus the two packages the program commissions
// (C1 evidence-trajectory, C2 evidence-trace-decode) and the third-party libraries the
// design names. Being permitted here grants nothing on its own — the inventory guard's
// dependency graph is what admits a dependency. This list exists so that a normal
// dependency addition by C4-C7 needs no edit to the boundary contract, and so that
// anything NOT on it is a deliberate, reviewed decision.
const PERMITTED_PACKAGES = [
  '@jinn-network/evidence-catalog-sqlite',
  '@jinn-network/evidence-derivation',
  '@jinn-network/evidence-discovery',
  '@jinn-network/evidence-local-runtime',
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-repository-ipfs',
  '@jinn-network/evidence-retrieval',
  '@jinn-network/evidence-trace-decode',
  '@jinn-network/evidence-trajectory',
  '@jinn-network/execution-recorder',
  '@jinn-network/record-discovery-client',
  '@jinn-network/record-discovery-protocol',
  '@jinn-network/trust-core',
  '@jinn-network/trust-resolve',
  '@modelcontextprotocol/sdk',
  '@noble/hashes',
  'better-sqlite3',
  'zod',
];

const FORBIDDEN_PACKAGES = [
  ...FROZEN_TRIO,
  // Applications and legacy surfaces. The product is a peer of these, never a consumer.
  '@jinn-network/autopilot',
  '@jinn-network/client',
  '@jinn-network/indexer',
  '@jinn-network/indexer-enrichment',
  '@jinn-network/sdk',
  'hermes-agent',
  // The outbound lane is PARKED (spec §5, §13): captured records are publishable by
  // construction, and un-parking is a consent surface plus derivation-scrub at the
  // boundary — a reviewed decision that edits this list, never a silent import.
  '@jinn-network/evidence-contribution',
  '@jinn-network/evidence-publication',
  // No issuance surface in this scope.
  '@jinn-network/attestation-issuer',
  // Family bans by prefix, so they hold the moment any member registers. The launcher
  // contract needs no change and the plugin attaches beside the launchers, never inside
  // them (spec §6.5); there is no marketplace or benchmarking surface in scope (§13).
  '@jinn-network/benchmarking-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-execution-*',
  // No chain surface: the runtime is read-plus-local-write and holds no keys (§8.5).
  'viem',
];

const FORBIDDEN_ROOTS = [
  ...FROZEN_TRIO_ROOTS,
  join(root, 'apps'),
  join(root, 'client'),
  // C0's relocated frozen adapter. This entry is pure path arithmetic and is correct
  // whether or not C0 has landed — insideForbiddenRoot() falls through to a relative()
  // computation when the root does not exist on disk.
  join(tree, 'frozen'),
];

// Canonical bytes must not depend on the host locale or the bundled ICU data: an ordering
// or formatting decision made with these APIs can change a record's digest between two
// hosts running identical code. Fail-closed by default; a presentation surface that
// genuinely needs locale formatting lands as an explicit, reviewed carve-out here.
const LOCALE_SENSITIVE_APIS = [
  'localeCompare',
  'toLocaleUpperCase',
  'toLocaleLowerCase',
  'toLocaleString',
  'toLocaleDateString',
  'toLocaleTimeString',
];
const localeSensitiveMember = new RegExp(
  String.raw`(?:\.|\?\.)\s*(?:${LOCALE_SENSITIVE_APIS.join('|')})\s*\(`,
  'g',
);
const localeSensitiveIntl = new RegExp(
  String.raw`(?<![\w$."'\x60])Intl\s*(?:\.|\?\.)`,
  'g',
);

function localeSensitiveUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [
      ...[...source.matchAll(localeSensitiveMember)],
      ...[...source.matchAll(localeSensitiveIntl)],
    ].map((match) => `${relative(root, file)} -> ${match[0].trim()}`);
  }).sort();
}

function files(directory) {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isFile()) return /\.(?:[cm]?[jt]sx?)$/.test(directory) ? [directory] : [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

function specifiers(source) {
  const trivia = String.raw`(?:(?:\s+)|(?:\/\*[\s\S]*?\*\/)|(?:\/\/[^\r\n]*(?:\r?\n|$)))*`;
  return [
    new RegExp(String.raw`\bfrom${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}["']([^"']+)["']`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}["']([^"']+)["']${trivia}\)`, 'g'),
    new RegExp(String.raw`\bimport${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
    new RegExp(String.raw`\brequire${trivia}\(${trivia}\x60((?:(?!\$\{)[^\x60])*)\x60${trivia}\)`, 'g'),
  ].flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function sourceModuleStem(path) {
  return path.replace(/\.[cm]?[jt]sx?$/u, '');
}

function insideForbiddenRoot(path, forbiddenRoot) {
  return existsSync(forbiddenRoot) && lstatSync(forbiddenRoot).isFile()
    ? sourceModuleStem(path) === sourceModuleStem(forbiddenRoot)
    : inside(path, forbiddenRoot);
}

// A forbidden entry ending in `*` bans a whole package-name family by prefix; one ending
// in `/` bans by literal prefix; otherwise it must match the specifier exactly or as its
// subpath root (benchmarking-source-boundaries.test.mjs precedent).
function packageSpecifierMatches(specifier, forbidden) {
  if (forbidden.endsWith('*')) return specifier.startsWith(forbidden.slice(0, -1));
  if (forbidden.endsWith('/')) return specifier.startsWith(forbidden);
  return specifier === forbidden || specifier.startsWith(`${forbidden}/`);
}

function forbiddenImportsInFiles(sourceFiles, forbiddenPackages, forbiddenRoots = []) {
  return sourceFiles.flatMap((file) => specifiers(readFileSync(file, 'utf8')).flatMap((specifier) => {
    const packageMatch = forbiddenPackages.some((forbidden) => packageSpecifierMatches(specifier, forbidden));
    const pathMatch = specifier.startsWith('.') && forbiddenRoots.some((forbiddenRoot) =>
      insideForbiddenRoot(resolve(dirname(file), specifier), forbiddenRoot));
    return packageMatch || pathMatch ? [`${relative(root, file)} -> ${specifier}`] : [];
  })).sort();
}

function forbiddenImports(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  return forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots);
}

function assertBoundary(sourceRoot, forbiddenPackages, forbiddenRoots = []) {
  assert.deepEqual(forbiddenImportsInFiles(files(sourceRoot), forbiddenPackages, forbiddenRoots), [],
    `${relative(root, sourceRoot)} crosses a plugin tree architecture boundary`);
}

function manifest(directory) {
  return JSON.parse(readFileSync(join(tree, directory, 'package.json'), 'utf8'));
}

/** A `./`-prefixed relative specifier from `fixtureDir` to `target`. */
function localSpecifier(fixtureDir, target) {
  const specifier = relative(fixtureDir, target).replaceAll('\\', '/');
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

test('the import scanner catches static, export, dynamic, require, and local-path escapes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-boundary-'));
  try {
    const source = join(fixture, 'src');
    const forbidden = join(fixture, 'forbidden');
    mkdirSync(source); mkdirSync(forbidden);
    writeFileSync(join(source, 'source.ts'), [
      'import value from "@jinn-network/forbidden";',
      'export { value } from "@jinn-network/forbidden/export";',
      'await import("@jinn-network/forbidden/dynamic");',
      'require("@jinn-network/forbidden/require");',
      'await import(/* webpackIgnore: true */ "@jinn-network/forbidden/commented-dynamic");',
      'export { value } from /* boundary */ "@jinn-network/forbidden/commented-export";',
      'await import(// boundary', '  "@jinn-network/forbidden/line-comment");',
      'export { value } from /* first */ /* second */ "@jinn-network/forbidden/multiple-comments";',
      'await import(`@jinn-network/forbidden/template-dynamic`);',
      'require(`@jinn-network/forbidden/template-require`);',
      'import "../forbidden/local.js";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, ['@jinn-network/'], [forbidden]).length, 11);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the family wildcard bans every member of a banned package family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-wildcard-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import "@jinn-network/marketplace-binding";',
      'import "@jinn-network/benchmarking-records";',
      'import "@jinn-network/task-execution-launchers";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, FORBIDDEN_PACKAGES).length, 3);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the guard refuses the frozen trio by name, by subpath, and by relative path', () => {
  // Created INSIDE the repository so that relative-path escapes resolve against the real
  // forbidden roots (repository-ipfs production-boundary test precedent).
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-boundary-'));
  try {
    const source = join(fixture, 'source.ts');
    writeFileSync(source, [
      'import "@jinn-network/core";',
      'import "@jinn-network/jinn-layer";',
      'import "@jinn-network/plugin";',
      'export * from "@jinn-network/core/scrub";',
      'await import("@jinn-network/plugin/ports");',
      'require("@jinn-network/jinn-layer/publish");',
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'core', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'layer', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(root, 'packages', 'plugin', 'src')))};`,
      `import ${JSON.stringify(localSpecifier(fixture, join(tree, 'frozen', 'jinn_layer.py')))};`,
    ].join('\n'));
    const findings = forbiddenImportsInFiles([source], FORBIDDEN_PACKAGES, FORBIDDEN_ROOTS);
    const label = relative(root, source);
    assert.deepEqual(findings, [
      `${label} -> ../packages/core/src`,
      `${label} -> ../packages/layer/src`,
      `${label} -> ../packages/plugin/src`,
      `${label} -> @jinn-network/core`,
      `${label} -> @jinn-network/core/scrub`,
      `${label} -> @jinn-network/jinn-layer`,
      `${label} -> @jinn-network/jinn-layer/publish`,
      `${label} -> @jinn-network/plugin`,
      `${label} -> @jinn-network/plugin/ports`,
      `${label} -> ./frozen/jinn_layer.py`,
    ].sort());
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the frozen-root ban holds before C0 relocates the adapter', () => {
  // C0 is a sibling stack root; this tree must refuse plugin/frozen imports whether or
  // not that directory exists yet.
  assert.equal(existsSync(join(tree, 'frozen')) ? 'present' : 'absent', existsSync(join(tree, 'frozen')) ? 'present' : 'absent');
  const fixture = mkdtempSync(join(tree, '.plugin-tree-frozen-absent-'));
  try {
    const source = join(fixture, 'source.ts');
    writeFileSync(source, `import ${JSON.stringify(localSpecifier(fixture, join(tree, 'frozen', 'plugin.yaml')))};`);
    assert.equal(
      forbiddenImportsInFiles([source], [], [join(tree, 'frozen')]).length,
      1,
      'the plugin/frozen ban is path arithmetic and must not depend on the directory existing',
    );
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the permitted allowlist and the forbidden list are disjoint', () => {
  const collisions = PERMITTED_PACKAGES.filter((permitted) =>
    FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(permitted, forbidden)));
  assert.deepEqual(collisions, [], 'a package may not be both permitted and forbidden');
  for (const frozen of FROZEN_TRIO) {
    assert.ok(FORBIDDEN_PACKAGES.includes(frozen), `${frozen} must be forbidden by name`);
    assert.ok(!PERMITTED_PACKAGES.includes(frozen), `${frozen} must not be permitted`);
  }
});

test('locale-sensitive API detection catches member calls, optional chaining, and Intl', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-locale-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      ...LOCALE_SENSITIVE_APIS.flatMap((api) => [`left.${api}(right);`, `left?.${api}(right);`]),
      'new Intl.Collator("en-US").compare(left, right);',
      'Intl?.Collator;',
    ].join('\n'));
    assert.equal(
      localeSensitiveUsesInFiles(files(source)).length,
      LOCALE_SENSITIVE_APIS.length * 2 + 2,
    );
    writeFileSync(join(source, 'clean.ts'), [
      'export function compareCodeUnitStrings(left, right) {',
      '  return left < right ? -1 : left > right ? 1 : 0;',
      '}',
      '// localeCompare is banned; this comment must not trip the scanner.',
    ].join('\n'));
    assert.deepEqual(localeSensitiveUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('plugin tree source boundaries hold and the manifest matches the approved shape', () => {
  const sourceFiles = files(runtimeSource);
  assert.ok(
    sourceFiles.length >= MIN_SCANNED_FILES,
    `expected at least ${MIN_SCANNED_FILES} source files scanned, got ${sourceFiles.length} — `
      + 'the runtime may have moved sources out of src/',
  );
  assertBoundary(runtimeSource, FORBIDDEN_PACKAGES, FORBIDDEN_ROOTS);

  const production = sourceFiles.filter((file) => !/\.test\.[cm]?[jt]sx?$/u.test(file));
  assert.deepEqual(
    localeSensitiveUsesInFiles(production),
    [],
    'plugin/runtime production source must not depend on the host locale or ICU data',
  );

  const runtimeManifest = manifest('runtime');
  assert.deepEqual(
    Object.keys(runtimeManifest.exports).sort(),
    ['.'],
    'the runtime publishes one entrypoint: tier 4 carries no conformance kit, so there is '
      + 'no ./testing export (spec §9.4)',
  );
  assert.deepEqual(runtimeManifest.exports['.'], {
    import: './dist/index.js',
    types: './dist/index.d.ts',
  });
  assert.deepEqual(runtimeManifest.bin, { 'jinn-plugin-runtime': './dist/bin.js' });
  assert.deepEqual(runtimeManifest.files.sort(), ['README.md', 'dist/']);
  for (const section of [
    'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
  ]) {
    for (const dependency of Object.keys(runtimeManifest[section] ?? {})) {
      assert.ok(
        !FORBIDDEN_PACKAGES.some((forbidden) => packageSpecifierMatches(dependency, forbidden)),
        `runtime may not declare ${dependency} in ${section}`,
      );
      assert.ok(
        PERMITTED_PACKAGES.includes(dependency) || !dependency.startsWith('@jinn-network/'),
        `runtime declares Jinn dependency ${dependency}, which is not on the permitted list`,
      );
    }
  }
});
```

- [x] **Step 2: Run the guard to verify it passes**

Run: `node --test .github/scripts/plugin-tree-source-boundaries.test.mjs`
Expected: PASS — `# pass 7`, `# fail 0`.

> The `MIN_SCANNED_FILES` floor is 8 and the tree has one source file today, so this run **fails** the last test with `expected at least 8 source files scanned, got 1`. That is deliberate ordering: the floor is set for the tree the plan delivers. Verify the six self-tests pass now and re-run at the end of Task 10.
>
> Actual expected at this step: `# pass 6`, `# fail 1`, the failure being exactly the file-count floor. Confirm the message names the floor and nothing else.

- [x] **Step 3: Run the negative test against the real package — the program's C3 gate**

Program §6 requires that the guard trio red-lines a deliberate frozen-trio import. Prove it on the real file, not only on a fixture.

```bash
cat >> plugin/runtime/src/index.ts <<'EOF'
import "@jinn-network/core";
EOF
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```

Expected: FAIL, with the boundary assertion reporting
`plugin/runtime/src/index.ts -> @jinn-network/core` and the message
`plugin/runtime/src crosses a plugin tree architecture boundary`.

- [x] **Step 4: Repeat for the other two frozen identities**

```bash
git checkout plugin/runtime/src/index.ts
cat >> plugin/runtime/src/index.ts <<'EOF'
export * from "@jinn-network/plugin";
await import("@jinn-network/jinn-layer");
EOF
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```

Expected: FAIL, reporting both
`plugin/runtime/src/index.ts -> @jinn-network/jinn-layer` and
`plugin/runtime/src/index.ts -> @jinn-network/plugin`.

- [x] **Step 5: Revert the deliberate violation and confirm the tree is clean**

```bash
git checkout plugin/runtime/src/index.ts
git status --porcelain plugin/runtime/src
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```

Expected: `git status --porcelain` prints nothing; the guard returns to `# pass 6`, `# fail 1` (the file-count floor only).

- [x] **Step 6: Confirm the `plugin/frozen` ban works with C0 absent**

Run: `ls plugin` and then `node --test --test-name-pattern 'frozen-root ban' .github/scripts/plugin-tree-source-boundaries.test.mjs`
Expected: `ls plugin` shows `README.md` and `runtime` only — no `frozen`. The named test passes, proving the ban is path arithmetic and C3 does not wait for C0.

- [x] **Step 7: Commit**

```bash
git add .github/scripts/plugin-tree-source-boundaries.test.mjs
git commit -m "feat(plugin-runtime): source-boundary guard refusing the frozen trio"
```

---

### Task 3: The packed-types canary

**Files:**
- Create: `.github/scripts/plugin-tree-packed-types.test.mjs`

**Interfaces:**
- Consumes: the built `plugin/runtime/dist` from Task 1.
- Produces: `packages`, `codeEntrypoints`, `CROSS_TREE_PACKAGES` — the three lists later components extend.

- [x] **Step 1: Write the canary**

Create `.github/scripts/plugin-tree-packed-types.test.mjs`:

```js
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const treeRoot = join(root, 'plugin');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'jinn-plugin-tree-packed-types-'));
const archivesRoot = join(temporaryRoot, 'archives');
const consumerRoot = join(temporaryRoot, 'consumer');

const packages = [
  ['runtime', '@jinn-network/plugin-runtime'],
];

const codeEntrypoints = [
  '@jinn-network/plugin-runtime',
];

// Cross-tree Jinn dependencies must be packed as file: deps so NodeNext resolves them
// from the packed consumer (benchmarking-packed-types.test.mjs precedent). C3 declares
// none; C4-C7 add rows here as they add dependencies.
const CROSS_TREE_PACKAGES = [];

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = Buffer.concat(stdout).toString('utf8');
      const errorOutput = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolvePromise(output);
        return;
      }
      reject(new Error(`${command} exited with ${code}:\n${output}${errorOutput}`));
    });
  });
}

async function packOne(directory, name) {
  const packed = JSON.parse(await run(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', archivesRoot],
    { cwd: directory },
  ));
  if (packed.length !== 1 || typeof packed[0]?.filename !== 'string') {
    throw new Error(`npm pack returned an unexpected result for ${name}`);
  }
  return join(archivesRoot, packed[0].filename);
}

try {
  await mkdir(archivesRoot);
  const archives = new Map();
  for (const [directory, name] of packages) {
    archives.set(name, await packOne(join(treeRoot, directory), name));
  }
  for (const [name, directory] of CROSS_TREE_PACKAGES) {
    archives.set(name, await packOne(directory, name));
  }

  await mkdir(consumerRoot);
  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
    dependencies: Object.fromEntries([
      ...packages.map(([, name]) => [name, `file:${archives.get(name)}`]),
      ...CROSS_TREE_PACKAGES.map(([name]) => [name, `file:${archives.get(name)}`]),
      ['@types/node', '^22.0.0'],
      ['typescript', '^5.9.3'],
    ]),
  }, null, 2));
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: consumerRoot });

  await writeFile(
    join(consumerRoot, 'consumer.ts'),
    codeEntrypoints
      .map((specifier, index) => `import type * as Entry${index} from ${JSON.stringify(specifier)};`)
      .join('\n')
      + '\n\n'
      + `export type PluginTreeEntrypoints = [\n${codeEntrypoints
        .map((_, index) => `  typeof Entry${index},`)
        .join('\n')}\n];\n`,
  );
  await writeFile(join(consumerRoot, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      noEmit: true,
      strict: true,
      target: 'ES2022',
    },
    include: ['consumer.ts'],
  }, null, 2));

  const typescript = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  await run(typescript, ['--project', 'tsconfig.json'], { cwd: consumerRoot });

  for (const [directory, name] of packages) {
    const installed = JSON.parse(await readFile(
      join(consumerRoot, 'node_modules', ...name.split('/'), 'package.json'),
      'utf8',
    ));
    if (installed.name !== name) {
      throw new Error(`${directory} installed as ${installed.name ?? 'an unnamed package'}`);
    }
    if (installed.publishConfig?.provenance !== true) {
      throw new Error(`${name} must publish with provenance (custody law C5)`);
    }
  }

  console.log(
    `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} plugin tree packages.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

- [x] **Step 2: Build and run the canary**

Run: `cd plugin/runtime && yarn build && cd - && node .github/scripts/plugin-tree-packed-types.test.mjs`
Expected: `Compiled a packed TypeScript consumer against 1 public code entrypoints across all 1 plugin tree packages.`

- [x] **Step 3: Commit**

```bash
git add .github/scripts/plugin-tree-packed-types.test.mjs
git commit -m "feat(plugin-runtime): packed public entrypoint canary for the plugin tree"
```

---

### Task 4: The tree's CI workflow

**Files:**
- Create: `.github/workflows/plugin-tree-ci.yml`

**Interfaces:**
- Consumes: the three guard scripts and the package scripts.
- Produces: jobs `architecture`, `runtime`, `verify`; the artifact name `plugin-runtime-dist`.

- [x] **Step 1: Write the workflow**

Create `.github/workflows/plugin-tree-ci.yml`:

```yaml
# The frozen `packages/plugin` owns `plugin-ci.yml`; this tree is `plugin-tree-*`
# throughout (C3 plan, finding F-C3-1). `pull_request` carries no path filter, matching
# evidence-ci.yml and benchmarking-ci.yml, so the aggregate check is always reported.
name: Plugin Tree CI

on:
  pull_request:
  push:
    branches: [next]
    paths:
      - "plugin/**"
      - ".github/scripts/plugin-tree-*.test.mjs"
      - ".github/workflows/plugin-tree-ci.yml"
      - "docs/superpowers/specs/2026-07-30-plugin-stack-reconciliation-design.md"
      - "docs/superpowers/plans/2026-07-30-plugin-c3-product-tree.md"

permissions:
  contents: read

env:
  PLUGIN_TREE_ROOT: plugin

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify package inventory and dependency graph
        run: node --test .github/scripts/plugin-tree-package-inventory.test.mjs
      - name: Verify source boundaries, the frozen-trio refusal, and the custody canaries
        run: node --test .github/scripts/plugin-tree-source-boundaries.test.mjs

  runtime:
    name: Plugin Runtime
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
      # C4-C7 add a "Build cross-tree portal dependencies from source" step here, one
      # `(cd <package> && yarn install --immutable && yarn build)` line per portal
      # dependency, matching benchmarking-ci.yml.
      - name: Verify Plugin Runtime
        working-directory: plugin/runtime
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Plugin Runtime distribution
        uses: actions/upload-artifact@v4
        with:
          name: plugin-runtime-dist
          path: plugin/runtime/dist
          if-no-files-found: error
          retention-days: 1

  verify:
    needs: [architecture, runtime]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Require every Plugin Tree CI stage to succeed
        env:
          ARCHITECTURE_RESULT: ${{ needs.architecture.result }}
          RUNTIME_RESULT: ${{ needs.runtime.result }}
        run: |
          for result in \
            "$ARCHITECTURE_RESULT" \
            "$RUNTIME_RESULT"; do
            test "$result" = "success"
          done
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Enable Yarn 4.13.0
        run: |
          corepack enable
          corepack prepare yarn@4.13.0 --activate
      - name: Restore all package distributions
        uses: actions/download-artifact@v4
        with:
          pattern: plugin-*-dist
          path: .plugin-tree-dist
      - name: Place package distributions
        run: |
          mkdir -p plugin/runtime/dist
          cp -R .plugin-tree-dist/plugin-runtime-dist/. plugin/runtime/dist/
      - name: Compile packed public entrypoint consumers
        run: node .github/scripts/plugin-tree-packed-types.test.mjs
```

- [x] **Step 2: Verify the YAML parses and the job graph is what it claims**

Run:
```bash
node -e "const {readFileSync}=require('node:fs');const s=readFileSync('.github/workflows/plugin-tree-ci.yml','utf8');const jobs=[...s.matchAll(/^  ([a-z-]+):$/gm)].map(m=>m[1]);console.log(jobs.join(' '));if(!s.includes('plugin/**'))throw new Error('missing path filter');"
```
Expected output: `architecture runtime verify`

- [x] **Step 3: Confirm the workflow name does not collide**

Run: `ls .github/workflows/ | grep -c '^plugin' && ls .github/workflows/plugin*`
Expected: `2`, then `.github/workflows/plugin-ci.yml` and `.github/workflows/plugin-tree-ci.yml` — two distinct files, the first still owning `packages/plugin`.

- [x] **Step 4: Run every command the workflow runs, locally**

```bash
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn build && cd -
node .github/scripts/plugin-tree-packed-types.test.mjs
```
Expected: inventory `# pass 5 / # fail 0`; the package installs immutably (no lockfile drift), typechecks and builds; the canary prints its one-entrypoint line. (`yarn test` and `yarn pack:smoke` land in Tasks 5–10; the boundary guard's file-count floor is satisfied at Task 10.)

- [x] **Step 5: Commit**

```bash
git add .github/workflows/plugin-tree-ci.yml
git commit -m "feat(plugin-runtime): plugin tree CI workflow"
```

---

### Task 5: Errors and the injected logger

**Files:**
- Create: `plugin/runtime/src/errors.ts`, `plugin/runtime/src/logger.ts`, `plugin/runtime/src/logger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class PluginRuntimeError extends Error { readonly code: string }`; `const RUNTIME_ERROR_CODES`; `type LogLevel = "silent" | "error" | "warn" | "info" | "debug"`; `interface RuntimeLogger { debug/info/warn/error(message: string, fields?: Readonly<Record<string, unknown>>): void }`; `createLineLogger(level: LogLevel, write: (line: string) => void): RuntimeLogger`.

`code` is deliberately a plain `string` rather than a closed union: C4–C7 add their own codes by construction, without editing a shared type and without forking the error base.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/logger.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { createLineLogger } from "./logger.js";

const collect = () => {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
};

describe("PluginRuntimeError", () => {
  test("carries a code and preserves the cause", () => {
    const cause = new Error("underlying");
    const error = new PluginRuntimeError("config-invalid", "bad config", { cause });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PluginRuntimeError");
    expect(error.code).toBe("config-invalid");
    expect(error.message).toBe("bad config");
    expect(error.cause).toBe(cause);
  });

  test("the code table is frozen and covers the runtime lifecycle", () => {
    expect(Object.isFrozen(RUNTIME_ERROR_CODES)).toBe(true);
    expect(Object.values(RUNTIME_ERROR_CODES).sort()).toEqual([
      "capability-start-failed",
      "capability-stop-failed",
      "config-invalid",
      "runtime-already-started",
      "runtime-not-started",
    ]);
  });

  test("a component may define its own code without editing the base", () => {
    class MirrorError extends PluginRuntimeError {
      constructor(message: string) {
        super("mirror-sync-locked", message);
        this.name = "MirrorError";
      }
    }
    const error = new MirrorError("held");
    expect(error).toBeInstanceOf(PluginRuntimeError);
    expect(error.code).toBe("mirror-sync-locked");
  });
});

describe("createLineLogger", () => {
  test("writes one JSON line per record", () => {
    const { lines, write } = collect();
    createLineLogger("info", write).info("started", { capabilities: 0 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      message: "started",
      capabilities: 0,
    });
  });

  test("suppresses records below the configured level", () => {
    const { lines, write } = collect();
    const log = createLineLogger("warn", write);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["warn", "error"]);
  });

  test("silent suppresses everything", () => {
    const { lines, write } = collect();
    const log = createLineLogger("silent", write);
    log.error("e");
    expect(lines).toEqual([]);
  });

  test("fields never overwrite level or message", () => {
    const { lines, write } = collect();
    createLineLogger("debug", write).debug("real", { level: "fake", message: "fake" });
    expect(JSON.parse(lines[0]!)).toEqual({ level: "debug", message: "real" });
  });

  test("a field that cannot be serialized does not throw", () => {
    const { lines, write } = collect();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLineLogger("debug", write).debug("cyclic", { cyclic });
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "debug",
      message: "cyclic",
      cyclic: "[unserializable]",
    });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — `Failed to resolve import "./errors.js"`.

- [x] **Step 3: Write the implementation**

`plugin/runtime/src/errors.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime's error base. `code` is a plain string on purpose: components register
 * their own codes by subclassing, without editing a shared closed union.
 */
export class PluginRuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PluginRuntimeError";
    this.code = code;
  }
}

/** The codes the runtime container itself raises. */
export const RUNTIME_ERROR_CODES = Object.freeze({
  configInvalid: "config-invalid",
  runtimeAlreadyStarted: "runtime-already-started",
  runtimeNotStarted: "runtime-not-started",
  capabilityStartFailed: "capability-start-failed",
  capabilityStopFailed: "capability-stop-failed",
} as const);

export type RuntimeErrorCode =
  (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];
```

`plugin/runtime/src/logger.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface RuntimeLogger {
  debug(message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(message: string, fields?: Readonly<Record<string, unknown>>): void;
}

const SEVERITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
});

type EmittedLevel = Exclude<LogLevel, "silent">;

function serializeField(value: unknown): unknown {
  try {
    JSON.stringify(value);
    return value;
  } catch {
    return "[unserializable]";
  }
}

/**
 * A structured line logger over an injected sink. The sink is injected so nothing in this
 * package reaches for a real stream: the binary owns stderr, and stdout stays reserved
 * for the MCP stdio transport.
 */
export function createLineLogger(
  level: LogLevel,
  write: (line: string) => void,
): RuntimeLogger {
  const threshold = SEVERITY[level];

  const emit = (
    entryLevel: EmittedLevel,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): void => {
    if (SEVERITY[entryLevel] > threshold) return;
    const record: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (key === "level" || key === "message") continue;
      record[key] = serializeField(value);
    }
    record.level = entryLevel;
    record.message = message;
    write(JSON.stringify(record));
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
  };
}

/** A logger that discards every record. Useful as a default and in tests. */
export function createSilentLogger(): RuntimeLogger {
  return createLineLogger("silent", () => {});
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 8 tests.

- [x] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): error base and injected line logger"
```

---

### Task 6: The configuration surface — typed and injected

**Files:**
- Create: `plugin/runtime/src/config.ts`, `plugin/runtime/src/config.test.ts`

**Interfaces:**
- Consumes: `PluginRuntimeError`, `RUNTIME_ERROR_CODES` (Task 5); `LogLevel` (Task 5).
- Produces: `interface RuntimeConfigSource { env: Readonly<Record<string, string | undefined>>; homeDirectory: string; file?: unknown }`; `interface RuntimeConfig { homeDirectory: string; archiveDirectory: string; catalogPath: string; indexPath: string; mirrorStatePath: string; logLevel: LogLevel }`; `resolveRuntimeConfig(source: RuntimeConfigSource): RuntimeConfig`; `RuntimeConfigFileSchema`.

This is where custody law C2 becomes structural. The module imports `node:path` and `zod` and nothing else; it never reads `process.env`. The binary reads the environment and hands it over. Task 9 installs the guard assertion that makes this permanent.

Precedence is defaults < file < environment, matching the daemon's documented `Config file first, env var override`.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/config.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { PluginRuntimeError } from "./errors.js";
import { resolveRuntimeConfig } from "./config.js";

const HOME = "/srv/hermes-home/.jinn-plugin";

const base = { env: {}, homeDirectory: HOME } as const;

describe("resolveRuntimeConfig", () => {
  test("derives every path from the home directory", () => {
    expect(resolveRuntimeConfig(base)).toEqual({
      homeDirectory: HOME,
      archiveDirectory: `${HOME}/archive`,
      catalogPath: `${HOME}/catalog.sqlite`,
      indexPath: `${HOME}/index.sqlite`,
      mirrorStatePath: `${HOME}/mirror-state.json`,
      logLevel: "info",
    });
  });

  test("normalizes the home directory", () => {
    const config = resolveRuntimeConfig({ ...base, homeDirectory: "/srv/./a/../home/" });
    expect(config.homeDirectory).toBe("/srv/home");
    expect(config.archiveDirectory).toBe("/srv/home/archive");
  });

  test("rejects a relative home directory", () => {
    expect(() => resolveRuntimeConfig({ ...base, homeDirectory: "relative/home" })).toThrow(
      PluginRuntimeError,
    );
  });

  test("the environment overrides the file, which overrides the defaults", () => {
    const fromFile = resolveRuntimeConfig({
      ...base,
      file: { home: "/from/file", logLevel: "debug" },
    });
    expect(fromFile.homeDirectory).toBe("/from/file");
    expect(fromFile.logLevel).toBe("debug");

    const fromEnv = resolveRuntimeConfig({
      env: { JINN_PLUGIN_HOME: "/from/env", JINN_PLUGIN_LOG_LEVEL: "warn" },
      homeDirectory: HOME,
      file: { home: "/from/file", logLevel: "debug" },
    });
    expect(fromEnv.homeDirectory).toBe("/from/env");
    expect(fromEnv.logLevel).toBe("warn");
  });

  test("an empty environment value does not override", () => {
    const config = resolveRuntimeConfig({
      env: { JINN_PLUGIN_HOME: "", JINN_PLUGIN_LOG_LEVEL: "" },
      homeDirectory: HOME,
    });
    expect(config.homeDirectory).toBe(HOME);
    expect(config.logLevel).toBe("info");
  });

  test("rejects an unknown log level with an issue path", () => {
    try {
      resolveRuntimeConfig({ env: { JINN_PLUGIN_LOG_LEVEL: "chatty" }, homeDirectory: HOME });
      throw new Error("expected PluginRuntimeError");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginRuntimeError);
      expect((error as PluginRuntimeError).code).toBe("config-invalid");
      expect((error as PluginRuntimeError).message).toContain("logLevel");
    }
  });

  test("rejects an unknown key in the config file", () => {
    expect(() => resolveRuntimeConfig({ ...base, file: { hoem: "/typo" } })).toThrow(
      PluginRuntimeError,
    );
  });

  test("rejects a non-object config file", () => {
    expect(() => resolveRuntimeConfig({ ...base, file: "not an object" })).toThrow(
      PluginRuntimeError,
    );
  });

  test("an absent config file is not an error", () => {
    expect(resolveRuntimeConfig({ ...base, file: undefined }).logLevel).toBe("info");
  });

  test("the result is frozen so a capability cannot mutate shared configuration", () => {
    expect(Object.isFrozen(resolveRuntimeConfig(base))).toBe(true);
  });

  test("resolution is pure: the same source yields an equal result", () => {
    expect(resolveRuntimeConfig(base)).toEqual(resolveRuntimeConfig({ ...base }));
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — `Failed to resolve import "./config.js"`.

- [x] **Step 3: Write the implementation**

`plugin/runtime/src/config.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { isAbsolute, join, normalize } from "node:path";
import { z } from "zod";

import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import type { LogLevel } from "./logger.js";

const LogLevelSchema = z.enum(["silent", "error", "warn", "info", "debug"]);

/**
 * The optional on-disk configuration document. The caller reads and parses the file; this
 * module only validates. Keeping the read outside means nothing in the library touches
 * the filesystem to acquire configuration.
 */
export const RuntimeConfigFileSchema = z.strictObject({
  home: z.string().min(1).optional(),
  logLevel: LogLevelSchema.optional(),
});

export type RuntimeConfigFile = z.infer<typeof RuntimeConfigFileSchema>;

/**
 * Everything the resolver is allowed to read. The environment is injected wholesale
 * rather than reached for, so no code path in this package acquires ambient authority
 * (custody law C2); `.github/scripts/plugin-tree-source-boundaries.test.mjs` enforces it.
 */
export interface RuntimeConfigSource {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute. The host adapter supplies the per-host-home path. */
  readonly homeDirectory: string;
  /** Already-parsed JSON of an optional configuration file. */
  readonly file?: unknown;
}

export interface RuntimeConfig {
  readonly homeDirectory: string;
  readonly archiveDirectory: string;
  readonly catalogPath: string;
  readonly indexPath: string;
  readonly mirrorStatePath: string;
  readonly logLevel: LogLevel;
}

export const ENVIRONMENT_KEYS = Object.freeze({
  home: "JINN_PLUGIN_HOME",
  logLevel: "JINN_PLUGIN_LOG_LEVEL",
} as const);

function invalid(path: string, message: string, cause?: unknown): PluginRuntimeError {
  return new PluginRuntimeError(
    RUNTIME_ERROR_CODES.configInvalid,
    `runtime configuration is invalid at ${path}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

/** Empty and whitespace-only environment values are treated as unset, never as overrides. */
function present(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseFile(file: unknown): RuntimeConfigFile {
  if (file === undefined || file === null) return {};
  const parsed = RuntimeConfigFileSchema.safeParse(file);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw invalid(issue?.path.join(".") || "<root>", issue?.message ?? "unrecognized document");
  }
  return parsed.data;
}

function parseLogLevel(value: string): LogLevel {
  const parsed = LogLevelSchema.safeParse(value);
  if (!parsed.success) {
    throw invalid("logLevel", `expected one of ${LogLevelSchema.options.join(", ")}`);
  }
  return parsed.data;
}

/**
 * Resolve the runtime's configuration. Precedence: defaults, then the configuration file,
 * then the environment. Pure — no filesystem, no clock, no ambient reads.
 */
export function resolveRuntimeConfig(source: RuntimeConfigSource): RuntimeConfig {
  const file = parseFile(source.file);

  const envHome = present(source.env[ENVIRONMENT_KEYS.home]);
  const envLogLevel = present(source.env[ENVIRONMENT_KEYS.logLevel]);

  const rawHome = envHome ?? file.home ?? source.homeDirectory;
  if (typeof rawHome !== "string" || rawHome.trim() === "") {
    throw invalid("home", "a home directory is required");
  }
  if (!isAbsolute(rawHome)) {
    throw invalid("home", `expected an absolute path, received ${rawHome}`);
  }
  const homeDirectory = normalize(rawHome).replace(/\/+$/u, "") || "/";

  const logLevel = envLogLevel !== undefined
    ? parseLogLevel(envLogLevel)
    : file.logLevel ?? "info";

  return Object.freeze({
    homeDirectory,
    archiveDirectory: join(homeDirectory, "archive"),
    catalogPath: join(homeDirectory, "catalog.sqlite"),
    indexPath: join(homeDirectory, "index.sqlite"),
    mirrorStatePath: join(homeDirectory, "mirror-state.json"),
    logLevel,
  });
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 11 new tests (19 total).

- [x] **Step 5: Confirm the config module reaches for nothing ambient**

Run: `grep -n "process\.\|node:fs\|node:os" plugin/runtime/src/config.ts || echo "clean"`
Expected: `clean`

- [x] **Step 6: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): typed, injected configuration surface"
```

---

### Task 7: The health surface — the doctor contract

**Files:**
- Create: `plugin/runtime/src/version.ts`, `plugin/runtime/src/health.ts`, `plugin/runtime/src/health.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface HealthCheck { name: string; ok: boolean; detail: string; remedy: string | null }`; `interface HealthReport { ok: boolean; version: string; checks: readonly HealthCheck[] }`; `summarizeHealth(version: string, checks: readonly HealthCheck[]): HealthReport`; `const RUNTIME_VERSION: string`.

The `{ name, ok, detail, remedy }` shape is the onboarding design's doctor contract, which the reconciliation spec §5 keeps as the experience bar and §9.3 extends with one phrasing: when a precondition is not fixable from this machine, the doctor must report a known-outage state rather than print a no-op remedy. That state is `remedy: null`, and it is a first-class value here rather than a convention C7 has to remember.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/health.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import { summarizeHealth } from "./health.js";
import { RUNTIME_VERSION } from "./version.js";

const ok = (name: string) => ({ name, ok: true, detail: "ready", remedy: null });

describe("summarizeHealth", () => {
  test("an empty check list is healthy", () => {
    expect(summarizeHealth("0.1.0", [])).toEqual({ ok: true, version: "0.1.0", checks: [] });
  });

  test("every check passing is healthy", () => {
    expect(summarizeHealth("0.1.0", [ok("a"), ok("b")]).ok).toBe(true);
  });

  test("one failing check fails the report", () => {
    const report = summarizeHealth("0.1.0", [
      ok("a"),
      { name: "b", ok: false, detail: "the archive directory is unreadable", remedy: "chmod u+rwx <archive>" },
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(2);
  });

  test("a failing check may name a state that is not fixable from this machine", () => {
    const report = summarizeHealth("0.1.0", [
      {
        name: "runtime-pin",
        ok: false,
        detail: "the pinned runtime version is not published — channel issue",
        remedy: null,
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.remedy).toBeNull();
  });

  test("checks keep their given order and the report is frozen", () => {
    const report = summarizeHealth("0.1.0", [ok("z"), ok("a")]);
    expect(report.checks.map((check) => check.name)).toEqual(["z", "a"]);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.checks)).toBe(true);
  });

  test("rejects two checks with the same name", () => {
    expect(() => summarizeHealth("0.1.0", [ok("a"), ok("a")])).toThrow(/duplicate health check/);
  });

  test("rejects a check with an empty detail", () => {
    expect(() =>
      summarizeHealth("0.1.0", [{ name: "a", ok: false, detail: "", remedy: null }]),
    ).toThrow(/detail/);
  });
});

describe("RUNTIME_VERSION", () => {
  test("matches the package manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(RUNTIME_VERSION).toBe(manifest.version);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — `Failed to resolve import "./health.js"`.

- [x] **Step 3: Write the implementation**

`plugin/runtime/src/version.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime's own version, reported in every health report and matched against
 * `package.json` by `health.test.ts`. Declared as a literal rather than imported from the
 * manifest so the published bundle needs no JSON module resolution and no filesystem read.
 */
export const RUNTIME_VERSION = "0.1.0";
```

`plugin/runtime/src/health.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * One doctor check. `remedy` is `null` when the state is not fixable from this machine —
 * a channel outage, for example — so the host adapter reports a known-outage state
 * instead of printing a remedy that would do nothing.
 */
export interface HealthCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly remedy: string | null;
}

export interface HealthReport {
  readonly ok: boolean;
  readonly version: string;
  readonly checks: readonly HealthCheck[];
}

/** Fold contributed checks into one report. Order is preserved; names must be unique. */
export function summarizeHealth(
  version: string,
  checks: readonly HealthCheck[],
): HealthReport {
  const seen = new Set<string>();
  for (const check of checks) {
    if (check.name.trim() === "") {
      throw new Error("a health check must have a name");
    }
    if (check.detail.trim() === "") {
      throw new Error(`health check ${check.name} must have a detail`);
    }
    if (seen.has(check.name)) {
      throw new Error(`duplicate health check name: ${check.name}`);
    }
    seen.add(check.name);
  }
  return Object.freeze({
    ok: checks.every((check) => check.ok),
    version,
    checks: Object.freeze([...checks]),
  });
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 8 new tests (27 total).

- [x] **Step 5: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): health report surface and the doctor check contract"
```

---

### Task 8: The capability seam and the runtime lifecycle

**Files:**
- Create: `plugin/runtime/src/capability.ts`, `plugin/runtime/src/runtime.ts`, `plugin/runtime/src/runtime.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig` (Task 6); `HealthCheck`, `HealthReport`, `summarizeHealth`, `RUNTIME_VERSION` (Task 7); `RuntimeLogger`, `createSilentLogger` (Task 5); `PluginRuntimeError`, `RUNTIME_ERROR_CODES` (Task 5).
- Produces: `interface CapabilityContext { config: RuntimeConfig; log: RuntimeLogger }`; `interface RuntimeCapability { name: string; start?(context): Promise<void>; stop?(): Promise<void>; healthChecks?(): Promise<readonly HealthCheck[]> }`; `interface PluginRuntimeOptions { config: RuntimeConfig; capabilities?: readonly RuntimeCapability[]; log?: RuntimeLogger }`; `interface PluginRuntime { start(): Promise<void>; health(): Promise<HealthReport>; stop(): Promise<void> }`; `createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime`.

The lifecycle rules fixed here are what C4–C7 build against: capabilities start in array order and stop in reverse; a failing `start` unwinds what already started; `stop` is idempotent and best-effort; `health` before `start` is an error rather than a misleading empty report.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/runtime.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import type { RuntimeCapability } from "./capability.js";
import { resolveRuntimeConfig } from "./config.js";
import { PluginRuntimeError } from "./errors.js";
import { createLineLogger } from "./logger.js";
import { createPluginRuntime } from "./runtime.js";
import { RUNTIME_VERSION } from "./version.js";

const config = resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/home" });

const recorder = () => {
  const events: string[] = [];
  const capability = (name: string, overrides: Partial<RuntimeCapability> = {}): RuntimeCapability => ({
    name,
    start: async () => {
      events.push(`start:${name}`);
    },
    stop: async () => {
      events.push(`stop:${name}`);
    },
    ...overrides,
  });
  return { events, capability };
};

describe("createPluginRuntime", () => {
  test("starts with no capabilities and reports a healthy, empty report", async () => {
    const runtime = createPluginRuntime({ config });
    await runtime.start();
    await expect(runtime.health()).resolves.toEqual({
      ok: true,
      version: RUNTIME_VERSION,
      checks: [],
    });
    await runtime.stop();
  });

  test("starts capabilities in order and stops them in reverse", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [capability("first"), capability("second")],
    });
    await runtime.start();
    await runtime.stop();
    expect(events).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
  });

  test("passes the config and a logger to each capability", async () => {
    let seen: { home?: string } = {};
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "probe",
          start: async (context) => {
            seen = { home: context.config.homeDirectory };
            context.log.info("probing");
          },
        },
      ],
    });
    await runtime.start();
    await runtime.stop();
    expect(seen.home).toBe("/srv/home");
  });

  test("a capability without hooks is accepted", async () => {
    const runtime = createPluginRuntime({ config, capabilities: [{ name: "inert" }] });
    await runtime.start();
    await expect(runtime.health()).resolves.toMatchObject({ ok: true, checks: [] });
    await runtime.stop();
  });

  test("rejects duplicate capability names before starting anything", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [capability("same"), capability("same")],
    });
    await expect(runtime.start()).rejects.toThrow(/duplicate capability/);
    expect(events).toEqual([]);
  });

  test("a failing start unwinds the capabilities that already started", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        capability("good"),
        capability("bad", {
          start: async () => {
            events.push("start:bad");
            throw new Error("boom");
          },
        }),
        capability("never"),
      ],
    });
    await expect(runtime.start()).rejects.toMatchObject({ code: "capability-start-failed" });
    expect(events).toEqual(["start:good", "start:bad", "stop:good"]);
  });

  test("a failing start names the capability and preserves the cause", async () => {
    const cause = new Error("boom");
    const runtime = createPluginRuntime({
      config,
      capabilities: [{ name: "bad", start: async () => { throw cause; } }],
    });
    await expect(runtime.start()).rejects.toMatchObject({
      message: expect.stringContaining("bad"),
      cause,
    });
  });

  test("starting twice is an error", async () => {
    const runtime = createPluginRuntime({ config });
    await runtime.start();
    await expect(runtime.start()).rejects.toMatchObject({ code: "runtime-already-started" });
    await runtime.stop();
  });

  test("health before start is an error", async () => {
    const runtime = createPluginRuntime({ config });
    await expect(runtime.health()).rejects.toMatchObject({ code: "runtime-not-started" });
  });

  test("stop before start is a no-op, and stop is idempotent", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({ config, capabilities: [capability("one")] });
    await runtime.stop();
    expect(events).toEqual([]);
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(events).toEqual(["start:one", "stop:one"]);
  });

  test("stop attempts every capability even when one throws, then reports the failure", async () => {
    const { events, capability } = recorder();
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        capability("first"),
        capability("bad", { stop: async () => { throw new Error("stuck"); } }),
        capability("last"),
      ],
    });
    await runtime.start();
    await expect(runtime.stop()).rejects.toMatchObject({ code: "capability-stop-failed" });
    expect(events).toEqual([
      "start:first",
      "start:bad",
      "start:last",
      "stop:last",
      "stop:first",
    ]);
  });

  test("health folds every capability's checks in registration order", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        {
          name: "archive",
          healthChecks: async () => [
            { name: "archive-writable", ok: true, detail: "writable", remedy: null },
          ],
        },
        {
          name: "mirror",
          healthChecks: async () => [
            { name: "mirror-fresh", ok: false, detail: "never synced", remedy: "run sync" },
          ],
        },
      ],
    });
    await runtime.start();
    const report = await runtime.health();
    expect(report.ok).toBe(false);
    expect(report.checks.map((check) => check.name)).toEqual([
      "archive-writable",
      "mirror-fresh",
    ]);
    await runtime.stop();
  });

  test("a capability whose health check throws yields a failing check, not a thrown report", async () => {
    const runtime = createPluginRuntime({
      config,
      capabilities: [
        { name: "flaky", healthChecks: async () => { throw new Error("unavailable"); } },
      ],
    });
    await runtime.start();
    const report = await runtime.health();
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      {
        name: "flaky",
        ok: false,
        detail: "the capability could not report its health: unavailable",
        remedy: null,
      },
    ]);
    await runtime.stop();
  });

  test("lifecycle transitions are logged at debug level", async () => {
    const lines: string[] = [];
    const runtime = createPluginRuntime({
      config,
      log: createLineLogger("debug", (line) => lines.push(line)),
    });
    await runtime.start();
    await runtime.stop();
    const messages = lines.map((line) => JSON.parse(line).message);
    expect(messages).toContain("runtime started");
    expect(messages).toContain("runtime stopped");
  });

  test("errors raised by the runtime are PluginRuntimeError", async () => {
    const runtime = createPluginRuntime({ config });
    await runtime.health().catch((error: unknown) => {
      expect(error).toBeInstanceOf(PluginRuntimeError);
    });
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — `Failed to resolve import "./capability.js"`.

- [x] **Step 3: Write the implementation**

`plugin/runtime/src/capability.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { RuntimeConfig } from "./config.js";
import type { HealthCheck } from "./health.js";
import type { RuntimeLogger } from "./logger.js";

/** Everything a capability is handed. Nothing is reached for; everything is given. */
export interface CapabilityContext {
  readonly config: RuntimeConfig;
  readonly log: RuntimeLogger;
}

/**
 * One unit of product behavior. Capture, the corpus mirror, retrieval, relevance, and the
 * MCP server each arrive as one of these; the runtime itself holds no product logic.
 *
 * A capability owns what it opens; there is no shared handle registry.
 *
 * **Do not hold the local evidence archive open across the process lifetime.**
 * `openLocalEvidenceRuntime` takes an *exclusive* SQLite lock on the runtime root
 * (`packages/evidence/local-runtime/src/lock.ts:37,46` — `locking_mode = EXCLUSIVE` plus
 * `BEGIN EXCLUSIVE`, three retries at 10/25/50 ms, then `ROOT_IN_USE`). Sessions are
 * short-lived and a session may hold two runtime instances (host-spawned for tools,
 * adapter-spawned for hooks), so a capability that opened the archive in `start` would
 * starve its sibling for the whole session. Open the archive per operation and close it.
 * `start` is for cheap, contention-free setup; long-lived exclusive resources belong to
 * the operation that needs them.
 */
export interface RuntimeCapability {
  readonly name: string;
  start?(context: CapabilityContext): Promise<void>;
  stop?(): Promise<void>;
  healthChecks?(): Promise<readonly HealthCheck[]>;
}
```

`plugin/runtime/src/runtime.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import type { CapabilityContext, RuntimeCapability } from "./capability.js";
import type { RuntimeConfig } from "./config.js";
import { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
import { type HealthCheck, type HealthReport, summarizeHealth } from "./health.js";
import { type RuntimeLogger, createSilentLogger } from "./logger.js";
import { RUNTIME_VERSION } from "./version.js";

export interface PluginRuntimeOptions {
  readonly config: RuntimeConfig;
  readonly capabilities?: readonly RuntimeCapability[];
  readonly log?: RuntimeLogger;
}

export interface PluginRuntime {
  start(): Promise<void>;
  health(): Promise<HealthReport>;
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertUniqueNames(capabilities: readonly RuntimeCapability[]): void {
  const seen = new Set<string>();
  for (const capability of capabilities) {
    if (seen.has(capability.name)) {
      throw new PluginRuntimeError(
        RUNTIME_ERROR_CODES.capabilityStartFailed,
        `duplicate capability name: ${capability.name}`,
      );
    }
    seen.add(capability.name);
  }
}

/**
 * The capability container. It owns the lifecycle and nothing else: start in registration
 * order, stop in reverse, fold health checks in registration order.
 */
export function createPluginRuntime(options: PluginRuntimeOptions): PluginRuntime {
  const capabilities = [...(options.capabilities ?? [])];
  const log = options.log ?? createSilentLogger();
  const context: CapabilityContext = { config: options.config, log };

  let started = false;
  const running: RuntimeCapability[] = [];

  const stopRunning = async (): Promise<readonly string[]> => {
    const failures: string[] = [];
    while (running.length > 0) {
      const capability = running.pop() as RuntimeCapability;
      try {
        await capability.stop?.();
      } catch (error) {
        failures.push(`${capability.name}: ${describe(error)}`);
        log.error("capability failed to stop", {
          capability: capability.name,
          reason: describe(error),
        });
      }
    }
    return failures;
  };

  return {
    async start(): Promise<void> {
      if (started) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeAlreadyStarted,
          "the runtime is already started",
        );
      }
      assertUniqueNames(capabilities);
      for (const capability of capabilities) {
        try {
          await capability.start?.();
          // The optional-call above would skip the context; call explicitly instead.
        } catch (error) {
          await stopRunning();
          throw new PluginRuntimeError(
            RUNTIME_ERROR_CODES.capabilityStartFailed,
            `capability ${capability.name} failed to start: ${describe(error)}`,
            { cause: error },
          );
        }
        running.push(capability);
      }
      started = true;
      log.debug("runtime started", { capabilities: capabilities.length });
    },

    async health(): Promise<HealthReport> {
      if (!started) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.runtimeNotStarted,
          "the runtime must be started before it can report health",
        );
      }
      const checks: HealthCheck[] = [];
      for (const capability of capabilities) {
        if (capability.healthChecks === undefined) continue;
        try {
          checks.push(...(await capability.healthChecks()));
        } catch (error) {
          checks.push({
            name: capability.name,
            ok: false,
            detail: `the capability could not report its health: ${describe(error)}`,
            remedy: null,
          });
        }
      }
      return summarizeHealth(RUNTIME_VERSION, checks);
    },

    async stop(): Promise<void> {
      if (!started) return;
      const failures = await stopRunning();
      started = false;
      log.debug("runtime stopped", {});
      if (failures.length > 0) {
        throw new PluginRuntimeError(
          RUNTIME_ERROR_CODES.capabilityStopFailed,
          `capabilities failed to stop: ${failures.join("; ")}`,
        );
      }
    },
  };
}
```

- [x] **Step 4: Fix the deliberate defect the tests catch**

The `start` loop above calls `capability.start?.()` without the context, so the "passes the config and a logger to each capability" test fails with `seen.home` undefined. Replace the two lines

```ts
          await capability.start?.();
          // The optional-call above would skip the context; call explicitly instead.
```

with

```ts
          if (capability.start !== undefined) await capability.start(context);
```

- [x] **Step 5: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 15 new tests (42 total).

- [x] **Step 6: Commit**

```bash
git add plugin/runtime/src
git commit -m "feat(plugin-runtime): capability seam and the runtime lifecycle"
```

---

### Task 9: The process skeleton, and the custody and stdout boundary assertions

**Files:**
- Create: `plugin/runtime/src/bin.ts`, `plugin/runtime/src/bin.test.ts`
- Modify: `.github/scripts/plugin-tree-source-boundaries.test.mjs` (add the two custody canaries and the `src/bin.ts` confinement assertion, before the final `test('plugin tree source boundaries hold…')`)

**Interfaces:**
- Consumes: `resolveRuntimeConfig`, `ENVIRONMENT_KEYS` (Task 6); `createPluginRuntime` (Task 8); `createLineLogger` (Task 5); `PluginRuntimeError` (Task 5).
- Produces: `interface BinIo { writeOut; writeErr; homeDirectory; untilShutdown }`; `main(argv: readonly string[], env: Readonly<Record<string, string | undefined>>, io: BinIo): Promise<number>`.

Two invariants land here and are made permanent by the guard:

1. **`process` is confined to `src/bin.ts`.** Custody law C2 says the runtime acquires no ambient authority; the boundary guard turns that from a claim into a build failure.
2. **stdout is reserved for the MCP stdio transport.** C7 attaches an MCP server to stdout; a stray `console.log` anywhere in the tree would corrupt the protocol stream. Every diagnostic goes to stderr, and the only stdout write in the tree is the `health` subcommand's single JSON line.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/bin.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import { main } from "./bin.js";
import { RUNTIME_VERSION } from "./version.js";

const io = (untilShutdown: () => Promise<void> = async () => {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    value: {
      writeOut: (line: string) => out.push(line),
      writeErr: (line: string) => err.push(line),
      homeDirectory: "/srv/default-home",
      untilShutdown,
    },
  };
};

describe("main", () => {
  test("health prints one JSON report line to stdout and exits zero", async () => {
    const { out, err, value } = io();
    await expect(main(["health"], {}, value)).resolves.toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ ok: true, version: RUNTIME_VERSION, checks: [] });
    expect(err.some((line) => JSON.parse(line).level === "error")).toBe(false);
  });

  test("serve waits for shutdown, then stops and exits zero", async () => {
    let released = () => {};
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { err, value } = io(() => gate);
    const exit = main(["serve"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    released();
    await expect(exit).resolves.toBe(0);
    const messages = err.map((line) => JSON.parse(line).message);
    expect(messages).toContain("runtime started");
    expect(messages).toContain("runtime stopped");
  });

  test("serve is the default command", async () => {
    const { value } = io();
    await expect(main([], {}, value)).resolves.toBe(0);
  });

  test("serve writes nothing to stdout — it is reserved for the MCP transport", async () => {
    const { out, value } = io();
    await main(["serve"], { JINN_PLUGIN_LOG_LEVEL: "debug" }, value);
    expect(out).toEqual([]);
  });

  test("the injected home directory is the default and the environment overrides it", async () => {
    const withDefault = io();
    await main(["health"], {}, withDefault.value);
    const overridden = io();
    await main(["health"], { JINN_PLUGIN_HOME: "/srv/from-env" }, overridden.value);
    const detail = (lines: string[]) =>
      lines.map((line) => JSON.parse(line)).find((entry) => entry.message === "configuration resolved")?.home;
    expect(detail(withDefault.err)).toBe("/srv/default-home");
    expect(detail(overridden.err)).toBe("/srv/from-env");
  });

  test("an unknown command prints usage to stderr and exits two", async () => {
    const { out, err, value } = io();
    await expect(main(["distill"], {}, value)).resolves.toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("usage: jinn-plugin-runtime");
  });

  test("invalid configuration exits two with the error on stderr", async () => {
    const { out, err, value } = io();
    await expect(main(["health"], { JINN_PLUGIN_LOG_LEVEL: "chatty" }, value)).resolves.toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("logLevel");
  });

  test("--help prints usage to stderr and exits zero", async () => {
    const { err, value } = io();
    await expect(main(["--help"], {}, value)).resolves.toBe(0);
    expect(err.join("\n")).toContain("usage: jinn-plugin-runtime");
  });

  test("--version prints the version to stdout and exits zero", async () => {
    const { out, value } = io();
    await expect(main(["--version"], {}, value)).resolves.toBe(0);
    expect(out).toEqual([RUNTIME_VERSION]);
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — `Failed to resolve import "./bin.js"`.

- [x] **Step 3: Write the implementation**

`plugin/runtime/src/bin.ts`:

```ts
#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRuntimeConfig } from "./config.js";
import { PluginRuntimeError } from "./errors.js";
import { createLineLogger } from "./logger.js";
import { createPluginRuntime } from "./runtime.js";
import { RUNTIME_VERSION } from "./version.js";

const USAGE = [
  "usage: jinn-plugin-runtime [serve|health]",
  "",
  "  serve    run the runtime until SIGINT or SIGTERM (default)",
  "  health   print one JSON health report and exit",
  "",
  "  --help     print this message",
  "  --version  print the runtime version",
  "",
  "Environment: JINN_PLUGIN_HOME, JINN_PLUGIN_LOG_LEVEL",
].join("\n");

/**
 * Everything the entry point is allowed to touch, injected so tests drive it without a
 * real process, real streams, or real signals.
 */
export interface BinIo {
  /** Reserved for protocol output. Diagnostics never go here. */
  readonly writeOut: (line: string) => void;
  readonly writeErr: (line: string) => void;
  /** The default home directory when neither the file nor the environment names one. */
  readonly homeDirectory: string;
  /** Resolves when the process should shut down. */
  readonly untilShutdown: () => Promise<void>;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: BinIo,
): Promise<number> {
  const [command = "serve"] = argv;

  if (command === "--help" || command === "-h") {
    io.writeErr(USAGE);
    return 0;
  }
  if (command === "--version") {
    io.writeOut(RUNTIME_VERSION);
    return 0;
  }
  if (command !== "serve" && command !== "health") {
    io.writeErr(`unknown command: ${command}`);
    io.writeErr(USAGE);
    return 2;
  }

  let config;
  try {
    config = resolveRuntimeConfig({ env, homeDirectory: io.homeDirectory });
  } catch (error) {
    io.writeErr(
      error instanceof PluginRuntimeError ? error.message : `configuration failed: ${String(error)}`,
    );
    return 2;
  }

  const log = createLineLogger(config.logLevel, io.writeErr);
  log.debug("configuration resolved", {
    home: config.homeDirectory,
    archive: config.archiveDirectory,
  });

  // No capabilities are wired yet; C4 onward register them here.
  const runtime = createPluginRuntime({ config, capabilities: [], log });

  if (command === "health") {
    await runtime.start();
    const report = await runtime.health();
    await runtime.stop();
    io.writeOut(JSON.stringify(report));
    return report.ok ? 0 : 1;
  }

  await runtime.start();
  log.info("runtime listening", { transport: "none" });
  await io.untilShutdown();
  await runtime.stop();
  return 0;
}

/** True when this module is the process entry point rather than an imported module. */
function isProcessEntry(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isProcessEntry()) {
  const untilShutdown = (): Promise<void> =>
    new Promise<void>((resolve) => {
      const finish = (): void => {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
        resolve();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
    });

  process.exitCode = await main(process.argv.slice(2), process.env, {
    writeOut: (line) => process.stdout.write(`${line}\n`),
    writeErr: (line) => process.stderr.write(`${line}\n`),
    homeDirectory: process.env.JINN_PLUGIN_HOME ?? join(homedir(), ".jinn-plugin"),
    untilShutdown,
  });
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 9 new tests (51 total).

- [x] **Step 5: Verify the built binary actually runs**

```bash
cd plugin/runtime && yarn build
node dist/bin.js --version
JINN_PLUGIN_HOME=/tmp/jinn-plugin-skeleton node dist/bin.js health
JINN_PLUGIN_LOG_LEVEL=chatty node dist/bin.js health; echo "exit=$?"
cd -
```
Expected:
```
0.1.0
{"ok":true,"version":"0.1.0","checks":[]}
runtime configuration is invalid at logLevel: expected one of silent, error, warn, info, debug
exit=2
```

- [x] **Step 6: Verify `serve` starts and exits cleanly on SIGTERM**

```bash
cd plugin/runtime
JINN_PLUGIN_LOG_LEVEL=info node dist/bin.js serve 2>/tmp/jinn-plugin-serve.err 1>/tmp/jinn-plugin-serve.out &
PID=$!
sleep 1 && kill -TERM "$PID" && wait "$PID"; echo "exit=$?"
cat /tmp/jinn-plugin-serve.err
wc -c /tmp/jinn-plugin-serve.out
cd -
```
Expected: `exit=0`; the stderr file contains `{"level":"info","message":"runtime listening","transport":"none"}`; `wc -c` on the stdout file reports `0` — the process wrote nothing to stdout.

- [x] **Step 7: Add the custody and stdout canaries to the boundary guard**

In `.github/scripts/plugin-tree-source-boundaries.test.mjs`, insert after the `manifest` / `localSpecifier` helpers:

```js
const binEntry = join(runtimeSource, 'bin.ts');

// Custody law C2: no ambient authority acquisition. The runtime reads the environment in
// exactly one place — the binary — and hands the result to a pure resolver. `process` in
// any other file is a boundary violation, not a style question.
//
// The same confinement protects the wire: stdout is reserved for the MCP stdio transport
// (design §6.2), so a stray write anywhere else would corrupt the protocol stream.
const PROCESS_SURFACES = [
  [/process\s*(?:\.|\?\.)\s*env\b/g, 'process.env'],
  [/process\s*(?:\.|\?\.)\s*argv\b/g, 'process.argv'],
  [/process\s*(?:\.|\?\.)\s*stdout\b/g, 'process.stdout'],
  [/(?<![\w$."'\x60])console\s*(?:\.|\?\.)\s*(?:log|info|debug|table|dir)\s*\(/g, 'console stdout write'],
];

function processSurfaceUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return PROCESS_SURFACES.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(() => `${relative(root, file)} -> ${label}`));
  }).sort();
}

// Custody law C3: signer objects only. Key-construction helpers and key-material
// parameter names are refused in any position (custody-boundaries.test.mjs precedent).
// The runtime is read-plus-local-write and holds no keys (design §8.5).
const KEY_MATERIAL_PATTERNS = [
  [/privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey/g, 'key-construction helper'],
  [/\b(?:privateKey|mnemonic|seedPhrase)\s*[:?]/gi, 'key-material parameter or property'],
];

function keyMaterialUsesInFiles(sourceFiles) {
  return sourceFiles.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return KEY_MATERIAL_PATTERNS.flatMap(([pattern, label]) =>
      [...source.matchAll(pattern)].map(() => `${relative(root, file)} -> ${label}`));
  }).sort();
}

test('the process-surface scanner catches env, argv, stdout, and console writes', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-custody-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'const home = process.env.JINN_PLUGIN_HOME;',
      'const args = process.argv.slice(2);',
      'process.stdout.write("leak");',
      'console.log("leak");',
      'console.info("leak");',
    ].join('\n'));
    assert.equal(processSurfaceUsesInFiles(files(source)).length, 5);
    writeFileSync(join(source, 'clean.ts'), [
      'export const resolve = (env: Record<string, string | undefined>) => env.JINN_PLUGIN_HOME;',
      'console.error("diagnostics go to stderr");',
    ].join('\n'));
    assert.deepEqual(processSurfaceUsesInFiles([join(source, 'clean.ts')]), []);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('the key-material scanner catches construction helpers and parameter names', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-plugin-tree-keys-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { privateKeyToAccount } from "somewhere";',
      'export function sign(options: { privateKey: string; mnemonic?: string }) {',
      '  return privateKeyToAccount(options.privateKey);',
      '}',
    ].join('\n'));
    assert.ok(keyMaterialUsesInFiles(files(source)).length >= 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test('ambient process surfaces are confined to the binary, and no key material exists', () => {
  const sourceFiles = files(runtimeSource);
  const nonBin = sourceFiles.filter((file) => file !== binEntry);
  assert.deepEqual(
    processSurfaceUsesInFiles(nonBin),
    [],
    'only plugin/runtime/src/bin.ts may read the ambient environment or write stdout — '
      + 'configuration is injected (custody law C2) and stdout is reserved for the MCP '
      + 'stdio transport (design §6.2)',
  );
  assert.ok(existsSync(binEntry), 'plugin/runtime/src/bin.ts must exist to hold the confinement');
  assert.deepEqual(
    keyMaterialUsesInFiles(sourceFiles),
    [],
    'the runtime holds no keys and accepts no key material in any parameter position '
      + '(custody law C3)',
  );
});
```

- [x] **Step 8: Run the guard and confirm the custody assertions pass**

Run: `node --test .github/scripts/plugin-tree-source-boundaries.test.mjs`
Expected: PASS — `# pass 10`, `# fail 0`. (The `MIN_SCANNED_FILES` floor of 8 is now met: `bin.ts`, `capability.ts`, `config.ts`, `errors.ts`, `health.ts`, `index.ts`, `logger.ts`, `runtime.ts`, `version.ts` plus the four test files.)

- [x] **Step 9: Run the custody negative test**

```bash
cat >> plugin/runtime/src/config.ts <<'EOF'
export const leaked = process.env.JINN_PLUGIN_HOME;
EOF
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
git checkout plugin/runtime/src/config.ts
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
```
Expected: the first guard run FAILS with `plugin/runtime/src/config.ts -> process.env` and the message naming custody law C2; after the revert it returns to `# pass 10`, `# fail 0`.

- [x] **Step 10: Commit**

```bash
git add plugin/runtime/src .github/scripts/plugin-tree-source-boundaries.test.mjs
git commit -m "feat(plugin-runtime): process skeleton with custody and stdout confinement"
```

---

### Task 10: Public surface, pack smoke, and the full green run

**Files:**
- Modify: `plugin/runtime/src/index.ts` (replace the placeholder)
- Create: `plugin/runtime/src/index.test.ts`, `plugin/runtime/scripts/pack-smoke.mjs`

**Interfaces:**
- Consumes: everything from Tasks 5–9.
- Produces: the package's single public entrypoint.

The root entrypoint must never re-export `bin.ts` — that would drag `process` access, signal handlers, and the entry-point side effect into every consumer, the same defect the execution-recorder-bridge guards against with its `cli.ts` rule.

- [x] **Step 1: Write the failing test**

`plugin/runtime/src/index.test.ts`:

```ts
import { describe, expect, test } from "vitest";

import * as runtime from "./index.js";

describe("public surface", () => {
  test("exports exactly the runtime's public names", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "ENVIRONMENT_KEYS",
      "PluginRuntimeError",
      "RUNTIME_ERROR_CODES",
      "RUNTIME_VERSION",
      "RuntimeConfigFileSchema",
      "createLineLogger",
      "createPluginRuntime",
      "createSilentLogger",
      "resolveRuntimeConfig",
      "summarizeHealth",
    ]);
  });

  test("does not export the binary's entry point", () => {
    expect("main" in runtime).toBe(false);
    expect("BinIo" in runtime).toBe(false);
  });

  test("a consumer can build and run a runtime from the public surface alone", async () => {
    const config = runtime.resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/consumer" });
    const instance = runtime.createPluginRuntime({ config });
    await instance.start();
    await expect(instance.health()).resolves.toEqual({
      ok: true,
      version: runtime.RUNTIME_VERSION,
      checks: [],
    });
    await instance.stop();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `cd plugin/runtime && yarn test`
Expected: FAIL — the first test reports `[]` against the expected ten names (the placeholder `index.ts` exports nothing).

- [x] **Step 3: Write the public surface**

`plugin/runtime/src/index.ts` (replacing the placeholder in full):

```ts
// SPDX-License-Identifier: Apache-2.0

export type { CapabilityContext, RuntimeCapability } from "./capability.js";
export {
  ENVIRONMENT_KEYS,
  RuntimeConfigFileSchema,
  resolveRuntimeConfig,
} from "./config.js";
export type { RuntimeConfig, RuntimeConfigFile, RuntimeConfigSource } from "./config.js";
export { PluginRuntimeError, RUNTIME_ERROR_CODES } from "./errors.js";
export type { RuntimeErrorCode } from "./errors.js";
export { summarizeHealth } from "./health.js";
export type { HealthCheck, HealthReport } from "./health.js";
export { createLineLogger, createSilentLogger } from "./logger.js";
export type { LogLevel, RuntimeLogger } from "./logger.js";
export { createPluginRuntime } from "./runtime.js";
export type { PluginRuntime, PluginRuntimeOptions } from "./runtime.js";
export { RUNTIME_VERSION } from "./version.js";

// `bin.ts` is deliberately NOT re-exported: it reads the ambient environment, installs
// signal handlers, and runs on import as a process entry point. Re-exporting it would
// pull all three into every consumer.
```

- [x] **Step 4: Run the test to verify it passes**

Run: `cd plugin/runtime && yarn test && yarn typecheck`
Expected: PASS — 3 new tests (54 total).

- [x] **Step 5: Add the root-entrypoint assertion to the boundary guard**

In `.github/scripts/plugin-tree-source-boundaries.test.mjs`, inside the final
`test('plugin tree source boundaries hold and the manifest matches the approved shape', …)`,
append before the closing brace:

```js
  assert.deepEqual(
    forbiddenImportsInFiles([join(runtimeSource, 'index.ts')], [], [binEntry]),
    [],
    'the runtime root entrypoint must not export bin.ts, which reads the ambient '
      + 'environment, installs signal handlers, and executes on import',
  );
```

- [x] **Step 6: Write the pack smoke**

`plugin/runtime/scripts/pack-smoke.mjs`:

```js
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-plugin-runtime-"));
const archive = join(temporaryRoot, "plugin-runtime.tgz");
const consumer = join(temporaryRoot, "consumer");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

function output(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
        return;
      }
      reject(new Error(`${command} exited with ${code}: ${Buffer.concat(stderr).toString("utf8")}`));
    });
  });
}

try {
  await run("corepack", ["yarn@4.13.0", "pack", "--out", archive], { cwd: packageRoot });

  const entries = (await output("tar", ["-tzf", archive])).split(/\r?\n/u).filter(Boolean);
  for (const required of [
    "package/README.md",
    "package/dist/bin.js",
    "package/dist/index.d.ts",
    "package/dist/index.js",
    "package/package.json",
  ]) {
    if (!entries.includes(required)) {
      throw new Error(`packed runtime is missing ${required}`);
    }
  }
  const leaked = entries.filter(
    (entry) =>
      /(?:^|\/)[^/]*\.(?:test|spec)\./u.test(entry) ||
      entry.endsWith(".map") ||
      entry.includes("/src/") ||
      entry.includes("/fixtures/"),
  );
  if (leaked.length > 0) {
    throw new Error(`private/test material leaked into tarball: ${leaked.join(", ")}`);
  }

  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: { "@jinn-network/plugin-runtime": `file:${archive}` },
    }),
  );
  await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumer });

  await writeFile(
    join(consumer, "smoke.mjs"),
    `
import assert from "node:assert/strict";
import * as runtime from "@jinn-network/plugin-runtime";

assert.equal(typeof runtime.createPluginRuntime, "function");
assert.equal(typeof runtime.resolveRuntimeConfig, "function");
assert.equal(typeof runtime.summarizeHealth, "function");
assert.equal("main" in runtime, false);

const config = runtime.resolveRuntimeConfig({ env: {}, homeDirectory: "/srv/packed" });
assert.equal(config.archiveDirectory, "/srv/packed/archive");

const instance = runtime.createPluginRuntime({ config });
await instance.start();
const report = await instance.health();
assert.equal(report.ok, true);
assert.equal(report.checks.length, 0);
await instance.stop();
`,
  );
  await run(process.execPath, [join(consumer, "smoke.mjs")], { cwd: consumer });

  // The binary must run from the installed tarball, and it must keep stdout clean.
  const binary = join(consumer, "node_modules", ".bin", "jinn-plugin-runtime");
  const version = await output(binary, ["--version"], { cwd: consumer });
  const installedManifest = JSON.parse(
    await readFile(
      join(consumer, "node_modules", "@jinn-network", "plugin-runtime", "package.json"),
      "utf8",
    ),
  );
  assert.equal(version.trim(), installedManifest.version);
  assert.deepEqual(installedManifest.publishConfig, { access: "public", provenance: true });
  assert.deepEqual(Object.keys(installedManifest.exports), ["."]);

  const health = await output(binary, ["health"], {
    cwd: consumer,
    env: { ...process.env, JINN_PLUGIN_HOME: join(temporaryRoot, "home") },
  });
  const report = JSON.parse(health.trim());
  assert.equal(report.ok, true);
  assert.deepEqual(report.checks, []);

  // Nothing test-only travels with the package.
  await assert.rejects(
    access(join(consumer, "node_modules", "vitest", "package.json")),
    { code: "ENOENT" },
  );

  console.log("Packed plugin runtime tarball shape, isolated consumer, and binary verified.");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
```

- [x] **Step 7: Run the pack smoke**

Run: `cd plugin/runtime && yarn build && yarn pack:smoke`
Expected: `Packed plugin runtime tarball shape, isolated consumer, and binary verified.`

- [x] **Step 8: Run every gate the workflow runs, in workflow order**

```bash
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke && cd -
node .github/scripts/plugin-tree-packed-types.test.mjs
```
Expected, in order:
- inventory: `# pass 5`, `# fail 0`
- boundaries: `# pass 10`, `# fail 0`
- package: immutable install with no lockfile drift; `tsc` silent; vitest `Test Files 5 passed`, `Tests 54 passed`; build emits `dist/`; pack smoke prints its verified line
- canary: `Compiled a packed TypeScript consumer against 1 public code entrypoints across all 1 plugin tree packages.`

- [x] **Step 9: Confirm the tree stayed out of the operator image and the frozen lanes**

```bash
grep -n "plugin/" client/Dockerfile || echo "Dockerfile clean"
grep -n "^      - 'plugin/" .github/workflows/ci.yml || echo "ci.yml clean"
git diff --stat integration/evidence-v1...HEAD -- client packages apps
```
Expected: `Dockerfile clean`; `ci.yml clean`; the `git diff --stat` prints nothing — C3 touched no file under `client/`, `packages/`, or `apps/`, so it changes neither the operator image nor the frozen trio (spec §4.1, §9.4).

- [x] **Step 10: Confirm C0 independence one final time**

```bash
ls plugin
git diff --name-only integration/evidence-v1...HEAD
```
Expected: `plugin` contains `README.md` and `runtime` only. The changed-file list is exactly: `.github/scripts/plugin-tree-package-inventory.test.mjs`, `.github/scripts/plugin-tree-packed-types.test.mjs`, `.github/scripts/plugin-tree-source-boundaries.test.mjs`, `.github/workflows/plugin-tree-ci.yml`, `.gitignore`, `plugin/README.md`, and the files under `plugin/runtime/`. **No file C0 owns appears.**

- [x] **Step 11: Commit**

```bash
git add plugin/runtime .github/scripts/plugin-tree-source-boundaries.test.mjs
git commit -m "feat(plugin-runtime): public surface, pack smoke, and the tree's first green run"
```

---

## Restacking

C3 is a **stack root**: its base is `integration/evidence-v1` and it has no component dependencies. Restacking is therefore only ever against a moving base, never against a squashed sibling.

**Routine case — the base moved:**

```bash
git fetch origin
git rebase origin/integration/evidence-v1
```

**If the base was squash-merged or otherwise rewritten** (the ordinary hazard in this repo's stacked trains: the old base commits no longer exist, so a plain rebase replays them and conflicts):

```bash
git fetch origin
OLD_BASE=$(git merge-base HEAD origin/integration/evidence-v1)   # capture BEFORE rebasing
git rebase --onto origin/integration/evidence-v1 "$OLD_BASE" plugin/c3-product-tree
```

If `git merge-base` no longer finds a shared ancestor because the base was rewritten, take the old base from the reflog (`git reflog show plugin/c3-product-tree | tail -1`) or from the PR's "merged commit" reference, and pass that SHA as `$OLD_BASE`.

**Verifying coherence after any restack** — the point is that a green rebase proves nothing about whether the tree still holds against a base that moved underneath it:

```bash
git log --oneline origin/integration/evidence-v1..HEAD          # only C3's commits
git diff --name-only origin/integration/evidence-v1...HEAD      # only C3-owned paths
node --test .github/scripts/plugin-tree-package-inventory.test.mjs
node --test .github/scripts/plugin-tree-source-boundaries.test.mjs
cd plugin/runtime && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke && cd -
node .github/scripts/plugin-tree-packed-types.test.mjs
```

Three restack-specific checks beyond "the tests pass":

1. **`yarn install --immutable` must succeed.** A base that changed a shared dependency version does not touch this package (it is a self-contained project), but a rebase that mangles `plugin/runtime/yarn.lock` will show here rather than in CI.
2. **The changed-file list must still contain no file C0 owns** — a restack that accidentally absorbs a sibling's commit shows up as `plugin/frozen/…` or `jinn-plugin-split.yml` in the diff.
3. **`.github/workflows/plugin-ci.yml` must still exist and still be the frozen package's.** If a base moved by C9 removed it, that is a signal the program's phase ordering has been violated, not a conflict to resolve locally — stop and escalate.

**Do not** rebase onto a base that has C0's commits when C0's PR has not merged; the two are siblings, and C3 has no dependency to inherit.

---

## Self-review

**Scope coverage against the brief.**

| Required deliverable | Where |
| --- | --- |
| Tree layout per program §4 (`runtime/` npm-published, `adapter-hermes/` Python non-published, `frozen/` C0-owned and not created here) | Task 1 Step 3 (`plugin/README.md`), Task 1 Step 1 (`NON_NPM_DIRECTORIES` assertion), §Path ownership |
| `plugin/runtime` scaffold: manifest, tsconfig pair, yarnrc, gitignore, README, pack-smoke | Task 1 Step 4, Task 10 Step 6 |
| Guard trio as new `.github/scripts/plugin-*.test.mjs` following the evidence-tree pattern | Tasks 1, 2, 3 (as `plugin-tree-*`; see finding F-C3-1) |
| CI workflow | Task 4 |
| Frozen-trio import assertion with a negative test proving the guard bites (program gate C3) | Task 2 Steps 1, 3, 4, 5 |
| Runtime configuration surface, typed and injected, no ambient env reads for authority (custody C2) | Task 6; enforced in Task 9 Step 7 |
| Runnable process skeleton: starts, reports health, exits cleanly, no capabilities | Tasks 7, 8, 9 |
| Tier 4 means no conformance kit obligation | §Global constraints, `plugin/README.md`, the `exports` assertion in Task 2 Step 1, `plugin/runtime/README.md` |
| C3/C0 path ownership stated, no assumption C0 landed | §Path ownership; Task 2 Steps 1 and 6; Task 10 Step 10 |
| Source-boundary allowlist anticipating the §6.1 composition table, with later extension noted | Task 2 Step 1 (`PERMITTED_PACKAGES` + its comment), Task 1 Step 1 (`SIBLING_TREE_DIRS`) |
| Tree does not enter the operator image (spec §9.4) | §Global constraints; verified in Task 10 Step 9 |

**Placeholder scan.** No step contains "TBD", "similar to Task N", "add error handling", or an elided body. Every source file is given in full; the only file written twice is `plugin/runtime/src/index.ts`, whose placeholder (Task 1) is replaced in full (Task 10 Step 3) with the replacement spelled out. Every command step names the exact command and its expected output. One step (Task 8 Step 4) deliberately corrects a defect introduced in Step 3; the defect, the failing test that catches it, and the exact replacement text are all stated.

**Name and type consistency.** `RuntimeConfig` field names used in Task 6 (`homeDirectory`, `archiveDirectory`, `catalogPath`, `indexPath`, `mirrorStatePath`, `logLevel`) are the same names consumed in Tasks 8, 9, 10 and in the pack smoke. `HealthCheck`'s four fields (`name`, `ok`, `detail`, `remedy`) match the onboarding design's doctor contract as quoted in spec §5 and §9.3. `RUNTIME_ERROR_CODES` values match the strings asserted in Task 5's test and the `code` values matched in Task 8's tests. The public-surface list in Task 10 Step 1 contains exactly the ten value exports of Task 10 Step 3 (type-only exports do not appear at runtime, which is why `RuntimeConfig`, `HealthCheck`, and friends are absent from the list). The guard's `MIN_SCANNED_FILES` of 8 is satisfied by the nine production files the plan creates. The workflow's artifact name `plugin-runtime-dist` matches the `pattern: plugin-*-dist` download and the `cp -R .plugin-tree-dist/plugin-runtime-dist/.` placement.

**Verified against real code.** Guard helpers (`files`, `specifiers`, `inside`, `sourceModuleStem`, `insideForbiddenRoot`, `forbiddenImportsInFiles`, `assertBoundary`, `manifest`) are copied from `.github/scripts/evidence-source-boundaries.test.mjs:347-417`; `packageSpecifierMatches` (the `*` family wildcard) from `.github/scripts/benchmarking-source-boundaries.test.mjs`; the escape self-test asserting 11 findings from `evidence-source-boundaries.test.mjs:419-441`; the in-repo fixture technique for relative-path escapes from the same file's `:606-639`; the derived-cardinality inventory shape and `SIBLING_TREE_DIRS` from `.github/scripts/benchmarking-package-inventory.test.mjs`; the packed-types consumer from `.github/scripts/{evidence,benchmarking}-packed-types.test.mjs`; the workflow's `architecture` / per-package / `verify` shape and the `for result in … test "$result" = "success"` loop from `.github/workflows/evidence-ci.yml:24-36,483-532`; the scaffold from `packages/evidence/derivation/{package.json,tsconfig.json,tsconfig.build.json,.yarnrc.yml,.gitignore}`; the pack-smoke structure from `packages/evidence/derivation/scripts/pack-smoke.mjs`; the `bin` declaration shape from `packages/evidence/execution-recorder-bridge/package.json`; the custody patterns and `MIN_SCANNED_FILES` floor from `.github/scripts/custody-boundaries.test.mjs` (added on `integration/evidence-v1` at `439391538`). The `plugin-ci.yml` collision was verified by reading the file (its `paths` are `packages/plugin/**`).

---

## Findings

Recorded per the designs-are-law rule (program §Global constraints). Each carries a proposed disposition. **This plan edits neither the spec nor the program plan.**

- **F-C3-1 — `plugin-ci.yml` is taken; the tree's guards and workflow use the `plugin-tree-` prefix.** The task brief and the program's guard-trio convention imply `.github/workflows/plugin-ci.yml`, but that file exists and belongs to the frozen `packages/plugin` until C9 dismantles it (program §1, C9 row). **Proposed disposition:** ratify `plugin-tree-{package-inventory,source-boundaries,packed-types}.test.mjs` and `plugin-tree-ci.yml` as the permanent names. Do **not** rename after C9 frees `plugin-ci.yml`: a rename would churn branch protection a second time for no gain, and `plugin-tree-` reads more clearly beside a repository that still contains a frozen `packages/plugin` in git history. C9's plan should be amended to note that it removes `plugin-ci.yml` and must not touch `plugin-tree-ci.yml`.

- **F-C3-2 — `plugin/adapter-hermes/` cannot be created by C3.** Program §4 settles the tree layout as three directories, but git cannot track an empty directory and C3 has no adapter content to put there (C7 does). **Proposed disposition:** the layout is *declared* by C3 in `plugin/README.md` and *enforced* by the inventory guard's `NON_NPM_DIRECTORIES` assertion (which passes when the directory is absent and asserts manifest-freedom when it appears); C7 creates the directory with its first file. No spec or program change needed — recorded so a reviewer does not read the missing directory as an omission.

- **F-C3-3 — the design's §6.1 composition table names capabilities, not package identities, for two rows.** "Public-corpus mirror — `discovery` client (chain-walk/sync, high-water-mark store)" and "Trust filtering — `trust/*`" do not resolve to a single package name. Investigated: the discovery client is `@jinn-network/record-discovery-client` (`packages/discovery/client`), and its transitive contract package is `@jinn-network/record-discovery-protocol`; the trust tree publishes `@jinn-network/trust-core`, `@jinn-network/trust-resolve`, and `@jinn-network/trust-testing`. Note also the **name collision hazard**: `@jinn-network/evidence-discovery` (`packages/evidence/discovery`) is a *different* package from the record-discovery family, and both are in scope — the former supplies the catalog contract, the latter the announcement client. **Proposed disposition:** C3's allowlist admits `record-discovery-client`, `record-discovery-protocol`, `evidence-discovery`, `trust-core`, and `trust-resolve`, and deliberately omits `trust-testing` (a kit, not a runtime dependency) and `record-discovery-serve` (the product is a client of discovery, never a server of it — serving archives is the daemon cutover's stage). C5 should confirm this reading when it wires the mirror; a divergence is a one-line allowlist edit, reviewed.

- **F-C3-8 — the archive's exclusive lock forecloses the `start`-time-handle design the capability seam would otherwise invite; C3 states the rule rather than leaving it to be discovered.** Spec §6.2 names the archive-access mode ("direct multi-process access under these locks versus per-instance open/close discipline") as the build plan's first design unit, and program §1 assigns it to C4. C4's investigation settled it against the code: `openLocalEvidenceRuntime` takes an **exclusive** SQLite lock on the runtime root (`packages/evidence/local-runtime/src/lock.ts:37` `pragma locking_mode = EXCLUSIVE`, `:46` `BEGIN EXCLUSIVE`, three retries at 10/25/50 ms, then `LocalEvidenceRuntimeError` code `ROOT_IN_USE` at `:80`). Cooperative multi-process access is therefore not available; the lock is exclusive-or-fail. Since spec §6.2 also fixes that a session may hold **two** runtime instances (host-spawned for tools, adapter-spawned for hooks), a capability that opened the archive in `start()` would starve its sibling for the whole session. **Proposed disposition:** the rule — *open the archive per operation, never across the capability lifetime* — is documented in `src/capability.ts` and `plugin/runtime/README.md` by C3 (Task 8 Step 3, Task 1 Step 4) so C5 and C6 do not design a long-lived handle, and C4 carries the finding into the spec as the dated resolution of §6.2's design unit. C3 enforces nothing here: this is a documented invariant, not a guard, because "holds a handle too long" is not statically detectable.

- **F-C3-9 — `@jinn-network/evidence-discovery` was missing from the anticipated dependency set (raised by C4, adopted).** The design's §6.1 composition table lists `evidence/local-runtime` for capture but not `evidence/discovery`, yet `LocalEvidenceRuntime.catalog` is typed `EvidenceCatalogReader`, which local-runtime re-exports only as a type (`packages/evidence/local-runtime/src/types.ts:4`) from Discovery. Any consumer of `runtime.catalog` needs Discovery resolvable for `tsc`, and local-runtime declares it as a real dependency with a `portal:` resolution. **Proposed disposition:** added to `SIBLING_TREE_DIRS` and `PERMITTED_PACKAGES` in this plan (Task 1 Step 1, Task 2 Step 1). No spec change is needed — the table names concerns, not manifests — but it is recorded because it is the second instance of the same class after F-C3-3, and a third would argue for the spec carrying an explicit package manifest for §6.1.

- **F-C3-4 — the design does not say where `evidence-publication` and `evidence-contribution` sit relative to the boundary.** Spec §5 parks the outbound lane as a recorded extension point and §13 makes "no outbound publication" a non-goal, but nothing states whether the packages may be *depended on* early. **Proposed disposition:** C3 forbids both by name, so un-parking the lane is a reviewed edit to the boundary contract rather than a silent import that arrives with a feature. This is the strictest reading consistent with §5 and §13 and costs nothing to reverse. Recorded so the C8/C9-era reviewer knows the ban is deliberate and where to lift it.

- **F-C3-5 — the locale canary is installed fail-closed in a tier-4 tree, where it is arguably too strict.** Every stack tree bans `localeCompare`/`Intl` in production source because canonical bytes must not depend on host ICU data; a *product* tree also has legitimate presentation code (rendering a timestamp for a human) where locale formatting is correct. **Proposed disposition:** ban tree-wide now — C4 assembles sealed records in this tree, which is exactly the digest-instability class the canary exists for — and admit a narrow, named carve-out (a `src/render/` region) by reviewed guard edit if and when C6 or C7 has a real presentation surface. Recorded so a future contributor does not read the ban as an oversight and quietly delete it.

- **F-C3-6 — "reports health" is under-specified for a runtime with no capabilities.** The brief asks for a skeleton that starts, reports health, and exits cleanly, but a capability-free runtime has nothing to check. **Proposed disposition:** the empty report (`{ ok: true, version, checks: [] }`) is the honest answer and is asserted as such, rather than inventing a synthetic "runtime is running" check that would always pass and teach C7 a bad pattern. What C3 delivers instead is the *contract* — including `remedy: null` as the first-class encoding of the spec §9.3 not-fixable-from-this-machine state, which the design describes in prose and no plan had yet given a representation.

- **F-C3-7 — `plugin/runtime`'s version and the channel pin are not yet connected.** Program §4 settles `runtime-pin.json` (`{ package, version, bin }`) as C7's artifact and spec §9.3 requires the runtime to be published stable *before* the mirror re-point. C3 declares `version: "0.1.0"` and a `bin` name (`jinn-plugin-runtime`) that the pin must match, but nothing yet verifies the two agree. **Proposed disposition:** C7's plan should add an assertion that `runtime-pin.json`'s `package`, `version`, and `bin` match `plugin/runtime/package.json` — the analogue of `verify-layer-stable-version.mjs` for the new channel — and C8's cutover gate should treat a mismatch as the "pin cannot resolve" doctor state rather than a build error. No C3 change; recorded so the check has a named owner before the cutover rather than after it.

- **F-C3-10 — Task 2 frozen-trio fixture expected paths assumed the fixture directory was a direct child of `plugin/`.** `mkdtempSync(join(tree, '.plugin-tree-frozen-boundary-'))` creates `plugin/.plugin-tree-frozen-boundary-*`, so `localSpecifier` yields `../../packages/{core,layer,plugin}/src` and `../frozen/jinn_layer.py`, not `../packages/...` and `./frozen/...`. **Disposition applied:** the committed guard asserts the nested-relative paths. No topology change.

- **F-C3-11 — Task 2 Steps 3–4's full-suite negative gate is masked by `MIN_SCANNED_FILES` until Task 10.** The production-boundary test asserts the file-count floor *before* `assertBoundary`, and at Task 2 the tree has one source file, so a deliberate frozen-trio import never reaches the boundary assertion in the full suite (failure message stays the floor). **Disposition applied:** (1) the dedicated frozen-trio fixture test still red-lines name/subpath/relative escapes; (2) Task 2 verified `assertBoundary` on the real violated `index.ts` and captured the expected findings; (3) re-run Steps 3–4's full-suite red→green as part of Task 10's green gate once ≥8 source files exist.

- **F-C3-12 — Task 4 Step 2's job-name regex also matches `on.push`.** The one-liner `/^  ([a-z-]+):$/gm` matches both `push:` under `on:` and the three jobs, so the printed string is `push architecture runtime verify` rather than the plan's `architecture runtime verify`. **Disposition:** no YAML change; the three jobs exist and are correctly named. Treat the Step 2 expected string as jobs-only and ignore the trigger key match.

- **F-C3-13 — Task 9 home-directory test requires `configuration resolved` at the default log level.** The plan's `bin.ts` emits that record at `log.debug`, but the test runs `main(["health"], {}, …)` with no `JINN_PLUGIN_LOG_LEVEL`, so the default `info` level suppresses it. **Disposition applied:** emit `configuration resolved` at `info`. Topology and custody confinement unchanged.

- **F-C3-14 — Node 22 top-level-await `serve` exits before SIGTERM without an event-loop keepalive.** With only signal listeners and no other handles, the process can exit (observed exit 13) before `kill -TERM`. **Disposition applied:** the process-entry `untilShutdown` holds a long `setInterval` cleared on signal; `main` starts the shutdown promise before the first `await` on the serve path so handlers are armed early. Tests still inject `untilShutdown`; only the process entry carries the keepalive.

- **F-C3-15 — npm `.bin` symlinks make `import.meta.url === pathToFileURL(process.argv[1]).href` false.** Pack smoke installs the tarball and runs `node_modules/.bin/jinn-plugin-runtime`, which is a symlink to `dist/bin.js`; the plan's `isProcessEntry()` compared unresolved paths and skipped `main()`, so `--version`/`health` produced empty stdout. **Disposition applied:** resolve both sides with `realpathSync` before comparing. Confined to `bin.ts`; no public-API change.

- **F-C3-16 — Task 10 Step 9's `grep -n "plugin/" client/Dockerfile` matches the frozen `packages/plugin/` COPY lines.** Those lines are pre-existing and required; the product tree `plugin/` is absent. **Disposition:** treat the gate as "no product-tree path (`plugin/runtime`, root `plugin/`) in the operator image"; do not edit `client/Dockerfile`.

---

## Review amendments — 2026-07-31 (clean-slate consolidated review-fix wave)

Recorded per the coordinator's consolidated review. Historical task text above is unchanged.

- **R-C3-1 — Custody canary bypasses and dropped import bans (Important; IMPLEMENT).** The source-boundary guard's process-surface scanner detected only dotted `process.env`/`argv`/`stdout` and console writes. Independent probe proved these bypass forms passed unflagged outside `bin.ts`: `import { env, argv, stdout } from "node:process"`; equivalent imports from `process`; `process["env"]` bracket access; `const p = process; p.env` alias acquisition. The guard also lacked the custody precedent's `node:fs`/`fs` and `node:child_process`/`child_process` direct-import bans. **Disposition applied:** outside `plugin/runtime/src/bin.ts`, reject `node:process`/`process` module imports, bracket access to confined surfaces, and alias acquisition; across production source (excluding `bin.ts`, which holds `realpathSync` for entry detection), reject direct imports of `node:fs`/`fs` and `node:child_process`/`child_process` including subpaths. Self-tests added for each bypass form. **Evidence:** boundaries guard `# pass 14`; red probe showed dotted-only scanner `oldHits: 0` on combined bypass fixture; hardened scanner catches `moduleImports: 2`, `bracket: 1`, `alias: 1`.

- **R-C3-2 — `PERMITTED_PACKAGES` must constrain third-party install-time deps (Important; IMPLEMENT).** The comment claimed anything not on the allowlist requires a reviewed edit, but the manifest assertion exempted every non-`@jinn-network/*` dependency. **Disposition applied:** `PERMITTED_PACKAGES` is authoritative for `dependencies`, `optionalDependencies`, and `peerDependencies`; `devDependencies` remain free. Separate Jinn graph/portal checks preserved. Negative self-test proves `lodash` in `dependencies` is rejected; `zod` remains admitted. No runtime dependency added or removed.

- **R-C3-3 — Guard completeness asymmetry (Minor; FIX).** Inventory guard proved package-list completeness; source-boundary and packed-types guards hardcoded one package without discovery assertion. **Disposition applied:** `BOUNDARY_SCANNED_PACKAGES` in source-boundaries and `PACKED_TYPES_PACKAGES` in packed-types each proved against `discoveredPluginPackageDirectories()` so a future npm package under `plugin/` cannot be inventoried while silently omitted.

- **R-C3-4 — Health validation escapes runtime error taxonomy; vacuous test (Minor; FIX).** `summarizeHealth` threw bare `Error` for empty name/detail and duplicate names. **Disposition applied:** added `health-invalid` to `RUNTIME_ERROR_CODES`; `summarizeHealth` throws `PluginRuntimeError` with that code; `runtime.test.ts` vacuous `.catch()` replaced with `rejects.toBeInstanceOf`; health and logger tests assert code membership. Component-extensible string error codes preserved.

- **R-C3-5 — Keepalive cleanup on startup failure (Minor; RECORD ONLY, deferred to C4).** Process entry arms `untilShutdown()` before `runtime.start()`; future non-empty capabilities can make `start()` fail while signal timer/listeners remain armed. **Disposition:** C4's first non-empty capability wiring must add cancellable shutdown registration (or equivalent try/finally cleanup) and a startup-failure process test before accepting a capability that can fail. C3 ships `capabilities: []` — no live `start()` failure path exists today. Do not redesign `ProcessIo` API in this wave.

- **R-C3-6 — Export condition order (Minor; FIX).** **Disposition applied:** root export condition reordered to `types` before `import` in `plugin/runtime/package.json`; manifest assertion updated. Design-neutral plan correction — historical text specified the opposite order.

- **R-C3-7 — Task 10 expected test-file count (Minor; PLAN-ONLY).** Fresh full suite is **6 test files / 55 tests** (was 5 files / 54 tests at Task 10 close; one additional health validation test in this wave). Historical Step 8 expectation of 5 files preserved above.

- **R-C3-8 — Contract 11 composition-root ambiguity (Recommendation; RECORD ONLY).** Program contract 11: composition root ("the binary, or a thin adapter beside it") may depend on `viem`; `plugin/runtime` may not. C3's binary lives inside `plugin/runtime` and the guard applies to that package. **Disposition:** non-blocking for C3 but blocking C5/C7 chain-facing wiring pending operator disposition. No `viem` added, runtime allowlist not weakened, no new package/path, no topology chosen.

- **R-C3-9 — C7 stderr expectation (Recommendation; RECORD ONLY).** F-C3-13's `configuration resolved` info-level line writes the resolved home path to stderr during normal health invocation. Stdout remains clean. **Disposition:** C7 doctor rendering/rehearsal should expect this line rather than classify it as protocol noise.

- **R-C3-10 — C0+C3 integration proof (Recommendation; RECORD ONLY).** Program-level integration gate: once C0 and C3 heads are both review-clean, source-boundary guard must run on a temporary combined head containing actual `plugin/frozen` content, proving synthetic frozen-trio refusal also holds against the relocated tree. **Disposition:** do not merge C0 into C3 or alter branch topology in this wave.

