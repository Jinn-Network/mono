# Stack Publish Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the 45 platform packages under `packages/{task-execution,evidence,trust,discovery,marketplace,benchmarking}` as a coherent canary + stable set from CI, in dependency-graph-derived topological order, and prove externally that a published package installs and passes its own conformance kit from a clean directory outside this repository.

**Architecture:** Three new `.github/scripts/` modules — a graph module (discovery + topological waves), a manifest module (publish-time transform + exact restore), and a driver (`publish-stack.mjs`) that walks waves, builds, packs, publishes, and verifies by tarball integrity. One new workflow (`stack-npm-publish.yml`) drives canary on push and stable on release. Two DevX riders ride the same artifacts: a per-schema golden-fixture immutability gate (append-only + errata), and a static profile-root builder producing a SHA-256 manifest with a DSSE sidecar, ready for hosting.

**Tech Stack:** Node 22, `node:test` + `node:assert/strict` (all `.github/scripts` tests), Yarn 4.13.0 per-package projects (no root workspace), npm 11.16.0 CLI, GitHub Actions with npm trusted publishing (OIDC), vitest 4.1.8 (external acceptance only).

## Global Constraints

- **Issue:** #2293. **Shape:** `feat`. **Base branch:** `integration/evidence-v1` (the 45 packages do not exist on `next`).
- **Assumed merged before this plan starts:** PRs #2306, #2307, #2308. #2306 parameterized the four `@jinn-network/sdk@x.y.z` literals in `.github/workflows/npm-publish.yml` to manifest-derived reads — **never reintroduce a hard-coded sdk version literal**; `.github/scripts/npm-publish-workflow.test.mjs` guards this and must stay green.
- **No hard-coded package lists.** `.github/scripts/publish-layer-stable.mjs`'s three-entry `packageSet` const is the anti-pattern this plan generalizes. Every package set in new code is derived by filesystem discovery plus a manifest predicate.
- **American English** in identifiers, CLI verbs, file names, env vars, paths, and copy (Rule 5).
- **No emoji** in any produced artifact, code, workflow, or doc (BRAND.md non-negotiable).
- **Canary version scheme, verbatim from the existing lanes:** `<packageVersion>-canary.sha.<40-hex-commit-sha>`, dist-tag `canary`. Source: `.github/workflows/sdk-npm-publish.yml` and `.github/workflows/npm-publish.yml`.
- **Stable release tag namespace for this set:** `stack-v<semver>`, dist-tag `latest`. Distinct from `v*` (client), `sdk-v*`, `client-v*`, `layer-v*`.
- **All 45 packages carry the same version at all times.** Today every one is `0.1.0` and every in-set dependency specifier is exactly `0.1.0` (verified across all 45 manifests, all four dependency sections). The set publishes as one coherent unit; no per-package independent versioning in this plan.
- **npm permits one trusted-publisher configuration per package.** All 45 registrations name workflow filename `stack-npm-publish.yml`, repository `Jinn-Network/mono`, and leave the optional npmjs Environment field **blank** (the `docs/runbooks/layer-npm-publishing.md` precedent — one workflow, two GitHub environments).
- **Human-action boundary.** npm org trusted-publisher registrations and `jinn.network` DNS/static hosting are **checklist outputs of tasks in this plan**, never silent assumptions. Task 19 produces both checklists as committed files.
- **The in-repo development path must keep working unchanged.** No task edits a `packages/**/package.json` `resolutions` block or `portal:` link in the working tree. Publish-time manifest mutation happens in the working tree only transiently and is restored byte-for-byte before the process exits.
- **Node test runner, not vitest,** for everything under `.github/scripts/`. Run with `node --test <file>`.

---

## Verified ground truth (do not re-derive; re-verify only if a step fails)

Reproduced at worktree head `89fd3f514` on `claude/marketplace-consumption-boundary-ca5071`:

- **45 packages** across the six trees. Enumerate with:
  `find packages/task-execution packages/evidence packages/trust packages/discovery packages/marketplace packages/benchmarking -name package.json -not -path '*/node_modules/*'`
- **The dependency graph is acyclic.** Counting runtime + dev + peer + optional in-set edges it has **8 topological waves**; runtime-only it has 7. Wave 0 is `evidence-protocol`, `task-execution-protocol`, `trust-core`. Wave 7 is `benchmarking-marketplace` alone.
- **`portal:` links live in `resolutions`, never in `dependencies`.** Every in-set dependency specifier is already the registry-exact string `0.1.0`. Example: `packages/evidence/retrieval/package.json` declares `"@jinn-network/evidence-protocol": "0.1.0"` in `dependencies` and `"@jinn-network/evidence-protocol": "portal:../protocol"` in `resolutions`.
- **`resolutions` is not purely portal.** Four packages (`evidence-contribution`, `evidence-derivation`, `evidence-publication`, `evidence-repository-ipfs`) pin `"vite": "6.4.3"` there. Nine `resolutions` entries pin in-set packages that the manifest does not declare as direct dependencies (transitive portal pins). Both facts constrain the transform.
- **All 45 packages have identical script surfaces:** `build`, `typecheck`, `test`, `pack:smoke`, `prepack: yarn build`.
- **No root `package.json`, no root `.yarnrc.yml`.** Each package is its own Yarn project with its own `yarn.lock` and `.yarnrc.yml` (`nodeLinker: node-modules`).
- **22 of the 45 ship schema, profile, or fixture directories** in `files` with matching `exports` subpaths. These are the tier-1/2 publication surface and the profile-root input.
- **Precedents to imitate, not re-invent:** `.github/scripts/publish-layer-stable.mjs` (tarball integrity preflight + post-publish verification, coherent set, OIDC dist-tag limitation), `.github/workflows/sdk-npm-publish.yml` (canary version resolution, idempotent re-publish check, canary version patch), `.github/scripts/npm-publish-workflow.test.mjs` (workflow-text guard test shape), `client/scripts/external-consumer-acceptance.mjs` (packed acceptance from a clean directory), `docs/runbooks/layer-npm-publishing.md` (trusted-publisher runbook shape).

## Design decisions (deviations and judgment calls, with rationale)

**D1 — Branch-aware trigger (an explicit, stated deviation from the AC).**
The acceptance criterion says "canary publishing on push to `next`". The 45 packages do not exist on `next`; they live on `integration/evidence-v1`. A workflow that triggers only on `next` would land green and publish nothing, which is the never-publish equilibrium the issue names as the main failure mode. Therefore `stack-npm-publish.yml` triggers on pushes to **both** `integration/evidence-v1` and `next`, and its first step is an **existence guard**: if fewer than one package is discovered under the six roots, the job logs a notice and exits 0 without publishing. Consequence: it publishes canaries from the integration branch now, and the moment integration merges to `next` the same file publishes from `next` with no edit. This is a superset of the AC, not a substitute for it — the AC's `next` trigger is present from the first commit.

**D2 — The rewrite is "strip portal resolutions + patch version pins", not "rewrite dependency ranges".**
The AC's phrasing ("`portal:` deps rewritten to registry ranges") assumed `portal:` specifiers sit in `dependencies`. They do not: `dependencies` already carry registry-exact `0.1.0`, and `portal:` is confined to `resolutions`. The publish-time transform therefore (a) sets `version` to the publish version, (b) rewrites every in-set specifier in all four dependency sections to that same exact version, and (c) deletes only the `portal:`-valued `resolutions` entries. Yarn honors `resolutions` only at a project root, so a consumer never sees them — but a published tarball containing `portal:../protocol` is a misleading artifact, and stripping it is what makes the tarball self-describing. Non-portal `resolutions` entries (the four `vite` pins) are preserved verbatim.

**D3 — Exact version pins, not caret or tilde ranges.**
The marketplace-surfaces design §8.2 fixes 0.x semantics as **minor = breaking, patch = additive or fix**, and states the design intent that "the stack publishes as a coherent set (same-sha canaries, coherent stables)". Exact pins are the only specifier that makes intra-release cross-package skew structurally impossible, and they match what all 45 manifests already declare. Ranges are a post-1.0 question and are out of scope.

**D4 — Publishing order uses the union graph (runtime + dev + peer + optional), 8 waves.**
Runtime edges alone (7 waves) suffice for registry resolvability, but the union order is a strict superset and costs one extra wave. It buys correctness for the external acceptance (which installs `*-testing` kits whose in-set edges are partly dev edges) at no risk. Cycle detection runs over the union graph.

**D5 — `npm pack --ignore-scripts` after an explicit `yarn build`.**
Every package declares `prepack: yarn build`. Letting `npm pack` fire `prepack` would run Yarn *after* the driver has mutated `package.json`, inviting lockfile-drift errors and making the packed bytes depend on Yarn's post-mutation behavior. The driver builds first (unmutated manifest, portal-resolved `node_modules`), then mutates, then packs with scripts disabled. Deterministic, and the mutation window is as small as it can be.

**D6 — Tarball integrity (`sha512-`) is the identity check; `gitHead` is set explicitly in the transformed manifest.**
`publish-layer-stable.mjs` already proves integrity-based idempotence and post-publish verification against a tarball-path publish. npm's automatic `gitHead` capture is a `npm publish`-from-directory behavior and is not something to rely on for a tarball-path publish, so the transform writes `gitHead` into the manifest explicitly (npm honors a manifest `gitHead` field). Both checks then hold, and the existing lanes' `gitHead` validation discipline carries over unchanged.

**D7 — The publish lane does not re-run per-tree test suites; it gates on their check-runs.**
The six tree CI workflows (`evidence-ci.yml`, `trust-ci.yml`, `task-execution-ci.yml`, `record-discovery-ci.yml`, `marketplace-ci.yml`, `benchmarking-ci.yml`) already run `typecheck` + `test` + `pack:smoke` per package on the same commit. The publish job installs, builds, packs, and publishes. It preflights the six workflows' check-runs at the publish SHA and refuses to publish if **any of them concluded failure**; a workflow with **no run at that SHA** (its path filter excluded it) is not a failure. The whole set republishes on every push regardless of which tree changed — that is what "coherent same-sha canaries" means.

**D8 — The DSSE signature is a sidecar file, so signed and unsigned manifest bytes are identical.**
The profile-root builder always emits `manifest.json`. `manifest.dsse.json` is emitted only when the signing key secret is present. If the signature were a field inside the manifest, the digest-bound identity would differ between a key-provisioned and key-less run, which defeats the point. Key provisioning is a Task 19 human checklist item; an unsigned canary artifact is honest, a fake-key-signed one is not.

**D9 — Fixture immutability splits into an offline PR gate and an online stable gate.**
Design §8.1 requires both "CI refuses a release that changes or removes any existing fixture byte" and "adding one is at least a minor bump". The no-mutation half needs no network and binds from day one against the merge base (PR CI). The minor-bump half only means anything once a published identifier exists to protect, and needs the registry, so it runs in the stable publish lane against the current `latest` tarball. Enforcing a minor bump against the merge base pre-publication would force `0.2.0`, `0.3.0`, … during ordinary development while protecting nothing.

## File structure

**Created:**

| Path | Responsibility |
| --- | --- |
| `.github/scripts/stack-package-graph.mjs` | Discover the platform package set from the filesystem; build the in-set dependency graph; topologically sort into waves; detect cycles. |
| `.github/scripts/stack-package-graph.test.mjs` | Fixture-driven tests for discovery, graph, waves, cycles. |
| `.github/scripts/stack-publish-manifest.mjs` | Publish-time manifest transform, write, and byte-exact restore; publish-version resolution. |
| `.github/scripts/stack-publish-manifest.test.mjs` | Transform, portal-strip, preservation, round-trip, version-resolution tests. |
| `.github/scripts/publish-stack.mjs` | The driver: plan, build, pack, publish per wave, verify. |
| `.github/scripts/publish-stack.test.mjs` | Driver tests against a fake npm and a fixture package tree. |
| `.github/workflows/stack-npm-publish.yml` | Canary lane (push) and stable lane (release), plus the profile-root artifact job. |
| `.github/scripts/stack-publish-workflow.test.mjs` | Workflow-text guard test. |
| `.github/scripts/stack-trusted-publishers.mjs` | Emit the per-package trusted-publisher registration list as a build artifact. |
| `.github/scripts/stack-trusted-publishers.test.mjs` | Registration-list tests. |
| `.github/scripts/stack-external-acceptance.mjs` | Install published packages into a clean directory outside the repo and run a conformance kit plus a schema-retrieval check. |
| `.github/scripts/stack-external-acceptance.test.mjs` | Argument-parsing and assertion-helper tests. |
| `.github/scripts/stack-publication-surface.test.mjs` | Guard: every on-disk schema/profile/fixture directory is inside `files` and reachable through an `exports` subpath. |
| `.github/scripts/fixture-manifest.mjs` | Generate and check the per-package `fixtures/manifest.sha256.json`. |
| `.github/scripts/fixture-manifest.test.mjs` | Generator and `--check` tests. |
| `.github/scripts/fixture-immutability.mjs` | Compare a candidate fixture manifest against a baseline; enforce append-only, errata well-formedness, and the minor-bump rule. |
| `.github/scripts/fixture-immutability.test.mjs` | Immutability-rule tests. |
| `.github/workflows/stack-fixture-immutability.yml` | PR-triggered offline fixture gate. |
| `.github/scripts/build-profile-root.mjs` | Assemble the static profile root and its SHA-256 manifest. |
| `.github/scripts/build-profile-root.test.mjs` | Profile-root assembly tests. |
| `.github/scripts/sign-profile-manifest.mjs` | Produce the DSSE sidecar over the profile manifest. |
| `.github/scripts/sign-profile-manifest.test.mjs` | DSSE envelope tests. |
| `docs/runbooks/stack-npm-publishing.md` | The publish runbook plus the two human checklists. |
| `packages/**/fixtures/manifest.sha256.json` | Per-package golden-fixture digest manifests (generated data, committed). |

**Modified:** none outside `.github/` and `docs/`, except the generated fixture manifests. No package source, no `resolutions`, no `portal:` link.

---

### Task 1: Package-set discovery

**Files:**
- Create: `.github/scripts/stack-package-graph.mjs`
- Test: `.github/scripts/stack-package-graph.test.mjs`

**Interfaces:**
- Produces: `STACK_ROOTS: string[]` — the six tree-relative roots. `discoverStackPackages(repoRoot: string): StackPackage[]` where `StackPackage = { directory: string, name: string, manifest: object, manifestPath: string }`; `directory` is repo-relative and POSIX-separated; the array is sorted by `directory` ascending. Throws `Error` when a discovered manifest fails the platform predicate.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-package-graph.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { STACK_ROOTS, discoverStackPackages } from './stack-package-graph.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function fixtureRepo(packages) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-stack-graph-'));
  for (const [directory, manifest] of Object.entries(packages)) {
    const dir = join(root, directory);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return root;
}

const publishable = (name, extra = {}) => ({
  name,
  version: '0.1.0',
  publishConfig: { access: 'public' },
  ...extra,
});

test('STACK_ROOTS names exactly the six platform trees', () => {
  assert.deepEqual(STACK_ROOTS, [
    'packages/benchmarking',
    'packages/discovery',
    'packages/evidence',
    'packages/marketplace',
    'packages/task-execution',
    'packages/trust',
  ]);
});

test('discovers nested packages at any depth and sorts by directory', () => {
  const root = fixtureRepo({
    'packages/evidence/protocol': publishable('@jinn-network/evidence-protocol'),
    'packages/task-execution/backend-local/workspace': publishable('@jinn-network/task-execution-workspace'),
    'packages/trust/core': publishable('@jinn-network/trust-core'),
  });
  try {
    const found = discoverStackPackages(root);
    assert.deepEqual(found.map((p) => p.directory), [
      'packages/evidence/protocol',
      'packages/task-execution/backend-local/workspace',
      'packages/trust/core',
    ]);
    assert.equal(found[0].name, '@jinn-network/evidence-protocol');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('skips node_modules trees', () => {
  const root = fixtureRepo({
    'packages/trust/core': publishable('@jinn-network/trust-core'),
    'packages/trust/core/node_modules/left-pad': { name: 'left-pad', version: '1.0.0' },
  });
  try {
    assert.deepEqual(discoverStackPackages(root).map((p) => p.name), ['@jinn-network/trust-core']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a platform package that is not publishable', () => {
  const root = fixtureRepo({
    'packages/trust/core': { name: '@jinn-network/trust-core', version: '0.1.0' },
  });
  try {
    assert.throws(
      () => discoverStackPackages(root),
      /packages\/trust\/core: platform packages must declare publishConfig.access "public"/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a platform package outside the @jinn-network scope', () => {
  const root = fixtureRepo({
    'packages/trust/core': publishable('trust-core'),
  });
  try {
    assert.throws(
      () => discoverStackPackages(root),
      /packages\/trust\/core: platform packages must be named under @jinn-network\//,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the real repository set is discovered without a hard-coded list', () => {
  const found = discoverStackPackages(repoRoot);
  assert.ok(found.length >= 45, `expected at least 45 platform packages, found ${found.length}`);
  assert.equal(new Set(found.map((p) => p.name)).size, found.length, 'package names must be unique');
  for (const root of STACK_ROOTS) {
    assert.ok(
      found.some((p) => p.directory.startsWith(`${root}/`)),
      `no packages discovered under ${root}`,
    );
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-package-graph.test.mjs`
Expected: FAIL — `Cannot find module '.../stack-package-graph.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/stack-package-graph.mjs`:

```js
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const STACK_ROOTS = [
  'packages/benchmarking',
  'packages/discovery',
  'packages/evidence',
  'packages/marketplace',
  'packages/task-execution',
  'packages/trust',
];

const SCOPE = '@jinn-network/';

function toPosix(value) {
  return value.split(sep).join('/');
}

function manifestPaths(absoluteDir, relativeDir, found) {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const childAbsolute = join(absoluteDir, entry.name);
    const childRelative = `${relativeDir}/${entry.name}`;
    const childManifest = join(childAbsolute, 'package.json');
    let isFile = false;
    try {
      isFile = statSync(childManifest).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) found.push({ directory: childRelative, manifestPath: childManifest });
    manifestPaths(childAbsolute, childRelative, found);
  }
  return found;
}

export function discoverStackPackages(repoRoot) {
  const root = resolve(repoRoot);
  const located = [];
  for (const stackRoot of STACK_ROOTS) {
    manifestPaths(join(root, ...stackRoot.split('/')), stackRoot, located);
  }
  const packages = located.map(({ directory, manifestPath }) => {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`${directory}: cannot read package.json: ${error?.message ?? String(error)}`);
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(SCOPE)) {
      throw new Error(`${directory}: platform packages must be named under ${SCOPE}, got ${manifest.name ?? '<missing>'}`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${directory}: platform packages must declare publishConfig.access "public"`);
    }
    return { directory: toPosix(directory), name: manifest.name, manifest, manifestPath };
  });
  packages.sort((left, right) => (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));
  const seen = new Set();
  for (const pkg of packages) {
    if (seen.has(pkg.name)) throw new Error(`duplicate platform package name ${pkg.name}`);
    seen.add(pkg.name);
  }
  return packages;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-package-graph.test.mjs`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/stack-package-graph.mjs .github/scripts/stack-package-graph.test.mjs
git commit -m "feat(publish): derive the platform package set from the filesystem"
```

---

### Task 2: Dependency graph and topological waves

**Files:**
- Modify: `.github/scripts/stack-package-graph.mjs`
- Modify: `.github/scripts/stack-package-graph.test.mjs`

**Interfaces:**
- Consumes: `discoverStackPackages` from Task 1.
- Produces: `DEPENDENCY_SECTIONS: string[]` = `['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']`. `buildDependencyGraph(packages: StackPackage[]): Map<string, Set<string>>` — in-set edges only, keyed by package name. `topologicalWaves(graph: Map<string, Set<string>>): string[][]` — each wave sorted ascending; throws `Error` naming the members on a cycle.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/stack-package-graph.test.mjs` (and extend the import at the top to `import { STACK_ROOTS, buildDependencyGraph, discoverStackPackages, topologicalWaves } from './stack-package-graph.mjs';`):

```js
test('the graph keeps in-set edges from all four dependency sections and drops the rest', () => {
  const packages = [
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { dependencies: { zod: '4.4.3' } } },
    {
      directory: 'packages/trust/resolve',
      name: '@jinn-network/trust-resolve',
      manifest: {
        dependencies: { '@jinn-network/trust-core': '0.1.0', zod: '4.4.3' },
        devDependencies: { '@jinn-network/trust-testing': '0.1.0', vitest: '4.1.8' },
        peerDependencies: { vitest: '^4.1.8' },
        optionalDependencies: {},
      },
    },
    { directory: 'packages/trust/testing', name: '@jinn-network/trust-testing', manifest: { dependencies: { '@jinn-network/trust-core': '0.1.0' } } },
  ];
  const graph = buildDependencyGraph(packages);
  assert.deepEqual([...graph.get('@jinn-network/trust-core')], []);
  assert.deepEqual(
    [...graph.get('@jinn-network/trust-resolve')].sort(),
    ['@jinn-network/trust-core', '@jinn-network/trust-testing'],
  );
});

test('a self-edge is ignored rather than reported as a cycle', () => {
  const graph = buildDependencyGraph([
    { directory: 'packages/trust/core', name: '@jinn-network/trust-core', manifest: { devDependencies: { '@jinn-network/trust-core': '0.1.0' } } },
  ]);
  assert.deepEqual([...graph.get('@jinn-network/trust-core')], []);
  assert.deepEqual(topologicalWaves(graph), [['@jinn-network/trust-core']]);
});

test('waves are dependency-first and each wave is sorted', () => {
  const graph = new Map([
    ['c', new Set(['a', 'b'])],
    ['b', new Set(['a'])],
    ['a', new Set()],
    ['d', new Set(['a'])],
  ]);
  assert.deepEqual(topologicalWaves(graph), [['a'], ['b', 'd'], ['c']]);
});

test('a cycle throws and names every member', () => {
  const graph = new Map([
    ['a', new Set(['b'])],
    ['b', new Set(['a'])],
    ['c', new Set()],
  ]);
  assert.throws(
    () => topologicalWaves(graph),
    /dependency cycle among platform packages: a, b/,
  );
});

test('the real repository graph is acyclic and its first wave is the three sealed protocols', () => {
  const waves = topologicalWaves(buildDependencyGraph(discoverStackPackages(repoRoot)));
  assert.deepEqual(waves[0], [
    '@jinn-network/evidence-protocol',
    '@jinn-network/task-execution-protocol',
    '@jinn-network/trust-core',
  ]);
  const flattened = waves.flat();
  assert.equal(new Set(flattened).size, flattened.length, 'a package must appear in exactly one wave');
  assert.ok(flattened.length >= 45);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-package-graph.test.mjs`
Expected: FAIL — `buildDependencyGraph is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `.github/scripts/stack-package-graph.mjs`:

```js
export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export function buildDependencyGraph(packages) {
  const names = new Set(packages.map((pkg) => pkg.name));
  const graph = new Map();
  for (const pkg of packages) {
    const edges = new Set();
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(pkg.manifest?.[section] ?? {})) {
        if (dependency !== pkg.name && names.has(dependency)) edges.add(dependency);
      }
    }
    graph.set(pkg.name, edges);
  }
  return graph;
}

export function topologicalWaves(graph) {
  const remaining = new Set(graph.keys());
  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((name) => [...graph.get(name)].every((dependency) => !remaining.has(dependency)))
      .sort();
    if (wave.length === 0) {
      throw new Error(`dependency cycle among platform packages: ${[...remaining].sort().join(', ')}`);
    }
    for (const name of wave) remaining.delete(name);
    waves.push(wave);
  }
  return waves;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-package-graph.test.mjs`
Expected: PASS, 11/11.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/stack-package-graph.mjs .github/scripts/stack-package-graph.test.mjs
git commit -m "feat(publish): topologically order the platform package set"
```

---

### Task 3: Publish-time manifest transform and byte-exact restore

**Files:**
- Create: `.github/scripts/stack-publish-manifest.mjs`
- Test: `.github/scripts/stack-publish-manifest.test.mjs`

**Interfaces:**
- Consumes: `DEPENDENCY_SECTIONS` from Task 2.
- Produces:
  - `resolvePublishVersion({ mode, baseVersion, sha, releaseTag }): { version: string, distTag: string }` — `mode` is `'canary'` or `'stable'`.
  - `transformManifestForPublish(manifest: object, { version: string, gitHead: string, inSetNames: Set<string> }): object` — returns a new object, never mutates its input.
  - `applyPublishManifest(manifestPath: string, options): { restore: () => void }` — writes the transformed manifest and returns a restorer that rewrites the exact original bytes.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-publish-manifest.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPublishManifest,
  resolvePublishVersion,
  transformManifestForPublish,
} from './stack-publish-manifest.mjs';

const SHA = 'a'.repeat(40);
const inSetNames = new Set([
  '@jinn-network/evidence-protocol',
  '@jinn-network/evidence-repository',
  '@jinn-network/evidence-discovery',
]);

function sample() {
  return {
    name: '@jinn-network/evidence-retrieval',
    version: '0.1.0',
    dependencies: {
      '@jinn-network/evidence-discovery': '0.1.0',
      '@jinn-network/evidence-protocol': '0.1.0',
      '@jinn-network/evidence-repository': '0.1.0',
    },
    peerDependencies: { vitest: '^4.1.8' },
    devDependencies: { typescript: '^5.9.3', vitest: '^4.1.8' },
    resolutions: {
      '@jinn-network/evidence-discovery': 'portal:../discovery',
      '@jinn-network/evidence-protocol': 'portal:../protocol',
      '@jinn-network/evidence-repository': 'portal:../repository',
      vite: '6.4.3',
    },
  };
}

test('canary version and dist-tag follow the existing scheme', () => {
  assert.deepEqual(
    resolvePublishVersion({ mode: 'canary', baseVersion: '0.1.0', sha: SHA }),
    { version: `0.1.0-canary.sha.${SHA}`, distTag: 'canary' },
  );
});

test('stable version comes from a stack-v tag and must match the manifest version', () => {
  assert.deepEqual(
    resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'stack-v0.1.0' }),
    { version: '0.1.0', distTag: 'latest' },
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'stack-v0.2.0' }),
    /release tag stack-v0.2.0 resolves to 0.2.0, but the package set is at 0.1.0/,
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'stable', baseVersion: '0.1.0', releaseTag: 'v0.1.0' }),
    /stable platform releases must use stack-v<semver>, got v0.1.0/,
  );
  assert.throws(
    () => resolvePublishVersion({ mode: 'canary', baseVersion: '0.1.0', sha: 'abc' }),
    /canary publishing requires a 40-character commit sha, got abc/,
  );
});

test('the transform patches version, in-set pins, and gitHead', () => {
  const version = `0.1.0-canary.sha.${SHA}`;
  const patched = transformManifestForPublish(sample(), { version, gitHead: SHA, inSetNames });
  assert.equal(patched.version, version);
  assert.equal(patched.gitHead, SHA);
  assert.deepEqual(patched.dependencies, {
    '@jinn-network/evidence-discovery': version,
    '@jinn-network/evidence-protocol': version,
    '@jinn-network/evidence-repository': version,
  });
});

test('the transform strips portal resolutions and preserves the rest', () => {
  const patched = transformManifestForPublish(sample(), { version: '0.1.0', gitHead: SHA, inSetNames });
  assert.deepEqual(patched.resolutions, { vite: '6.4.3' });
});

test('resolutions is deleted when only portal entries existed', () => {
  const manifest = sample();
  delete manifest.resolutions.vite;
  const patched = transformManifestForPublish(manifest, { version: '0.1.0', gitHead: SHA, inSetNames });
  assert.equal('resolutions' in patched, false);
});

test('the transform never mutates its input and leaves out-of-set specifiers alone', () => {
  const original = sample();
  const snapshot = JSON.stringify(original);
  const patched = transformManifestForPublish(original, { version: '9.9.9', gitHead: SHA, inSetNames });
  assert.equal(JSON.stringify(original), snapshot);
  assert.deepEqual(patched.devDependencies, { typescript: '^5.9.3', vitest: '^4.1.8' });
  assert.deepEqual(patched.peerDependencies, { vitest: '^4.1.8' });
});

test('applyPublishManifest writes the patched bytes and restores the original exactly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-publish-manifest-'));
  const path = join(dir, 'package.json');
  const originalBytes = `${JSON.stringify(sample(), null, 2)}\n`;
  writeFileSync(path, originalBytes, 'utf8');
  try {
    const { restore } = applyPublishManifest(path, { version: '0.1.0-canary.sha.' + SHA, gitHead: SHA, inSetNames });
    const written = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(written.version, `0.1.0-canary.sha.${SHA}`);
    assert.equal(written.resolutions['@jinn-network/evidence-protocol'], undefined);
    restore();
    assert.equal(readFileSync(path, 'utf8'), originalBytes);
    restore();
    assert.equal(readFileSync(path, 'utf8'), originalBytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-publish-manifest.test.mjs`
Expected: FAIL — `Cannot find module '.../stack-publish-manifest.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/stack-publish-manifest.mjs`:

```js
import { readFileSync, writeFileSync } from 'node:fs';

import { DEPENDENCY_SECTIONS } from './stack-package-graph.mjs';

const STABLE_SEMVER = /^\d+\.\d+\.\d+$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

export function resolvePublishVersion({ mode, baseVersion, sha, releaseTag }) {
  if (!STABLE_SEMVER.test(String(baseVersion))) {
    throw new Error(`the package set version must be a stable semver, got ${baseVersion ?? '<missing>'}`);
  }
  if (mode === 'canary') {
    if (!COMMIT_SHA.test(String(sha))) {
      throw new Error(`canary publishing requires a 40-character commit sha, got ${sha ?? '<missing>'}`);
    }
    return { version: `${baseVersion}-canary.sha.${sha}`, distTag: 'canary' };
  }
  if (mode === 'stable') {
    const tag = String(releaseTag ?? '');
    if (!tag.startsWith('stack-v') || !STABLE_SEMVER.test(tag.slice('stack-v'.length))) {
      throw new Error(`stable platform releases must use stack-v<semver>, got ${tag || '<missing>'}`);
    }
    const version = tag.slice('stack-v'.length);
    if (version !== baseVersion) {
      throw new Error(`release tag ${tag} resolves to ${version}, but the package set is at ${baseVersion}`);
    }
    return { version, distTag: 'latest' };
  }
  throw new Error(`unknown publish mode ${mode ?? '<missing>'}`);
}

export function transformManifestForPublish(manifest, { version, gitHead, inSetNames }) {
  const patched = structuredClone(manifest);
  patched.version = version;
  patched.gitHead = gitHead;
  for (const section of DEPENDENCY_SECTIONS) {
    const entries = patched[section];
    if (!entries) continue;
    for (const dependency of Object.keys(entries)) {
      if (inSetNames.has(dependency)) entries[dependency] = version;
    }
  }
  if (patched.resolutions) {
    for (const [key, value] of Object.entries(patched.resolutions)) {
      if (typeof value === 'string' && value.startsWith('portal:')) delete patched.resolutions[key];
    }
    if (Object.keys(patched.resolutions).length === 0) delete patched.resolutions;
  }
  return patched;
}

export function applyPublishManifest(manifestPath, options) {
  const originalBytes = readFileSync(manifestPath, 'utf8');
  const patched = transformManifestForPublish(JSON.parse(originalBytes), options);
  writeFileSync(manifestPath, `${JSON.stringify(patched, null, 2)}\n`, 'utf8');
  return {
    restore() {
      writeFileSync(manifestPath, originalBytes, 'utf8');
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-publish-manifest.test.mjs`
Expected: PASS, 7/7.

- [ ] **Step 5: Verify the working tree is untouched**

Run: `git status --porcelain packages/`
Expected: empty output.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/stack-publish-manifest.mjs .github/scripts/stack-publish-manifest.test.mjs
git commit -m "feat(publish): transform platform manifests for publication and restore them exactly"
```

---

### Task 4: The driver's plan mode

**Files:**
- Create: `.github/scripts/publish-stack.mjs`
- Test: `.github/scripts/publish-stack.test.mjs`

**Interfaces:**
- Consumes: `discoverStackPackages`, `buildDependencyGraph`, `topologicalWaves` (Tasks 1-2); `resolvePublishVersion` (Task 3).
- Produces: `parsePublishArgs(argv: string[]): { mode, sha, releaseTag, dryRun, npmCommand, repoRoot }`. `buildPublishPlan({ repoRoot, mode, sha, releaseTag }): { version, distTag, waves: PlanEntry[][] }` where `PlanEntry = { name, directory, manifestPath, spec }` and `spec` is `` `${name}@${version}` ``. CLI: `node .github/scripts/publish-stack.mjs --mode canary --sha <sha> --dry-run` prints the plan and exits 0.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/publish-stack.test.mjs`:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

import { buildPublishPlan, parsePublishArgs } from './publish-stack.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'publish-stack.mjs');
const SHA = 'b'.repeat(40);

test('argument parsing accepts the canary and stable forms', () => {
  assert.deepEqual(parsePublishArgs(['--mode', 'canary', '--sha', SHA, '--dry-run']), {
    mode: 'canary', sha: SHA, releaseTag: undefined, dryRun: true, npmCommand: 'npm', repoRoot: process.cwd(),
  });
  assert.deepEqual(parsePublishArgs(['--mode', 'stable', '--release-tag', 'stack-v0.1.0', '--root', '/tmp/x']), {
    mode: 'stable', sha: undefined, releaseTag: 'stack-v0.1.0', dryRun: false, npmCommand: 'npm', repoRoot: '/tmp/x',
  });
});

test('argument parsing rejects unknown flags and a missing mode', () => {
  assert.throws(() => parsePublishArgs(['--wat', '1']), /unknown argument: --wat/);
  assert.throws(() => parsePublishArgs(['--sha', SHA]), /--mode is required/);
});

test('the plan covers every package exactly once, in wave order', () => {
  const plan = buildPublishPlan({ repoRoot, mode: 'canary', sha: SHA });
  assert.equal(plan.distTag, 'canary');
  assert.match(plan.version, new RegExp(`^0\\.1\\.0-canary\\.sha\\.${SHA}$`));
  const flattened = plan.waves.flat();
  assert.ok(flattened.length >= 45);
  assert.equal(new Set(flattened.map((entry) => entry.name)).size, flattened.length);
  for (const entry of flattened) assert.equal(entry.spec, `${entry.name}@${plan.version}`);
  assert.deepEqual(plan.waves[0].map((entry) => entry.name), [
    '@jinn-network/evidence-protocol',
    '@jinn-network/task-execution-protocol',
    '@jinn-network/trust-core',
  ]);
});

test('the plan refuses a package set whose versions disagree', () => {
  assert.throws(
    () => buildPublishPlan({ repoRoot, mode: 'stable', releaseTag: 'stack-v9.9.9' }),
    /release tag stack-v9.9.9 resolves to 9.9.9, but the package set is at 0.1.0/,
  );
});

test('--dry-run prints the ordered plan and exits 0 without touching the working tree', () => {
  const result = spawnSync(process.execPath, [script, '--mode', 'canary', '--sha', SHA, '--dry-run', '--root', repoRoot], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /wave 0: @jinn-network\/evidence-protocol/);
  assert.match(result.stdout, new RegExp(`publish version 0\\.1\\.0-canary\\.sha\\.${SHA} at canary`));
  const status = spawnSync('git', ['status', '--porcelain', 'packages/'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(status.stdout.trim(), '', 'a dry run must leave the working tree clean');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/publish-stack.test.mjs`
Expected: FAIL — `Cannot find module '.../publish-stack.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/publish-stack.mjs`:

```js
#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  buildDependencyGraph,
  discoverStackPackages,
  topologicalWaves,
} from './stack-package-graph.mjs';
import { resolvePublishVersion } from './stack-publish-manifest.mjs';

const FLAGS_WITH_VALUES = new Set(['--mode', '--sha', '--release-tag', '--npm', '--root']);

export function parsePublishArgs(argv) {
  const parsed = {
    mode: undefined,
    sha: undefined,
    releaseTag: undefined,
    dryRun: false,
    npmCommand: 'npm',
    repoRoot: process.cwd(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (!FLAGS_WITH_VALUES.has(flag)) throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--mode') parsed.mode = value;
    if (flag === '--sha') parsed.sha = value;
    if (flag === '--release-tag') parsed.releaseTag = value;
    if (flag === '--npm') parsed.npmCommand = value;
    if (flag === '--root') parsed.repoRoot = value;
  }
  if (!parsed.mode) throw new Error('--mode is required (canary or stable)');
  return parsed;
}

export function buildPublishPlan({ repoRoot, mode, sha, releaseTag }) {
  const packages = discoverStackPackages(repoRoot);
  const baseVersions = new Set(packages.map((pkg) => pkg.manifest.version));
  if (baseVersions.size !== 1) {
    throw new Error(
      `the platform package set must carry one version; found ${[...baseVersions].sort().join(', ')}`,
    );
  }
  const [baseVersion] = [...baseVersions];
  const { version, distTag } = resolvePublishVersion({ mode, baseVersion, sha, releaseTag });
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const waves = topologicalWaves(buildDependencyGraph(packages)).map((wave) => wave.map((name) => {
    const pkg = byName.get(name);
    return {
      name,
      directory: pkg.directory,
      manifestPath: resolve(repoRoot, pkg.directory, 'package.json'),
      spec: `${name}@${version}`,
    };
  }));
  return { version, distTag, waves, inSetNames: new Set(byName.keys()) };
}

export function renderPlan(plan) {
  const lines = [`publish version ${plan.version} at ${plan.distTag}`];
  plan.waves.forEach((wave, index) => {
    lines.push(`wave ${index}: ${wave.map((entry) => entry.name).join(', ')}`);
  });
  lines.push(`${plan.waves.flat().length} packages in ${plan.waves.length} waves`);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = parsePublishArgs(process.argv.slice(2));
    const plan = buildPublishPlan(args);
    console.log(renderPlan(plan));
    if (!args.dryRun) {
      const { runPublish } = await import('./publish-stack-run.mjs');
      await runPublish(plan, args);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

Note: `publish-stack-run.mjs` does not exist yet — Task 5 creates it, and the dynamic import means `--dry-run` works before it does.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/publish-stack.test.mjs`
Expected: PASS, 5/5.

- [ ] **Step 5: See the real plan**

Run: `node .github/scripts/publish-stack.mjs --mode canary --sha $(git rev-parse HEAD) --dry-run`
Expected: `45 packages in 8 waves`, wave 0 the three sealed protocols.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/publish-stack.mjs .github/scripts/publish-stack.test.mjs
git commit -m "feat(publish): plan the coherent platform publish in topological order"
```

---

### Task 5: Build, pack, and restore per wave

**Files:**
- Create: `.github/scripts/publish-stack-run.mjs`
- Test: `.github/scripts/publish-stack-run.test.mjs`

**Interfaces:**
- Consumes: `buildPublishPlan` output from Task 4; `applyPublishManifest` from Task 3.
- Produces: `packWave(wave, { repoRoot, version, gitHead, inSetNames, tarballsDir, exec }): Promise<Artifact[]>` where `Artifact = { name, spec, directory, tarball, integrity }` and `integrity` is `` `sha512-${base64}` ``. `exec(command, args, cwd): { status, stdout, stderr }` is injected so tests never spawn Yarn or npm. `runPublish(plan, args): Promise<void>` is the entry point Task 4's CLI calls; at this task it builds, packs, restores, and stops before publishing.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/publish-stack-run.test.mjs`:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { packWave } from './publish-stack-run.mjs';

const SHA = 'c'.repeat(40);

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-publish-run-'));
  const packageDir = join(root, 'packages/trust/core');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    `${JSON.stringify({
      name: '@jinn-network/trust-core',
      version: '0.1.0',
      publishConfig: { access: 'public' },
      resolutions: { '@jinn-network/trust-testing': 'portal:../testing' },
    }, null, 2)}\n`,
    'utf8',
  );
  return { root, packageDir };
}

function fakeExec(root, calls, tarballBytes) {
  return (command, args, cwd) => {
    calls.push({ command, args, cwd });
    if (command === 'npm' && args[0] === 'pack') {
      const destination = args[args.indexOf('--pack-destination') + 1];
      const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      const filename = 'jinn-network-trust-core.tgz';
      writeFileSync(join(destination, filename), tarballBytes);
      calls.push({ packedManifest: manifest });
      return { status: 0, stdout: JSON.stringify([{ name: manifest.name, version: manifest.version, filename }]), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('packWave builds unmutated, packs mutated, and restores the manifest', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  const original = readFileSync(join(packageDir, 'package.json'), 'utf8');
  const bytes = Buffer.from('tarball-bytes');
  const calls = [];
  try {
    const artifacts = await packWave(
      [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: `@jinn-network/trust-core@0.1.0-canary.sha.${SHA}` }],
      {
        repoRoot: root,
        version: `0.1.0-canary.sha.${SHA}`,
        gitHead: SHA,
        inSetNames: new Set(['@jinn-network/trust-core']),
        tarballsDir,
        exec: fakeExec(root, calls, bytes),
      },
    );
    const commands = calls.filter((call) => call.command).map((call) => `${call.command} ${call.args.join(' ')}`);
    assert.deepEqual(commands, [
      'yarn install --immutable',
      'yarn build',
      `npm pack --json --ignore-scripts --pack-destination ${tarballsDir}`,
    ]);
    const packed = calls.find((call) => call.packedManifest).packedManifest;
    assert.equal(packed.version, `0.1.0-canary.sha.${SHA}`);
    assert.equal(packed.gitHead, SHA);
    assert.equal('resolutions' in packed, false);
    assert.equal(readFileSync(join(packageDir, 'package.json'), 'utf8'), original);
    assert.equal(artifacts[0].integrity, `sha512-${createHash('sha512').update(bytes).digest('base64')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});

test('packWave restores the manifest even when the build fails', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  const original = readFileSync(join(packageDir, 'package.json'), 'utf8');
  try {
    await assert.rejects(
      packWave(
        [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: 'x' }],
        {
          repoRoot: root,
          version: '0.1.0',
          gitHead: SHA,
          inSetNames: new Set(['@jinn-network/trust-core']),
          tarballsDir,
          exec: (command, args) => (args[0] === 'build'
            ? { status: 2, stdout: '', stderr: 'tsc exploded' }
            : { status: 0, stdout: '', stderr: '' }),
        },
      ),
      /packages\/trust\/core: yarn build failed: tsc exploded/,
    );
    assert.equal(readFileSync(join(packageDir, 'package.json'), 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});

test('packWave rejects a tarball whose packed identity disagrees with the plan', async () => {
  const { root, packageDir } = scratch();
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-publish-tarballs-'));
  try {
    await assert.rejects(
      packWave(
        [{ name: '@jinn-network/trust-core', directory: 'packages/trust/core', manifestPath: join(packageDir, 'package.json'), spec: 'x' }],
        {
          repoRoot: root,
          version: '0.1.0',
          gitHead: SHA,
          inSetNames: new Set(['@jinn-network/trust-core']),
          tarballsDir,
          exec: (command, args, cwd) => (command === 'npm'
            ? { status: 0, stdout: JSON.stringify([{ name: '@jinn-network/impostor', version: '0.1.0', filename: 'x.tgz' }]), stderr: '' }
            : { status: 0, stdout: '', stderr: '' }),
        },
      ),
      /npm pack produced @jinn-network\/impostor@0\.1\.0, expected @jinn-network\/trust-core@0\.1\.0/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tarballsDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/publish-stack-run.test.mjs`
Expected: FAIL — `Cannot find module '.../publish-stack-run.mjs'`.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/publish-stack-run.mjs`:

```js
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { applyPublishManifest } from './stack-publish-manifest.mjs';

export function defaultExec(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: publishEnv() });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

export function publishEnv() {
  const env = { ...process.env };
  delete env.NODE_AUTH_TOKEN;
  return env;
}

function requireSuccess(result, directory, label) {
  if (result.status !== 0) {
    throw new Error(`${directory}: ${label} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
  return result;
}

export async function packWave(wave, options) {
  const { repoRoot, version, gitHead, inSetNames, tarballsDir, exec = defaultExec } = options;
  const artifacts = [];
  for (const entry of wave) {
    const packageRoot = resolve(repoRoot, entry.directory);
    requireSuccess(exec('yarn', ['install', '--immutable'], packageRoot), entry.directory, 'yarn install --immutable');
    requireSuccess(exec('yarn', ['build'], packageRoot), entry.directory, 'yarn build');
    const { restore } = applyPublishManifest(entry.manifestPath, { version, gitHead, inSetNames });
    let packed;
    try {
      const result = requireSuccess(
        exec('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', tarballsDir], packageRoot),
        entry.directory,
        'npm pack',
      );
      const entries = JSON.parse(result.stdout);
      if (!Array.isArray(entries) || entries.length !== 1) {
        throw new Error(`${entry.directory}: npm pack returned ${Array.isArray(entries) ? entries.length : 'non-array'} entries`);
      }
      [packed] = entries;
    } finally {
      restore();
    }
    if (packed?.name !== entry.name || packed.version !== version || typeof packed.filename !== 'string') {
      throw new Error(
        `npm pack produced ${packed?.name ?? '<missing>'}@${packed?.version ?? '<missing>'}, expected ${entry.name}@${version}`,
      );
    }
    const tarball = join(tarballsDir, basename(packed.filename));
    const bytes = readFileSync(tarball);
    artifacts.push({
      name: entry.name,
      spec: `${entry.name}@${version}`,
      directory: entry.directory,
      tarball,
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    });
  }
  return artifacts;
}

export async function runPublish(plan, args) {
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-stack-publish-'));
  try {
    for (const [index, wave] of plan.waves.entries()) {
      const artifacts = await packWave(wave, {
        repoRoot: args.repoRoot,
        version: plan.version,
        gitHead: args.sha ?? plan.version,
        inSetNames: plan.inSetNames,
        tarballsDir,
      });
      console.log(`wave ${index}: packed ${artifacts.length} packages`);
    }
  } finally {
    rmSync(tarballsDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/publish-stack-run.test.mjs`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/publish-stack-run.mjs .github/scripts/publish-stack-run.test.mjs
git commit -m "feat(publish): build and pack the platform set with byte-exact manifest restore"
```

---

### Task 6: Idempotent publish and integrity verification

**Files:**
- Modify: `.github/scripts/publish-stack-run.mjs`
- Modify: `.github/scripts/publish-stack-run.test.mjs`

**Interfaces:**
- Consumes: `Artifact[]` from `packWave` (Task 5).
- Produces: `registryIntegrity(spec, { exec, npmCommand, repoRoot, attempts, delayMs }): string | null` — `null` on E404. `publishWave(artifacts, { distTag, exec, npmCommand, repoRoot }): Promise<void>` — preflights every artifact's integrity, publishes only the missing ones, then reverifies the whole wave. `runPublish` now calls `publishWave` after each `packWave`.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/publish-stack-run.test.mjs` (extend the import to include `publishWave`):

```js
function registryExec(state) {
  return (command, args) => {
    if (args[0] === 'view') {
      const [, spec, field] = args;
      const record = state.get(spec);
      if (!record) return { status: 1, stdout: '', stderr: 'npm error code E404\nnpm error 404 Not Found' };
      if (field === 'dist.integrity') return { status: 0, stdout: JSON.stringify(record.integrity), stderr: '' };
      return { status: 0, stdout: JSON.stringify(record.distTag), stderr: '' };
    }
    if (args[0] === 'publish') {
      const spec = args.__spec;
      state.set(spec, { integrity: args.__integrity, distTag: args[args.indexOf('--tag') + 1] });
      return { status: 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
}

test('publishWave skips an artifact already published with matching integrity', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  const published = [];
  await publishWave(artifacts, {
    distTag: 'canary',
    repoRoot: '/tmp',
    exec: (command, args) => {
      if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
      if (args[0] === 'view') return { status: 0, stdout: '"canary"', stderr: '' };
      published.push(args);
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(published, []);
});

test('publishWave publishes a missing artifact and reverifies it', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  let exists = false;
  const published = [];
  await publishWave(artifacts, {
    distTag: 'canary',
    repoRoot: '/tmp',
    exec: (command, args) => {
      if (args[0] === 'view' && !exists) return { status: 1, stdout: '', stderr: 'npm error code E404' };
      if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
      if (args[0] === 'view') return { status: 0, stdout: '"canary"', stderr: '' };
      published.push(args);
      exists = true;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(published, [['publish', '/tmp/a.tgz', '--access', 'public', '--provenance', '--tag', 'canary']]);
});

test('publishWave aborts the whole wave when a preflight integrity disagrees', async () => {
  const artifacts = [
    { name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' },
    { name: '@jinn-network/trust-resolve', spec: '@jinn-network/trust-resolve@0.1.0', tarball: '/tmp/b.tgz', integrity: 'sha512-BBB' },
  ];
  const published = [];
  await assert.rejects(
    publishWave(artifacts, {
      distTag: 'canary',
      repoRoot: '/tmp',
      exec: (command, args) => {
        if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-DIFFERENT"', stderr: '' };
        if (args[0] === 'view') return { status: 0, stdout: '"canary"', stderr: '' };
        published.push(args);
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /preflight integrity mismatch for @jinn-network\/trust-core@0\.1\.0: local sha512-AAA, registry sha512-DIFFERENT/,
  );
  assert.deepEqual(published, [], 'a preflight mismatch must abort before the first publish');
});

test('publishWave rejects a dist-tag that did not move to this version', async () => {
  const artifacts = [{ name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', tarball: '/tmp/a.tgz', integrity: 'sha512-AAA' }];
  await assert.rejects(
    publishWave(artifacts, {
      distTag: 'latest',
      repoRoot: '/tmp',
      exec: (command, args) => {
        if (args[0] === 'view' && args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
        if (args[0] === 'view') return { status: 0, stdout: '"0.0.9"', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /preflight latest mismatch for @jinn-network\/trust-core: expected 0\.1\.0, got 0\.0\.9/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/publish-stack-run.test.mjs`
Expected: FAIL — `publishWave is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `.github/scripts/publish-stack-run.mjs`:

```js
const RETRY_ATTEMPTS = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_ATTEMPTS ?? '12', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.JINN_NPM_REGISTRY_RETRY_DELAY_MS ?? '5000', 10);

function sleepSync(ms) {
  if (ms <= 0) return;
  spawnSync('sleep', [String(Math.max(1, Math.ceil(ms / 1000)))], { stdio: 'ignore' });
}

function viewJson(args, { exec, npmCommand = 'npm', repoRoot, attempts = 1, delayMs = 0 }, label) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = exec(npmCommand, args, repoRoot);
    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(`registry returned invalid JSON for ${label}: ${error?.message ?? String(error)}`);
      }
    }
    const output = `${result.stdout}\n${result.stderr}`;
    if (!/\bE404\b|404 Not Found/u.test(output)) {
      throw new Error(`npm ${args.join(' ')} failed: ${output.trim()}`);
    }
    if (attempt < attempts - 1) sleepSync(delayMs);
  }
  return null;
}

export function registryIntegrity(spec, context) {
  return viewJson(['view', spec, 'dist.integrity', '--json'], context, spec);
}

export function registryDistTag(name, distTag, context) {
  return viewJson(['view', name, `dist-tags.${distTag}`, '--json'], context, name);
}

function assertIntegrity(artifact, actual, phase) {
  if (actual !== artifact.integrity) {
    throw new Error(`${phase} integrity mismatch for ${artifact.spec}: local ${artifact.integrity}, registry ${actual ?? '<missing>'}`);
  }
}

function assertDistTag(artifact, actual, expectedVersion, distTag, phase) {
  if (actual !== expectedVersion) {
    throw new Error(
      `${phase} ${distTag} mismatch for ${artifact.name}: expected ${expectedVersion}, got ${actual ?? '<missing>'}; `
      + 'OIDC cannot repair an immutable version via npm dist-tag, refusing further publication',
    );
  }
}

export async function publishWave(artifacts, options) {
  const { distTag, exec = defaultExec, npmCommand = 'npm', repoRoot } = options;
  const context = { exec, npmCommand, repoRoot };
  const version = artifacts[0]?.spec.slice(artifacts[0].spec.lastIndexOf('@') + 1);
  const missing = [];
  for (const artifact of artifacts) {
    const actual = registryIntegrity(artifact.spec, context);
    if (actual === null) {
      missing.push(artifact);
      continue;
    }
    assertIntegrity(artifact, actual, 'preflight');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, context), version, distTag, 'preflight');
    console.log(`already published with matching integrity: ${artifact.spec}`);
  }
  for (const artifact of missing) {
    const result = exec(npmCommand, ['publish', artifact.tarball, '--access', 'public', '--provenance', '--tag', distTag], repoRoot);
    if (result.status !== 0) {
      throw new Error(`npm publish ${artifact.spec} failed: ${(result.stderr || result.stdout).trim()}`);
    }
    const retrying = { ...context, attempts: RETRY_ATTEMPTS, delayMs: RETRY_DELAY_MS };
    assertIntegrity(artifact, registryIntegrity(artifact.spec, retrying), 'post-publish');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, retrying), version, distTag, 'post-publish');
    console.log(`published ${artifact.spec} at ${distTag}`);
  }
}
```

Then replace the body of `runPublish`'s loop so it publishes each wave before starting the next:

```js
      console.log(`wave ${index}: packed ${artifacts.length} packages`);
      await publishWave(artifacts, { distTag: plan.distTag, npmCommand: args.npmCommand, repoRoot: args.repoRoot });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test .github/scripts/publish-stack-run.test.mjs .github/scripts/publish-stack.test.mjs`
Expected: PASS, 10/10.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/publish-stack-run.mjs .github/scripts/publish-stack-run.test.mjs
git commit -m "feat(publish): publish each wave idempotently and verify by tarball integrity"
```

---

### Task 7: Whole-set coherence gate

**Files:**
- Modify: `.github/scripts/publish-stack-run.mjs`
- Modify: `.github/scripts/publish-stack-run.test.mjs`

**Interfaces:**
- Produces: `verifyCoherentSet(artifacts, { distTag, version, exec, npmCommand, repoRoot }): void` — after every wave has published, reverify all 45 specs' integrity and dist-tag together; throws on the first disagreement, naming the partially-published graph. `runPublish` accumulates artifacts across waves and calls it once at the end.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/publish-stack-run.test.mjs` (extend the import to include `verifyCoherentSet`):

```js
test('verifyCoherentSet passes when every package resolves at the published version', () => {
  const artifacts = [
    { name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', integrity: 'sha512-AAA' },
    { name: '@jinn-network/trust-resolve', spec: '@jinn-network/trust-resolve@0.1.0', integrity: 'sha512-BBB' },
  ];
  const integrities = { '@jinn-network/trust-core@0.1.0': 'sha512-AAA', '@jinn-network/trust-resolve@0.1.0': 'sha512-BBB' };
  verifyCoherentSet(artifacts, {
    distTag: 'latest',
    version: '0.1.0',
    repoRoot: '/tmp',
    exec: (command, args) => (args[2] === 'dist.integrity'
      ? { status: 0, stdout: JSON.stringify(integrities[args[1]]), stderr: '' }
      : { status: 0, stdout: '"0.1.0"', stderr: '' }),
  });
});

test('verifyCoherentSet names the partially-published graph', () => {
  const artifacts = [
    { name: '@jinn-network/trust-core', spec: '@jinn-network/trust-core@0.1.0', integrity: 'sha512-AAA' },
    { name: '@jinn-network/trust-resolve', spec: '@jinn-network/trust-resolve@0.1.0', integrity: 'sha512-BBB' },
  ];
  assert.throws(
    () => verifyCoherentSet(artifacts, {
      distTag: 'latest',
      version: '0.1.0',
      repoRoot: '/tmp',
      exec: (command, args) => {
        if (args[1] === '@jinn-network/trust-resolve@0.1.0') return { status: 1, stdout: '', stderr: 'npm error code E404' };
        if (args[2] === 'dist.integrity') return { status: 0, stdout: '"sha512-AAA"', stderr: '' };
        return { status: 0, stdout: '"0.1.0"', stderr: '' };
      },
    }),
    /partially-published platform set at 0\.1\.0: @jinn-network\/trust-resolve is missing from the registry/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/publish-stack-run.test.mjs`
Expected: FAIL — `verifyCoherentSet is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `.github/scripts/publish-stack-run.mjs`:

```js
export function verifyCoherentSet(artifacts, options) {
  const { distTag, version, exec = defaultExec, npmCommand = 'npm', repoRoot } = options;
  const context = { exec, npmCommand, repoRoot };
  for (const artifact of artifacts) {
    const actual = registryIntegrity(artifact.spec, context);
    if (actual === null) {
      throw new Error(`partially-published platform set at ${version}: ${artifact.name} is missing from the registry`);
    }
    assertIntegrity(artifact, actual, 'final');
    assertDistTag(artifact, registryDistTag(artifact.name, distTag, context), version, distTag, 'final');
  }
  console.log(`verified coherent platform set ${version} at ${distTag} across ${artifacts.length} packages`);
}
```

Then change `runPublish` to accumulate and finish:

```js
export async function runPublish(plan, args) {
  const tarballsDir = mkdtempSync(join(tmpdir(), 'jinn-stack-publish-'));
  const allArtifacts = [];
  try {
    for (const [index, wave] of plan.waves.entries()) {
      const artifacts = await packWave(wave, {
        repoRoot: args.repoRoot,
        version: plan.version,
        gitHead: args.sha ?? plan.version,
        inSetNames: plan.inSetNames,
        tarballsDir,
      });
      console.log(`wave ${index}: packed ${artifacts.length} packages`);
      await publishWave(artifacts, { distTag: plan.distTag, npmCommand: args.npmCommand, repoRoot: args.repoRoot });
      allArtifacts.push(...artifacts);
    }
    verifyCoherentSet(allArtifacts, {
      distTag: plan.distTag,
      version: plan.version,
      npmCommand: args.npmCommand,
      repoRoot: args.repoRoot,
    });
  } finally {
    rmSync(tarballsDir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test .github/scripts/publish-stack-run.test.mjs`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add .github/scripts/publish-stack-run.mjs .github/scripts/publish-stack-run.test.mjs
git commit -m "feat(publish): fail the release on a partially-published platform graph"
```

---

### Task 8: The canary lane workflow

**Files:**
- Create: `.github/workflows/stack-npm-publish.yml`
- Test: `.github/scripts/stack-publish-workflow.test.mjs`

**Interfaces:**
- Consumes: `node .github/scripts/publish-stack.mjs --mode canary --sha <sha>` (Tasks 4-7).
- Produces: a workflow whose job id is `publish`, whose trigger branches are `integration/evidence-v1` and `next`, and whose npm trusted-publisher identity is the filename `stack-npm-publish.yml`.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-publish-workflow.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const workflowPath = resolve(import.meta.dirname, '../workflows/stack-npm-publish.yml');
const workflow = readFileSync(workflowPath, 'utf8');

test('the canary lane triggers on both the integration branch and next', () => {
  assert.match(workflow, /branches:\s*\[integration\/evidence-v1, next\]/);
});

test('the workflow carries the OIDC permissions trusted publishing needs', () => {
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /checks: read/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN/);
});

test('the existence guard runs before any publish step', () => {
  const guardAt = workflow.indexOf('name: Guard on an empty platform package set');
  const publishAt = workflow.indexOf('name: Publish the platform package set');
  assert.ok(guardAt > -1, 'the existence guard step must exist');
  assert.ok(publishAt > -1, 'the publish step must exist');
  assert.ok(guardAt < publishAt, 'the existence guard must precede the publish step');
});

test('the tree CI gate names all six platform CI workflows', () => {
  for (const name of ['Evidence CI', 'Trust CI', 'Task Execution CI', 'Record Discovery CI', 'Marketplace CI', 'Benchmarking CI']) {
    assert.ok(workflow.includes(name), `the tree CI gate must name "${name}"`);
  }
});

test('the workflow drives the derived publisher, never a hard-coded package list', () => {
  assert.match(workflow, /node \.github\/scripts\/publish-stack\.mjs --mode canary --sha "\$\{JINN_BUILD_COMMIT\}"/);
  assert.doesNotMatch(workflow, /@jinn-network\/(evidence|trust|task-execution|marketplace|benchmarking|record-discovery)-/);
});

test('the workflow pins the npm CLI version trusted publishing requires', () => {
  assert.match(workflow, /npm install -g npm@11\.16\.0/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: FAIL — `ENOENT: no such file or directory, open '.../stack-npm-publish.yml'`.

- [ ] **Step 3: Write the workflow**

Create `.github/workflows/stack-npm-publish.yml`:

```yaml
name: Stack npm Publish

# The 45 platform packages publish as one coherent set in dependency-graph order.
# Branch-aware by design (#2293, plan decision D1): the packages live on
# integration/evidence-v1 today and land on next when integration merges. Both
# branches trigger; the existence guard makes the trigger a no-op wherever the
# package set is absent.
#
# Trusted publishing (OIDC): register this single workflow filename on npmjs for
# every package the registration artifact lists. Leave the optional npmjs
# Environment field blank. See docs/runbooks/stack-npm-publishing.md.
on:
  push:
    branches: [integration/evidence-v1, next]
  release:
    types: [published]
  workflow_dispatch:
    inputs:
      release_tag:
        description: 'Published stack release tag to recover, for example stack-v0.1.0'
        required: true
        type: string

permissions:
  contents: read
  id-token: write
  checks: read

concurrency:
  group: stack-npm-publish-${{ github.ref }}
  cancel-in-progress: false

jobs:
  publish:
    name: Publish the platform package set
    if: github.event_name != 'release' || startsWith(github.event.release.tag_name, 'stack-v')
    runs-on: ubuntu-latest
    timeout-minutes: 120
    environment: npm-publish
    env:
      JINN_BUILD_COMMIT: ${{ github.sha }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.sha }}

      - name: Verify exact publish commit
        shell: bash
        run: |
          set -euo pipefail
          ACTUAL_SHA="$(git rev-parse HEAD)"
          if [ "${ACTUAL_SHA}" != "${JINN_BUILD_COMMIT}" ]; then
            echo "::error::Checked out ${ACTUAL_SHA}, expected publish commit ${JINN_BUILD_COMMIT}"
            exit 1
          fi

      - uses: actions/setup-node@v7
        with:
          node-version: '22'

      - run: npm install -g npm@11.16.0
      - run: corepack enable

      - name: Guard on an empty platform package set
        id: guard
        shell: bash
        run: |
          set -euo pipefail
          if node .github/scripts/publish-stack.mjs --mode canary --sha "${JINN_BUILD_COMMIT}" --dry-run; then
            echo "present=true" >> "${GITHUB_OUTPUT}"
          else
            echo "::notice::No platform package set on this ref; nothing to publish."
            echo "present=false" >> "${GITHUB_OUTPUT}"
          fi

      - name: Verify the six platform tree CI workflows
        if: steps.guard.outputs.present == 'true'
        uses: actions/github-script@v7
        env:
          PUBLISH_SHA: ${{ env.JINN_BUILD_COMMIT }}
        with:
          script: |
            const required = [
              'Evidence CI',
              'Trust CI',
              'Task Execution CI',
              'Record Discovery CI',
              'Marketplace CI',
              'Benchmarking CI',
            ];
            const { data } = await github.rest.checks.listForRef({
              owner: context.repo.owner,
              repo: context.repo.repo,
              ref: process.env.PUBLISH_SHA,
              per_page: 100,
            });
            const failed = [];
            for (const name of required) {
              const runs = data.check_runs.filter((run) => run.name.startsWith(name));
              for (const run of runs) {
                if (run.status === 'completed' && run.conclusion !== 'success' && run.conclusion !== 'skipped' && run.conclusion !== 'neutral') {
                  failed.push(`${run.name}: ${run.conclusion}`);
                }
              }
            }
            if (failed.length > 0) {
              core.setFailed(`Platform tree CI concluded failure at ${process.env.PUBLISH_SHA}: ${failed.join('; ')}`);
            } else {
              core.notice(`No platform tree CI failure at ${process.env.PUBLISH_SHA}`);
            }

      - name: Publish the platform package set
        if: steps.guard.outputs.present == 'true' && github.event_name == 'push'
        shell: bash
        run: |
          set -euo pipefail
          unset NODE_AUTH_TOKEN
          node .github/scripts/publish-stack.mjs --mode canary --sha "${JINN_BUILD_COMMIT}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 6/6.

- [ ] **Step 5: Validate the YAML parses**

Run: `node -e "const {readFileSync}=require('fs');const s=readFileSync('.github/workflows/stack-npm-publish.yml','utf8');if(!s.includes('jobs:'))throw new Error('no jobs');console.log('ok')"` and `gh workflow list --repo Jinn-Network/mono >/dev/null 2>&1 || true`
Expected: `ok`. (Actions validates on push; a local YAML parse is the cheap pre-check.)

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/stack-npm-publish.yml .github/scripts/stack-publish-workflow.test.mjs
git commit -m "feat(publish): add the branch-aware platform canary lane"
```

---

### Task 9: The stable lane

**Files:**
- Modify: `.github/workflows/stack-npm-publish.yml`
- Modify: `.github/scripts/stack-publish-workflow.test.mjs`

**Interfaces:**
- Consumes: `node .github/scripts/publish-stack.mjs --mode stable --release-tag <tag>` (Tasks 4-7).
- Produces: a `Publish the stable platform set` step gated on `github.event_name == 'release'` or `workflow_dispatch`, running in the `npm-stable-publish` environment.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/stack-publish-workflow.test.mjs`:

```js
test('the stable lane runs from the protected stable environment', () => {
  assert.match(workflow, /name: stack-stable\n/);
  assert.match(workflow, /environment: npm-stable-publish/);
});

test('the stable lane derives its version from a stack-v tag', () => {
  assert.match(workflow, /node \.github\/scripts\/publish-stack\.mjs --mode stable --release-tag "\$\{RELEASE_TAG\}"/);
  assert.match(workflow, /startsWith\(github\.event\.release\.tag_name, 'stack-v'\)/);
});

test('the stable lane refuses a release tag that is not on origin at the checked-out sha', () => {
  assert.match(workflow, /Release tag \$\{RELEASE_TAG\} points at/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: FAIL — three assertions fail on missing stable-lane text.

- [ ] **Step 3: Add the stable job**

Append this job to `.github/workflows/stack-npm-publish.yml` (sibling of `publish`):

```yaml
  stack-stable:
    name: stack-stable
    if: (github.event_name == 'release' && startsWith(github.event.release.tag_name, 'stack-v')) || github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    timeout-minutes: 120
    environment: npm-stable-publish
    env:
      RELEASE_TAG: ${{ github.event_name == 'workflow_dispatch' && inputs.release_tag || github.event.release.tag_name }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ env.RELEASE_TAG }}
          fetch-depth: 0

      - name: Verify the release tag resolves on origin to this checkout
        shell: bash
        run: |
          set -euo pipefail
          TAG_SHA="$(git ls-remote origin "refs/tags/${RELEASE_TAG}" | awk '{print $1}' | head -n1)"
          if [ -z "${TAG_SHA}" ]; then
            echo "::error::Release tag ${RELEASE_TAG} does not exist on origin"
            exit 1
          fi
          PEELED="$(git rev-parse "${RELEASE_TAG}^{commit}")"
          RESOLVED="$(git rev-parse "${TAG_SHA}^{commit}")"
          if [ "${PEELED}" != "${RESOLVED}" ]; then
            echo "::error::Release tag ${RELEASE_TAG} points at ${RESOLVED}, not the checked-out ${PEELED}"
            exit 1
          fi
          echo "JINN_BUILD_COMMIT=${PEELED}" >> "${GITHUB_ENV}"

      - uses: actions/setup-node@v7
        with:
          node-version: '22'

      - run: npm install -g npm@11.16.0
      - run: corepack enable

      - name: Publish the stable platform set
        shell: bash
        run: |
          set -euo pipefail
          unset NODE_AUTH_TOKEN
          node .github/scripts/publish-stack.mjs --mode stable --release-tag "${RELEASE_TAG}"
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/stack-npm-publish.yml .github/scripts/stack-publish-workflow.test.mjs
git commit -m "feat(publish): add the coherent stable lane on stack-v release tags"
```

---

### Task 10: The trusted-publisher registration artifact and runbook

**Files:**
- Create: `.github/scripts/stack-trusted-publishers.mjs`
- Test: `.github/scripts/stack-trusted-publishers.test.mjs`
- Create: `docs/runbooks/stack-npm-publishing.md`
- Modify: `.github/workflows/stack-npm-publish.yml`

**Interfaces:**
- Consumes: `discoverStackPackages` (Task 1).
- Produces: `buildRegistrationList(repoRoot): Registration[]` where `Registration = { package: string, provider: 'GitHub Actions', organization: 'Jinn-Network', repository: 'mono', workflow: 'stack-npm-publish.yml', environment: '' }`. `renderRegistrationMarkdown(registrations): string`. CLI: `node .github/scripts/stack-trusted-publishers.mjs --out <dir>` writes `trusted-publishers.json` and `trusted-publishers.md`.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-trusted-publishers.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildRegistrationList, renderRegistrationMarkdown } from './stack-trusted-publishers.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const script = resolve(import.meta.dirname, 'stack-trusted-publishers.mjs');

test('every platform package gets one registration bound to this repo and workflow', () => {
  const registrations = buildRegistrationList(repoRoot);
  assert.ok(registrations.length >= 45);
  assert.equal(new Set(registrations.map((r) => r.package)).size, registrations.length);
  for (const registration of registrations) {
    assert.equal(registration.provider, 'GitHub Actions');
    assert.equal(registration.organization, 'Jinn-Network');
    assert.equal(registration.repository, 'mono');
    assert.equal(registration.workflow, 'stack-npm-publish.yml');
    assert.equal(registration.environment, '', 'the optional npmjs Environment field must be blank');
    assert.ok(registration.package.startsWith('@jinn-network/'));
  }
});

test('the markdown rendering states the blank-environment rule and one row per package', () => {
  const markdown = renderRegistrationMarkdown(buildRegistrationList(repoRoot));
  assert.match(markdown, /Environment field MUST be blank/);
  assert.match(markdown, /\| `@jinn-network\/evidence-protocol` \| `stack-npm-publish\.yml` \|/);
  assert.doesNotMatch(markdown, /[\u{1F300}-\u{1FAFF}]/u, 'no emoji in produced artifacts');
});

test('the CLI writes both artifact files', () => {
  const out = mkdtempSync(join(tmpdir(), 'jinn-registrations-'));
  try {
    const result = spawnSync(process.execPath, [script, '--out', out, '--root', repoRoot], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(readFileSync(join(out, 'trusted-publishers.json'), 'utf8'));
    assert.ok(json.length >= 45);
    assert.match(readFileSync(join(out, 'trusted-publishers.md'), 'utf8'), /Environment field MUST be blank/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-trusted-publishers.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/stack-trusted-publishers.mjs`:

```js
#!/usr/bin/env node

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const PUBLISHER_WORKFLOW = 'stack-npm-publish.yml';

export function buildRegistrationList(repoRoot) {
  return discoverStackPackages(repoRoot).map((pkg) => ({
    package: pkg.name,
    provider: 'GitHub Actions',
    organization: 'Jinn-Network',
    repository: 'mono',
    workflow: PUBLISHER_WORKFLOW,
    environment: '',
  })).sort((left, right) => (left.package < right.package ? -1 : left.package > right.package ? 1 : 0));
}

export function renderRegistrationMarkdown(registrations) {
  const rows = registrations.map((r) => `| \`${r.package}\` | \`${r.workflow}\` |`).join('\n');
  return [
    '# npm trusted-publisher registrations for the platform package set',
    '',
    `Generated from the repository. ${registrations.length} packages, one registration each.`,
    '',
    'For every row, in the npmjs package settings, add a trusted publisher with:',
    '',
    '| npmjs field | Value |',
    '| --- | --- |',
    '| Provider | GitHub Actions |',
    '| Organization or user | `Jinn-Network` |',
    '| Repository | `mono` |',
    `| Workflow filename | \`${PUBLISHER_WORKFLOW}\` |`,
    '| Allowed action | `npm publish` |',
    '| Optional Environment | **Leave blank** |',
    '',
    'The optional npmjs **Environment field MUST be blank**. npm permits one trusted',
    'publisher configuration per package, and this one workflow publishes from two',
    'GitHub environments: canaries from `npm-publish`, stable from `npm-stable-publish`.',
    'Naming either environment in npmjs breaks the other lane.',
    '',
    '| Package | Workflow filename |',
    '| --- | --- |',
    rows,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const out = args[args.indexOf('--out') + 1];
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    if (!args.includes('--out') || !out) throw new Error('--out <directory> is required');
    mkdirSync(out, { recursive: true });
    const registrations = buildRegistrationList(root);
    writeFileSync(join(out, 'trusted-publishers.json'), `${JSON.stringify(registrations, null, 2)}\n`, 'utf8');
    writeFileSync(join(out, 'trusted-publishers.md'), renderRegistrationMarkdown(registrations), 'utf8');
    console.log(`wrote ${registrations.length} trusted-publisher registrations to ${out}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Add the artifact job to the workflow**

Append this job to `.github/workflows/stack-npm-publish.yml`:

```yaml
  registrations:
    name: Trusted-publisher registration list
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Generate the registration list
        run: node .github/scripts/stack-trusted-publishers.mjs --out "${RUNNER_TEMP}/registrations"
      - uses: actions/upload-artifact@v4
        with:
          name: stack-trusted-publishers
          path: ${{ runner.temp }}/registrations
          if-no-files-found: error
```

- [ ] **Step 5: Create the runbook**

Create `docs/runbooks/stack-npm-publishing.md`:

```markdown
# Platform stack npm publishing runbook

**Scope:** the 45 platform packages under `packages/{task-execution,evidence,trust,discovery,marketplace,benchmarking}`. Issue #2293. Workflow: `.github/workflows/stack-npm-publish.yml`. Driver: `.github/scripts/publish-stack.mjs`.

## What publishes, and when

| Trigger | Version | Dist-tag | Environment |
| --- | --- | --- | --- |
| Push to `integration/evidence-v1` or `next` | `<setVersion>-canary.sha.<commit>` | `canary` | `npm-publish` |
| Release published with a `stack-v<semver>` tag | `<semver>` | `latest` | `npm-stable-publish` |

The whole set publishes every time, in dependency-graph order (8 waves). Nothing is
partially released: a wave verifies before the next starts, and a final pass reverifies
every package's tarball integrity and dist-tag together.

## Branch awareness

The 45 packages live on `integration/evidence-v1` and are not yet on `next`. The workflow
triggers on both branches and no-ops where the package set is absent, so it starts
publishing today and continues from `next` after the integration merge with no edit.

## Inspecting the plan without publishing

```bash
node .github/scripts/publish-stack.mjs --mode canary --sha "$(git rev-parse HEAD)" --dry-run
```

## npmjs trusted-publisher configuration

The registration list is generated, never hand-maintained. Download the
`stack-trusted-publishers` artifact from any run of the workflow, or generate it locally:

```bash
node .github/scripts/stack-trusted-publishers.mjs --out /tmp/registrations
```

`trusted-publishers.md` in that directory is the operator-facing checklist. It states the
exact npmjs field values and why the optional Environment field must be blank.

## Recovery

A failed publish is safe to re-run: every step is idempotent on exact tarball integrity, and
an already-published version with matching integrity is skipped. A version published with
*different* bytes is unrecoverable through this workflow by design — npm versions are
immutable and OIDC cannot repair a dist-tag. Cut a new version instead.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-trusted-publishers.test.mjs .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 12/12.

- [ ] **Step 7: Commit**

```bash
git add .github/scripts/stack-trusted-publishers.mjs .github/scripts/stack-trusted-publishers.test.mjs .github/workflows/stack-npm-publish.yml docs/runbooks/stack-npm-publishing.md
git commit -m "feat(publish): generate the per-package trusted-publisher registration list"
```

---

### Task 11: External-consumer acceptance from a clean directory

**Files:**
- Create: `.github/scripts/stack-external-acceptance.mjs`
- Test: `.github/scripts/stack-external-acceptance.test.mjs`

**Interfaces:**
- Consumes: published packages at an exact version.
- Produces: `parseAcceptanceArgs(argv): { version, registry, keep }` — `version` must be an exact version, never a range or dist-tag. `renderAcceptanceSpec(version): string` — the vitest spec source written into the external directory. CLI: `node .github/scripts/stack-external-acceptance.mjs --version <exact>` creates a temporary directory under `os.tmpdir()` (never inside the repository), installs the kits from the registry, and runs them.

The kit chosen is the one the platform architecture §5 names as the existing tier-3 form: `describeTaskExecutionBackendContract` from `@jinn-network/task-execution-testing`, driven against `createInMemoryBackend` from the same published package. The spec also resolves a published JSON Schema file through its `exports` subpath, which is the mechanical proof of the "retrievable without cloning" acceptance criterion.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-external-acceptance.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseAcceptanceArgs, renderAcceptanceSpec } from './stack-external-acceptance.mjs';

const VERSION = `0.1.0-canary.sha.${'d'.repeat(40)}`;

test('an exact version is required', () => {
  assert.deepEqual(parseAcceptanceArgs(['--version', VERSION]), {
    version: VERSION, registry: 'https://registry.npmjs.org', keep: false,
  });
  assert.throws(() => parseAcceptanceArgs(['--version', '^0.1.0']), /--version must be an exact version, got \^0\.1\.0/);
  assert.throws(() => parseAcceptanceArgs(['--version', 'canary']), /--version must be an exact version, got canary/);
  assert.throws(() => parseAcceptanceArgs([]), /--version is required/);
  assert.throws(() => parseAcceptanceArgs(['--nope', '1']), /unknown argument: --nope/);
});

test('the acceptance spec runs the published backend-contract kit against the published fake', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.match(spec, /from "@jinn-network\/task-execution-testing"/);
  assert.match(spec, /describeTaskExecutionBackendContract\(\(\) => createInMemoryBackend\(\)\)/);
});

test('the acceptance spec proves a schema is retrievable from the installed package', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.match(spec, /import\.meta\.resolve\("@jinn-network\/task-execution-protocol\/schemas\/task\.schema\.json"\)/);
  assert.match(spec, /json-schema\.org\/draft\/2020-12\/schema/);
});

test('the acceptance spec never reads from the repository under test', () => {
  const spec = renderAcceptanceSpec(VERSION);
  assert.doesNotMatch(spec, /\.\.\//, 'no relative escape into the repository');
  assert.doesNotMatch(spec, /portal:/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-external-acceptance.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/stack-external-acceptance.mjs`:

```js
#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u;

export function parseAcceptanceArgs(argv) {
  const parsed = { version: undefined, registry: 'https://registry.npmjs.org', keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (flag !== '--version' && flag !== '--registry') throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    index += 1;
    if (flag === '--version') parsed.version = value;
    if (flag === '--registry') parsed.registry = value;
  }
  if (!parsed.version) throw new Error('--version is required');
  if (!EXACT_VERSION.test(parsed.version)) {
    throw new Error(`--version must be an exact version, got ${parsed.version}`);
  }
  return parsed;
}

export function renderAcceptanceSpec(version) {
  return `// Generated by .github/scripts/stack-external-acceptance.mjs for ${version}.
// This file lives outside the Jinn repository and reads nothing from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createInMemoryBackend, describeTaskExecutionBackendContract } from "@jinn-network/task-execution-testing";
import { expect, test } from "vitest";

describeTaskExecutionBackendContract(() => createInMemoryBackend());

test("a published JSON Schema is retrievable without cloning the repository", async () => {
  const url = await import.meta.resolve("@jinn-network/task-execution-protocol/schemas/task.schema.json");
  const schema = JSON.parse(readFileSync(fileURLToPath(url), "utf8"));
  expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  expect(schema.type).toBe("object");
});
`;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: { ...process.env, NODE_AUTH_TOKEN: undefined } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

export function runAcceptance({ version, registry, keep }) {
  const consumer = mkdtempSync(join(tmpdir(), 'jinn-stack-external-'));
  try {
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({
      name: 'jinn-stack-external-acceptance',
      private: true,
      type: 'module',
      version: '0.0.0',
    }, null, 2)}\n`, 'utf8');
    writeFileSync(join(consumer, 'acceptance.test.js'), renderAcceptanceSpec(version), 'utf8');
    run('npm', [
      'install', '--no-package-lock', '--registry', registry,
      `@jinn-network/task-execution-testing@${version}`,
      `@jinn-network/task-execution-protocol@${version}`,
      'vitest@4.1.8',
    ], consumer);
    run('npx', ['--no-install', 'vitest', 'run', 'acceptance.test.js'], consumer);
    console.log(`external acceptance passed for the platform set at ${version} in ${consumer}`);
  } finally {
    if (!keep) rmSync(consumer, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    runAcceptance(parseAcceptanceArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-external-acceptance.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Confirm the schema path the spec resolves exists and is exported**

Run: `node -e "console.log(Object.keys(require('./packages/task-execution/protocol/package.json').exports))" && ls packages/task-execution/protocol/schemas`
Expected: `./schemas/*` among the exports, and `task.schema.json` in the directory (verified present at plan time).

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/stack-external-acceptance.mjs .github/scripts/stack-external-acceptance.test.mjs
git commit -m "feat(publish): accept published platform packages from a clean external directory"
```

---

### Task 12: Wire external acceptance into both lanes

**Files:**
- Modify: `.github/workflows/stack-npm-publish.yml`
- Modify: `.github/scripts/stack-publish-workflow.test.mjs`

**Interfaces:**
- Consumes: `stack-external-acceptance.mjs` (Task 11) and the publish steps (Tasks 8-9).
- Produces: a `Registry consumer acceptance` step in both `publish` and `stack-stable`, running after the publish step, with a registry-availability wait first.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/stack-publish-workflow.test.mjs`:

```js
test('both lanes run external acceptance after publishing', () => {
  const occurrences = workflow.split('name: Registry consumer acceptance').length - 1;
  assert.equal(occurrences, 2, 'canary and stable lanes must each run external acceptance');
  const canaryPublishAt = workflow.indexOf('name: Publish the platform package set');
  const canaryAcceptAt = workflow.indexOf('name: Registry consumer acceptance');
  assert.ok(canaryPublishAt < canaryAcceptAt, 'acceptance must follow the publish step');
  assert.match(workflow, /node \.github\/scripts\/stack-external-acceptance\.mjs --version "\$\{ACCEPTANCE_VERSION\}"/);
});

test('acceptance waits for registry availability before installing', () => {
  assert.match(workflow, /name: Wait for the platform set on the registry/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: FAIL — acceptance step text missing.

- [ ] **Step 3: Add the steps**

Append to the `publish` job's steps, after `Publish the platform package set`:

```yaml
      - name: Wait for the platform set on the registry
        if: steps.guard.outputs.present == 'true' && github.event_name == 'push'
        shell: bash
        run: |
          set -euo pipefail
          SET_VERSION="$(node -e "console.log(JSON.parse(require('fs').readFileSync('packages/trust/core/package.json','utf8')).version)")"
          ACCEPTANCE_VERSION="${SET_VERSION}-canary.sha.${JINN_BUILD_COMMIT}"
          echo "ACCEPTANCE_VERSION=${ACCEPTANCE_VERSION}" >> "${GITHUB_ENV}"
          for _ in $(seq 1 60); do
            if npm view "@jinn-network/task-execution-testing@${ACCEPTANCE_VERSION}" version >/dev/null 2>&1; then
              exit 0
            fi
            sleep 5
          done
          echo "::error::@jinn-network/task-execution-testing@${ACCEPTANCE_VERSION} never became visible on the registry"
          exit 1

      - name: Registry consumer acceptance
        if: steps.guard.outputs.present == 'true' && github.event_name == 'push'
        shell: bash
        run: |
          set -euo pipefail
          unset NODE_AUTH_TOKEN
          node .github/scripts/stack-external-acceptance.mjs --version "${ACCEPTANCE_VERSION}"
```

Append to the `stack-stable` job's steps, after `Publish the stable platform set`:

```yaml
      - name: Wait for the platform set on the registry
        shell: bash
        run: |
          set -euo pipefail
          ACCEPTANCE_VERSION="${RELEASE_TAG#stack-v}"
          echo "ACCEPTANCE_VERSION=${ACCEPTANCE_VERSION}" >> "${GITHUB_ENV}"
          for _ in $(seq 1 60); do
            if npm view "@jinn-network/task-execution-testing@${ACCEPTANCE_VERSION}" version >/dev/null 2>&1; then
              exit 0
            fi
            sleep 5
          done
          echo "::error::@jinn-network/task-execution-testing@${ACCEPTANCE_VERSION} never became visible on the registry"
          exit 1

      - name: Registry consumer acceptance
        shell: bash
        run: |
          set -euo pipefail
          unset NODE_AUTH_TOKEN
          node .github/scripts/stack-external-acceptance.mjs --version "${ACCEPTANCE_VERSION}"
```

The `packages/trust/core/package.json` read is a version *probe*, not a package list — the publisher already asserted every package carries one version, so any member answers the question. Use `trust/core` because it is a wave-0 package that cannot disappear without the whole set disappearing.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 13/13.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/stack-npm-publish.yml .github/scripts/stack-publish-workflow.test.mjs
git commit -m "feat(publish): gate both lanes on external consumer acceptance"
```

---

### Task 13: Publication-surface guard

**Files:**
- Create: `.github/scripts/stack-publication-surface.test.mjs`
- Modify: `.github/workflows/stack-npm-publish.yml`

**Interfaces:**
- Consumes: `discoverStackPackages` (Task 1).
- Produces: a standing guard, no new runtime module. Asserts the spec §5 "published" clause is mechanically satisfiable: every on-disk `schemas/`, `profiles/`, `profile/`, or `fixtures/` directory in a platform package is inside that package's `files` allowlist **and** reachable through an `exports` subpath, so consumers can retrieve it without cloning.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/stack-publication-surface.test.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { discoverStackPackages } from './stack-package-graph.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const PUBLICATION_DIRECTORIES = ['schemas', 'profiles', 'profile', 'fixtures'];

function publicationDirectories(packageDirectory) {
  return PUBLICATION_DIRECTORIES.filter((name) => {
    const path = join(repoRoot, packageDirectory, name);
    return existsSync(path) && statSync(path).isDirectory();
  });
}

test('every schema, profile, and fixture directory is inside the packed files allowlist', () => {
  const violations = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const files = (pkg.manifest.files ?? []).map((entry) => entry.replace(/\/$/, ''));
    for (const directory of publicationDirectories(pkg.directory)) {
      if (!files.includes(directory)) {
        violations.push(`${pkg.directory}: ${directory}/ exists but is not in "files"`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('every packed publication directory is reachable through an exports subpath', () => {
  const violations = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const exportTargets = Object.values(pkg.manifest.exports ?? {})
      .flatMap((value) => (typeof value === 'string' ? [value] : Object.values(value)))
      .filter((value) => typeof value === 'string');
    for (const directory of publicationDirectories(pkg.directory)) {
      const reachable = exportTargets.some((target) => target.includes(`./${directory}/`) || target === `./${directory}/*`);
      if (!reachable) {
        violations.push(`${pkg.directory}: ${directory}/ is packed but has no exports subpath`);
      }
    }
  }
  assert.deepEqual(violations, []);
});
```

- [ ] **Step 2: Run the test to see the true starting state**

Run: `node --test .github/scripts/stack-publication-surface.test.mjs`
Expected: This may PASS immediately (22 packages already declare both). If it fails, the failure list names the exact package and directory. Fix by adding the directory to `files` and the matching `exports` subpath in that package's `package.json` — this is the only task in the plan permitted to edit a `packages/**/package.json`, and only these two fields, never `resolutions` or a dependency specifier.

- [ ] **Step 3: If it passed, prove it can fail**

Temporarily remove `"fixtures/"` from `packages/trust/core/package.json`'s `files`, run the test, confirm it reports `packages/trust/core: fixtures/ exists but is not in "files"`, then restore the file with `git checkout -- packages/trust/core/package.json`.

- [ ] **Step 4: Wire it into CI**

Add to the `registrations` job in `.github/workflows/stack-npm-publish.yml`, before the generation step:

```yaml
      - name: Verify the publication surface
        run: node --test .github/scripts/stack-publication-surface.test.mjs
```

- [ ] **Step 5: Run the test and confirm the working tree is clean**

Run: `node --test .github/scripts/stack-publication-surface.test.mjs && git status --porcelain packages/`
Expected: PASS, and empty git status (or only the intentional `files`/`exports` fixes from Step 2).

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/stack-publication-surface.test.mjs .github/workflows/stack-npm-publish.yml packages/
git commit -m "feat(publish): guard that schemas and kits are retrievable without cloning"
```

---

### Task 14: Per-package golden-fixture digest manifests

**Files:**
- Create: `.github/scripts/fixture-manifest.mjs`
- Test: `.github/scripts/fixture-manifest.test.mjs`
- Create (generated data): `packages/**/fixtures/manifest.sha256.json`

**Interfaces:**
- Consumes: `discoverStackPackages` (Task 1).
- Produces:
  - `FIXTURE_MANIFEST_NAME = 'manifest.sha256.json'`.
  - `buildFixtureManifest(packageRoot: string): FixtureManifest` where `FixtureManifest = { version: 1, entries: { id: string, sha256: string }[], errata: Erratum[] }`, `id` is the fixture path relative to the package's `fixtures/` directory (POSIX, sorted ascending, the manifest file itself excluded), and `Erratum = { id: string, supersededBy: string, date: string, reason: string }`.
  - `readFixtureManifest(packageRoot): FixtureManifest | null`.
  - `writeFixtureManifest(packageRoot, manifest): void` — two-space JSON with a trailing newline.
  - CLI: `--write` regenerates every fixture-bearing package's manifest, preserving its `errata` array; `--check` exits 1 on any drift.

Per design §8.1, `errata` is authored by hand and is append-only; the generator never invents or removes an erratum.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/fixture-manifest.test.mjs`:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  FIXTURE_MANIFEST_NAME,
  buildFixtureManifest,
  readFixtureManifest,
  writeFixtureManifest,
} from './fixture-manifest.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');

function fixturePackage(files) {
  const root = mkdtempSync(join(tmpdir(), 'jinn-fixture-manifest-'));
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, 'fixtures', relative);
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, contents, 'utf8');
  }
  return root;
}

test('the manifest lists every fixture file by sorted relative id with its sha256', () => {
  const root = fixturePackage({ 'b.json': '{"b":1}', 'nested/a.json': '{"a":1}' });
  try {
    const manifest = buildFixtureManifest(root);
    assert.equal(manifest.version, 1);
    assert.deepEqual(manifest.entries.map((entry) => entry.id), ['b.json', 'nested/a.json']);
    assert.equal(manifest.entries[0].sha256, createHash('sha256').update('{"b":1}').digest('hex'));
    assert.deepEqual(manifest.errata, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the manifest never lists itself', () => {
  const root = fixturePackage({ 'a.json': '{}', [FIXTURE_MANIFEST_NAME]: '{"version":1,"entries":[],"errata":[]}' });
  try {
    assert.deepEqual(buildFixtureManifest(root).entries.map((entry) => entry.id), ['a.json']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('regeneration preserves a hand-authored errata array', () => {
  const root = fixturePackage({ 'a.json': '{}', 'a-corrected.json': '{}' });
  try {
    const erratum = { id: 'a.json', supersededBy: 'a-corrected.json', date: '2026-07-30', reason: 'sealed the wrong outcome value' };
    writeFixtureManifest(root, { ...buildFixtureManifest(root), errata: [erratum] });
    const rebuilt = { ...buildFixtureManifest(root), errata: readFixtureManifest(root).errata };
    assert.deepEqual(rebuilt.errata, [erratum]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('writeFixtureManifest emits stable two-space JSON with a trailing newline', () => {
  const root = fixturePackage({ 'a.json': '{}' });
  try {
    const manifest = buildFixtureManifest(root);
    writeFixtureManifest(root, manifest);
    const bytes = readFileSync(join(root, 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8');
    assert.equal(bytes, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFixtureManifest(root, manifest);
    assert.equal(readFileSync(join(root, 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8'), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readFixtureManifest returns null for a package with no fixtures directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-fixture-manifest-empty-'));
  try {
    assert.equal(readFixtureManifest(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every fixture-bearing platform package has a current manifest on disk', async () => {
  const { discoverStackPackages } = await import('./stack-package-graph.mjs');
  const drift = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const packageRoot = join(repoRoot, pkg.directory);
    const built = buildFixtureManifest(packageRoot);
    if (built === null) continue;
    const stored = readFixtureManifest(packageRoot);
    if (stored === null) {
      drift.push(`${pkg.directory}: missing fixtures/${FIXTURE_MANIFEST_NAME}`);
      continue;
    }
    if (JSON.stringify(stored.entries) !== JSON.stringify(built.entries)) {
      drift.push(`${pkg.directory}: fixtures/${FIXTURE_MANIFEST_NAME} is stale`);
    }
  }
  assert.deepEqual(drift, []);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/fixture-manifest.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/fixture-manifest.mjs`:

```js
#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const FIXTURE_MANIFEST_NAME = 'manifest.sha256.json';

function walk(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'node_modules') continue;
    const child = join(directory, entry.name);
    const id = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(child, id, found);
    else if (entry.isFile() && id !== FIXTURE_MANIFEST_NAME) found.push({ id, path: child });
  }
  return found;
}

export function buildFixtureManifest(packageRoot) {
  const fixturesRoot = join(packageRoot, 'fixtures');
  if (!existsSync(fixturesRoot) || !statSync(fixturesRoot).isDirectory()) return null;
  const entries = walk(fixturesRoot, '', [])
    .map(({ id, path }) => ({ id: id.split(sep).join('/'), sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { version: 1, entries, errata: [] };
}

export function readFixtureManifest(packageRoot) {
  const path = join(packageRoot, 'fixtures', FIXTURE_MANIFEST_NAME);
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] };
}

export function writeFixtureManifest(packageRoot, manifest) {
  writeFileSync(
    join(packageRoot, 'fixtures', FIXTURE_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    const write = args.includes('--write');
    if (!write && !args.includes('--check')) throw new Error('pass --write or --check');
    const drift = [];
    for (const pkg of discoverStackPackages(root)) {
      const packageRoot = join(root, pkg.directory);
      const built = buildFixtureManifest(packageRoot);
      if (built === null) continue;
      const stored = readFixtureManifest(packageRoot);
      const next = { ...built, errata: stored?.errata ?? [] };
      if (write) {
        writeFixtureManifest(packageRoot, next);
      } else if (stored === null || JSON.stringify(stored.entries) !== JSON.stringify(next.entries)) {
        drift.push(`${pkg.directory}/fixtures/${FIXTURE_MANIFEST_NAME}`);
      }
    }
    if (drift.length > 0) {
      throw new Error(`stale or missing fixture manifests; run --write:\n  ${drift.join('\n  ')}`);
    }
    console.log(write ? 'fixture manifests written' : 'fixture manifests are current');
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Generate the manifests**

Run: `node .github/scripts/fixture-manifest.mjs --write`
Expected: `fixture manifests written`.

Run: `git status --porcelain packages/ | grep manifest.sha256.json | wc -l`
Expected: a count matching the fixture-bearing platform packages (roughly 20).

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test .github/scripts/fixture-manifest.test.mjs`
Expected: PASS, 6/6.

- [ ] **Step 6: Confirm the manifests ship in the tarballs**

Run: `node --test .github/scripts/stack-publication-surface.test.mjs`
Expected: PASS — the manifests live under `fixtures/`, which Task 13 already proved is inside `files`.

- [ ] **Step 7: Commit**

```bash
git add .github/scripts/fixture-manifest.mjs .github/scripts/fixture-manifest.test.mjs packages/
git commit -m "feat(fixtures): pin every golden fixture with a per-package sha256 manifest"
```

---

### Task 15: The offline fixture immutability gate

**Files:**
- Create: `.github/scripts/fixture-immutability.mjs`
- Test: `.github/scripts/fixture-immutability.test.mjs`
- Create: `.github/workflows/stack-fixture-immutability.yml`

**Interfaces:**
- Consumes: `FixtureManifest` from Task 14.
- Produces: `compareFixtureManifests(baseline: FixtureManifest, candidate: FixtureManifest, { label: string }): { added: string[] }` — throws on a changed digest, on a removed id, or on a malformed erratum; returns the added ids otherwise. `readManifestAtRef(ref, packageDirectory, { exec }): FixtureManifest | null`. CLI: `node .github/scripts/fixture-immutability.mjs --base <git-ref>`.

Rules, verbatim from design §8.1: an existing id keeps its exact digest forever; nothing is removed; corrections arrive as a *new* fixture plus a dated erratum naming the superseded id; additions are allowed and reported (Task 16 attaches the version consequence).

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/fixture-immutability.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compareFixtureManifests } from './fixture-immutability.mjs';

const baseline = {
  version: 1,
  entries: [{ id: 'golden/a.json', sha256: 'aa' }, { id: 'adversarial/b.json', sha256: 'bb' }],
  errata: [],
};

test('an unchanged manifest adds nothing', () => {
  assert.deepEqual(compareFixtureManifests(baseline, baseline, { label: 'packages/trust/core' }), { added: [] });
});

test('an added fixture is allowed and reported', () => {
  const candidate = { ...baseline, entries: [...baseline.entries, { id: 'adversarial/c.json', sha256: 'cc' }] };
  assert.deepEqual(compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }), {
    added: ['adversarial/c.json'],
  });
});

test('a changed fixture byte is refused', () => {
  const candidate = { ...baseline, entries: [{ id: 'golden/a.json', sha256: 'ZZ' }, baseline.entries[1]] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: golden\/a\.json changed from aa to ZZ; a published fixture is never edited, it is superseded by a new fixture plus a dated erratum/,
  );
});

test('a removed fixture is refused', () => {
  const candidate = { ...baseline, entries: [baseline.entries[0]] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: adversarial\/b\.json was removed; fixtures are append-only/,
  );
});

test('a correction is accepted as a new fixture plus a dated erratum', () => {
  const candidate = {
    version: 1,
    entries: [...baseline.entries, { id: 'golden/a-corrected.json', sha256: 'cc' }],
    errata: [{ id: 'golden/a.json', supersededBy: 'golden/a-corrected.json', date: '2026-07-30', reason: 'sealed the wrong outcome value' }],
  };
  assert.deepEqual(compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }), {
    added: ['golden/a-corrected.json'],
  });
});

test('errata are append-only', () => {
  const withErratum = {
    ...baseline,
    errata: [{ id: 'golden/a.json', supersededBy: 'golden/a2.json', date: '2026-07-30', reason: 'wrong' }],
  };
  assert.throws(
    () => compareFixtureManifests(withErratum, baseline, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json was removed; errata are append-only/,
  );
});

test('a malformed erratum is refused', () => {
  const candidate = { ...baseline, errata: [{ id: 'golden/a.json', supersededBy: 'nope.json', date: '2026-07-30', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, candidate, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json names supersededBy nope\.json, which is not a fixture in this manifest/,
  );
  const undated = { ...baseline, errata: [{ id: 'golden/a.json', supersededBy: 'adversarial/b.json', date: 'soon', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, undated, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum for golden\/a\.json needs an ISO date \(YYYY-MM-DD\), got soon/,
  );
  const unnamed = { ...baseline, errata: [{ id: 'ghost.json', supersededBy: 'adversarial/b.json', date: '2026-07-30', reason: 'x' }] };
  assert.throws(
    () => compareFixtureManifests(baseline, unnamed, { label: 'packages/trust/core' }),
    /packages\/trust\/core: erratum names ghost\.json, which is not a fixture in this manifest/,
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/fixture-immutability.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/fixture-immutability.mjs`:

```js
#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';
import { FIXTURE_MANIFEST_NAME, readFixtureManifest } from './fixture-manifest.mjs';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

export function compareFixtureManifests(baseline, candidate, { label }) {
  const candidateById = new Map(candidate.entries.map((entry) => [entry.id, entry.sha256]));
  for (const entry of baseline.entries) {
    if (!candidateById.has(entry.id)) {
      throw new Error(`${label}: ${entry.id} was removed; fixtures are append-only`);
    }
    const actual = candidateById.get(entry.id);
    if (actual !== entry.sha256) {
      throw new Error(
        `${label}: ${entry.id} changed from ${entry.sha256} to ${actual}; a published fixture is never edited, `
        + 'it is superseded by a new fixture plus a dated erratum',
      );
    }
  }
  const candidateErrata = new Map(candidate.errata.map((erratum) => [erratum.id, erratum]));
  for (const erratum of baseline.errata) {
    if (!candidateErrata.has(erratum.id)) {
      throw new Error(`${label}: erratum for ${erratum.id} was removed; errata are append-only`);
    }
  }
  for (const erratum of candidate.errata) {
    if (!candidateById.has(erratum.id)) {
      throw new Error(`${label}: erratum names ${erratum.id}, which is not a fixture in this manifest`);
    }
    if (!candidateById.has(erratum.supersededBy)) {
      throw new Error(`${label}: erratum for ${erratum.id} names supersededBy ${erratum.supersededBy}, which is not a fixture in this manifest`);
    }
    if (!ISO_DATE.test(String(erratum.date))) {
      throw new Error(`${label}: erratum for ${erratum.id} needs an ISO date (YYYY-MM-DD), got ${erratum.date}`);
    }
    if (typeof erratum.reason !== 'string' || erratum.reason.trim() === '') {
      throw new Error(`${label}: erratum for ${erratum.id} needs a non-empty reason`);
    }
  }
  const baselineIds = new Set(baseline.entries.map((entry) => entry.id));
  return { added: candidate.entries.map((entry) => entry.id).filter((id) => !baselineIds.has(id)) };
}

export function readManifestAtRef(ref, packageDirectory, { exec = defaultGit } = {}) {
  const path = `${packageDirectory}/fixtures/${FIXTURE_MANIFEST_NAME}`;
  const result = exec(['show', `${ref}:${path}`]);
  if (result.status !== 0) return null;
  const manifest = JSON.parse(result.stdout);
  return { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] };
}

function defaultGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '' };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const base = args[args.indexOf('--base') + 1];
    const root = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    if (!args.includes('--base') || !base) throw new Error('--base <git-ref> is required');
    let checked = 0;
    const additions = [];
    for (const pkg of discoverStackPackages(root)) {
      const candidate = readFixtureManifest(join(root, pkg.directory));
      if (candidate === null) continue;
      const baseline = readManifestAtRef(base, pkg.directory);
      if (baseline === null) continue;
      const { added } = compareFixtureManifests(baseline, candidate, { label: pkg.directory });
      checked += 1;
      if (added.length > 0) additions.push(`${pkg.directory}: +${added.join(', +')}`);
    }
    console.log(`fixture immutability holds across ${checked} packages against ${base}`);
    if (additions.length > 0) {
      console.log(`fixture additions in this change (each needs a minor bump and a changelog note):\n  ${additions.join('\n  ')}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/fixture-immutability.test.mjs`
Expected: PASS, 7/7.

- [ ] **Step 5: Add the CI workflow**

Create `.github/workflows/stack-fixture-immutability.yml`:

```yaml
name: Stack fixture immutability

# Golden fixtures are the compatibility contract (2026-07-30 marketplace-surfaces
# design §8.1). This gate is offline and binds from day one: an existing fixture id
# keeps its exact bytes forever, nothing is removed, and a correction arrives as a
# new fixture plus a dated erratum. The minor-bump consequence of an addition is
# enforced against the registry in the stable publish lane.
on:
  pull_request:
  push:
    branches: [integration/evidence-v1, next]

permissions:
  contents: read

jobs:
  fixtures:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Verify the fixture manifests are current
        run: node .github/scripts/fixture-manifest.mjs --check
      - name: Verify fixture immutability against the base
        env:
          BASE_REF: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
        run: |
          set -euo pipefail
          if [ -z "${BASE_REF}" ] || [ "${BASE_REF}" = "0000000000000000000000000000000000000000" ]; then
            echo "::notice::No base commit to compare against; skipping."
            exit 0
          fi
          node .github/scripts/fixture-immutability.mjs --base "${BASE_REF}"
```

- [ ] **Step 6: Prove the gate can fail**

Run:
```bash
printf 'x' >> packages/trust/core/fixtures/$(ls packages/trust/core/fixtures | grep -v manifest.sha256.json | head -1)
node .github/scripts/fixture-manifest.mjs --write
node .github/scripts/fixture-immutability.mjs --base HEAD
```
Expected: exit 1 with `packages/trust/core: <id> changed from … ; a published fixture is never edited …`.

Then restore: `git checkout -- packages/trust/core/`

- [ ] **Step 7: Commit**

```bash
git add .github/scripts/fixture-immutability.mjs .github/scripts/fixture-immutability.test.mjs .github/workflows/stack-fixture-immutability.yml
git commit -m "feat(fixtures): enforce append-only golden fixtures with dated errata"
```

---

### Task 16: The registry-backed fixture gate in the stable lane

**Files:**
- Modify: `.github/scripts/fixture-immutability.mjs`
- Modify: `.github/scripts/fixture-immutability.test.mjs`
- Modify: `.github/workflows/stack-npm-publish.yml`
- Modify: `.github/scripts/stack-publish-workflow.test.mjs`

**Interfaces:**
- Consumes: `compareFixtureManifests` (Task 15), `readFixtureManifest` (Task 14).
- Produces: `assertMinorBump(publishedVersion: string, candidateVersion: string, { label, added }): void` — throws unless the candidate's minor exceeds the published minor when `added` is non-empty. `readManifestFromRegistry(name, { exec, npmCommand, workDir }): FixtureManifest | null` — `null` when the package has no `latest`. CLI flag `--registry-baseline --version <candidateVersion>` runs the online form.

This is decision D9's online half: it only binds for packages that already have a published `latest` to protect.

- [ ] **Step 1: Write the failing test**

Append to `.github/scripts/fixture-immutability.test.mjs` (extend the import to include `assertMinorBump`):

```js
test('an addition against a published version requires a minor bump', () => {
  assert.doesNotThrow(() => assertMinorBump('0.1.0', '0.2.0', { label: 'packages/trust/core', added: ['a.json'] }));
  assert.doesNotThrow(() => assertMinorBump('0.1.0', '0.1.1', { label: 'packages/trust/core', added: [] }));
  assert.throws(
    () => assertMinorBump('0.1.0', '0.1.1', { label: 'packages/trust/core', added: ['a.json'] }),
    /packages\/trust\/core: 1 fixture added since 0\.1\.0 \(a\.json\); a fixture addition is at least a minor bump, but 0\.1\.1 keeps minor 1/,
  );
});

test('a major bump also satisfies the addition rule', () => {
  assert.doesNotThrow(() => assertMinorBump('0.9.0', '1.0.0', { label: 'packages/trust/core', added: ['a.json'] }));
});

test('a version that goes backwards is refused outright', () => {
  assert.throws(
    () => assertMinorBump('0.2.0', '0.1.0', { label: 'packages/trust/core', added: [] }),
    /packages\/trust\/core: candidate 0\.1\.0 is not ahead of the published 0\.2\.0/,
  );
});
```

Append to `.github/scripts/stack-publish-workflow.test.mjs`:

```js
test('the stable lane runs the registry-backed fixture gate before publishing', () => {
  const gateAt = workflow.indexOf('name: Verify fixture immutability against the published set');
  const publishAt = workflow.indexOf('name: Publish the stable platform set');
  assert.ok(gateAt > -1, 'the registry-backed fixture gate must exist');
  assert.ok(gateAt < publishAt, 'the fixture gate must precede the stable publish');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test .github/scripts/fixture-immutability.test.mjs .github/scripts/stack-publish-workflow.test.mjs`
Expected: FAIL — `assertMinorBump is not a function`, and the workflow assertion fails.

- [ ] **Step 3: Write the implementation**

Append to `.github/scripts/fixture-immutability.mjs`:

```js
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function parseSemver(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version));
  if (!match) throw new Error(`${label}: ${version} is not a semver`);
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function assertMinorBump(publishedVersion, candidateVersion, { label, added }) {
  const published = parseSemver(publishedVersion, label);
  const candidate = parseSemver(candidateVersion, label);
  const publishedRank = [published.major, published.minor, published.patch];
  const candidateRank = [candidate.major, candidate.minor, candidate.patch];
  const ahead = candidateRank.some((value, index) => value > publishedRank[index]
    && candidateRank.slice(0, index).every((earlier, i) => earlier === publishedRank[i]));
  if (!ahead) {
    throw new Error(`${label}: candidate ${candidateVersion} is not ahead of the published ${publishedVersion}`);
  }
  if (added.length === 0) return;
  const bumped = candidate.major > published.major || candidate.minor > published.minor;
  if (!bumped) {
    throw new Error(
      `${label}: ${added.length} fixture added since ${publishedVersion} (${added.join(', ')}); `
      + `a fixture addition is at least a minor bump, but ${candidateVersion} keeps minor ${published.minor}`,
    );
  }
}

export function readManifestFromRegistry(name, { exec = defaultNpm, npmCommand = 'npm' } = {}) {
  const workDir = mkdtempSync(join(tmpdir(), 'jinn-fixture-registry-'));
  try {
    const packed = exec(npmCommand, ['pack', `${name}@latest`, '--json', '--pack-destination', workDir], workDir);
    if (packed.status !== 0) return null;
    const [entry] = JSON.parse(packed.stdout);
    const extracted = exec('tar', ['-xzf', join(workDir, entry.filename), '-C', workDir], workDir);
    if (extracted.status !== 0) return null;
    let bytes;
    try {
      bytes = readFileSync(join(workDir, 'package', 'fixtures', FIXTURE_MANIFEST_NAME), 'utf8');
    } catch {
      return null;
    }
    const manifest = JSON.parse(bytes);
    return {
      version: entry.version,
      manifest: { version: manifest.version ?? 1, entries: manifest.entries ?? [], errata: manifest.errata ?? [] },
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function defaultNpm(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export function runRegistryBaseline(root, candidateVersion) {
  let checked = 0;
  for (const pkg of discoverStackPackages(root)) {
    const candidate = readFixtureManifest(join(root, pkg.directory));
    if (candidate === null) continue;
    const published = readManifestFromRegistry(pkg.name);
    if (published === null) {
      console.log(`${pkg.directory}: no published latest yet; nothing to protect`);
      continue;
    }
    const { added } = compareFixtureManifests(published.manifest, candidate, { label: pkg.directory });
    assertMinorBump(published.version, candidateVersion, { label: pkg.directory, added });
    checked += 1;
  }
  console.log(`fixture immutability holds against the published registry set across ${checked} packages`);
}
```

Extend the CLI block so `--registry-baseline --version <v>` calls `runRegistryBaseline(root, version)` instead of the git-ref path.

- [ ] **Step 4: Add the stable-lane step**

Insert into `.github/workflows/stack-npm-publish.yml`'s `stack-stable` job, before `Publish the stable platform set`:

```yaml
      - name: Verify fixture immutability against the published set
        shell: bash
        run: |
          set -euo pipefail
          node .github/scripts/fixture-immutability.mjs --registry-baseline --version "${RELEASE_TAG#stack-v}"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test .github/scripts/fixture-immutability.test.mjs .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 10/10 and 14/14.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/fixture-immutability.mjs .github/scripts/fixture-immutability.test.mjs .github/workflows/stack-npm-publish.yml .github/scripts/stack-publish-workflow.test.mjs
git commit -m "feat(fixtures): gate the stable cut on the published fixture manifests"
```

---

### Task 17: The static profile root and its SHA-256 manifest

**Files:**
- Create: `.github/scripts/build-profile-root.mjs`
- Test: `.github/scripts/build-profile-root.test.mjs`

**Interfaces:**
- Consumes: `discoverStackPackages` (Task 1).
- Produces: `PROFILE_SOURCE_DIRECTORIES = ['profiles', 'profile', 'schemas']`. `buildProfileRoot({ repoRoot, outDir }): ProfileManifest` where `ProfileManifest = { version: 1, generatedFrom: { repository: 'Jinn-Network/mono', commit: string }, documents: { path: string, sha256: string, mediaType: string, sourcePackage: string }[] }`; `path` is the served path under the root, `documents` is sorted by `path`. `manifestBytes(manifest): string` — canonical two-space JSON with a trailing newline, the bytes the DSSE envelope in Task 18 signs. CLI: `node .github/scripts/build-profile-root.mjs --out <dir> --commit <sha>`.

Files are copied under the root at their package-declared paths, so a document that lives at `packages/evidence/protocol/profiles/execution-evidence/1.0/schemas/x.schema.json` is served at `profiles/execution-evidence/1.0/schemas/x.schema.json` — exactly the path its `https://jinn.network/…` URI names.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/build-profile-root.test.mjs`:

```js
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { buildProfileRoot, manifestBytes } from './build-profile-root.mjs';

const repoRoot = resolve(import.meta.dirname, '../..');
const SHA = 'e'.repeat(40);

function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), 'jinn-profile-root-'));
  const packageDir = join(root, 'packages/evidence/protocol');
  mkdirSync(join(packageDir, 'profiles/execution-evidence/1.0/schemas'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify({
    name: '@jinn-network/evidence-protocol',
    version: '0.1.0',
    publishConfig: { access: 'public' },
    files: ['dist/', 'profiles/'],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(packageDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json'), '{"type":"object"}', 'utf8');
  writeFileSync(join(packageDir, 'profiles/execution-evidence/1.0/profile.md'), '# profile\n', 'utf8');
  return root;
}

test('documents are served at the paths their profile URIs name', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    assert.deepEqual(manifest.documents.map((d) => d.path), [
      'profiles/execution-evidence/1.0/profile.md',
      'profiles/execution-evidence/1.0/schemas/a.schema.json',
    ]);
    assert.ok(existsSync(join(outDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json')));
    assert.equal(
      readFileSync(join(outDir, 'profiles/execution-evidence/1.0/schemas/a.schema.json'), 'utf8'),
      '{"type":"object"}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('each document carries its exact-byte digest, media type, and source package', () => {
  const root = scratchRepo();
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot: root, outDir, commit: SHA });
    const schema = manifest.documents.find((d) => d.path.endsWith('a.schema.json'));
    assert.equal(schema.sha256, createHash('sha256').update('{"type":"object"}').digest('hex'));
    assert.equal(schema.mediaType, 'application/schema+json');
    assert.equal(schema.sourcePackage, '@jinn-network/evidence-protocol');
    assert.equal(manifest.documents.find((d) => d.path.endsWith('profile.md')).mediaType, 'text/markdown');
    assert.deepEqual(manifest.generatedFrom, { repository: 'Jinn-Network/mono', commit: SHA });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a colliding served path across two packages is refused', () => {
  const root = scratchRepo();
  const second = join(root, 'packages/trust/core');
  mkdirSync(join(second, 'profiles/execution-evidence/1.0'), { recursive: true });
  writeFileSync(join(second, 'package.json'), `${JSON.stringify({
    name: '@jinn-network/trust-core', version: '0.1.0', publishConfig: { access: 'public' }, files: ['profiles/'],
  }, null, 2)}\n`, 'utf8');
  writeFileSync(join(second, 'profiles/execution-evidence/1.0/profile.md'), '# other\n', 'utf8');
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    assert.throws(
      () => buildProfileRoot({ repoRoot: root, outDir, commit: SHA }),
      /profiles\/execution-evidence\/1\.0\/profile\.md is claimed by both @jinn-network\/evidence-protocol and @jinn-network\/trust-core/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('manifestBytes are canonical and stable', () => {
  const manifest = { version: 1, generatedFrom: { repository: 'Jinn-Network/mono', commit: SHA }, documents: [] };
  assert.equal(manifestBytes(manifest), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal(manifestBytes(manifest), manifestBytes(structuredClone(manifest)));
});

test('the real repository produces a non-empty profile root', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'jinn-profile-out-'));
  try {
    const manifest = buildProfileRoot({ repoRoot, outDir, commit: SHA });
    assert.ok(manifest.documents.length > 0, 'the platform must serve at least one profile document');
    for (const document of manifest.documents) {
      assert.match(document.sha256, /^[0-9a-f]{64}$/);
      assert.ok(existsSync(join(outDir, document.path)));
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/build-profile-root.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/build-profile-root.mjs`:

```js
#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

import { discoverStackPackages } from './stack-package-graph.mjs';

export const PROFILE_SOURCE_DIRECTORIES = ['profiles', 'profile', 'schemas'];

const MEDIA_TYPES = new Map([
  ['.schema.json', 'application/schema+json'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.txt', 'text/plain'],
]);

function mediaTypeFor(path) {
  for (const [suffix, mediaType] of MEDIA_TYPES) {
    if (path.endsWith(suffix)) return mediaType;
  }
  return 'application/octet-stream';
}

function walkFiles(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const child = join(directory, entry.name);
    const id = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(child, id, found);
    else if (entry.isFile()) found.push({ servedPath: id.split(sep).join('/'), absolutePath: child });
  }
  return found;
}

export function buildProfileRoot({ repoRoot, outDir, commit }) {
  const claims = new Map();
  const documents = [];
  for (const pkg of discoverStackPackages(repoRoot)) {
    const packed = new Set((pkg.manifest.files ?? []).map((entry) => entry.replace(/\/$/, '')));
    for (const source of PROFILE_SOURCE_DIRECTORIES) {
      if (!packed.has(source)) continue;
      const absolute = join(repoRoot, pkg.directory, source);
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) continue;
      for (const file of walkFiles(absolute, source, [])) {
        const claimed = claims.get(file.servedPath);
        if (claimed && claimed !== pkg.name) {
          throw new Error(`${file.servedPath} is claimed by both ${claimed} and ${pkg.name}`);
        }
        claims.set(file.servedPath, pkg.name);
        const bytes = readFileSync(file.absolutePath);
        documents.push({
          path: file.servedPath,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaType: mediaTypeFor(file.servedPath),
          sourcePackage: pkg.name,
        });
        const target = join(outDir, ...file.servedPath.split('/'));
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(file.absolutePath, target);
      }
    }
  }
  documents.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const manifest = {
    version: 1,
    generatedFrom: { repository: 'Jinn-Network/mono', commit },
    documents,
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'manifest.json'), manifestBytes(manifest), 'utf8');
  return manifest;
}

export function manifestBytes(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const outDir = args[args.indexOf('--out') + 1];
    const commit = args[args.indexOf('--commit') + 1];
    const repoRoot = args.includes('--root') ? args[args.indexOf('--root') + 1] : process.cwd();
    if (!args.includes('--out') || !outDir) throw new Error('--out <directory> is required');
    if (!args.includes('--commit') || !/^[0-9a-f]{40}$/u.test(String(commit))) {
      throw new Error('--commit <40-character sha> is required');
    }
    const manifest = buildProfileRoot({ repoRoot, outDir, commit });
    console.log(`wrote ${manifest.documents.length} profile documents and manifest.json to ${outDir}`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test .github/scripts/build-profile-root.test.mjs`
Expected: PASS, 5/5.

- [ ] **Step 5: Inspect the real profile root**

Run: `node .github/scripts/build-profile-root.mjs --out /tmp/jinn-profile-root --commit $(git rev-parse HEAD) && node -e "const m=require('/tmp/jinn-profile-root/manifest.json');console.log(m.documents.length);console.log(m.documents.slice(0,5).map(d=>d.path).join('\n'))"`
Expected: a document count above zero and served paths that mirror the `https://jinn.network/profiles/...` URIs found in package sources.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/build-profile-root.mjs .github/scripts/build-profile-root.test.mjs
git commit -m "feat(profiles): build the static profile root with a sha256 document manifest"
```

---

### Task 18: The DSSE sidecar and the hosting artifact

**Files:**
- Create: `.github/scripts/sign-profile-manifest.mjs`
- Test: `.github/scripts/sign-profile-manifest.test.mjs`
- Modify: `.github/workflows/stack-npm-publish.yml`
- Modify: `.github/scripts/stack-publish-workflow.test.mjs`

**Interfaces:**
- Consumes: `manifest.json` bytes from Task 17.
- Produces:
  - `PAYLOAD_TYPE = 'application/vnd.jinn.profile-manifest+json'`.
  - `preAuthenticationEncoding(payloadType: string, payload: Buffer): Buffer` — the DSSE PAE per the DSSE specification.
  - `signManifest(payloadBytes: Buffer, privateKeyPem: string, keyId: string): DsseEnvelope` where `DsseEnvelope = { payload: string, payloadType: string, signatures: [{ keyid: string, sig: string }] }`, both `payload` and `sig` base64.
  - `verifyEnvelope(envelope, publicKeyPem): boolean`.
  - CLI: `node .github/scripts/sign-profile-manifest.mjs --root <profileRootDir>` reads `JINN_PROFILE_MANIFEST_SIGNING_KEY` (PEM, ed25519) and `JINN_PROFILE_MANIFEST_KEY_ID`; when the key is absent it prints a notice and exits 0 **without** writing a sidecar.

Decision D8: the sidecar is a separate file, so `manifest.json` bytes are identical whether or not a key exists.

- [ ] **Step 1: Write the failing test**

Create `.github/scripts/sign-profile-manifest.test.mjs`:

```js
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  PAYLOAD_TYPE,
  preAuthenticationEncoding,
  signManifest,
  verifyEnvelope,
} from './sign-profile-manifest.mjs';

const script = resolve(import.meta.dirname, 'sign-profile-manifest.mjs');

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

test('the pre-authentication encoding follows the DSSE specification', () => {
  const pae = preAuthenticationEncoding('http://example.com/t', Buffer.from('hello'));
  assert.equal(pae.toString('utf8'), 'DSSEv1 20 http://example.com/t 5 hello');
});

test('a signed envelope verifies with the matching public key', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const payload = Buffer.from('{"version":1}\n', 'utf8');
  const envelope = signManifest(payload, privateKeyPem, 'jinn-profile-root-2026');
  assert.equal(envelope.payloadType, PAYLOAD_TYPE);
  assert.equal(Buffer.from(envelope.payload, 'base64').toString('utf8'), '{"version":1}\n');
  assert.equal(envelope.signatures[0].keyid, 'jinn-profile-root-2026');
  assert.equal(verifyEnvelope(envelope, publicKeyPem), true);
});

test('a tampered payload fails verification', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const envelope = signManifest(Buffer.from('{"version":1}\n'), privateKeyPem, 'k');
  envelope.payload = Buffer.from('{"version":2}\n').toString('base64');
  assert.equal(verifyEnvelope(envelope, publicKeyPem), false);
});

test('a signature from a different key fails verification', () => {
  const first = keyPair();
  const second = keyPair();
  const envelope = signManifest(Buffer.from('{"version":1}\n'), first.privateKeyPem, 'k');
  assert.equal(verifyEnvelope(envelope, second.publicKeyPem), false);
});

test('the CLI writes a sidecar when a key is present and leaves manifest.json byte-identical', () => {
  const { privateKeyPem, publicKeyPem } = keyPair();
  const root = mkdtempSync(join(tmpdir(), 'jinn-sign-'));
  try {
    const manifest = '{\n  "version": 1\n}\n';
    writeFileSync(join(root, 'manifest.json'), manifest, 'utf8');
    const result = spawnSync(process.execPath, [script, '--root', root], {
      encoding: 'utf8',
      env: { ...process.env, JINN_PROFILE_MANIFEST_SIGNING_KEY: privateKeyPem, JINN_PROFILE_MANIFEST_KEY_ID: 'k1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, 'manifest.json'), 'utf8'), manifest);
    const envelope = JSON.parse(readFileSync(join(root, 'manifest.dsse.json'), 'utf8'));
    assert.equal(verifyEnvelope(envelope, publicKeyPem), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI exits 0 and writes no sidecar when no key is provisioned', () => {
  const root = mkdtempSync(join(tmpdir(), 'jinn-sign-'));
  try {
    writeFileSync(join(root, 'manifest.json'), '{}\n', 'utf8');
    const env = { ...process.env };
    delete env.JINN_PROFILE_MANIFEST_SIGNING_KEY;
    const result = spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no profile-manifest signing key provisioned; wrote no sidecar/);
    assert.equal(existsSync(join(root, 'manifest.dsse.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/sign-profile-manifest.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `.github/scripts/sign-profile-manifest.mjs`:

```js
#!/usr/bin/env node

import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PAYLOAD_TYPE = 'application/vnd.jinn.profile-manifest+json';

export function preAuthenticationEncoding(payloadType, payload) {
  const typeBytes = Buffer.from(payloadType, 'utf8');
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${typeBytes.length} `, 'utf8'),
    typeBytes,
    Buffer.from(` ${payload.length} `, 'utf8'),
    payload,
  ]);
}

export function signManifest(payloadBytes, privateKeyPem, keyId) {
  const payload = Buffer.from(payloadBytes);
  const signature = sign(null, preAuthenticationEncoding(PAYLOAD_TYPE, payload), createPrivateKey(privateKeyPem));
  return {
    payload: payload.toString('base64'),
    payloadType: PAYLOAD_TYPE,
    signatures: [{ keyid: keyId, sig: signature.toString('base64') }],
  };
}

export function verifyEnvelope(envelope, publicKeyPem) {
  try {
    const payload = Buffer.from(envelope.payload, 'base64');
    const pae = preAuthenticationEncoding(envelope.payloadType, payload);
    return envelope.signatures.some((signature) => verify(
      null,
      pae,
      createPublicKey(publicKeyPem),
      Buffer.from(signature.sig, 'base64'),
    ));
  } catch {
    return false;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const args = process.argv.slice(2);
    const root = args[args.indexOf('--root') + 1];
    if (!args.includes('--root') || !root) throw new Error('--root <profile root directory> is required');
    const privateKeyPem = process.env.JINN_PROFILE_MANIFEST_SIGNING_KEY;
    if (!privateKeyPem) {
      console.log('no profile-manifest signing key provisioned; wrote no sidecar');
    } else {
      const keyId = process.env.JINN_PROFILE_MANIFEST_KEY_ID;
      if (!keyId) throw new Error('JINN_PROFILE_MANIFEST_KEY_ID is required alongside the signing key');
      const payload = readFileSync(join(root, 'manifest.json'));
      const envelope = signManifest(payload, privateKeyPem, keyId);
      writeFileSync(join(root, 'manifest.dsse.json'), `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');
      console.log(`signed manifest.json with key ${keyId}`);
    }
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Add the profile-root job to the workflow**

Append this job to `.github/workflows/stack-npm-publish.yml`:

```yaml
  profile-root:
    name: Profile root artifact
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: '22'
      - name: Build the static profile root
        run: node .github/scripts/build-profile-root.mjs --out "${RUNNER_TEMP}/profile-root" --commit "${GITHUB_SHA}"
      - name: Sign the profile manifest
        env:
          JINN_PROFILE_MANIFEST_SIGNING_KEY: ${{ secrets.JINN_PROFILE_MANIFEST_SIGNING_KEY }}
          JINN_PROFILE_MANIFEST_KEY_ID: ${{ vars.JINN_PROFILE_MANIFEST_KEY_ID }}
        run: node .github/scripts/sign-profile-manifest.mjs --root "${RUNNER_TEMP}/profile-root"
      - uses: actions/upload-artifact@v4
        with:
          name: jinn-profile-root
          path: ${{ runner.temp }}/profile-root
          if-no-files-found: error
```

Append to `.github/scripts/stack-publish-workflow.test.mjs`:

```js
test('the profile root is built and signed as an uploadable artifact', () => {
  assert.match(workflow, /name: jinn-profile-root/);
  const buildAt = workflow.indexOf('name: Build the static profile root');
  const signAt = workflow.indexOf('name: Sign the profile manifest');
  assert.ok(buildAt > -1 && signAt > buildAt, 'the manifest is signed after it is built');
  assert.match(workflow, /JINN_PROFILE_MANIFEST_SIGNING_KEY: \$\{\{ secrets\.JINN_PROFILE_MANIFEST_SIGNING_KEY \}\}/);
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test .github/scripts/sign-profile-manifest.test.mjs .github/scripts/stack-publish-workflow.test.mjs`
Expected: PASS, 6/6 and 15/15.

- [ ] **Step 6: Commit**

```bash
git add .github/scripts/sign-profile-manifest.mjs .github/scripts/sign-profile-manifest.test.mjs .github/workflows/stack-npm-publish.yml .github/scripts/stack-publish-workflow.test.mjs
git commit -m "feat(profiles): sign the profile manifest as a DSSE sidecar artifact"
```

---

### Task 19: Live canary proof and the two human checklists

**Files:**
- Modify: `docs/runbooks/stack-npm-publishing.md`
- Create: `docs/runbooks/jinn-network-profile-hosting.md`

**Interfaces:**
- Consumes: everything. This task's deliverable is evidence plus the two human checklists the plan owes.

This is the acceptance criterion's teeth: one full canary wave published to npm from CI and installed externally. Nothing here is simulated.

- [ ] **Step 1: Run the whole `.github/scripts` suite locally**

Run: `node --test .github/scripts/stack-package-graph.test.mjs .github/scripts/stack-publish-manifest.test.mjs .github/scripts/publish-stack.test.mjs .github/scripts/publish-stack-run.test.mjs .github/scripts/stack-publish-workflow.test.mjs .github/scripts/stack-trusted-publishers.test.mjs .github/scripts/stack-external-acceptance.test.mjs .github/scripts/stack-publication-surface.test.mjs .github/scripts/fixture-manifest.test.mjs .github/scripts/fixture-immutability.test.mjs .github/scripts/build-profile-root.test.mjs .github/scripts/sign-profile-manifest.test.mjs`
Expected: all pass, zero failures.

- [ ] **Step 2: Confirm the existing publish guards did not regress**

Run: `node --test .github/scripts/npm-publish-workflow.test.mjs .github/scripts/layer-publish-workflow.test.mjs .github/scripts/publish-layer-stable.test.mjs`
Expected: all pass. In particular `npm-publish-workflow.test.mjs` must still assert no hard-coded `@jinn-network/sdk@x.y.z` literal (PR #2306).

- [ ] **Step 3: Confirm the working tree is clean of accidental package mutation**

Run: `git status --porcelain packages/`
Expected: empty (the fixture manifests from Task 14 are already committed).

- [ ] **Step 4: Generate the trusted-publisher checklist and register the packages**

Run: `node .github/scripts/stack-trusted-publishers.mjs --out /tmp/jinn-registrations && cat /tmp/jinn-registrations/trusted-publishers.md`

**HUMAN CHECKLIST 1 — npm trusted-publisher registration.** Append the rendered table to `docs/runbooks/stack-npm-publishing.md` under a new `## Human checklist: npm trusted-publisher registration` heading, with this preamble:

```markdown
## Human checklist: npm trusted-publisher registration

An operator with npm owner rights on the `@jinn-network` scope must do this once per
package before the first canary of that package can publish. It cannot be automated:
npmjs has no API for trusted-publisher configuration.

- [ ] Confirm the operator is on a team in the `@jinn-network` org. A scope owner on **no**
      team gets a 404 on first publish, not a permission error. Fix with
      `npm team add @jinn-network:developers <user>`.
- [ ] Regenerate the list: `node .github/scripts/stack-trusted-publishers.mjs --out /tmp/jinn-registrations`
- [ ] For every row in `trusted-publishers.md`, open the npmjs package settings and add a
      trusted publisher with the exact field values in the table above.
- [ ] Leave the optional **Environment** field blank on every one of them.
- [ ] Add no `NODE_AUTH_TOKEN` and no long-lived npm credential anywhere.
- [ ] Confirm the two GitHub environments exist: `npm-publish` (canary, automatic) and
      `npm-stable-publish` (stable, required reviewer, branch policy).
- [ ] Record the date and the operator's handle in this file when complete.
```

- [ ] **Step 5: Trigger and observe the first live canary wave**

Push the branch. Then:

```bash
gh run list --repo Jinn-Network/mono --workflow stack-npm-publish.yml --limit 3
gh run watch --repo Jinn-Network/mono <run-id>
```

Expected: the `publish` job completes, its log shows `wave 0: packed 3 packages` through `wave 7: packed 1 packages`, then `verified coherent platform set 0.1.0-canary.sha.<sha> at canary across 45 packages`, then `external acceptance passed for the platform set at 0.1.0-canary.sha.<sha>`.

If the run fails on a missing trusted publisher, complete Step 4 for the named package and re-run — the driver is idempotent and resumes without republishing anything.

- [ ] **Step 6: Independently install and run the kit outside CI**

From a directory outside this repository:

```bash
node .github/scripts/stack-external-acceptance.mjs --version "0.1.0-canary.sha.<sha>" --keep
```

Expected: `external acceptance passed for the platform set at 0.1.0-canary.sha.<sha> in /tmp/jinn-stack-external-XXXX`. Inspect that directory and confirm its `node_modules/@jinn-network/*/package.json` files contain **no** `portal:` string:

```bash
grep -r 'portal:' /tmp/jinn-stack-external-*/node_modules/@jinn-network/ || echo "no portal links in published packages"
```

Expected: `no portal links in published packages`.

- [ ] **Step 7: Record the evidence in the runbook**

Append to `docs/runbooks/stack-npm-publishing.md`:

```markdown
## First live canary

- Run: <workflow run URL>
- Version: `0.1.0-canary.sha.<sha>`
- Packages published: 45, in 8 waves
- External acceptance: passed from a clean directory outside the repository
- Verified: no `portal:` specifier survives into any published tarball
```

Fill in the real run URL and sha. Do not commit this section with placeholders.

- [ ] **Step 8: Write the hosting checklist**

Create `docs/runbooks/jinn-network-profile-hosting.md`:

```markdown
# Hosting the jinn.network profile root

**Scope:** serving the reserved `https://jinn.network/profiles/…` and
`https://jinn.network/schemas/…` identifiers so that external conformance claims become
possible. Design: `docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md`
§8.1 (digest-bound identifiers) and §8.4 (the URI resolution gate). Issue #2293 rider 1.

## What CI produces

Every run of `.github/workflows/stack-npm-publish.yml` uploads a `jinn-profile-root`
artifact containing:

- the profile and schema documents at the exact paths their URIs name;
- `manifest.json` — a SHA-256 digest of every served document, with its media type and
  source package;
- `manifest.dsse.json` — a DSSE envelope over `manifest.json`'s exact bytes, present only
  when a signing key is provisioned.

`manifest.json`'s bytes never depend on whether a key exists; the signature is a sidecar.

## Why the digests matter

The profile URI is the name; the digests are the binding. A conformance claim cites document
digests, not bare URIs, so a hosting compromise or a quiet redeploy is detectable. Serving
the documents without the manifest reintroduces trust-the-host into a stack whose every
other link is a hash.

## Human checklist: hosting and key provisioning

None of this can be automated from this repository. An operator with control of the
`jinn.network` domain and the org's GitHub settings must:

- [ ] Generate an ed25519 signing key for the profile manifest, offline, and keep the
      private key out of this repository.
- [ ] Add the private key as the GitHub Actions secret `JINN_PROFILE_MANIFEST_SIGNING_KEY`
      (PKCS#8 PEM) on `Jinn-Network/mono`.
- [ ] Add the key identifier as the GitHub Actions variable `JINN_PROFILE_MANIFEST_KEY_ID`.
- [ ] Publish the corresponding **public** key at a stable URL and record that URL here, so a
      verifier can check `manifest.dsse.json` without asking anyone.
- [ ] Point `jinn.network` at a static host.
- [ ] Configure the host to serve the `jinn-profile-root` artifact's contents at the domain
      root, preserving paths exactly.
- [ ] Serve `application/schema+json` for `*.schema.json` and `text/markdown` for `*.md`, as
      `manifest.json` declares.
- [ ] Verify a resolution end to end:
      `curl -sSf https://jinn.network/profiles/task-execution/1.0/... | sha256sum` and confirm
      the digest matches `manifest.json`.
- [ ] Record the date, the operator's handle, and the public-key URL in this file when
      complete.

Until every box is ticked, no external party can make a conformance claim (design §8.4
item 1), and that limitation is stated, not hidden.
```

- [ ] **Step 9: Confirm no placeholders survive**

Run: `grep -nE 'TBD|TODO|<sha>|<run-id>|<workflow run URL>|FIXME' docs/runbooks/stack-npm-publishing.md`
Expected: no matches. (`docs/runbooks/jinn-network-profile-hosting.md` legitimately contains unticked checkboxes — those are the human's work, not placeholders.)

- [ ] **Step 10: Commit**

```bash
git add docs/runbooks/stack-npm-publishing.md docs/runbooks/jinn-network-profile-hosting.md
git commit -m "docs(publish): record the first live canary and the two human checklists"
```

- [ ] **Step 11: Open the PR**

```bash
gh pr create --repo Jinn-Network/mono --base integration/evidence-v1 \
  --title "feat(publish): the stack publish path for the 45 platform packages" \
  --body "$(cat <<'BODY'
## What

Implements #2293 — canary and stable publishing for the 45 platform packages under
`packages/{task-execution,evidence,trust,discovery,marketplace,benchmarking}`, in
dependency-graph-derived topological order (8 waves), with the two marketplace-surfaces
DevX riders that ride its artifacts.

- Topological publisher derived from the filesystem and the dependency graph — no
  hard-coded package list anywhere. Cycle detection, dedup, and wave ordering are unit-tested.
- Publish-time manifest transform: version and in-set pin patching, `portal:` resolution
  stripping (non-portal `resolutions` preserved), explicit `gitHead`, byte-exact restore.
  The in-repo `portal:` development path is untouched.
- Branch-aware trigger: `integration/evidence-v1` and `next`, with an existence guard, so
  it publishes today and continues from `next` after the integration merge (plan decision D1).
- Coherent stable lane on `stack-v<semver>` tags with a whole-set verification pass that
  fails on any partially-published graph.
- Generated per-package npm trusted-publisher registration list as a build artifact.
- External-consumer acceptance: a published package installs into a clean directory outside
  this repository and passes its own conformance kit; a published JSON Schema resolves there.
- Rider 1: static profile root with a SHA-256 document manifest and a DSSE sidecar, uploaded
  as a CI artifact ready for static hosting.
- Rider 2: per-package golden-fixture SHA-256 manifests, an offline append-only gate with
  dated errata, and a registry-backed minor-bump gate in the stable lane.

## Human actions required before the first publish

Two checklists ship with this PR and are not optional:

- `docs/runbooks/stack-npm-publishing.md` — npm trusted-publisher registration (one per package).
- `docs/runbooks/jinn-network-profile-hosting.md` — signing-key provisioning and jinn.network hosting.

## Verification

- Full `.github/scripts` suite green, including the pre-existing publish guards
  (`npm-publish-workflow.test.mjs` still asserts no hard-coded sdk version literal, per #2306).
- One live canary wave published from CI and installed externally; no `portal:` specifier
  survives into any published tarball.

Closes #2293

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

---

## Self-review

**1. Spec coverage.** Each acceptance criterion and rider requirement maps to a task:

| Requirement | Tasks |
| --- | --- |
| Canary publish on every push to `next` (branch-aware, D1) | 8 |
| Coherent stable publish on release trigger | 7, 9 |
| Topological order derived from the graph, no hard-coded lists | 1, 2, 4 |
| `portal:` rewritten at publish time; dev path unchanged | 3, 5 |
| Per-package trusted-publisher registration as a build artifact | 10 |
| Published package installs and passes its kit from a clean external directory | 11, 12, 19 |
| Schemas and kits retrievable without cloning | 11, 13, 17 |
| Rider 1: profile-URI hosting readiness (documents + DSSE-signed SHA-256 manifest as CI artifacts; the hosting click is a checklist) | 17, 18, 19 |
| Rider 2: fixture immutability (per-schema SHA-256 manifest, append-only, errata) | 14, 15, 16 |
| Human-action boundary produces checklists, never assumptions | 10, 19 |
| Live canary end-to-end proof | 19 |

Design-document coverage: LAW §5 "published" clause → Tasks 13, 17; LAW §6 gate items 1-2 (the publish path as enabling precondition) → Tasks 1-9; marketplace-surfaces §4.1 C5 (trusted-publisher provenance) → Tasks 6 (`--provenance`), 10; §8.1 → Tasks 14-17; §8.2 (0.x minor = breaking, coherent set) → D3, Task 16; §8.4 (URI resolution gate) → Tasks 17-19; §10 follow-ups 1 and 2 → Tasks 17-18 and 14-16.

**2. Placeholder scan.** No `TBD`, no "add error handling", no "similar to Task N", no "write tests for the above". Every code step carries the code. Task 19 Step 9 greps for placeholder text in the committed runbook so the plan's own prohibition is mechanically enforced. Two deliberate exceptions, both flagged in place: `<sha>` and `<run-id>` appear only inside instructions that say to substitute real values before committing, and Step 9 fails if they survive.

**3. Type consistency.** Names threaded across tasks, checked end to end:

- `discoverStackPackages` returns `{ directory, name, manifest, manifestPath }` — used identically in Tasks 2, 4, 10, 13, 14, 15, 17.
- `DEPENDENCY_SECTIONS` is defined once (Task 2) and consumed by `transformManifestForPublish` (Task 3).
- `buildPublishPlan` returns `{ version, distTag, waves, inSetNames }`; `runPublish` (Tasks 5-7) consumes exactly those four, and `packWave` takes `inSetNames` through to `applyPublishManifest`.
- `Artifact` is `{ name, spec, directory, tarball, integrity }` from `packWave` (Task 5), consumed unchanged by `publishWave` (Task 6) and `verifyCoherentSet` (Task 7).
- `FixtureManifest` is `{ version, entries, errata }` in Tasks 14, 15, 16; `readManifestFromRegistry` returns `{ version, manifest }` (the package version alongside it) and Task 16's `runRegistryBaseline` destructures accordingly.
- `FIXTURE_MANIFEST_NAME` is exported once (Task 14) and imported by Task 15's `readManifestAtRef` and Task 16's `readManifestFromRegistry`.
- `manifestBytes` (Task 17) produces exactly the bytes `signManifest` (Task 18) signs; the DSSE payload round-trips to the same string in Task 18's test.
- Workflow job ids `publish`, `stack-stable`, `registrations`, `profile-root` are asserted by name in `stack-publish-workflow.test.mjs` across Tasks 8, 9, 10, 12, 16, 18.

**4. Ordering.** Tasks 1-7 build the driver bottom-up, each independently testable. Tasks 8-12 are the CI surface. Task 13 is an independent guard. Tasks 14-16 and 17-18 are the two riders, each self-contained. Task 19 is the only task requiring network, credentials, or a human, and it is last by construction.

**5. Known residual risk.** Task 19 Step 5 can fail on a missing trusted-publisher registration for any of the 45 packages, and the fix is a human action in npmjs. This is not a plan defect — it is the human-action boundary made visible, and the driver's idempotence means each registration fixed lets the run resume without republishing anything.
