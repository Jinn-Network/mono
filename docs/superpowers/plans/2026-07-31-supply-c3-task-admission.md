# C3 — Task Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Date:** 2026-07-31
- **Component:** C3 of the verified-environment supply program
  ([`2026-07-31-supply-program.md`](2026-07-31-supply-program.md))
- **Design (law):** [`../specs/2026-07-31-verified-environment-supply-design.md`](../specs/2026-07-31-verified-environment-supply-design.md)
  §7.1 (admission), §3.1/§3.3 (unit + dependency direction), §11 (kit ordering), §12 (non-goals)
- **Branch:** `supply/c3-task-admission`, based on `supply/c1-environment-record`
- **Also owns:** `packages/task-supply/` tree scaffolding — guard trio + CI (program §1: the
  first package in a tree opens it)

**Goal:** ship `@jinn-network/task-admission` — the source-agnostic unit that turns *(candidate
task + environment record)* into a `DifferentialAdmissionReceipt/3`: a signed, per-path 2×2
proof that the candidate's grader **discriminates** (gold resolves the failing assertions; the
empty patch does not) on the exact environment the receipt names by digest. Anyone grading
anything can use it; nothing in it knows whether the candidate was imported, injected, or mined.

**Architecture.** Admission is pure orchestration over one injected port. It owns no Docker, no
network, no clock, no key material:

- **Input:** an `AdmissionCandidate` (digests, transitions, sealed EvaluationSpec **bytes**,
  test paths) plus the sealed **environment-record bytes**.
- **Enforcement (normative rule 1, spec §7.1):** the EvaluationSpec's inline deterministic-process
  `image` (manifest digest via its reference), `platform`, and `parser` MUST equal the referenced
  record's. Any mismatch refuses with `env-record-mismatch`, so a pair cannot grade against one
  image while borrowing another record's evidence. The receipt records that the check ran.
- **Evidence:** for each test path, four runs through `deps.runInEnvironment` — empty×2,
  gold×2. Repeats must be canonical-JSON identical; each path must carry ≥1 fail-to-pass
  assertion; raw assertion identifiers are globally unique across paths; the targeted command is
  bound by hash; the gold patch appears **only as a digest**.
- **Attestation-agnosticism (normative rule 2, spec §7.1):** the receipt cites
  `environment.recordDigest` and nothing else about the environment. The package has no
  dependency, import, or exported symbol touching verification attestations — enforced by a test
  (contract 7).
- **Output:** the receipt, sealed as the **predicate of a DSSE-signed in-toto Statement** whose
  subjects are the sealed Task and EvaluationSpec digests — the shape the marketplace evaluation
  leg already validates (`packages/task-execution/profiles/src/admission-receipt.ts`,
  `packages/marketplace/binding/src/named-checks.ts`). See Finding F-C3-1.

**Tech stack:** TypeScript / Node 22 / Yarn 4.13.0 (self-contained project, `portal:`
resolution); zod 4.4.3; vitest 4.1.8; `@jinn-network/environment-record` (C1);
`@jinn-network/trust-core` (DSSE + canonical JSON + digests).

---

## Global constraints

From program §5 (cross-plan contracts), plus this package's own:

1. **Designs are law.** Spec commit `5b0739832`. A defect found here is a dated Finding with a
   proposed disposition (see Findings), never a silent patch.
2. **Kits and fixtures precede implementations.** The admission kit (Task 9) is green before C4
   builds on this package (spec §11 ordering: record kit → verification kit → admission kit →
   derivation).
3. **Sealing is re-implemented per package** — but only for *record* sealing (C1). Admission
   signs through `trust-core`'s DSSE spine (spec §3.3: "verification **and admission**
   additionally depend on `trust/core` for DSSE (both sign)"). No local DSSE re-implementation.
4. **Custody law.** No key material, no ambient authority. The container runner and the DSSE
   signer are injected; no ambient `fetch`/`WebSocket`/`EventSource`/`XMLHttpRequest` and no
   `node:fs` in production source. Fail closed: every unproven condition refuses.
5. **No product names.** The identifiers `plugin`, `jinn-plugin`, `operator`, `autopilot`,
   `client` must not appear in source, exports, or dependencies. No unit imports
   `@jinn-network/core`, `@jinn-network/plugin`, `@jinn-network/jinn-layer`, or `client/`.
6. **Digest discipline.** Record-body and receipt-body digests are `sha256:`-prefixed lowercase
   hex; **in-toto DigestSet values (statement subjects, the Submission annotation descriptor) are
   bare hex** — the confusion fixture is mandatory in this kit.
7. **Attestation-agnostic** (spec §7.1). Attester policy in admission is a defect. Task 2 ships
   the test that keeps it true.
8. **Bounded claims.** No API name, error message, or log line may say "deterministic" or
   "verified" without the qualification the spec gives those words (D11). The family literal
   `"deterministic-process"` is a profiles term of art and is permitted; a bare "verified
   environment" in a message is not — say "record-matched" or name the check.
9. **Guards ship with the package.** The `packages/task-supply/` guard trio + CI land in Task 1
   and are extended in Task 9; C4–C6 append to them.
10. **TDD per task; verification before completion.** Every task ends with `yarn typecheck &&
    yarn test` in the package plus the guard scripts from the repository root, outputs shown,
    before the task is reported done.
11. **Stop on missing Consumes.** A C1 or trust-core symbol a task consumes that is not on the
    base branch is a stop-and-report, not an improvisation.
12. **Legacy is reference only.** `client/src/solver-types/_swe-rebench-v2-differential-admission.ts`
    and `_swe-rebench-v2-empirical-tests.ts` are read, never imported. This is a rewrite with its
    own tests; three deliberate departures are recorded in Task 4 and Task 7.

Package-local:

- Node `>=22`; `"type": "module"`; every relative import carries the `.js` extension.
- `src/index.ts` never re-exports `src/testing.ts`.
- No `localeCompare`, no `Intl` in production source — use `compareCodeUnitStrings` from
  `@jinn-network/trust-core`. The tree boundary guard fails the build otherwise.
- Refusals are **returned**, never thrown, at the `admitCandidate` boundary. Internally they
  propagate as `AdmissionRefusalError` and are converted once, at the top.

### Branch setup (run once, before Task 1)

```bash
cd /Users/adrianobradley/life\'s-work/jinn-mono
git fetch origin
git worktree add ../jinn-mono_worktrees/supply-c3-task-admission -b supply/c3-task-admission supply/c1-environment-record
cd ../jinn-mono_worktrees/supply-c3-task-admission
```

If `supply/c1-environment-record` does not exist yet, base on `integration/evidence-v1` and
restack when C1 lands: `git rebase --onto supply/c1-environment-record integration/evidence-v1 supply/c3-task-admission`.
**Every command in this plan runs from the worktree root** unless a `cd` says otherwise.

---

## File structure

All paths relative to `packages/task-supply/admission/` unless noted.

| File | Responsibility |
| --- | --- |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `.yarnrc.yml`, `vitest.config.ts`, `README.md` | package scaffold |
| `scripts/build.mjs`, `scripts/pack-smoke.mjs` | build + packed-tarball smoke |
| `src/identifiers.ts` | media type, schema/policy versions, predicate type, annotation URI, spec extension key |
| `src/refusals.ts` | the closed refusal taxonomy + `AdmissionRefusalError` + `refuse()` |
| `src/test-paths.ts` | traversal-safe repository-relative paths; targeted command binding |
| `src/observations.ts` | observation schema, repeat stability, derived transitions |
| `src/inline-match.ts` | the inline-match enforcement rule (normative rule 1) |
| `src/receipt.ts` | `DifferentialAdmissionReceiptV3Schema` + `verifyDifferentialAdmissionReceiptV3` |
| `src/admit.ts` | `admitCandidate`, the `runInEnvironment` port, deps + result types |
| `src/seal.ts` | `buildAdmissionStatement`, `sealReceipt`, `admissionReceiptAnnotation` |
| `src/index.ts` | public surface |
| `src/testing.ts` | the kit: fixtures + `describeTaskAdmissionConformance` |

Repository files this plan also creates or edits:

- `.github/scripts/task-supply-package-inventory.test.mjs` (new)
- `.github/scripts/task-supply-source-boundaries.test.mjs` (new)
- `.github/scripts/task-supply-packed-types.test.mjs` (new)
- `.github/workflows/task-supply-ci.yml` (new)
- `.gitignore` (append the `packages/task-supply/*` ignores)

---

### Task 1: Open the `packages/task-supply/` tree — scaffold, guard trio, CI

**Files:**
- Create: `packages/task-supply/admission/package.json`, `tsconfig.json`, `tsconfig.build.json`,
  `.yarnrc.yml`, `vitest.config.ts`, `README.md`, `scripts/build.mjs`, `scripts/pack-smoke.mjs`,
  `src/index.ts`
- Create: `.github/scripts/task-supply-package-inventory.test.mjs`,
  `.github/scripts/task-supply-source-boundaries.test.mjs`,
  `.github/scripts/task-supply-packed-types.test.mjs`,
  `.github/workflows/task-supply-ci.yml`
- Modify: `.gitignore` (after the `packages/marketplace/*` block, line 68)

**Interfaces:**
- Consumes: from branch `supply/c1-environment-record` — the package
  `@jinn-network/environment-record` at `packages/environments/record` (existence only at this
  task; symbols land in Task 3). From `integration/evidence-v1` —
  `@jinn-network/trust-core` at `packages/trust/core`.
- Produces: the directory `packages/task-supply/admission` publishing `@jinn-network/task-admission`
  with exports `.` and `./testing`; the `task-supply` guard trio and CI workflow.

- [ ] **Step 1: Write the inventory guard first, so it fails**

Create `.github/scripts/task-supply-package-inventory.test.mjs` (modeled on
`.github/scripts/benchmarking-package-inventory.test.mjs`, whose cardinality-free roster pattern
this copies):

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const packageRoot = join(root, 'packages', 'task-supply');
const DEPENDENCY_SECTIONS = [
  'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies',
];

// C4 (derivation), C5 (posting), and C6 (curation) append their rows here as they land.
const TASK_SUPPLY_PACKAGES = [
  ['admission', '@jinn-network/task-admission'],
];

// Cross-tree Jinn dependencies live outside packages/task-supply; map name -> absolute dir.
const SIBLING_TREE_DIRS = new Map([
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
]);

// Admission consumes environments/record types + digests and trust-core's DSSE spine, and
// nothing else (design §3.3). Every addition to this graph is a design question first.
const JINN_DEPENDENCY_GRAPH = new Map([
  ['admission', {
    dependencies: ['@jinn-network/environment-record', '@jinn-network/trust-core'],
    devDependencies: [], optionalDependencies: [], peerDependencies: [],
  }],
]);

function readPackage(directory) {
  const packageJson = join(packageRoot, directory, 'package.json');
  assert.ok(existsSync(packageJson), `missing package manifest: ${packageJson}`);
  return JSON.parse(readFileSync(packageJson, 'utf8'));
}

function packageManifests(directory) {
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
  const inTree = TASK_SUPPLY_PACKAGES.find(([, name]) => name === dependencyName);
  const targetDir = inTree ? join(packageRoot, inTree[0]) : SIBLING_TREE_DIRS.get(dependencyName);
  assert.ok(targetDir, `${directory} declares unknown Jinn dependency ${dependencyName}`);
  return `portal:${relative(join(packageRoot, directory), targetDir) || '.'}`;
}

test('the task-supply package inventory is explicit and derives cardinality from the live declaration', () => {
  for (const [directory, expectedName] of TASK_SUPPLY_PACKAGES) {
    const manifest = readPackage(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(
      manifest.repository?.directory,
      `packages/task-supply/${directory}`,
      `${expectedName} has a stale repository directory`,
    );
  }
  const actual = packageManifests(join(root, 'packages'))
    .flatMap((packageJson) => {
      const { name } = JSON.parse(readFileSync(packageJson, 'utf8'));
      return /^@jinn-network\/task-(admission|derivation|posting|curation)$/.test(name)
        ? [[relative(packageRoot, dirname(packageJson)), name]]
        : [];
    }).sort(([left], [right]) => left.localeCompare(right));
  assert.deepEqual(actual, [...TASK_SUPPLY_PACKAGES].sort(([left], [right]) => left.localeCompare(right)));
  assert.equal(actual.length, TASK_SUPPLY_PACKAGES.length);
});

test('the inventory guard itself contains no hardcoded package-cardinality assertion', () => {
  const source = readFileSync(import.meta.filename, 'utf8');
  assert.doesNotMatch(source, /TASK_SUPPLY_PACKAGES\.length\s*,\s*\d+/);
});

test('task-supply package Jinn dependencies and portal resolutions match the approved graph', () => {
  for (const [directory] of TASK_SUPPLY_PACKAGES) {
    const manifest = readPackage(directory);
    const approved = JINN_DEPENDENCY_GRAPH.get(directory);
    assert.ok(approved, `missing dependency graph entry for ${directory}`);
    for (const section of DEPENDENCY_SECTIONS) {
      assert.deepEqual(jinnDependencyNames(manifest, section), approved[section],
        `${directory} has unapproved Jinn ${section}`);
    }
    const declared = DEPENDENCY_SECTIONS.flatMap((section) => jinnDependencyNames(manifest, section)).sort();
    const portalResolutions = [...(approved.portalResolutions ?? [])].sort();
    const resolutions = manifest.resolutions ?? {};
    const resolved = Object.keys(resolutions).filter((name) => name.startsWith('@jinn-network/')).sort();
    assert.deepEqual(resolved, [...declared, ...portalResolutions].sort(),
      `${directory} has unmatched Jinn resolutions`);
    for (const dependencyName of [...declared, ...portalResolutions]) {
      assert.equal(resolutions[dependencyName], expectedPortal(directory, dependencyName),
        `${directory} must resolve ${dependencyName} through its matching portal`);
    }
  }
});
```

Note `localeCompare` is used **only inside the guard script** (a `node --test` file outside any
package's `src/`), matching the benchmarking precedent; production source may not use it.

Run: `node --test .github/scripts/task-supply-package-inventory.test.mjs`
Expected: FAIL — `missing package manifest: …/packages/task-supply/admission/package.json`.

- [ ] **Step 2: Create the package scaffold**

`packages/task-supply/admission/package.json`:

```json
{
  "name": "@jinn-network/task-admission",
  "version": "0.1.0",
  "description": "Source-agnostic differential admission: candidate task + environment record to a sealed DifferentialAdmissionReceipt/3.",
  "type": "module",
  "packageManager": "yarn@4.13.0",
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "repository": {
    "type": "git",
    "url": "https://github.com/Jinn-Network/mono.git",
    "directory": "packages/task-supply/admission"
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./testing": {
      "import": "./dist/testing.js",
      "types": "./dist/testing.d.ts"
    }
  },
  "files": [
    "dist/",
    "README.md"
  ],
  "publishConfig": {
    "access": "public"
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "test": "vitest run",
    "pack:smoke": "node scripts/pack-smoke.mjs",
    "prepack": "yarn build"
  },
  "dependencies": {
    "@jinn-network/environment-record": "0.1.0",
    "@jinn-network/trust-core": "0.1.0",
    "zod": "4.4.3"
  },
  "peerDependencies": {
    "vitest": "^4.1.8"
  },
  "peerDependenciesMeta": {
    "vitest": {
      "optional": true
    }
  },
  "resolutions": {
    "@jinn-network/environment-record": "portal:../../environments/record",
    "@jinn-network/trust-core": "portal:../../trust/core"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.8"
  }
}
```

`.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

`tsconfig.json`:

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
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

`tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["src/**/*.test.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
```

`scripts/build.mjs` — copy `packages/benchmarking/aggregate/scripts/build.mjs` verbatim (it is
package-root relative and has no benchmarking-specific content).

`src/index.ts` (placeholder for this task only; Task 8 replaces it):

```ts
// SPDX-License-Identifier: Apache-2.0
export {};
```

`README.md`:

```markdown
# @jinn-network/task-admission

Differential admission: *(candidate task + environment record) → `DifferentialAdmissionReceipt/3`*.

Given a candidate's sealed EvaluationSpec bytes and the sealed bytes of the environment record it
names, this package proves — per test path, twice on each side — that applying the gold patch
resolves the candidate's failing assertions and that the empty patch does not. The proof is a
receipt: policy version, task binding, `goldPatchHash` (a digest; never patch bytes), the 2×2
observations, the derived transitions, and `environment.recordDigest`.

Two rules define the boundary (design §7.1):

- **Inline match is enforced.** The EvaluationSpec's inline `image`, `platform`, and `parser` must
  equal the referenced record's, or admission refuses with `env-record-mismatch`.
- **Admission never reads attestations.** The receipt cites the environment record by digest and
  claims nothing about who attested it. Joining a receipt to attestations is the *consumer's*
  trust-policy decision.

Admission owns no container runtime: `runInEnvironment` is an injected port. It owns no key
material: `sealReceipt` takes a `DsseSigner`.
```

- [ ] **Step 3: Install and re-run the inventory guard**

Run: `cd packages/task-supply/admission && yarn install && cd - && node --test .github/scripts/task-supply-package-inventory.test.mjs`
Expected: PASS (3 tests) — one manifest, dependency graph and portal resolutions match.

- [ ] **Step 4: Create the source-boundary guard**

```bash
cp .github/scripts/benchmarking-source-boundaries.test.mjs .github/scripts/task-supply-source-boundaries.test.mjs
```

Then edit `.github/scripts/task-supply-source-boundaries.test.mjs`:

1. Replace the header constants (everything from `const packages = …` down to
   `const MARKETPLACE_FORBIDDEN_EXTRA = […];`) with:

```js
const packages = join(root, 'packages', 'task-supply');
const taskSupplyDirectories = ['admission'];

// The whole task-supply tree is forbidden the frozen trio, every evidence/discovery/marketplace
// package, every task-execution package, and every chain/storage client. Admission additionally
// may never import an environment-verification or attestation package (design §7.1: admission is
// attestation-agnostic; program contract 7). C4/C5/C6 carve out their own allowances when they
// land — C5 is the only future package that may import `@jinn-network/marketplace-binding`.
const TASK_SUPPLY_FOREIGN_PACKAGES = [
  '@jinn-network/core',
  '@jinn-network/plugin',
  '@jinn-network/jinn-layer',
  '@jinn-network/environment-verification',
  '@jinn-network/attestation-issuer',
  '@jinn-network/evidence-*',
  '@jinn-network/execution-recorder',
  '@jinn-network/execution-recorder-bridge',
  '@jinn-network/record-discovery-*',
  '@jinn-network/marketplace-*',
  '@jinn-network/task-execution-*',
  '@jinn-network/benchmarking-*',
  'viem',
  'better-sqlite3',
  'kubo-rpc-client',
  'dockerode',
];

// Relative-path escapes into the legacy tree, the marketplace tree, and the sibling
// verification package are caught the same way a package-name ban would not catch them.
const FORBIDDEN_ROOTS = [
  join(root, 'client'),
  join(root, 'packages', 'marketplace'),
  join(root, 'packages', 'environments', 'verification'),
];

// Admission's approved Jinn imports are exactly two packages (design §3.3): environments/record
// and trust-core. Nothing else in the monorepo is reachable from its production source.
const ADMISSION_FORBIDDEN_EXTRA = [
  '@jinn-network/task-derivation',
  '@jinn-network/task-posting',
  '@jinn-network/task-curation',
];
```

2. Replace the two benchmarking-specific tests (`'the marketplace-family wildcard bans …'` and
   `'marketplace may import binding and projector; …'`) with one task-supply test:

```js
test('the attestation and verification bans hold by exact name and by wildcard family', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'jinn-task-supply-attestation-ban-'));
  try {
    const source = join(fixture, 'src');
    mkdirSync(source);
    writeFileSync(join(source, 'source.ts'), [
      'import { verifyEnvironment } from "@jinn-network/environment-verification";',
      'import { issue } from "@jinn-network/attestation-issuer";',
      'import { put } from "@jinn-network/evidence-repository";',
      'import { postTask } from "@jinn-network/marketplace-binding";',
    ].join('\n'));
    assert.equal(forbiddenImports(source, TASK_SUPPLY_FOREIGN_PACKAGES).length, 4);
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
```

3. Replace the `'benchmarking source boundaries remain one-way across the approved graph'` test
   body with:

```js
test('task-supply source boundaries remain one-way across the approved graph', () => {
  // admission imports environments/record + trust-core only (design §3.3).
  assertBoundary(
    join(packages, 'admission', 'src'),
    [...TASK_SUPPLY_FOREIGN_PACKAGES, ...ADMISSION_FORBIDDEN_EXTRA],
    FORBIDDEN_ROOTS,
  );
});
```

4. Rename the remaining `benchmarkingDirectories` references to `taskSupplyDirectories`, the two
   tree-wide test titles to `'Task Supply production source never uses ambient network APIs'` and
   `'Task Supply production source never orders or formats with the host locale'`, every
   `jinn-benchmarking-` tmp-dir prefix to `jinn-task-supply-`, and the `assertBoundary` failure
   message from `crosses a benchmarking architecture boundary` to
   `crosses a task-supply architecture boundary`. In the locale test's guidance string, replace
   `Use src/order.ts.` with `Use compareCodeUnitStrings from @jinn-network/trust-core.`

Run: `node --test .github/scripts/task-supply-source-boundaries.test.mjs`
Expected: PASS (5 tests) — the scanner self-tests plus the boundary test over an `src/`
containing only the placeholder `index.ts`.

- [ ] **Step 5: Create the packed-types canary**

```bash
cp .github/scripts/benchmarking-packed-types.test.mjs .github/scripts/task-supply-packed-types.test.mjs
```

Then edit `.github/scripts/task-supply-packed-types.test.mjs`:

1. `const benchmarkingRoot = …` → `const taskSupplyRoot = join(root, 'packages', 'task-supply');`
   and update its two uses; the tmp prefix becomes `'jinn-task-supply-packed-types-'`.
2. Replace the three arrays:

```js
const packages = [
  ['admission', '@jinn-network/task-admission'],
];

const codeEntrypoints = [
  '@jinn-network/task-admission',
  '@jinn-network/task-admission/testing',
];

// Cross-tree Jinn dependencies packed as file: deps so NodeNext resolves them.
const CROSS_TREE_PACKAGES = [
  ['@jinn-network/environment-record', join(root, 'packages', 'environments', 'record')],
  ['@jinn-network/trust-core', join(root, 'packages', 'trust', 'core')],
];
```

3. In the consumer `package.json` dependency list, keep `@types/node`, `typescript`, `vitest`
   (the `./testing` entrypoint declares vitest as an optional peer, so the consumer must supply
   it for the type-level import to resolve).
4. Change the final `console.log` text to
   `` `Compiled a packed TypeScript consumer against ${codeEntrypoints.length} public code entrypoints across all ${packages.length} task-supply packages.` ``

Do not run it yet — `dist/testing.js` does not exist until Task 9. It runs in Step 8 of Task 9.

- [ ] **Step 6: Create the CI workflow**

`.github/workflows/task-supply-ci.yml`:

```yaml
name: Task Supply CI

on:
  pull_request:
  push:
    branches: [next]
    paths:
      - "packages/task-supply/**"
      - "packages/environments/**"
      - ".github/scripts/task-supply-*.test.mjs"
      - ".github/workflows/task-supply-ci.yml"
      - "docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md"

permissions:
  contents: read

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Verify package inventory and dependency graph
        run: node --test .github/scripts/task-supply-package-inventory.test.mjs
      - name: Verify source boundaries and canaries
        run: node --test .github/scripts/task-supply-source-boundaries.test.mjs

  admission:
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
      - name: Build cross-tree portal dependencies from source
        run: |
          (cd packages/trust/core && yarn install --immutable && yarn build)
          (cd packages/environments/record && yarn install --immutable && yarn build)
      - name: Verify Task Admission
        working-directory: packages/task-supply/admission
        run: |
          yarn install --immutable
          yarn typecheck
          yarn test
          yarn build
          yarn pack:smoke
      - name: Upload Task Admission distribution
        uses: actions/upload-artifact@v4
        with:
          name: task-supply-admission-dist
          path: packages/task-supply/admission/dist
          if-no-files-found: error
          retention-days: 1

  verify:
    needs: [architecture, admission]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Require every Task Supply CI stage to succeed
        env:
          ARCHITECTURE_RESULT: ${{ needs.architecture.result }}
          ADMISSION_RESULT: ${{ needs.admission.result }}
        run: |
          for result in \
            "$ARCHITECTURE_RESULT" \
            "$ADMISSION_RESULT"; do
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
          pattern: task-supply-*-dist
          path: .task-supply-dist
      - name: Place package distributions
        run: |
          mkdir -p packages/task-supply/admission/dist
          cp -R .task-supply-dist/task-supply-admission-dist/. packages/task-supply/admission/dist/
      - name: Build cross-tree portal dependencies from source
        run: |
          (cd packages/trust/core && yarn install --immutable && yarn build)
          (cd packages/environments/record && yarn install --immutable && yarn build)
      - name: Compile packed public entrypoint consumers
        run: node .github/scripts/task-supply-packed-types.test.mjs
```

- [ ] **Step 7: Register the tree's build artifacts in `.gitignore`**

In `.gitignore`, after the `packages/marketplace/*` block (line 68), add:

```gitignore
packages/task-supply/*/dist/
packages/task-supply/*/.yarn/cache/
packages/task-supply/*/.yarn/install-state.gz
```

(`packages/*/node_modules/` at line 39 does not cover two-level trees; confirm
`packages/task-supply/admission/node_modules` is ignored — if `git status` shows it, add
`packages/task-supply/*/node_modules/` immediately above.)

- [ ] **Step 8: Write the pack smoke script**

`scripts/pack-smoke.mjs` — start from `packages/benchmarking/aggregate/scripts/pack-smoke.mjs`
and change the portal roots, archives, and smoke body:

```js
const environmentRecordRoot = join(packageRoot, "..", "..", "environments", "record");
const trustCoreRoot = join(packageRoot, "..", "..", "trust", "core");
const temporaryRoot = await mkdtemp(join(tmpdir(), "jinn-task-admission-"));
```

```js
  const trustCoreArchive = await packOne(trustCoreRoot, "trust-core.tgz");
  const environmentRecordArchive = await packOne(environmentRecordRoot, "environment-record.tgz");
  const admissionArchive = await packOne(packageRoot, "task-admission.tgz");
```

dependencies:

```js
      dependencies: {
        "@jinn-network/trust-core": `file:${trustCoreArchive}`,
        "@jinn-network/environment-record": `file:${environmentRecordArchive}`,
        "@jinn-network/task-admission": `file:${admissionArchive}`,
      },
```

smoke body:

```js
import { readFile } from "node:fs/promises";
import { ADMISSION_REFUSAL_CODES, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "@jinn-network/task-admission";
if (!ADMISSION_REFUSAL_CODES.includes("env-record-mismatch")) {
  throw new Error("root import failed: the refusal taxonomy is missing env-record-mismatch");
}
if (DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide !== 2) {
  throw new Error("root import failed: the policy is not the 2x2 policy");
}
const packageJson = JSON.parse(await readFile(<installedRoot>/package.json, "utf8"));
const jinnDependencies = Object.keys(packageJson.dependencies ?? {}).filter((name) => name.startsWith("@jinn-network/")).sort();
const expectedJinnDependencies = ["@jinn-network/environment-record", "@jinn-network/trust-core"];
if (jinnDependencies.join(",") !== expectedJinnDependencies.join(",")) {
  throw new Error("unexpected Jinn coupling: " + jinnDependencies.join(", "));
}
console.log("Installed package imports and dependency boundary verified.");
```

(keep the aggregate script's `${JSON.stringify(join(installedRoot, "package.json"))}`
interpolation for the path, and its trailing `dist` test-leak check.)

`yarn pack:smoke` cannot pass until Task 2 exports those two symbols; it first runs in Task 2.

- [ ] **Step 9: Verify and commit**

Run:

```bash
cd packages/task-supply/admission && yarn install && yarn typecheck && yarn build && cd -
node --test .github/scripts/task-supply-package-inventory.test.mjs
node --test .github/scripts/task-supply-source-boundaries.test.mjs
git status --short
```

Expected: typecheck and build PASS; both guards PASS; `git status` shows no `node_modules` or
`dist` entries.

```bash
git add packages/task-supply .github/scripts/task-supply-package-inventory.test.mjs .github/scripts/task-supply-source-boundaries.test.mjs .github/scripts/task-supply-packed-types.test.mjs .github/workflows/task-supply-ci.yml .gitignore
git commit -m "feat(task-admission): open the task-supply tree with the admission package scaffold, guard trio, and CI"
```

---

### Task 2: Identifiers, the closed refusal taxonomy, and attestation-agnosticism

**Files:**
- Create: `src/identifiers.ts`, `src/identifiers.test.ts`, `src/refusals.ts`,
  `src/refusals.test.ts`, `src/attestation-agnostic.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: nothing outside the package.
- Produces: `ADMISSION_RECEIPT_SCHEMA_VERSION`, `DIFFERENTIAL_ADMISSION_POLICY_V3`,
  `DIFFERENTIAL_ADMISSION_PREDICATE_TYPE`, `ADMISSION_RECEIPT_ANNOTATION_URI`,
  `ADMISSION_RECEIPT_DESCRIPTOR_NAME`, `ADMISSION_RECEIPT_MEDIA_TYPE`,
  `ENVIRONMENT_RECORD_SPEC_KEY`, `ADMISSION_REFUSAL_CODES`, `AdmissionRefusalCode`,
  `AdmissionRefusal`, `AdmissionRefusalError`, `refuse`.

- [ ] **Step 1: Write the identifier tests first**

`src/identifiers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  ADMISSION_RECEIPT_DESCRIPTOR_NAME,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  ADMISSION_RECEIPT_SCHEMA_VERSION,
  DIFFERENTIAL_ADMISSION_POLICY_V3,
  DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
  ENVIRONMENT_RECORD_SPEC_KEY,
} from "./identifiers.js";

describe("identifiers", () => {
  it("pins the Submission annotation contract the marketplace evaluation leg validates", () => {
    // Byte-identical counterparts in packages/marketplace/binding/src/evaluation-derive.ts
    // (ADMISSION_RECEIPT_ANNOTATION_URI) and its `receipt.name !== "admission-receipt"` check.
    // That tree is outside this package's import boundary, so the strings are pinned, not shared.
    expect(ADMISSION_RECEIPT_ANNOTATION_URI).toBe(
      "https://jinn.network/annotations/admission-receipt/1.0",
    );
    expect(ADMISSION_RECEIPT_DESCRIPTOR_NAME).toBe("admission-receipt");
  });

  it("seals under the in-toto DSSE payload type the verdict gate requires", () => {
    // packages/marketplace/binding/src/named-checks.ts rejects an admission receipt whose
    // envelope payloadType is not VERDICT_DSSE_PAYLOAD_TYPE
    // (packages/task-execution/profiles/src/identifiers.ts = "application/vnd.in-toto+json").
    expect(ADMISSION_RECEIPT_MEDIA_TYPE).toBe("application/vnd.in-toto+json");
  });

  it("names the receipt kind and policy under jinn.network URIs", () => {
    expect(ADMISSION_RECEIPT_SCHEMA_VERSION).toBe(
      "https://jinn.network/records/differential-admission-receipt/3",
    );
    expect(DIFFERENTIAL_ADMISSION_PREDICATE_TYPE).toBe(
      "https://jinn.network/attestations/differential-admission/v3",
    );
    expect(DIFFERENTIAL_ADMISSION_POLICY_V3).toStrictEqual({
      admissionPolicyVersion: "https://jinn.network/task-admission/policy/3",
      observationsPerSide: 2,
      requireFailToPassPerPath: true,
      requireGloballyUniqueAssertionIds: true,
      requireInlineEnvironmentMatch: true,
    });
  });

  it("pins the namespaced EvaluationSpec key that carries the environment-record reference", () => {
    expect(ENVIRONMENT_RECORD_SPEC_KEY).toBe("network.jinn.environment.record");
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./identifiers.js"`.

- [ ] **Step 2: Write `src/identifiers.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

/**
 * DSSE `payloadType` for a sealed receipt. The receipt is the *predicate* of an in-toto
 * Statement, so the envelope seals under the generic in-toto payload type — the exact value
 * `packages/marketplace/binding/src/named-checks.ts` requires of an admission receipt
 * (`VERDICT_DSSE_PAYLOAD_TYPE`). Design §7.1: this unit conforms to the existing contract
 * rather than defining a new one.
 */
export const ADMISSION_RECEIPT_MEDIA_TYPE = "application/vnd.in-toto+json" as const;

/** in-toto Statement `_type`, mirrored structurally (never imported across trees). */
export const IN_TOTO_STATEMENT_TYPE = "https://in-toto.io/Statement/v1" as const;

/** Receipt kind — spec §15's `DifferentialAdmissionReceipt/3`, as a URI. */
export const ADMISSION_RECEIPT_SCHEMA_VERSION =
  "https://jinn.network/records/differential-admission-receipt/3" as const;

/** in-toto `predicateType` of the Statement whose predicate is the receipt. */
export const DIFFERENTIAL_ADMISSION_PREDICATE_TYPE =
  "https://jinn.network/attestations/differential-admission/v3" as const;

/**
 * The public, versioned evidence policy this package implements (design §7.1). It is a policy
 * about *this* candidate's grader, and says nothing about the environment beyond the record
 * digest it names.
 */
export const DIFFERENTIAL_ADMISSION_POLICY_V3 = {
  admissionPolicyVersion: "https://jinn.network/task-admission/policy/3",
  /** Repeats per side, per path: empty x2 and gold x2. */
  observationsPerSide: 2,
  requireFailToPassPerPath: true,
  requireGloballyUniqueAssertionIds: true,
  requireInlineEnvironmentMatch: true,
} as const;

/**
 * Namespaced EvaluationSpec extension key carrying the environment-record reference
 * (design §7.2). Declared here because admission enforces it; the derivation unit writes it.
 * See Finding F-C3-3.
 */
export const ENVIRONMENT_RECORD_SPEC_KEY = "network.jinn.environment.record" as const;

/**
 * Submission annotation URI under which a sealed receipt is referenced, and the descriptor
 * `name` the evaluation leg requires. Byte-identical counterparts live in
 * `packages/marketplace/binding/src/evaluation-derive.ts`; that tree is outside this package's
 * import boundary (design §3.3), so the strings are pinned by test, not shared by import.
 */
export const ADMISSION_RECEIPT_ANNOTATION_URI =
  "https://jinn.network/annotations/admission-receipt/1.0" as const;
export const ADMISSION_RECEIPT_DESCRIPTOR_NAME = "admission-receipt" as const;
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: PASS (4 tests).

- [ ] **Step 3: Write the refusal-taxonomy tests**

`src/refusals.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  ADMISSION_REFUSAL_CODES,
  AdmissionRefusalError,
  AdmissionRefusalCodeSchema,
  refuse,
} from "./refusals.js";

describe("the refusal taxonomy", () => {
  it("is closed and exactly these seven codes", () => {
    expect([...ADMISSION_REFUSAL_CODES]).toStrictEqual([
      "duplicate-assertion-id",
      "env-record-mismatch",
      "execution-failed",
      "invalid-candidate",
      "invalid-environment-record",
      "no-discrimination",
      "unstable-observations",
    ]);
  });

  it("rejects a code outside the taxonomy", () => {
    expect(AdmissionRefusalCodeSchema.safeParse("nope").success).toBe(false);
    expect(AdmissionRefusalCodeSchema.safeParse("env-record-mismatch").success).toBe(true);
  });

  it("carries the code and detail on the thrown error and on its refusal", () => {
    try {
      refuse("env-record-mismatch", "inline platform linux/arm64 is not linux/amd64");
      expect.unreachable("refuse must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdmissionRefusalError);
      const refusal = (error as AdmissionRefusalError).refusal;
      expect(refusal.code).toBe("env-record-mismatch");
      expect(refusal.detail).toBe("inline platform linux/arm64 is not linux/amd64");
      expect((error as Error).message).toBe(
        "env-record-mismatch: inline platform linux/arm64 is not linux/amd64",
      );
    }
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./refusals.js"`.

- [ ] **Step 4: Write `src/refusals.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * The closed admission refusal taxonomy. Small on purpose: a consumer routes on these codes, so
 * every addition is a contract change. Sorted by code so the tuple reads as the closed set it is.
 *
 * - `duplicate-assertion-id`  a raw assertion identifier was observed under more than one test
 *   path, so per-path evidence cannot be attributed.
 * - `env-record-mismatch`     the candidate's inline environment fields, or its
 *   environment-record reference, do not equal the record admission was given (design §7.1,
 *   normative rule 1).
 * - `execution-failed`        the injected runner did not produce a usable observation for a
 *   required cell: it threw, or it reported applying material other than the candidate's
 *   declared gold patch.
 * - `invalid-candidate`       the candidate is structurally unusable: wrong grader family, a
 *   malformed inline block, a digest in the wrong spelling, or an unsafe test path.
 * - `invalid-environment-record`  the supplied record bytes do not parse, or the record does not
 *   support per-path targeted admission (no single targetable test command).
 * - `no-discrimination`       a test path produced no fail-to-pass assertion: the suite does not
 *   discriminate, so there is nothing to admit.
 * - `unstable-observations`   the two repeats on a side were not canonical-JSON identical.
 */
export const ADMISSION_REFUSAL_CODES = [
  "duplicate-assertion-id",
  "env-record-mismatch",
  "execution-failed",
  "invalid-candidate",
  "invalid-environment-record",
  "no-discrimination",
  "unstable-observations",
] as const;

export type AdmissionRefusalCode = (typeof ADMISSION_REFUSAL_CODES)[number];

export const AdmissionRefusalCodeSchema = z.enum(ADMISSION_REFUSAL_CODES);

export interface AdmissionRefusal {
  readonly code: AdmissionRefusalCode;
  readonly detail: string;
}

/**
 * Internal control-flow carrier. Refusals are *returned* at the `admitCandidate` boundary; this
 * error exists so deep checks can fail closed without threading result types through every call.
 */
export class AdmissionRefusalError extends Error {
  readonly refusal: AdmissionRefusal;

  constructor(code: AdmissionRefusalCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "AdmissionRefusalError";
    this.refusal = { code, detail };
  }
}

export function refuse(code: AdmissionRefusalCode, detail: string): never {
  throw new AdmissionRefusalError(code, detail);
}
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the attestation-agnosticism guard test (contract 7)**

`src/attestation-agnostic.test.ts`:

```ts
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(sourceRoot, "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

function importSpecifiers(source: string): string[] {
  return [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1] as string);
}

describe("admission is attestation-agnostic by construction (design §7.1, program contract 7)", () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  it("declares exactly two Jinn dependencies and no verification or issuer package", () => {
    const jinn = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].filter((name) => name.startsWith("@jinn-network/")).sort();
    expect(jinn).toStrictEqual([
      "@jinn-network/environment-record",
      "@jinn-network/trust-core",
    ]);
  });

  it("imports no attestation or environment-verification module anywhere in the package", () => {
    const offenders = sourceFiles(sourceRoot).flatMap((file) =>
      importSpecifiers(readFileSync(file, "utf8"))
        .filter((specifier) => /attestation|environment-verification/i.test(specifier))
        .map((specifier) => `${file} -> ${specifier}`),
    );
    expect(offenders).toStrictEqual([]);
  });

  it("exports no symbol whose name claims anything about attestations", async () => {
    const surface = await import("./index.js");
    const offenders = Object.keys(surface).filter((name) => /attest/i.test(name));
    expect(offenders).toStrictEqual([]);
  });
});
```

The `predicateType` URI string contains `attestations` (house convention,
`RESULT_EVALUATION_PREDICATE_TYPE` precedent) — the rule this test enforces is the real one:
admission has no attestation *dependency*, *import*, or *exported symbol*, and never reads an
attestation to decide anything.

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — the third test cannot resolve `./index.js` exports (the placeholder exports
nothing, so `Object.keys` is empty and the test passes; the first two pass). If all three pass,
that is the expected state at this task.

- [ ] **Step 6: Export from the public surface**

`src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export * from "./identifiers.js";
export * from "./refusals.js";
```

- [ ] **Step 7: Verify and commit**

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck && yarn build && yarn pack:smoke`
Expected: PASS (10 tests); `dist/` produced; the pack smoke prints
`Installed package imports and dependency boundary verified.`

```bash
git add packages/task-supply/admission/src packages/task-supply/admission/scripts
git commit -m "feat(task-admission): identifiers, the closed refusal taxonomy, and the attestation-agnosticism guard"
```

---

### Task 3: Traversal-safe test paths and targeted command binding

Port of the legacy `validateRelativeSegments` / `commandCwdSegments` /
`targetRecipeCommandForTestPath` (reference:
`client/src/solver-types/_swe-rebench-v2-differential-admission.ts:110-174`) onto C1's
`CommandSpecSchema` and `EnvironmentRecord`. Rewrite, own tests (contract 12).

**Files:**
- Create: `src/test-paths.ts`, `src/test-paths.test.ts`

**Interfaces:**
- Consumes: from branch `supply/c1-environment-record`, package `@jinn-network/environment-record`
  — `CommandSpecSchema` (pinned, program §4) and the type `EnvironmentRecord`. The command type
  is derived locally as `z.infer<typeof CommandSpecSchema>` so this task depends on exactly one
  pinned symbol. **Stop-and-report** if `CommandSpecSchema` is not exported from C1's root.
- Produces: `normalizeRepositoryPath(rawPath, label): string`,
  `targetTestCommandForPath(record, repositoryRelativeTestPath): CommandSpec`, type `CommandSpec`.

- [ ] **Step 1: Write the tests first**

`src/test-paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AdmissionRefusalError } from "./refusals.js";
import { normalizeRepositoryPath, targetTestCommandForPath } from "./test-paths.js";

const record = {
  workspace: "/testbed",
  invocations: {
    test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }],
  },
} as never;

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("normalizeRepositoryPath", () => {
  it("normalizes a relative path to its canonical segments", () => {
    expect(normalizeRepositoryPath("tests/./unit/test_thing.py", "test path"))
      .toBe("tests/unit/test_thing.py");
  });

  it.each([
    ["", "must not be empty"],
    ["/etc/passwd", "must be repository-relative"],
    ["../outside/test_thing.py", "must not contain traversal"],
    ["tests/../../test_thing.py", "must not contain traversal"],
    ["-rf/test_thing.py", "must not contain option-shaped segments"],
  ])("refuses %s as invalid-candidate", (rawPath, fragment) => {
    const refusal = refusalOf(() => normalizeRepositoryPath(rawPath, "test path"));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain(fragment);
  });
});

describe("targetTestCommandForPath", () => {
  it("appends exactly one workspace-relative target to the single test command", () => {
    expect(targetTestCommandForPath(record, "tests/unit/test_thing.py")).toStrictEqual({
      bin: "python",
      args: ["-m", "pytest", "-rA", "tests/unit/test_thing.py"],
      cwd: "/testbed",
    });
  });

  it("scopes the target to a nested command cwd", () => {
    const nested = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    expect(targetTestCommandForPath(nested, "pkg/tests/test_thing.py").args)
      .toStrictEqual(["tests/test_thing.py"]);
  });

  it("refuses a path outside the test command's working directory", () => {
    const nested = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(nested, "other/test_thing.py"));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("outside the test command workspace");
  });

  it("refuses a record whose test scope is not a single targetable command", () => {
    const twoCommands = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [] }, { bin: "tox", args: [] }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(twoCommands, "tests/test_thing.py"));
    expect(refusal.code).toBe("invalid-environment-record");
    expect(refusal.detail).toContain("exactly one targetable test command");
  });

  it("refuses a record whose workspace is not a safe absolute path", () => {
    const unsafe = {
      workspace: "/testbed/../etc",
      invocations: { test: [{ bin: "pytest", args: [], cwd: "/testbed/pkg" }] },
    } as never;
    const refusal = refusalOf(() => targetTestCommandForPath(unsafe, "pkg/tests/test_thing.py"));
    expect(refusal.code).toBe("invalid-environment-record");
    expect(refusal.detail).toContain("workspace is unsafe");
  });

  it("preserves a command's declared env without aliasing it", () => {
    const withEnv = {
      workspace: "/testbed",
      invocations: { test: [{ bin: "pytest", args: [], env: { PYTHONHASHSEED: "0" } }] },
    } as never;
    const command = targetTestCommandForPath(withEnv, "tests/test_thing.py");
    expect(command.env).toStrictEqual({ PYTHONHASHSEED: "0" });
    expect(command.env).not.toBe(withEnv.invocations.test[0].env);
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./test-paths.js"`.

- [ ] **Step 2: Write `src/test-paths.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { posix as path } from "node:path";
import { CommandSpecSchema, type EnvironmentRecord } from "@jinn-network/environment-record";
import type { z } from "zod";
import { refuse } from "./refusals.js";

/** The shell-free command shape, derived from C1's pinned schema (never re-declared). */
export type CommandSpec = z.infer<typeof CommandSpecSchema>;

function segments(rawPath: string, label: string): string[] {
  if (rawPath === "") refuse("invalid-candidate", `${label} must not be empty`);
  if (path.isAbsolute(rawPath)) {
    refuse("invalid-candidate", `${label} must be repository-relative, not absolute`);
  }
  const raw = rawPath.split("/");
  if (raw.includes("..")) refuse("invalid-candidate", `${label} must not contain traversal`);
  if (raw.some((segment) => segment.startsWith("-"))) {
    refuse("invalid-candidate", `${label} must not contain option-shaped segments`);
  }
  const normalized = path.normalize(rawPath);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    refuse("invalid-candidate", `${label} escapes the repository workspace`);
  }
  return normalized.split("/").filter((segment) => segment !== "." && segment !== "");
}

/** Normalize a repository-relative path, refusing anything that could escape the workspace. */
export function normalizeRepositoryPath(rawPath: string, label: string): string {
  return segments(rawPath, label).join("/");
}

function commandCwdSegments(record: EnvironmentRecord, command: CommandSpec): string[] {
  if (command.cwd === undefined) return [];
  const workspace = record.workspace;
  if (!path.isAbsolute(workspace) || workspace.split("/").includes("..")) {
    refuse("invalid-environment-record", "the record workspace is unsafe");
  }
  if (path.isAbsolute(command.cwd)) {
    const normalizedWorkspace = path.normalize(workspace);
    const normalizedCwd = path.normalize(command.cwd);
    if (normalizedCwd === normalizedWorkspace) return [];
    if (!normalizedCwd.startsWith(`${normalizedWorkspace}/`)) {
      refuse("invalid-environment-record", "the test command cwd escapes the record workspace");
    }
    return segments(normalizedCwd.slice(normalizedWorkspace.length + 1), "test command cwd");
  }
  return segments(command.cwd, "test command cwd");
}

/**
 * Select the record's only targetable test-command template and append exactly one path scoped to
 * that command's working directory. The command stays structured — no shell, ever — and is what
 * the receipt binds by hash.
 */
export function targetTestCommandForPath(
  record: EnvironmentRecord,
  repositoryRelativeTestPath: string,
): CommandSpec {
  const templates = record.invocations.test;
  if (templates.length !== 1) {
    refuse(
      "invalid-environment-record",
      "exactly one targetable test command is required for per-path admission",
    );
  }
  const template = CommandSpecSchema.parse(templates[0]);

  const pathSegments = segments(repositoryRelativeTestPath, "test path");
  const cwdSegments = commandCwdSegments(record, template);
  if (!cwdSegments.every((segment, index) => pathSegments[index] === segment)) {
    refuse("invalid-candidate", "test path is outside the test command workspace");
  }
  const target = pathSegments.slice(cwdSegments.length);
  if (target.length === 0) {
    refuse("invalid-candidate", "test path must name a file below the test command workspace");
  }

  return {
    ...template,
    args: [...template.args, target.join("/")],
    ...(template.env === undefined ? {} : { env: { ...template.env } }),
  };
}
```

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS (13 new test cases; 23 total).

- [ ] **Step 3: Commit**

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): traversal-safe repository paths and targeted test-command binding"
```

---

### Task 4: Observations — schema, repeat stability, derived transitions

**Files:**
- Create: `src/observations.ts`, `src/observations.test.ts`

**Interfaces:**
- Consumes: `canonicalJsonBytes`, `compareCodeUnitStrings` from `@jinn-network/trust-core`
  (branch `integration/evidence-v1`).
- Produces: `ObservationSchema`, type `Observation`, `stableObservation(observations, side, testPath)`,
  `deriveTransitions(before, after)`.

**Three deliberate departures from the legacy port** (contract 12 — these are the rewrite):

1. `passed_match` → `passedMatch` (house camelCase; the legacy snake spelling was a foreign
   parser's field name leaking into a Jinn document).
2. Derived transitions are **sorted with `compareCodeUnitStrings`**, not left in a `Set`'s
   insertion order. The legacy derivation made receipt bytes depend on the runner's emission
   order; sorted output makes two honest runners produce identical receipts.
3. `passedMatch` is carried, never interpreted: it is the parser's own self-report, and admission
   makes no claim about it. (Contract 8: the receipt claims what it observed, nothing more.)

- [ ] **Step 1: Write the tests first**

`src/observations.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ObservationSchema, deriveTransitions, stableObservation } from "./observations.js";
import { AdmissionRefusalError } from "./refusals.js";

const observation = (passed: string[], failed: string[]) => ({ passed, failed, passedMatch: true });

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("ObservationSchema", () => {
  it("accepts a well-formed observation", () => {
    expect(ObservationSchema.parse(observation(["a"], ["b"]))).toStrictEqual({
      passed: ["a"], failed: ["b"], passedMatch: true,
    });
  });

  it("rejects an unknown key", () => {
    expect(ObservationSchema.safeParse({ ...observation(["a"], []), extra: 1 }).success).toBe(false);
  });

  it("rejects an identifier repeated within one observation", () => {
    expect(ObservationSchema.safeParse(observation(["a"], ["a"])).success).toBe(false);
    expect(ObservationSchema.safeParse(observation(["a", "a"], [])).success).toBe(false);
  });
});

describe("stableObservation", () => {
  it("returns the single observation when both repeats are canonical-JSON identical", () => {
    const first = observation(["a"], ["b"]);
    const second = { failed: ["b"], passed: ["a"], passedMatch: true };
    expect(stableObservation([first, second], "broken", "tests/test_thing.py"))
      .toStrictEqual(first);
  });

  it("refuses when the repeats differ", () => {
    const refusal = refusalOf(() =>
      stableObservation([observation(["a"], ["b"]), observation(["a", "b"], [])], "fixed", "tests/t.py"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("fixed observations for tests/t.py");
  });

  it("refuses when a side does not carry exactly two repeats", () => {
    const refusal = refusalOf(() => stableObservation([observation(["a"], [])], "broken", "tests/t.py"));
    expect(refusal.code).toBe("unstable-observations");
    expect(refusal.detail).toContain("exactly 2");
  });
});

describe("deriveTransitions", () => {
  it("derives fail-to-pass and pass-to-pass in code-unit order", () => {
    const before = observation(["keeps", "also"], ["zeta", "alpha"]);
    const after = observation(["keeps", "also", "zeta", "alpha"], []);
    expect(deriveTransitions(before, after)).toStrictEqual({
      failToPass: ["alpha", "zeta"],
      passToPass: ["also", "keeps"],
    });
  });

  it("does not depend on the runner's emission order", () => {
    const before = observation(["b", "a"], ["d", "c"]);
    const after = observation(["a", "b", "c", "d"], []);
    const reversed = deriveTransitions(
      observation(["a", "b"], ["c", "d"]),
      observation(["d", "c", "b", "a"], []),
    );
    expect(deriveTransitions(before, after)).toStrictEqual(reversed);
  });

  it("counts a test that regresses as neither transition", () => {
    expect(deriveTransitions(observation(["a"], []), observation([], ["a"])))
      .toStrictEqual({ failToPass: [], passToPass: [] });
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./observations.js"`.

- [ ] **Step 2: Write `src/observations.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, compareCodeUnitStrings } from "@jinn-network/trust-core";
import { z } from "zod";
import { DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { refuse } from "./refusals.js";

const AssertionId = z.string().min(1);

/**
 * One parser reading of one run. `passedMatch` is the parser's own self-report, carried into the
 * receipt as an observed fact and interpreted by nothing here.
 */
export const ObservationSchema = z
  .strictObject({
    passed: z.array(AssertionId),
    failed: z.array(AssertionId),
    passedMatch: z.boolean(),
  })
  .superRefine((observation, ctx) => {
    const seen = new Set<string>();
    for (const identifier of [...observation.passed, ...observation.failed]) {
      if (seen.has(identifier)) {
        ctx.addIssue({
          code: "custom",
          message: `observation repeats raw assertion identifier ${identifier}`,
        });
      }
      seen.add(identifier);
    }
  });

export type Observation = z.infer<typeof ObservationSchema>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/**
 * Collapse one side's repeats to the single observation they agree on. Disagreement is a refusal,
 * not an average: the receipt's whole claim is that the repeats were identical.
 */
export function stableObservation(
  observations: readonly unknown[],
  side: "broken" | "fixed",
  testPath: string,
): Observation {
  const expected = DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide;
  if (observations.length !== expected) {
    refuse(
      "unstable-observations",
      `${side} observations for ${testPath} must have exactly ${expected} runs`,
    );
  }
  const parsed = observations.map((observation) => {
    const result = ObservationSchema.safeParse(observation);
    if (!result.success) {
      refuse("invalid-candidate", `${side} observation for ${testPath}: ${result.error.message}`);
    }
    return result.data;
  });
  const first = parsed[0] as Observation;
  const canonical = canonicalJsonBytes(first);
  if (parsed.some((observation) => !bytesEqual(canonicalJsonBytes(observation), canonical))) {
    refuse("unstable-observations", `${side} observations for ${testPath} are not identical`);
  }
  return first;
}

/**
 * Fail-to-pass = failing (or absent) before, passing after. Pass-to-pass = passing on both sides.
 * Both are sorted by code unit so the receipt's bytes do not depend on the runner's emission
 * order.
 */
export function deriveTransitions(
  before: Observation,
  after: Observation,
): { readonly failToPass: string[]; readonly passToPass: string[] } {
  const beforePassed = new Set(before.passed);
  const afterPassed = new Set(after.passed);
  const all = [
    ...new Set([...before.passed, ...before.failed, ...after.passed, ...after.failed]),
  ].sort(compareCodeUnitStrings);
  return {
    failToPass: all.filter((id) => !beforePassed.has(id) && afterPassed.has(id)),
    passToPass: all.filter((id) => beforePassed.has(id) && afterPassed.has(id)),
  };
}
```

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS (9 new tests; 32 total).

- [ ] **Step 3: Commit**

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): observation schema, repeat stability, and order-free transition derivation"
```

---

### Task 5: Inline-match enforcement — the blocker rule (normative rule 1)

**Files:**
- Create: `src/inline-match.ts`, `src/inline-match.test.ts`

**Interfaces:**
- Consumes: the type `EnvironmentRecord` from `@jinn-network/environment-record`
  (branch `supply/c1-environment-record`); `ENVIRONMENT_RECORD_SPEC_KEY` from `./identifiers.js`.
- Produces: `checkInlineEnvironmentMatch(record, evaluationSpec, expectedRecordDigest): InlineMatchReport`,
  type `InlineMatchReport`.

**Why a local reader, not a profiles import.** Design §3.3 is explicit: "admission and derivation
consume `environments/record` types and digests only", and the `profiles (references only)` arrow
"denotes by-digest reference, not a package import in either direction". So this module declares
the narrowest possible mirror of the three fields it enforces — structurally identical to
`DETERMINISTIC_PROCESS_SHAPE` in
`packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts:68-77` (`image:
ResourceDescriptorSchema`, `platform: z.string()`, `parser: ParserIdentitySchema` — strict
`{id, version, digest}` with `digest` matching `/^sha256:[0-9a-f]{64}$/`) — and reads nothing
else. Compatibility is proven by the fixture in Task 9, not by an import.

- [ ] **Step 1: Write the tests first**

`src/inline-match.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkInlineEnvironmentMatch } from "./inline-match.js";
import { AdmissionRefusalError } from "./refusals.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const OTHER = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const RECORD_DIGEST = "sha256:4444444444444444444444444444444444444444444444444444444444444444";

const record = {
  image: {
    manifestDigest: MANIFEST,
    platform: "linux/amd64",
    reference: `ghcr.io/example/env@${MANIFEST}`,
  },
  parser: { id: "pytest-log", version: "3", digest: PARSER, uri: "https://example.test/parser" },
} as never;

function spec(familyBlock: Record<string, unknown>): unknown {
  return { family: "deterministic-process", familyBlock };
}

const inlineBlock = {
  image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
  platform: "linux/amd64",
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  transitions: { failToPass: ["a"], passToPass: [] },
  timeout: 1800,
};

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("checkInlineEnvironmentMatch", () => {
  it("passes and reports the fields it checked when the inline block equals the record", () => {
    expect(checkInlineEnvironmentMatch(record, spec(inlineBlock), RECORD_DIGEST)).toStrictEqual({
      fields: ["image", "parser", "platform"],
      specKeyPresent: false,
    });
  });

  it("MANDATORY ADVERSARIAL FIXTURE: refuses env-record-mismatch when the inline image differs", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${OTHER}`, digest: { sha256: OTHER.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("inline image manifest digest");
  });

  it("refuses env-record-mismatch on a platform difference", () => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ ...inlineBlock, platform: "linux/arm64" }), RECORD_DIGEST));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("platform");
  });

  it.each([
    ["id", { id: "other-parser", version: "3", digest: PARSER }],
    ["version", { id: "pytest-log", version: "4", digest: PARSER }],
    ["digest", { id: "pytest-log", version: "3", digest: OTHER }],
  ])("refuses env-record-mismatch on a parser %s difference", (_field, parser) => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ ...inlineBlock, parser }), RECORD_DIGEST));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("parser");
  });

  it("refuses env-record-mismatch when the spec's environment-record key names another record", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, "network.jinn.environment.record": { digest: { sha256: OTHER.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("env-record-mismatch");
    expect(refusal.detail).toContain("network.jinn.environment.record");
  });

  it("reports the environment-record key when it names the record admission was given", () => {
    const report = checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, "network.jinn.environment.record": { digest: { sha256: RECORD_DIGEST.slice(7) } } }),
      RECORD_DIGEST,
    );
    expect(report.specKeyPresent).toBe(true);
  });

  it("DIGEST-CONFUSION FIXTURE: refuses a sha256:-prefixed value inside the inline DigestSet", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("bare lowercase hex");
  });

  it("refuses an inline image whose reference and DigestSet disagree", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record,
      spec({ ...inlineBlock, image: { uri: `ghcr.io/example/env@${OTHER}`, digest: { sha256: MANIFEST.slice(7) } } }),
      RECORD_DIGEST,
    ));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("disagree");
  });

  it("refuses an inline image that carries no manifest digest at all", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record, spec({ ...inlineBlock, image: { uri: "ghcr.io/example/env:latest" } }), RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("manifest digest");
  });

  it("refuses a non-deterministic-process grader family", () => {
    const refusal = refusalOf(() => checkInlineEnvironmentMatch(
      record, { family: "model-graded", familyBlock: {} }, RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("deterministic-process");
  });

  it("refuses a malformed inline block", () => {
    const refusal = refusalOf(() =>
      checkInlineEnvironmentMatch(record, spec({ platform: "linux/amd64" }), RECORD_DIGEST));
    expect(refusal.code).toBe("invalid-candidate");
    expect(refusal.detail).toContain("inline");
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./inline-match.js"`.

- [ ] **Step 2: Write `src/inline-match.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import type { EnvironmentRecord } from "@jinn-network/environment-record";
import { z } from "zod";
import { ENVIRONMENT_RECORD_SPEC_KEY } from "./identifiers.js";
import { refuse } from "./refusals.js";

const BARE_SHA256 = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The narrowest possible mirror of the three fields this rule enforces. Structurally identical to
 * `DETERMINISTIC_PROCESS_SHAPE` in
 * `packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts` — read, never imported
 * (design §3.3: admission consumes environments/record types and digests only). Loose objects:
 * every other field of a real EvaluationSpec passes through untouched.
 */
const InlineImageSchema = z.looseObject({
  uri: z.string().optional(),
  digest: z.record(z.string(), z.string()).optional(),
});

const InlineParserSchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  digest: z.string().regex(PREFIXED_SHA256),
});

const InlineProcessBlockSchema = z.looseObject({
  image: InlineImageSchema,
  platform: z.string().min(1),
  parser: InlineParserSchema,
});

const EvaluationSpecShellSchema = z.looseObject({
  family: z.string(),
  familyBlock: z.unknown(),
});

const SpecEnvironmentReferenceSchema = z.looseObject({
  digest: z.looseObject({ sha256: z.string() }),
});

/** What the receipt records about the check having run (design §7.1). */
export interface InlineMatchReport {
  readonly fields: readonly ["image", "parser", "platform"];
  readonly specKeyPresent: boolean;
}

function manifestDigestFromDigestSet(digest: Record<string, string> | undefined): string | undefined {
  if (digest === undefined) return undefined;
  const value = digest["sha256"];
  if (value === undefined) return undefined;
  if (!BARE_SHA256.test(value)) {
    refuse(
      "invalid-candidate",
      "inline image DigestSet sha256 must be bare lowercase hex (in-toto DigestSet values are never sha256:-prefixed)",
    );
  }
  return `sha256:${value}`;
}

function manifestDigestFromReference(uri: string | undefined): string | undefined {
  if (uri === undefined) return undefined;
  const marker = uri.lastIndexOf("@");
  if (marker < 0) return undefined;
  const candidate = uri.slice(marker + 1);
  if (!PREFIXED_SHA256.test(candidate)) {
    refuse("invalid-candidate", `inline image reference "${uri}" does not end with @sha256:<64 hex>`);
  }
  return candidate;
}

/**
 * Normative rule 1 (design §7.1). The candidate's inline `image` (manifest digest via its
 * reference), `platform`, and `parser` MUST equal the referenced record's. A pair that grades
 * against one image while citing another record's digest is refused here, before it can earn a
 * receipt and inherit evidence it was never entitled to.
 *
 * The record's advisory `parser.uri` is deliberately not compared: the inline parser identity is
 * strict `{id, version, digest}`, and the digest is the authority.
 */
export function checkInlineEnvironmentMatch(
  record: EnvironmentRecord,
  evaluationSpec: unknown,
  expectedRecordDigest: string,
): InlineMatchReport {
  const shell = EvaluationSpecShellSchema.safeParse(evaluationSpec);
  if (!shell.success) {
    refuse("invalid-candidate", "the candidate EvaluationSpec is not a { family, familyBlock } document");
  }
  if (shell.data.family !== "deterministic-process") {
    refuse(
      "invalid-candidate",
      `admission grades the deterministic-process family only, not "${shell.data.family}"`,
    );
  }
  const block = InlineProcessBlockSchema.safeParse(shell.data.familyBlock);
  if (!block.success) {
    refuse("invalid-candidate", `the inline deterministic-process block is malformed: ${block.error.message}`);
  }

  const fromDigestSet = manifestDigestFromDigestSet(block.data.image.digest);
  const fromReference = manifestDigestFromReference(block.data.image.uri);
  if (fromDigestSet === undefined && fromReference === undefined) {
    refuse("invalid-candidate", "the inline image carries no manifest digest (needs a DigestSet or an @sha256: reference)");
  }
  if (fromDigestSet !== undefined && fromReference !== undefined && fromDigestSet !== fromReference) {
    refuse("invalid-candidate", "the inline image reference and DigestSet disagree on the manifest digest");
  }
  const inlineManifest = fromDigestSet ?? (fromReference as string);
  if (inlineManifest !== record.image.manifestDigest) {
    refuse(
      "env-record-mismatch",
      `inline image manifest digest ${inlineManifest} is not the record's ${record.image.manifestDigest}`,
    );
  }
  if (block.data.platform !== record.image.platform) {
    refuse(
      "env-record-mismatch",
      `inline platform ${block.data.platform} is not the record's ${record.image.platform}`,
    );
  }
  if (
    block.data.parser.id !== record.parser.id
    || block.data.parser.version !== record.parser.version
    || block.data.parser.digest !== record.parser.digest
  ) {
    refuse(
      "env-record-mismatch",
      `inline parser ${block.data.parser.id}@${block.data.parser.version} (${block.data.parser.digest}) is not the record's `
        + `${record.parser.id}@${record.parser.version} (${record.parser.digest})`,
    );
  }

  const specKey = (block.data as Record<string, unknown>)[ENVIRONMENT_RECORD_SPEC_KEY];
  let specKeyPresent = false;
  if (specKey !== undefined) {
    const reference = SpecEnvironmentReferenceSchema.safeParse(specKey);
    if (!reference.success) {
      refuse("invalid-candidate", `${ENVIRONMENT_RECORD_SPEC_KEY} must be { digest: { sha256 } }`);
    }
    const hex = reference.data.digest.sha256;
    if (!BARE_SHA256.test(hex)) {
      refuse("invalid-candidate", `${ENVIRONMENT_RECORD_SPEC_KEY} sha256 must be bare lowercase hex`);
    }
    if (`sha256:${hex}` !== expectedRecordDigest) {
      refuse(
        "env-record-mismatch",
        `${ENVIRONMENT_RECORD_SPEC_KEY} names sha256:${hex}, not the record admission was given (${expectedRecordDigest})`,
      );
    }
    specKeyPresent = true;
  }

  return { fields: ["image", "parser", "platform"], specKeyPresent };
}
```

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS (13 new test cases; 45 total). The mandatory adversarial fixture and the
digest-confusion fixture are both green.

- [ ] **Step 3: Commit**

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): inline-match enforcement with env-record-mismatch refusal"
```

---

### Task 6: The `DifferentialAdmissionReceipt/3` schema and its policy validator

**Files:**
- Create: `src/receipt.ts`, `src/receipt.test.ts`

**Interfaces:**
- Consumes: `./identifiers.js`, `./observations.js`, `./test-paths.js`, `./refusals.js`;
  `canonicalJsonBytes` from `@jinn-network/trust-core`.
- Produces: `DifferentialAdmissionReceiptV3Schema`, type `DifferentialAdmissionReceiptV3`,
  `verifyDifferentialAdmissionReceiptV3(raw)`, `receiptDigest(receipt)`.

**Receipt shape** (design §7.1's field list, plus the two fields the existing marketplace
contract requires — see Finding F-C3-1):

```jsonc
{
  "schemaVersion": "https://jinn.network/records/differential-admission-receipt/3",
  "admissionPolicyVersion": "https://jinn.network/task-admission/policy/3",
  "issuer": "<admitting agent IRI>",
  "task": {
    "documentDigest": "sha256:…",        // the sealed Task — statement subject 1
    "evaluationSpecDigest": "sha256:…",  // the sealed EvaluationSpec — statement subject 2
    "statementDigest": "sha256:…",       // the task statement material
    "testMaterialDigests": ["sha256:…"],
    "transitions": { "failToPass": ["…"], "passToPass": ["…"] }
  },
  "goldPatchHash": "sha256:…",           // a digest, always; never patch bytes
  "testPaths": [{
    "testPath": "tests/unit/test_thing.py",
    "commandHash": "sha256:…",
    "broken": [{ "passed": [], "failed": ["…"], "passedMatch": false }, { … }],
    "fixed":  [{ "passed": ["…"], "failed": [], "passedMatch": true }, { … }],
    "failToPass": ["…"],
    "passToPass": ["…"]
  }],
  "environment": {
    "recordDigest": "sha256:…",
    "inlineMatch": { "fields": ["image", "parser", "platform"], "specKeyPresent": true }
  },
  "evalSemanticsVersion": "4"
}
```

- [ ] **Step 1: Write the tests first**

`src/receipt.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { AdmissionRefusalError } from "./refusals.js";
import {
  DifferentialAdmissionReceiptV3Schema,
  verifyDifferentialAdmissionReceiptV3,
} from "./receipt.js";

const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const broken = { passed: ["keeps"], failed: ["target"], passedMatch: false };
const fixed = { passed: ["keeps", "target"], failed: [], passedMatch: true };

const receipt = {
  schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
  admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
  issuer: "https://jinn.network/agents/admission-1",
  task: {
    documentDigest: D("1"),
    evaluationSpecDigest: D("2"),
    statementDigest: D("3"),
    testMaterialDigests: [D("4")],
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  },
  goldPatchHash: D("5"),
  testPaths: [{
    testPath: "tests/unit/test_thing.py",
    commandHash: D("6"),
    broken: [broken, broken],
    fixed: [fixed, fixed],
    failToPass: ["target"],
    passToPass: ["keeps"],
  }],
  environment: {
    recordDigest: D("7"),
    inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
  },
  evalSemanticsVersion: "4",
};

function refusalOf(run: () => unknown): { code: string; detail: string } {
  try {
    run();
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return error.refusal;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("DifferentialAdmissionReceiptV3", () => {
  it("round-trips a golden receipt through parse and policy validation", () => {
    expect(verifyDifferentialAdmissionReceiptV3(receipt)).toStrictEqual(receipt);
  });

  it("GOLD-DIGEST-ONLY: rejects any receipt carrying patch bytes", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, goldPatch: "diff --git a/x b/x\n",
    }).success).toBe(false);
    expect(JSON.stringify(verifyDifferentialAdmissionReceiptV3(receipt))).not.toContain("diff --git");
  });

  it("rejects an unknown top-level key", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({ ...receipt, extra: 1 }).success).toBe(false);
  });

  it("rejects a bare-hex digest where the receipt body requires the sha256: spelling", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, goldPatchHash: receipt.goldPatchHash.slice("sha256:".length),
    }).success).toBe(false);
  });

  it("refuses a path whose declared transitions do not match its observations", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], passToPass: [] }],
    }));
    expect(refusal.code).toBe("no-discrimination");
    expect(refusal.detail).toContain("do not match its observations");
  });

  it("refuses a path with no fail-to-pass assertion", () => {
    const inert = { passed: ["keeps"], failed: [], passedMatch: true };
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{
        ...receipt.testPaths[0],
        broken: [inert, inert], fixed: [inert, inert],
        failToPass: [], passToPass: ["keeps"],
      }],
    }));
    expect(refusal.code).toBe("no-discrimination");
    expect(refusal.detail).toContain("no fail-to-pass assertion");
  });

  it("refuses unstable repeats inside a stored receipt", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], fixed: [fixed, { ...fixed, passedMatch: false }] }],
    }));
    expect(refusal.code).toBe("unstable-observations");
  });

  it("refuses an assertion identifier shared across two test paths", () => {
    const refusal = refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [
        receipt.testPaths[0],
        { ...receipt.testPaths[0], testPath: "tests/unit/test_other.py" },
      ],
    }));
    expect(refusal.code).toBe("duplicate-assertion-id");
    expect(refusal.detail).toContain("keeps");
  });

  it("refuses a repeated or unnormalized test path", () => {
    expect(refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt, testPaths: [receipt.testPaths[0], receipt.testPaths[0]],
    })).code).toBe("duplicate-assertion-id");
    expect(refusalOf(() => verifyDifferentialAdmissionReceiptV3({
      ...receipt,
      testPaths: [{ ...receipt.testPaths[0], testPath: "tests/./unit/test_thing.py" }],
    })).code).toBe("invalid-candidate");
  });

  it("refuses a foreign schema or policy version", () => {
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({ ...receipt, schemaVersion: "v2" }).success).toBe(false);
    expect(DifferentialAdmissionReceiptV3Schema.safeParse({
      ...receipt, admissionPolicyVersion: "swe-rebench-v2-differential-admission.v2",
    }).success).toBe(false);
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./receipt.js"`.

- [ ] **Step 2: Write `src/receipt.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { z } from "zod";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { ObservationSchema, deriveTransitions, stableObservation, type Observation } from "./observations.js";
import { refuse } from "./refusals.js";
import { normalizeRepositoryPath } from "./test-paths.js";

/** Receipt-body digests are `sha256:`-prefixed; in-toto DigestSet values (seal.ts) are bare hex. */
const PrefixedDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const NonEmpty = z.string().min(1);
const PER_SIDE = DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide;

const PathReceiptSchema = z.strictObject({
  testPath: NonEmpty,
  commandHash: PrefixedDigest,
  broken: z.array(ObservationSchema).length(PER_SIDE),
  fixed: z.array(ObservationSchema).length(PER_SIDE),
  failToPass: z.array(NonEmpty),
  passToPass: z.array(NonEmpty),
});
export type DifferentialAdmissionPathReceiptV3 = z.infer<typeof PathReceiptSchema>;

export const DifferentialAdmissionReceiptV3Schema = z.strictObject({
  schemaVersion: z.literal(ADMISSION_RECEIPT_SCHEMA_VERSION),
  admissionPolicyVersion: z.literal(DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion),
  /** The admitting agent IRI. Required by the in-toto predicate shape the evaluation leg parses. */
  issuer: NonEmpty,
  task: z.strictObject({
    documentDigest: PrefixedDigest,
    evaluationSpecDigest: PrefixedDigest,
    statementDigest: PrefixedDigest,
    testMaterialDigests: z.array(PrefixedDigest).min(1),
    transitions: z.strictObject({
      failToPass: z.array(NonEmpty),
      passToPass: z.array(NonEmpty),
    }),
  }),
  /** Deliberately a digest only: gold-patch contents are never receipt data. */
  goldPatchHash: PrefixedDigest,
  testPaths: z.array(PathReceiptSchema).min(1),
  environment: z.strictObject({
    recordDigest: PrefixedDigest,
    inlineMatch: z.strictObject({
      fields: z.tuple([z.literal("image"), z.literal("parser"), z.literal("platform")]),
      specKeyPresent: z.boolean(),
    }),
  }),
  evalSemanticsVersion: NonEmpty,
});
export type DifferentialAdmissionReceiptV3 = z.infer<typeof DifferentialAdmissionReceiptV3Schema>;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => right[index] === value);
}

function validatePolicy(receipt: DifferentialAdmissionReceiptV3): void {
  const seenPaths = new Set<string>();
  const owners = new Map<string, string>();
  for (const pathReceipt of receipt.testPaths) {
    const normalized = normalizeRepositoryPath(pathReceipt.testPath, "receipt test path");
    if (normalized !== pathReceipt.testPath) {
      refuse("invalid-candidate", `receipt test path ${pathReceipt.testPath} is not normalized`);
    }
    if (seenPaths.has(pathReceipt.testPath)) {
      refuse("duplicate-assertion-id", `receipt repeats test path ${pathReceipt.testPath}`);
    }
    seenPaths.add(pathReceipt.testPath);

    const broken = stableObservation(pathReceipt.broken, "broken", pathReceipt.testPath);
    const fixed = stableObservation(pathReceipt.fixed, "fixed", pathReceipt.testPath);
    const derived = deriveTransitions(broken, fixed);
    if (
      !sameStrings(derived.failToPass, pathReceipt.failToPass)
      || !sameStrings(derived.passToPass, pathReceipt.passToPass)
    ) {
      refuse(
        "no-discrimination",
        `the transitions recorded for ${pathReceipt.testPath} do not match its observations`,
      );
    }
    if (pathReceipt.failToPass.length === 0) {
      refuse("no-discrimination", `test path ${pathReceipt.testPath} has no fail-to-pass assertion`);
    }

    for (const identifier of assertionIds(broken, fixed)) {
      const owner = owners.get(identifier);
      if (owner !== undefined && owner !== pathReceipt.testPath) {
        refuse(
          "duplicate-assertion-id",
          `raw assertion identifier ${identifier} appears under both ${owner} and ${pathReceipt.testPath}`,
        );
      }
      owners.set(identifier, pathReceipt.testPath);
    }
  }
}

function assertionIds(broken: Observation, fixed: Observation): Set<string> {
  return new Set([...broken.passed, ...broken.failed, ...fixed.passed, ...fixed.failed]);
}

/**
 * Parse, re-derive, and validate a receipt. Every consumer — including this package's own
 * producer path — goes through here, so a stored receipt is held to exactly the policy that
 * minted it.
 */
export function verifyDifferentialAdmissionReceiptV3(raw: unknown): DifferentialAdmissionReceiptV3 {
  const parsed = DifferentialAdmissionReceiptV3Schema.safeParse(raw);
  if (!parsed.success) {
    refuse("invalid-candidate", `the receipt failed schema validation: ${parsed.error.message}`);
  }
  validatePolicy(parsed.data);
  return parsed.data;
}

/** Canonical content digest of a receipt body. Not the sealed identity — see seal.ts. */
export function receiptDigest(receipt: DifferentialAdmissionReceiptV3): `sha256:${string}` {
  return recordDigest(canonicalJsonBytes(verifyDifferentialAdmissionReceiptV3(receipt)));
}
```

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS (11 new test cases; 56 total).

- [ ] **Step 3: Commit**

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): the DifferentialAdmissionReceipt/3 schema and its policy validator"
```

---

### Task 7: `admitCandidate` over the injected `runInEnvironment` port

**Files:**
- Create: `src/admit.ts`, `src/admit.test.ts`

**Interfaces:**
- Consumes: from `@jinn-network/environment-record` (branch `supply/c1-environment-record`) —
  `parseEnvironmentRecord(bytes)`, `environmentRecordDigest(bytes)`, type `EnvironmentRecord`.
  From `@jinn-network/trust-core` — `canonicalJsonBytes`, `recordDigest`. **Stop-and-report** if
  either C1 symbol is missing from C1's root export.
- Produces: `admitCandidate(deps, candidate, environmentRecordBytes): Promise<AdmissionResult>`,
  types `AdmissionCandidate`, `AdmissionDeps`, `AdmissionResult`, `RunInEnvironmentPort`,
  `EnvironmentRunRequest`, `EnvironmentRunObservation`, `PatchSelector`.

**Departure from the legacy port** (contract 12, third of three): the runner echoes back the
digest of the material it applied, and admission refuses unless it equals the candidate's declared
`goldPatchHash` (or `null` on the empty side). The legacy path trusted the caller to hand the
right patch to the right run; here the receipt's `goldPatchHash` is *bound* to what actually ran.
Admission still never sees patch bytes — the port carries a selector, not content.

- [ ] **Step 1: Write the tests first**

`src/admit.test.ts`:

```ts
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { describe, expect, it } from "vitest";
import { admitCandidate, type AdmissionCandidate, type EnvironmentRunRequest } from "./admit.js";

const MANIFEST = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const PARSER = "sha256:3333333333333333333333333333333333333333333333333333333333333333";
const GOLD = "sha256:5555555555555555555555555555555555555555555555555555555555555555";
const D = (seed: string) => `sha256:${seed.repeat(64).slice(0, 64)}`;

const recordBytes = sealEnvironmentRecord({
  kind: "https://jinn.network/records/environment/1.0",
  source: { repo: "owner/name", repoUrl: "https://github.com/owner/name", commit: "a".repeat(40) },
  image: { manifestDigest: MANIFEST, platform: "linux/amd64", reference: `ghcr.io/example/env@${MANIFEST}` },
  workspace: "/testbed",
  invocations: { test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }] },
  parser: { id: "pytest-log", version: "3", digest: PARSER },
  build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
  rights: { sourceLicense: "MIT" },
} as never);

const evaluationSpecBytes = new TextEncoder().encode(JSON.stringify({
  family: "deterministic-process",
  familyBlock: {
    image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
    platform: "linux/amd64",
    parser: { id: "pytest-log", version: "3", digest: PARSER },
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    timeout: 1800,
  },
}));

const candidate: AdmissionCandidate = {
  taskDocumentDigest: D("1"),
  statementDigest: D("3"),
  testMaterialDigests: [D("4")],
  transitions: { failToPass: ["target"], passToPass: ["keeps"] },
  goldPatchHash: GOLD,
  evaluationSpecBytes,
  testPaths: ["tests/unit/test_thing.py"],
  evalSemanticsVersion: "4",
};

function runner(overrides: Partial<Record<"gold" | "none", unknown>> = {}) {
  const requests: EnvironmentRunRequest[] = [];
  const port = async (request: EnvironmentRunRequest) => {
    requests.push(request);
    const gold = request.patch.kind === "gold";
    return (overrides[request.patch.kind] as never) ?? {
      passed: gold ? ["keeps", "target"] : ["keeps"],
      failed: gold ? [] : ["target"],
      passedMatch: gold,
      appliedPatchDigest: gold ? GOLD : null,
    };
  };
  return { port, requests };
}

describe("admitCandidate", () => {
  it("admits a discriminating candidate and returns a policy-valid receipt", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate({ port: undefined as never, runInEnvironment: port, issuer: "https://jinn.network/agents/a" }, candidate, recordBytes);
    expect("receipt" in result).toBe(true);
    if (!("receipt" in result)) return;
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.patch.kind)).toStrictEqual(["none", "none", "gold", "gold"]);
    expect(result.receipt.testPaths[0]?.failToPass).toStrictEqual(["target"]);
    expect(result.receipt.testPaths[0]?.passToPass).toStrictEqual(["keeps"]);
    expect(result.receipt.environment.inlineMatch).toStrictEqual({
      fields: ["image", "parser", "platform"], specKeyPresent: false,
    });
    expect(result.receipt.goldPatchHash).toBe(GOLD);
  });

  it("passes the gold patch to the runner as a selector, never as bytes", async () => {
    const { port, requests } = runner();
    await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain("diff --git");
      expect(Object.keys(request.patch).sort()).toStrictEqual(
        request.patch.kind === "gold" ? ["digest", "kind"] : ["kind"],
      );
    }
  });

  it("binds the environment record by digest and targets the record's test command", async () => {
    const { port, requests } = runner();
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    if (!("receipt" in result)) throw new Error("expected a receipt");
    expect(requests[0]?.environmentRecordDigest).toBe(result.receipt.environment.recordDigest);
    expect(requests[0]?.command.args).toStrictEqual(["-m", "pytest", "-rA", "tests/unit/test_thing.py"]);
  });

  it("refuses env-record-mismatch when the inline image is not the record's", async () => {
    const { port } = runner();
    const mismatched = {
      ...candidate,
      evaluationSpecBytes: new TextEncoder().encode(
        new TextDecoder().decode(evaluationSpecBytes).replaceAll("1111", "2222"),
      ),
    };
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, mismatched, recordBytes);
    expect(result).toStrictEqual({
      refusal: { code: "env-record-mismatch", detail: expect.stringContaining("inline image manifest digest") },
    });
  });

  it("refuses invalid-environment-record on unparseable record bytes", async () => {
    const { port } = runner();
    const result = await admitCandidate(
      { runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never,
      candidate,
      new TextEncoder().encode("{not json"),
    );
    expect("refusal" in result && result.refusal.code).toBe("invalid-environment-record");
  });

  it("refuses unstable-observations when a side's repeats differ", async () => {
    let call = 0;
    const port = async () => ({
      passed: call++ === 0 ? ["keeps"] : ["keeps", "flake"],
      failed: ["target"], passedMatch: false, appliedPatchDigest: null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("unstable-observations");
  });

  it("refuses no-discrimination when gold changes nothing", async () => {
    const inert = { passed: ["keeps"], failed: [], passedMatch: true };
    const port = async (request: EnvironmentRunRequest) => ({
      ...inert, appliedPatchDigest: request.patch.kind === "gold" ? GOLD : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("no-discrimination");
  });

  it("refuses execution-failed when the runner applies material other than the declared gold patch", async () => {
    const port = async (request: EnvironmentRunRequest) => ({
      passed: [], failed: ["target"], passedMatch: false,
      appliedPatchDigest: request.patch.kind === "gold" ? D("9") : null,
    });
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
  });

  it("refuses execution-failed when the runner throws", async () => {
    const port = async () => { throw new Error("container runtime unavailable"); };
    const result = await admitCandidate({ runInEnvironment: port, issuer: "https://jinn.network/agents/a" } as never, candidate, recordBytes);
    expect("refusal" in result && result.refusal.code).toBe("execution-failed");
    expect("refusal" in result && result.refusal.detail).toContain("container runtime unavailable");
  });
});
```

(The first test's `port: undefined as never` line is a typo guard — delete it when writing the
file; deps is `{ runInEnvironment, issuer }`.)

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./admit.js"`.

- [ ] **Step 2: Write `src/admit.ts`**

```ts
// SPDX-License-Identifier: Apache-2.0

import {
  environmentRecordDigest,
  parseEnvironmentRecord,
  type EnvironmentRecord,
} from "@jinn-network/environment-record";
import { canonicalJsonBytes, recordDigest } from "@jinn-network/trust-core";
import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import { checkInlineEnvironmentMatch } from "./inline-match.js";
import { deriveTransitions, stableObservation } from "./observations.js";
import {
  verifyDifferentialAdmissionReceiptV3,
  type DifferentialAdmissionReceiptV3,
} from "./receipt.js";
import { AdmissionRefusalError, type AdmissionRefusal } from "./refusals.js";
import { normalizeRepositoryPath, targetTestCommandForPath, type CommandSpec } from "./test-paths.js";

/** Which material a run applies. A selector, never content: admission holds no patch bytes. */
export type PatchSelector =
  | { readonly kind: "none" }
  | { readonly kind: "gold"; readonly digest: `sha256:${string}` };

export interface EnvironmentRunRequest {
  readonly environmentRecordDigest: `sha256:${string}`;
  readonly command: CommandSpec;
  readonly patch: PatchSelector;
  readonly testMaterialDigests: readonly `sha256:${string}`[];
  readonly testPath: string;
  /** 1 or 2 — the repeat index within a side, so a runner can start a fresh container. */
  readonly attempt: 1 | 2;
  readonly signal?: AbortSignal;
}

export interface EnvironmentRunObservation {
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly passedMatch: boolean;
  /** The digest of the material the runner actually applied; `null` for the empty side. */
  readonly appliedPatchDigest: `sha256:${string}` | null;
}

/**
 * The one port admission needs. Admission does not own Docker, a workspace, or a parser — a host
 * supplies this, and everything else here is pure orchestration over what it returns.
 */
export type RunInEnvironmentPort = (
  request: EnvironmentRunRequest,
) => Promise<EnvironmentRunObservation>;

export interface AdmissionDeps {
  readonly runInEnvironment: RunInEnvironmentPort;
  /** The admitting agent IRI written into the receipt (and the signed statement's issuer). */
  readonly issuer: string;
  readonly signal?: AbortSignal;
}

export interface AdmissionCandidate {
  /** Digest of the sealed Task document. */
  readonly taskDocumentDigest: `sha256:${string}`;
  /** Digest of the task's statement material. */
  readonly statementDigest: `sha256:${string}`;
  readonly testMaterialDigests: readonly `sha256:${string}`[];
  readonly transitions: {
    readonly failToPass: readonly string[];
    readonly passToPass: readonly string[];
  };
  /** A digest, always. The gold patch itself never enters this package. */
  readonly goldPatchHash: `sha256:${string}`;
  /** The exact sealed EvaluationSpec bytes; their digest is the receipt's spec subject. */
  readonly evaluationSpecBytes: Uint8Array;
  readonly testPaths: readonly string[];
  readonly evalSemanticsVersion: string;
}

export type AdmissionResult =
  | { readonly receipt: DifferentialAdmissionReceiptV3 }
  | { readonly refusal: AdmissionRefusal };

function parseRecord(bytes: Uint8Array): EnvironmentRecord {
  try {
    return parseEnvironmentRecord(bytes);
  } catch (cause) {
    throw new AdmissionRefusalError(
      "invalid-environment-record",
      `the supplied environment record does not parse: ${String(cause)}`,
    );
  }
}

function parseSpec(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw new AdmissionRefusalError(
      "invalid-candidate",
      `the candidate EvaluationSpec bytes are not UTF-8 JSON: ${String(cause)}`,
    );
  }
}

async function observeSide(
  deps: AdmissionDeps,
  request: Omit<EnvironmentRunRequest, "attempt">,
): Promise<EnvironmentRunObservation[]> {
  const observations: EnvironmentRunObservation[] = [];
  for (let attempt = 1; attempt <= DIFFERENTIAL_ADMISSION_POLICY_V3.observationsPerSide; attempt += 1) {
    let observation: EnvironmentRunObservation;
    try {
      observation = await deps.runInEnvironment({ ...request, attempt: attempt as 1 | 2 });
    } catch (cause) {
      throw new AdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.patch.kind} for ${request.testPath} failed: ${String(cause)}`,
      );
    }
    const expected = request.patch.kind === "gold" ? request.patch.digest : null;
    if (observation.appliedPatchDigest !== expected) {
      throw new AdmissionRefusalError(
        "execution-failed",
        `run ${attempt} of ${request.patch.kind} for ${request.testPath} applied `
          + `${String(observation.appliedPatchDigest)}, not ${String(expected)}`,
      );
    }
    observations.push(observation);
  }
  return observations;
}

function observationBody(observation: EnvironmentRunObservation): unknown {
  return {
    passed: [...observation.passed],
    failed: [...observation.failed],
    passedMatch: observation.passedMatch,
  };
}

/**
 * Candidate + environment record -> receipt, or a refusal from the closed taxonomy. Source-agnostic
 * by construction: nothing here knows whether the candidate was imported, injected, or mined.
 */
export async function admitCandidate(
  deps: AdmissionDeps,
  candidate: AdmissionCandidate,
  environmentRecordBytes: Uint8Array,
): Promise<AdmissionResult> {
  try {
    const record = parseRecord(environmentRecordBytes);
    const environmentDigest = environmentRecordDigest(environmentRecordBytes) as `sha256:${string}`;
    const evaluationSpecDigest = recordDigest(candidate.evaluationSpecBytes);
    const inlineMatch = checkInlineEnvironmentMatch(
      record,
      parseSpec(candidate.evaluationSpecBytes),
      environmentDigest,
    );

    const testPaths = [];
    for (const rawPath of candidate.testPaths) {
      const command = targetTestCommandForPath(record, rawPath);
      const testPath = normalizeRepositoryPath(rawPath, "test path");
      const base = {
        environmentRecordDigest: environmentDigest,
        command,
        testMaterialDigests: candidate.testMaterialDigests,
        testPath,
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      };
      const brokenRuns = await observeSide(deps, { ...base, patch: { kind: "none" } });
      const fixedRuns = await observeSide(deps, {
        ...base,
        patch: { kind: "gold", digest: candidate.goldPatchHash },
      });
      const broken = stableObservation(brokenRuns.map(observationBody), "broken", testPath);
      const fixed = stableObservation(fixedRuns.map(observationBody), "fixed", testPath);
      testPaths.push({
        testPath,
        commandHash: recordDigest(canonicalJsonBytes(command)),
        broken: [broken, broken],
        fixed: [fixed, fixed],
        ...deriveTransitions(broken, fixed),
      });
    }

    return {
      receipt: verifyDifferentialAdmissionReceiptV3({
        schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
        admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
        issuer: deps.issuer,
        task: {
          documentDigest: candidate.taskDocumentDigest,
          evaluationSpecDigest,
          statementDigest: candidate.statementDigest,
          testMaterialDigests: [...candidate.testMaterialDigests],
          transitions: {
            failToPass: [...candidate.transitions.failToPass],
            passToPass: [...candidate.transitions.passToPass],
          },
        },
        goldPatchHash: candidate.goldPatchHash,
        testPaths,
        environment: { recordDigest: environmentDigest, inlineMatch },
        evalSemanticsVersion: candidate.evalSemanticsVersion,
      }),
    };
  } catch (error) {
    if (error instanceof AdmissionRefusalError) return { refusal: error.refusal };
    throw error;
  }
}
```

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS (9 new test cases; 65 total).

- [ ] **Step 3: Commit**

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): admitCandidate over the injected environment-run port"
```

---

### Task 8: Sealing — the in-toto wrapper, `sealReceipt`, and the Submission annotation

**Files:**
- Create: `src/seal.ts`, `src/seal.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `sealSignedRecord`, `parseSignedRecordEnvelope`, type `DsseSigner`, type
  `SealedRecord`, `dssePreAuthEncoding` from `@jinn-network/trust-core`
  (branch `integration/evidence-v1`).
- Produces: `buildAdmissionStatement(receipt)`, `sealReceipt(receipt, signer)`,
  `admissionReceiptAnnotation(sealed)`, types `AdmissionStatement`, `SealedAdmissionReceipt`,
  `AdmissionReceiptDescriptor`.

**Compatibility contract this task satisfies** (read from
`packages/task-execution/profiles/src/admission-receipt.ts` and
`packages/marketplace/binding/src/named-checks.ts`):

| Requirement | Where enforced downstream | How this task meets it |
| --- | --- | --- |
| envelope `payloadType` is `application/vnd.in-toto+json` | `named-checks.ts` payloadType check | `ADMISSION_RECEIPT_MEDIA_TYPE` |
| payload is an in-toto Statement with `_type`, `subject` (≥2), `predicateType`, `predicate.issuer` | `AdmissionReceiptStatementSchema` | `buildAdmissionStatement` |
| subject DigestSets name the sealed Task digest and the EvaluationSpec digest, **bare hex** | `checkAdmissionReceipt` | subjects derived from `receipt.task.*`, prefix stripped |
| the annotation descriptor's `digest.sha256` equals the digest of the **envelope bytes** | `admissionReceiptFailure` | `receiptDigest` = `sealSignedRecord(...).recordDigest` |
| descriptor `name` is `admission-receipt` | `evaluation-derive.ts`, `named-checks.ts` | `ADMISSION_RECEIPT_DESCRIPTOR_NAME` |

- [ ] **Step 1: Write the tests first**

`src/seal.test.ts`:

```ts
import { dssePreAuthEncoding, parseSignedRecordEnvelope, recordDigest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";
import { ADMISSION_RECEIPT_MEDIA_TYPE, DIFFERENTIAL_ADMISSION_PREDICATE_TYPE } from "./identifiers.js";
import { admissionReceiptAnnotation, buildAdmissionStatement, sealReceipt } from "./seal.js";
import { goldenReceipt } from "./testing.js";

/** A pure, deterministic test signer: no key material anywhere in this package. */
const signer = async (request: { preAuthEncoding: Uint8Array }) =>
  [{ signature: new TextEncoder().encode(recordDigest(request.preAuthEncoding)), keyid: "test" }] as const;

describe("buildAdmissionStatement", () => {
  it("wraps the receipt as the predicate of an in-toto Statement with bare-hex subjects", () => {
    const receipt = goldenReceipt();
    const statement = buildAdmissionStatement(receipt);
    expect(statement._type).toBe("https://in-toto.io/Statement/v1");
    expect(statement.predicateType).toBe(DIFFERENTIAL_ADMISSION_PREDICATE_TYPE);
    expect(statement.predicate).toStrictEqual(receipt);
    expect(statement.subject).toStrictEqual([
      { name: "task", digest: { sha256: receipt.task.documentDigest.slice(7) } },
      { name: "evaluation-spec", digest: { sha256: receipt.task.evaluationSpecDigest.slice(7) } },
    ]);
    for (const subject of statement.subject) {
      expect(subject.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(subject.digest.sha256.startsWith("sha256:")).toBe(false);
    }
  });
});

describe("sealReceipt", () => {
  it("seals under the in-toto payload type and identifies the receipt by its envelope digest", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const parsed = parseSignedRecordEnvelope(sealed.envelopeBytes, ADMISSION_RECEIPT_MEDIA_TYPE);
    expect(parsed.recordDigest).toBe(sealed.receiptDigest);
    expect(JSON.parse(new TextDecoder().decode(parsed.payloadBytes)).predicate.goldPatchHash)
      .toBe(goldenReceipt().goldPatchHash);
  });

  it("signs the DSSE pre-authentication encoding of the payload", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const expected = recordDigest(
      dssePreAuthEncoding(ADMISSION_RECEIPT_MEDIA_TYPE, sealed.payloadBytes),
    );
    const envelope = JSON.parse(new TextDecoder().decode(sealed.envelopeBytes));
    expect(new TextDecoder().decode(Uint8Array.from(atob(envelope.signatures[0].sig), (c) => c.charCodeAt(0))))
      .toBe(expected);
  });

  it("refuses to seal a receipt that does not satisfy the policy", async () => {
    const broken = { ...goldenReceipt(), goldPatchHash: "not-a-digest" };
    await expect(sealReceipt(broken as never, signer as never)).rejects.toThrow(/invalid-candidate/);
  });

  it("is byte-stable across repeated sealing of the same receipt", async () => {
    const first = await sealReceipt(goldenReceipt(), signer as never);
    const second = await sealReceipt(goldenReceipt(), signer as never);
    expect(second.envelopeBytes).toStrictEqual(first.envelopeBytes);
  });
});

describe("admissionReceiptAnnotation", () => {
  it("DIGEST-CONFUSION FIXTURE: emits a bare-hex DigestSet, never the sha256: spelling", async () => {
    const sealed = await sealReceipt(goldenReceipt(), signer as never);
    const descriptor = admissionReceiptAnnotation(sealed);
    expect(descriptor).toStrictEqual({
      name: "admission-receipt",
      mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
      digest: { sha256: sealed.receiptDigest.slice("sha256:".length) },
    });
    expect(descriptor.digest.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `Failed to resolve import "./seal.js"` (and `./testing.js`, which Task 9 writes;
write `src/testing.ts`'s `goldenReceipt` in Step 2 below so this task is self-contained).

- [ ] **Step 2: Write `src/seal.ts` and the `goldenReceipt` fixture**

`src/seal.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

import { sealSignedRecord, type DsseSigner } from "@jinn-network/trust-core";
import {
  ADMISSION_RECEIPT_DESCRIPTOR_NAME,
  ADMISSION_RECEIPT_MEDIA_TYPE,
  DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
  IN_TOTO_STATEMENT_TYPE,
} from "./identifiers.js";
import {
  verifyDifferentialAdmissionReceiptV3,
  type DifferentialAdmissionReceiptV3,
} from "./receipt.js";

export interface AdmissionStatementSubject {
  readonly name: string;
  /** in-toto DigestSet: bare lowercase hex, never `sha256:`-prefixed. */
  readonly digest: { readonly sha256: string };
}

export interface AdmissionStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_TYPE;
  readonly subject: readonly [AdmissionStatementSubject, AdmissionStatementSubject];
  readonly predicateType: typeof DIFFERENTIAL_ADMISSION_PREDICATE_TYPE;
  readonly predicate: DifferentialAdmissionReceiptV3;
}

export interface SealedAdmissionReceipt {
  readonly envelopeBytes: Uint8Array;
  readonly payloadBytes: Uint8Array;
  /** Digest of the sealed envelope bytes — the receipt's identity. */
  readonly receiptDigest: `sha256:${string}`;
}

export interface AdmissionReceiptDescriptor {
  readonly name: typeof ADMISSION_RECEIPT_DESCRIPTOR_NAME;
  readonly mediaType: typeof ADMISSION_RECEIPT_MEDIA_TYPE;
  readonly digest: { readonly sha256: string };
}

function bareHex(digest: `sha256:${string}`): string {
  return digest.slice("sha256:".length);
}

/**
 * Wrap a receipt as the predicate of an in-toto Statement whose subjects are the sealed Task and
 * EvaluationSpec digests. Subjects are *derived* from the receipt body, so the two can never
 * diverge. This shape is what the evaluation leg parses (design §7.1: conform, do not redefine).
 */
export function buildAdmissionStatement(
  receipt: DifferentialAdmissionReceiptV3,
): AdmissionStatement {
  const checked = verifyDifferentialAdmissionReceiptV3(receipt);
  return {
    _type: IN_TOTO_STATEMENT_TYPE,
    subject: [
      { name: "task", digest: { sha256: bareHex(checked.task.documentDigest) } },
      { name: "evaluation-spec", digest: { sha256: bareHex(checked.task.evaluationSpecDigest) } },
    ],
    predicateType: DIFFERENTIAL_ADMISSION_PREDICATE_TYPE,
    predicate: checked,
  };
}

/** Seal a receipt with an injected signer. No key material lives in this package. */
export async function sealReceipt(
  receipt: DifferentialAdmissionReceiptV3,
  signer: DsseSigner,
): Promise<SealedAdmissionReceipt> {
  const sealed = await sealSignedRecord({
    record: buildAdmissionStatement(receipt),
    payloadType: ADMISSION_RECEIPT_MEDIA_TYPE,
    signer,
  });
  return {
    envelopeBytes: sealed.envelopeBytes,
    payloadBytes: sealed.payloadBytes,
    receiptDigest: sealed.recordDigest,
  };
}

/**
 * The descriptor a Submission carries at `ADMISSION_RECEIPT_ANNOTATION_URI`. Its digest names the
 * envelope bytes and uses the bare-hex DigestSet spelling — the receipt body's own digests keep
 * the `sha256:` prefix (program contract 6).
 */
export function admissionReceiptAnnotation(
  sealed: SealedAdmissionReceipt,
): AdmissionReceiptDescriptor {
  return {
    name: ADMISSION_RECEIPT_DESCRIPTOR_NAME,
    mediaType: ADMISSION_RECEIPT_MEDIA_TYPE,
    digest: { sha256: bareHex(sealed.receiptDigest) },
  };
}
```

`src/testing.ts` (first half — Task 9 adds the conformance suite):

```ts
// SPDX-License-Identifier: Apache-2.0

import { ADMISSION_RECEIPT_SCHEMA_VERSION, DIFFERENTIAL_ADMISSION_POLICY_V3 } from "./identifiers.js";
import type { DifferentialAdmissionReceiptV3 } from "./receipt.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const BROKEN = { passed: ["keeps"], failed: ["target"], passedMatch: false } as const;
const FIXED = { passed: ["keeps", "target"], failed: [], passedMatch: true } as const;

/** A policy-valid receipt over one discriminating test path. */
export function goldenReceipt(): DifferentialAdmissionReceiptV3 {
  return {
    schemaVersion: ADMISSION_RECEIPT_SCHEMA_VERSION,
    admissionPolicyVersion: DIFFERENTIAL_ADMISSION_POLICY_V3.admissionPolicyVersion,
    issuer: "https://jinn.network/agents/admission-1",
    task: {
      documentDigest: digest("1"),
      evaluationSpecDigest: digest("2"),
      statementDigest: digest("3"),
      testMaterialDigests: [digest("4")],
      transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    },
    goldPatchHash: digest("5"),
    testPaths: [{
      testPath: "tests/unit/test_thing.py",
      commandHash: digest("6"),
      broken: [{ ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] },
               { ...BROKEN, passed: [...BROKEN.passed], failed: [...BROKEN.failed] }],
      fixed: [{ ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] },
              { ...FIXED, passed: [...FIXED.passed], failed: [...FIXED.failed] }],
      failToPass: ["target"],
      passToPass: ["keeps"],
    }],
    environment: {
      recordDigest: digest("7"),
      inlineMatch: { fields: ["image", "parser", "platform"], specKeyPresent: true },
    },
    evalSemanticsVersion: "4",
  };
}
```

- [ ] **Step 3: Extend the public surface**

`src/index.ts`:

```ts
// SPDX-License-Identifier: Apache-2.0

export * from "./admit.js";
export * from "./identifiers.js";
export * from "./inline-match.js";
export * from "./observations.js";
export * from "./receipt.js";
export * from "./refusals.js";
export * from "./seal.js";
export * from "./test-paths.js";
```

`src/index.ts` never re-exports `./testing.js`.

- [ ] **Step 4: Verify and commit**

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck && yarn build`
Expected: PASS (6 new test cases; 71 total); `dist/` produced.

```bash
git add packages/task-supply/admission/src
git commit -m "feat(task-admission): DSSE sealing as an in-toto statement and the Submission annotation descriptor"
```

---

### Task 9: The conformance kit, the mandatory fixtures, and the CI wiring

**Files:**
- Modify: `src/testing.ts` (add fixtures + the conformance suite), `.github/scripts/task-supply-source-boundaries.test.mjs`
- Create: `src/testing.test.ts`

**Interfaces:**
- Consumes: `vitest` (declared as an exact optional peer, evidence-tree precedent); C1's
  `sealEnvironmentRecord` for the record fixture.
- Produces: the `./testing` entrypoint — `goldenReceipt()`, `goldenEnvironmentRecordBytes()`,
  `goldenEvaluationSpecBytes(overrides?)`, `goldenCandidate(overrides?)`,
  `scriptedRunner(script?)`, `describeTaskAdmissionConformance(label, subject)`.

The kit is the artifact C4 builds against (contract 2, spec §11: the admission kit is green before
derivation builds). It carries the four checks this component owes:

1. **golden receipt round-trip** — `verifyDifferentialAdmissionReceiptV3(goldenReceipt())` is
   identity, and seal → parse → predicate is byte-stable;
2. **refusal taxonomy** — every code in `ADMISSION_REFUSAL_CODES` is reachable, and no refusal
   escapes it;
3. **the mandatory adversarial fixture** — inline image ≠ referenced record → `env-record-mismatch`;
4. **gold-digest-only** — no patch bytes reach the receipt or the runner port.

- [ ] **Step 1: Write the kit's own test first**

`src/testing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { admitCandidate } from "./admit.js";
import { ADMISSION_REFUSAL_CODES } from "./refusals.js";
import {
  describeTaskAdmissionConformance,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  mismatchedImageCandidate,
  scriptedRunner,
} from "./testing.js";

describeTaskAdmissionConformance("in-package", {
  admitCandidate,
  goldenCandidate,
  goldenEnvironmentRecordBytes,
  mismatchedImageCandidate,
  scriptedRunner,
});

describe("the kit reaches every refusal code", () => {
  it("covers the closed taxonomy", async () => {
    const reached = new Set<string>();
    for (const scenario of Object.values(scriptedRunner.refusalScenarios)) {
      const result = await admitCandidate(
        { runInEnvironment: scenario.runner, issuer: "https://jinn.network/agents/kit" },
        scenario.candidate(),
        scenario.recordBytes(),
      );
      if ("refusal" in result) reached.add(result.refusal.code);
    }
    expect([...reached].sort()).toStrictEqual([...ADMISSION_REFUSAL_CODES]);
  });
});
```

Run: `cd packages/task-supply/admission && yarn test`
Expected: FAIL — `./testing.js` does not export `goldenCandidate`.

- [ ] **Step 2: Complete `src/testing.ts`**

Add to the file written in Task 8:

```ts
import { sealEnvironmentRecord } from "@jinn-network/environment-record";
import { describe, expect, it } from "vitest";
import type { AdmissionCandidate, EnvironmentRunObservation, EnvironmentRunRequest, RunInEnvironmentPort } from "./admit.js";

const MANIFEST = digest("1");
const PARSER = digest("3");
const GOLD = digest("5");

/**
 * A sealed, tier-0 imported environment record: one image, one platform, one targetable test
 * command, one pinned parser.
 */
export function goldenEnvironmentRecordBytes(): Uint8Array {
  return sealEnvironmentRecord({
    kind: "https://jinn.network/records/environment/1.0",
    source: { repo: "owner/name", repoUrl: "https://github.com/owner/name", commit: "a".repeat(40) },
    image: {
      manifestDigest: MANIFEST,
      platform: "linux/amd64",
      reference: `ghcr.io/example/env@${MANIFEST}`,
    },
    workspace: "/testbed",
    invocations: { test: [{ bin: "python", args: ["-m", "pytest", "-rA"], cwd: "/testbed" }] },
    parser: { id: "pytest-log", version: "3", digest: PARSER },
    build: { reproducibilityTier: 0, provider: { id: "upstream-import", version: "1" } },
    rights: { sourceLicense: "MIT" },
  } as never);
}

/**
 * An EvaluationSpec whose inline deterministic-process block matches the golden record. The block
 * mirrors `DETERMINISTIC_PROCESS_SHAPE` in
 * packages/task-execution/profiles/src/evaluation-spec/family-blocks.ts field for field — this
 * fixture is the compatibility proof for the local reader in inline-match.ts (design §3.3
 * forbids importing profiles).
 */
export function goldenEvaluationSpecBytes(blockOverrides: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    protocol: "https://jinn.network/profiles/evaluation-spec/1.0",
    family: "deterministic-process",
    familyBlock: {
      image: { uri: `ghcr.io/example/env@${MANIFEST}`, digest: { sha256: MANIFEST.slice(7) } },
      platform: "linux/amd64",
      workspace: { path: "/testbed" },
      testMaterial: [{ name: "test-patch", digest: { sha256: digest("4").slice(7) }, accessClass: "public" }],
      parser: { id: "pytest-log", version: "3", digest: PARSER },
      transitions: { failToPass: ["target"], passToPass: ["keeps"] },
      timeout: 1800,
      "network.jinn.environment.record": {
        digest: { sha256: environmentRecordDigest(goldenEnvironmentRecordBytes()).slice(7) },
      },
      ...blockOverrides,
    },
  }));
}

export function goldenCandidate(overrides: Partial<AdmissionCandidate> = {}): AdmissionCandidate {
  return {
    taskDocumentDigest: digest("1"),
    statementDigest: digest("3"),
    testMaterialDigests: [digest("4")],
    transitions: { failToPass: ["target"], passToPass: ["keeps"] },
    goldPatchHash: GOLD,
    evaluationSpecBytes: goldenEvaluationSpecBytes(),
    testPaths: ["tests/unit/test_thing.py"],
    evalSemanticsVersion: "4",
    ...overrides,
  };
}

/** The mandatory adversarial fixture (design §7.1): inline image != referenced record. */
export function mismatchedImageCandidate(): AdmissionCandidate {
  const other = digest("2");
  return goldenCandidate({
    evaluationSpecBytes: goldenEvaluationSpecBytes({
      image: { uri: `ghcr.io/example/env@${other}`, digest: { sha256: other.slice(7) } },
    }),
  });
}

/** A pure runner whose per-side answers are scripted; it never touches a container. */
export function scriptedRunner(
  script: Partial<Record<"none" | "gold", EnvironmentRunObservation>> = {},
): RunInEnvironmentPort {
  return async (request: EnvironmentRunRequest) => {
    const gold = request.patch.kind === "gold";
    return script[request.patch.kind] ?? {
      passed: gold ? ["keeps", "target"] : ["keeps"],
      failed: gold ? [] : ["target"],
      passedMatch: gold,
      appliedPatchDigest: gold ? GOLD : null,
    };
  };
}

/** One scenario per refusal code, so a consumer can prove the taxonomy is reachable and closed. */
scriptedRunner.refusalScenarios = { /* one entry per code in ADMISSION_REFUSAL_CODES */ } as Record<
  string,
  { runner: RunInEnvironmentPort; candidate: () => AdmissionCandidate; recordBytes: () => Uint8Array }
>;

export interface TaskAdmissionConformanceSubject {
  readonly admitCandidate: typeof import("./admit.js").admitCandidate;
  readonly goldenCandidate: typeof goldenCandidate;
  readonly goldenEnvironmentRecordBytes: typeof goldenEnvironmentRecordBytes;
  readonly mismatchedImageCandidate: typeof mismatchedImageCandidate;
  readonly scriptedRunner: typeof scriptedRunner;
}

/** The admission conformance kit (spec §11). Green before derivation builds on this package. */
export function describeTaskAdmissionConformance(
  label: string,
  subject: TaskAdmissionConformanceSubject,
): void {
  describe(`task admission conformance (${label})`, () => {
    const deps = { issuer: "https://jinn.network/agents/kit", runInEnvironment: subject.scriptedRunner() };

    it("admits a discriminating candidate against its own environment record", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      expect("receipt" in result).toBe(true);
    });

    it("refuses env-record-mismatch when the inline image is not the referenced record's", async () => {
      const result = await subject.admitCandidate(
        deps, subject.mismatchedImageCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      expect("refusal" in result && result.refusal.code).toBe("env-record-mismatch");
    });

    it("records that the inline-match check ran", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(result.receipt.environment.inlineMatch).toStrictEqual({
        fields: ["image", "parser", "platform"], specKeyPresent: true,
      });
    });

    it("carries the gold patch as a digest and never as bytes", async () => {
      const result = await subject.admitCandidate(
        deps, subject.goldenCandidate(), subject.goldenEnvironmentRecordBytes(),
      );
      if (!("receipt" in result)) throw new Error("expected a receipt");
      expect(result.receipt.goldPatchHash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(result.receipt)).not.toContain("diff --git");
    });
  });
}
```

Fill `scriptedRunner.refusalScenarios` with exactly seven entries, one per code — each a
`{ runner, candidate, recordBytes }` triple reusing the refusal paths already tested in Tasks 3–7:
`duplicate-assertion-id` (two test paths sharing `keeps`), `env-record-mismatch`
(`mismatchedImageCandidate`), `execution-failed` (a runner that throws), `invalid-candidate`
(`testPaths: ["../escape.py"]`), `invalid-environment-record` (record bytes `{not json`),
`no-discrimination` (an inert runner), `unstable-observations` (a runner that flakes on repeat 2).

- [ ] **Step 3: Register `./testing` with the boundary guard**

In `.github/scripts/task-supply-source-boundaries.test.mjs`, the `assertBoundary` helper already
excludes `*.test.ts` but **not** `testing.ts`. `src/testing.ts` imports `vitest` (a peer, not a
Jinn package) and `@jinn-network/environment-record` (approved), so no change is needed — add a
comment above the admission `assertBoundary` call recording that `src/testing.ts` is production
source under the same boundary, and that its `vitest` import is an optional peer.

- [ ] **Step 4: Run the kit**

Run: `cd packages/task-supply/admission && yarn test && yarn typecheck`
Expected: PASS — 4 conformance cases + the taxonomy-coverage case; ~76 tests total.

- [ ] **Step 5: Run every guard and the packed-types canary**

Run:

```bash
cd packages/task-supply/admission && yarn install --immutable && yarn typecheck && yarn test && yarn build && yarn pack:smoke && cd -
node --test .github/scripts/task-supply-package-inventory.test.mjs
node --test .github/scripts/task-supply-source-boundaries.test.mjs
node .github/scripts/task-supply-packed-types.test.mjs
```

Expected: every command PASS. The packed-types canary prints `Compiled a packed TypeScript
consumer against 2 public code entrypoints across all 1 task-supply packages.`

- [ ] **Step 6: Commit**

```bash
git add packages/task-supply/admission .github/scripts/task-supply-source-boundaries.test.mjs
git commit -m "feat(task-admission): the admission conformance kit with the mandatory inline-mismatch fixture"
```

- [ ] **Step 7: Open the stacked PR**

```bash
git push -u origin supply/c3-task-admission
gh pr create --base supply/c1-environment-record --title "feat(task-admission): differential admission with inline-match enforcement" --body "$(cat <<'EOF'
Implements C3 of the verified-environment supply program
(`docs/superpowers/plans/2026-07-31-supply-c3-task-admission.md`), against
`docs/superpowers/specs/2026-07-31-verified-environment-supply-design.md` §7.1.

Also opens `packages/task-supply/` — guard trio + CI (program §1).

Both normative rules of §7.1 are test-covered by name:
- inline-match enforcement, with the mandatory adversarial fixture (inline image != referenced
  record -> `env-record-mismatch`)
- attestation-agnosticism, enforced by dependency, import, and export-name assertions

Findings F-C3-1 .. F-C3-4 are recorded in the plan for the component review.

Stacked on `supply/c1-environment-record`; do not merge before it.
EOF
)"
```

---

## Component review gate

Before C4 builds on this package, one independent high-effort review (principles §13.2) checks it
against the design, covering at minimum:

1. **§7.1 rule 1 coverage** — is inline-match enforcement complete? Does any path reach a receipt
   without it? Is the reference-vs-DigestSet reconciliation right for real OCI references?
2. **§7.1 rule 2 coverage** — does anything in the package read, require, or imply an attestation?
3. **The refusal taxonomy** — is it closed, reachable, and correctly assigned (especially the
   `invalid-candidate` / `env-record-mismatch` split, and `execution-failed` covering both a
   throwing runner and a patch-binding violation)?
4. **The in-toto wrapper** (Finding F-C3-1) — does a sealed receipt actually satisfy
   `checkAdmissionReceipt` and `admissionReceiptFailure` end to end?
5. **Digest discipline** — `sha256:` in receipt bodies, bare hex in DigestSets, in every producer.
6. **Bounded claims** — does any exported name, message, or README line claim more than the
   evidence supports?

## Findings this plan carries into the component review

Dated 2026-07-31. Designs are law (program contract 1) — each of these is a proposed disposition
to be ruled on, not a silent patch.

- **F-C3-1 — the receipt needs an in-toto wrapper the spec's field list omits.** Spec §7.1 lists
  the receipt as "policy version, task binding (statement digest, test-material digests,
  transitions), `goldPatchHash`, per-path 2×2 observations, derived F2P/P2P, `environment:
  {recordDigest}`, semantics version", and adds that the receipt "is DSSE-signed by the admitting
  party (the marketplace evaluation leg already validates issuer scope and purpose for admission
  receipts — this unit conforms to that existing contract rather than defining a new one)."
  Reading the existing contract (`packages/task-execution/profiles/src/admission-receipt.ts`,
  `packages/marketplace/binding/src/named-checks.ts`) shows it requires strictly more: the
  envelope's `payloadType` must be `application/vnd.in-toto+json`; the payload must be an in-toto
  Statement with `_type`, ≥2 subjects, a `predicateType`, and `predicate.issuer`; and the subject
  DigestSets must name the **sealed Task digest** and the **EvaluationSpec digest** in bare hex.
  **Disposition (implemented here):** the §7.1 field list is the *predicate*; this plan adds
  `issuer`, `task.documentDigest`, and `task.evaluationSpecDigest` to the receipt body and derives
  the Statement subjects from them, so the two can never diverge. **Proposed amendment:** §7.1
  gains one sentence naming the wrapper and the three additional fields. Raise at the component
  review; do not edit the spec unilaterally.
- **F-C3-2 — declared transitions are recorded but not cross-checked against derived ones.** The
  receipt carries both the candidate's declared `task.transitions` and the per-path derived
  `failToPass`/`passToPass`. Nothing in §7.1 requires them to agree, and this plan does not add
  that rule: a candidate could declare transitions the observations do not support, and still earn
  a receipt (a consumer can detect it, since both are in the receipt). **Proposed disposition:**
  amend §7.1 to require that every declared `failToPass` identifier appear in some path's derived
  `failToPass`, with a new refusal code `transitions-mismatch`. Not implemented here — it is a new
  normative rule, and inventing one is exactly what contract 1 forbids.
- **F-C3-3 — `network.jinn.environment.record` is pinned to C4 in program §4, but admission must
  enforce it.** Leaving the key unchecked reopens the §7.1 blocker from the other side: a pair
  could pass the inline-field check while its spec cites a *different* record, and inherit that
  record's evidence. This plan therefore declares and exports `ENVIRONMENT_RECORD_SPEC_KEY` in C3
  and refuses `env-record-mismatch` when the key names a record other than the one admission was
  given. **Proposed disposition:** program §4's C4 line reads "uses" rather than "defines" for
  this key, and C4 imports the constant from `@jinn-network/task-admission`. The exact string is
  unchanged either way, so no contract moves — only its declaring package. Confirm at the
  component review before C4 starts.
- **F-C3-4 — `ADMISSION_RECEIPT_ANNOTATION_URI` now exists in two trees.** `marketplace/binding`
  declares it, and admission cannot import that tree (design §3.3). This plan pins the literal by
  test in both places rather than sharing a symbol. **Proposed disposition:** accept the
  duplication for v1; if a third tree needs the URI, it moves to a shared identifiers package.
  Filed so the duplication is on the record rather than discovered later.

## Self-review

- **§7.1 coverage.** Both normative rules are covered by tests that name them: the inline-match
  rule (Task 5 — golden match, the mandatory adversarial mismatch fixture, platform, three parser
  fields, the spec-key cross-check, the digest-confusion fixture; re-asserted end-to-end in Task 7
  and in the kit, Task 9) and attestation-agnosticism (Task 2 — dependency set, import scan,
  export-name scan; plus the tree boundary guard's `@jinn-network/environment-verification` and
  `@jinn-network/attestation-issuer` bans, Task 1). The kit's four required checks — golden
  round-trip, refusal taxonomy, mismatch fixture, gold-digest-only — are Task 9 Steps 1–2.
- **Placeholder scan.** No `TODO`, `FIXME`, `…`, or `<fill in>` in any code block. Two places name
  work the implementer completes from an explicit enumeration rather than from a blank: Task 9's
  `scriptedRunner.refusalScenarios` (the seven codes and their scenarios are listed in Step 2) and
  Task 1's guard-file `cp`-then-edit steps (every constant table and every renamed identifier is
  given verbatim).
- **Signature consistency.** `admitCandidate(deps, candidate, environmentRecordBytes)` returns
  `{receipt} | {refusal: {code, detail}}` with `code` drawn from a seven-member closed taxonomy
  including `env-record-mismatch`; `sealReceipt(receipt, signer)` keeps its pinned two-argument
  shape (the statement subjects are derived, not passed); the receipt type is named
  `DifferentialAdmissionReceiptV3` with `environment: {recordDigest, inlineMatch}` and gold as a
  digest only. These match program §4's pinned C3 line exactly.
- **Consumes discipline.** Every consumed symbol is pinned in program §4 (C1:
  `parseEnvironmentRecord`, `sealEnvironmentRecord`, `environmentRecordDigest`,
  `CommandSpecSchema`, type `EnvironmentRecord`) or already exists on `integration/evidence-v1`
  (trust-core: `sealSignedRecord`, `parseSignedRecordEnvelope`, `dssePreAuthEncoding`,
  `canonicalJsonBytes`, `recordDigest`, `compareCodeUnitStrings`, type `DsseSigner` — all verified
  present in `packages/trust/core/src/` on 2026-07-31). Tasks 3 and 7 carry explicit
  stop-and-report clauses for the C1 symbols.
