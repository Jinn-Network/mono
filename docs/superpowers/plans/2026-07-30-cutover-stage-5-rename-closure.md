# Cutover Stage 5 — Rename and Closure Implementation Plan

> **Addendum 2026-08-15** (execution train after [#2688](https://github.com/Jinn-Network/mono/pull/2688)
> landed the one-swap onto `next` at `6a09c9d36`):
>
> - **Branch target is `next`**, not `integration/evidence-v1`. Every merge that
>   touches the operator tree publishes canary. Semantic deletions stay on
>   `client/`; the paths-only rename is last so a missed `working-directory`
>   cannot strand canary until that one mechanical PR.
> - **D5 (native-v1 parallel entry) is stage 5**, not Wave 4
>   ([DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)
>   decision 3). Delete `native-main.ts`, `NativeProductFileSchema`, per-role
>   file leases, the `Daemon` `native-v1` branch, and `run.ts` dual dispatch.
>   Keep `main.ts` and `compositionMode: "native"`. Flip
>   `legacy-operator-composition` in that PR; rewrite `defaultPolicy` to the
>   stage-driven frame Wave 4 left unflipped.
> - **Reorder vs Tasks 6–10:** re-home then delete `task_runs` and
>   `joinedSolverNets` *before* the rename. Both are still boot-reachable
>   (Task 8/9 stop-rule). Backup prune uses the shipped shape
>   `<filePath>.backup-<ISO-basic>` from `client/src/config/atomic-write.ts`,
>   not this plan's `config.json.pre-v2.*.bak` (finding F5: the code is right).
> - **Rename file list grew.** Recensus at the rename PR. Known additions:
>   `native-e2e-rig.yml`, `release-tier-1.yml`, `marketplace-ci.yml`,
>   CODEOWNERS `/client/` blanket, reverse refs in
>   `packages/marketplace/testing` and `packages/benchmarking/records`, and
>   every `.github/scripts` that still `join(root, 'client')`. Canary-critical:
>   flip `sdk-npm-publish.yml` `paths: client/**` and
>   `npm-publish.yml` `working-directory: client` in the same commit as
>   `git mv`.
> - Historical task bodies below are **not** rewritten. The 2026-08-05 addendum
>   still stands for the collapsed stages 2–4.
>
> **Addendum 2026-08-05** (per
> [DR-2026-08-05](../../../log/decisions/2026-08-05-cutover-one-swap-collapse.md)): stages
> 2–4 collapsed into one wholesale swap. The Global Constraints dependency reads:
> *depends on the one-swap deploy PR merged and its two-probe gate green*. Baseline
> assumption 1 restates as: *the swap has landed — `client/src/discovery/`, peer-sync,
> the registry client, the delivery-watcher, the mech adapter's evaluation machinery,
> the legacy TaskEngine, the creator loop, the launched-record generators, and lifecycle
> publishing are gone; the native evaluator and posting flows and the public archive
> listener are live.* Baseline assumption 2 restates as: *the swap retired the legacy
> TaskEngine, so what remains of `task_runs` is residual — Task 8 discovers the exact
> residue.* Everything else in this plan (rename mechanics, guard trio, findings F1–F7,
> legacy-key deletion, backup pruning) is unchanged; the headless §13 stage-5 addition
> (`verticalMode` manifest rows flip in the branch-deletion PR) stands, and DR-2026-08-05
> decision 7 lists which transition-manifest rows remain for this stage.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the operator-daemon cutover — rename `client/` → `operator/` as one paths-only commit, install the operator tree's first guard trio, delete the `task_runs` state machine and the legacy SolverNet config keys, fix the repository's last cross-tree import violation (#2297), and file the bridge-retirement chore.

**Architecture:** Guards go in **before** the rename (on the still-named `client/` tree) so the rename commit has a working boundary check to prove it did not smuggle a semantic change; the rename is then a single mechanical commit whose entire correctness claim is "the tree still builds and every guard still runs against it"; the deletions land after, each with its own verification. The rename is paths-only — the npm package name `@jinn-network/client`, the OCI image name `ghcr.io/jinn-network/client`, the `~/.jinn-client` state directory, the `client-v*` release tags, and every CI job name stay exactly as they are.

**Tech Stack:** TypeScript / Node 22 / Yarn 4.13.0 with `portal:` resolution; `node --test` for the `.github/scripts/*.test.mjs` guards; vitest for the tree's own suite; GitHub Actions; Docker.

## Global Constraints

- Branch target: `integration/evidence-v1` (stacked PR train; the integration branch is not yet in `next`). Nothing here publishes to npm.
- Depends on stage 4 complete (`2026-07-30-cutover-stage-4-discovery-serving.md`) and on PRs #2306 / #2307 / #2308 merged. #2306 edited `.github/workflows/npm-publish.yml`, which carries `working-directory: client` and reads `../packages/sdk/package.json`; if this worktree predates that merge, read the merged form via `docs/superpowers/plans/2026-07-30-marketplace-surfaces-immediate-tranche.md` Task 1 before editing.
- Every task ends with typecheck + tests + the relevant guards run locally, outputs shown.
- American English throughout; no product names in tier-3 code.
- Design is law (`docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md`, v0.2): §3 rename rationale, §9 retirement completions, §10 stage-5 row + standing rules, §12.3 bridge-retirement chore. Discoveries are findings with proposed dispositions, never silent patches.
- Stacked PRs, no agent self-merge; the stage deploy PR is operator-approved.
- The `core`/`layer`/`plugin` portal surface survives this stage. Their `portal:` specs are **depth-preserving** (`portal:../packages/core` from `operator/` resolves identically to `portal:../packages/core` from `client/`), so their disposition is untouched here — it stays with the plugin session (design §12.2).

---

## Baseline assumptions (verify before Task 1)

State these in the stage PR description:

1. Stage 4 has landed: `client/src/discovery/`, the peer-sync loop, and the registry client are gone; the projector, work, evaluator, posting loops and the evidence driver are live; the archive is mounted.
2. Stages 1–2 retired the legacy TaskEngine, so what remains of `task_runs` at this point is **residual** — Task 8 discovers the exact residue rather than assuming it.
3. Stage 1 shipped the additive config migration and writes a timestamped pre-migration backup. **This plan pins the backup filename shape** (finding F5 below): `<configDir>/config.json.pre-v2.<ISO8601-basic>.bak`, permissions copied from the source file. If stage 1 shipped a different shape, Task 10 uses stage 1's actual shape and the coordinator is told.
4. The repo has **no root `package.json`** and no root workspace. Each tree installs independently (`cd client && yarn install`). There is nothing repo-level to re-point.

## Findings carried into this plan (proposed dispositions)

- **F1 — `client` is overloaded; only the directory renames.** `@jinn-network/client` (npm name), `ghcr.io/jinn-network/client` (OCI image, referenced by live Railway services), `~/.jinn-client` (operator state dir on every existing installation), `client-v*` (release tags in `docker.yml`, `npm-publish.yml`, `release-notes-scaffold.yml`), `packages/discovery/client` (a different tree), and `bin: {"client": …}` are **not** paths. *Disposition: none of them change in this stage.* Renaming the npm package or the state directory is a breaking operator-visible change with its own migration; it is not in the design and is not done here.
- **F2 — CI job names are branch-protection contexts.** `.github/scripts/enable-hermetic-gate-required.sh` and `enable-main-base-guard.sh` write `required_status_checks.contexts` from job names. The `client-compat` jobs in `core-ci.yml`, `layer-ci.yml`, `plugin-ci.yml`, `sdk-ci.yml` are such names. *Disposition: job names and workflow `name:` fields are not renamed. Only `working-directory:`, `paths:`, `file:`, and path arguments change.*
- **F3 — three stack guard scripts hard-code `join(root, 'client')` in their `APPLICATION_AND_LEGACY_ROOTS` forbidden-escape list** (`marketplace-source-boundaries.test.mjs:11`, `task-execution-source-boundaries.test.mjs:16`, `record-discovery-source-boundaries.test.mjs:11`, plus `evidence-source-boundaries.test.mjs:17,625,628`). Missing these means the stack packages could relative-import into `operator/` with no guard firing. *Disposition: they are load-bearing edits inside the rename commit (Task 6).*
- **F4 — `.github/CODEOWNERS` carries seven `/client/src/dashboard/spa/…` human-surface paths.** A missed path silently drops the human-review gate on the operator SPA. *Disposition: in the rename commit, verified by an explicit `git grep` assertion.*
- **F5 — the config-backup filename shape is not pinned by any earlier plan.** Task 10 must prune what stage 1 wrote. *Disposition: this plan pins the shape (see assumption 3) as a cross-plan contract; the coordinator propagates it to the stage-1 plan. If stage 1 already shipped a different shape, Task 10 adopts it and the plan is amended, not the code.*
- **F6 — deleting `task_runs` code must not drop the table from existing operator databases.** A `DROP TABLE` destroys the operator's local history and makes a stage revert lossy. *Disposition: delete only the code that creates, migrates, reads, and writes the table. Existing databases keep an orphaned table; that is harmless and reversible.*
- **F7 — 294 files under `docs/` mention `client/`; the overwhelming majority are dated historical plans and specs.** Per the repo's standing rule that dated historical documents are not retro-edited, sweeping them would be a 250-file diff of pure noise that also falsifies the historical record. *Disposition: Task 7 sweeps only live operational docs and agent-skill references — the enumerated set in that task — and leaves everything under `docs/superpowers/plans/`, `docs/superpowers/specs/`, `spec/`, `log/`, and `docs/press/` untouched.*

## File structure

**New files (all created before the rename, then renamed with the tree or left in `.github/`):**

| File | Responsibility |
| --- | --- |
| `.github/scripts/operator-source-boundaries.test.mjs` | Guard 1 — no relative import from the operator tree escapes it; no deep import into another package's `src/`/`dist/`. This is #2297's regression guard. |
| `.github/scripts/operator-package-inventory.test.mjs` | Guard 2 — the operator manifest's `@jinn-network/*` dependency set, portal targets, and workspace list are exactly the approved shape. |
| `.github/scripts/operator-packed-types.test.mjs` | Guard 3 — pack the operator, install the tarball into a scratch consumer, and typecheck an `import` against the packed `.d.ts`. |

**Modified (the enumerated rename surface, Task 6):** twelve workflow files, three deploy files, seven CODEOWNERS lines, six `.github/scripts/*.mjs` guards, four reverse cross-tree references (`packages/core`, `packages/sdk`, `packages/indexer/explorer`, `contracts/scripts`), two ignore files, and the in-tree literal-path sweep.

**Deleted (Tasks 8–10):** the `task_runs` persistence residue; `joinedSolverNets` / `solverNets` config schema and migration; the stage-1 config backup pruning path is *added*, the backups themselves are pruned at runtime.

---

### Task 1: Operator source-boundary guard (red on #2297)

Write the guard first, on the tree still named `client/`, and watch it fail on the one real violation. That failure is the regression test for Task 2.

**Files:**
- Create: `.github/scripts/operator-source-boundaries.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `node --test`-runnable guard. Task 5 wires it into `ci.yml`. Task 6 flips its `TREE` constant from `client` to `operator`.

- [ ] **Step 1: Write the failing guard**

Create `.github/scripts/operator-source-boundaries.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'client';
const treeRoot = join(root, TREE);

// Directories inside the tree whose sources are checked.
const SCANNED = ['src', 'scripts', 'test'];

// Every sibling tree the operator must not reach into with a relative path.
// A relative escape bypasses the package boundary and the portal graph, which
// is exactly the #2297 violation class.
const SIBLING_ROOTS = [
  join(root, 'packages'),
  join(root, 'apps'),
  join(root, 'contracts'),
  join(root, 'examples'),
  join(root, 'legacy'),
];

const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/u;
// import ... from '<spec>' | export ... from '<spec>' | import('<spec>')
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu;

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') return [];
      return sourceFiles(child);
    }
    return SOURCE_EXTENSIONS.test(entry.name) ? [child] : [];
  });
}

function relativeEscapes(file) {
  const contents = readFileSync(file, 'utf8');
  const offenders = [];
  for (const match of contents.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const target = resolve(file, '..', specifier);
    if (!relative(treeRoot, target).startsWith('..')) continue;
    const escaped = SIBLING_ROOTS.some(
      (sibling) => !relative(sibling, target).startsWith('..'),
    );
    if (escaped) offenders.push(`${relative(root, file)} -> ${specifier}`);
  }
  return offenders;
}

// A bare-specifier import that reaches past a package's public entrypoint,
// e.g. '@jinn-network/jinn-layer/src/publish.js'. The portal graph is the
// supported seam; internals are not.
function packageInternalImports(file) {
  const contents = readFileSync(file, 'utf8');
  const offenders = [];
  for (const match of contents.matchAll(SPECIFIER)) {
    const specifier = match[1];
    if (!specifier.startsWith('@jinn-network/')) continue;
    if (/^@jinn-network\/[^/]+\/(?:src|dist)\//u.test(specifier)) {
      offenders.push(`${relative(root, file)} -> ${specifier}`);
    }
  }
  return offenders;
}

test('operator tree source never relative-imports into a sibling tree', () => {
  const offenders = SCANNED
    .flatMap((directory) => sourceFiles(join(treeRoot, directory)))
    .flatMap(relativeEscapes);
  assert.deepEqual(
    offenders.sort(),
    [],
    `${TREE}/ crosses a tree boundary with a relative import; consume the package through its portal entrypoint instead`,
  );
});

test('operator tree source never imports another package’s internals', () => {
  const offenders = SCANNED
    .flatMap((directory) => sourceFiles(join(treeRoot, directory)))
    .flatMap(packageInternalImports);
  assert.deepEqual(
    offenders.sort(),
    [],
    `${TREE}/ imports past a package public entrypoint`,
  );
});
```

- [ ] **Step 2: Run the guard to verify it fails**

Run: `node --test .github/scripts/operator-source-boundaries.test.mjs`

Expected: FAIL on the first test, with two offenders naming `client/scripts/distill-run-manifest-live.ts -> ../../packages/layer/src/publish.js` and `… -> ../../packages/layer/src/bridge-fetch-evidence.js`.

- [ ] **Step 3: Commit the red guard**

```bash
git add .github/scripts/operator-source-boundaries.test.mjs
git commit -m "test(operator): add source-boundary guard, red on #2297"
```

---

### Task 2: Fix #2297 — the last cross-tree import violation

`client/scripts/distill-run-manifest-live.ts:29-30` reaches into `../../packages/layer/src/*.js`. The file already imports the rest of what it needs from `@jinn-network/jinn-layer` (a declared `portal:` devDependency at `client/package.json:207`); these four symbols are simply not exported from the layer's public index.

**Files:**
- Modify: `packages/layer/src/index.ts` (add the missing public exports)
- Modify: `client/scripts/distill-run-manifest-live.ts:29-30`
- Test: `.github/scripts/operator-source-boundaries.test.mjs` (from Task 1)

**Interfaces:**
- Consumes: the Task 1 guard.
- Produces: `@jinn-network/jinn-layer` publicly exports `publishManifestBatch`, `ManifestBatchPublishDeps`, `ManifestBatchSetResult`, `createEvidenceFetcher`.

- [ ] **Step 1: Confirm the guard is red for exactly this reason**

Run: `node --test .github/scripts/operator-source-boundaries.test.mjs`
Expected: FAIL naming the two `packages/layer/src/*` specifiers and nothing else.

- [ ] **Step 2: Export the four symbols from the layer's public index**

In `packages/layer/src/index.ts`, extend the existing `from './publish.js'` export block (which currently ends at the `type PublishResult,` line) and add a new block for the evidence fetcher:

```typescript
export {
  publish,
  PublishLedgerError,
  toPublishedEpisode,
  toTraceEnvelope,
  EPISODE_ARTIFACT_TYPE,
  TRACE_ENVELOPE_ARTIFACT_TYPE,
  publishManifestBatch,
  type HarnessPublishDeps,
  type PublishedResult,
  type PublishOptions,
  type PublishResult,
  type ManifestBatchPublishDeps,
  type ManifestBatchSetResult,
} from './publish.js';

export { createEvidenceFetcher } from './bridge-fetch-evidence.js';
```

- [ ] **Step 3: Re-point the script's imports**

In `client/scripts/distill-run-manifest-live.ts`, delete lines 29-30 (the two `../../packages/layer/src/…` import statements) and fold their symbols into the existing `@jinn-network/jinn-layer` import block so it reads:

```typescript
import {
  runJinnLayerCli,
  capture,
  createBoundedIpfsJsonFetcher,
  createEvidenceFetcher,
  publishManifestBatch,
  DEFAULT_IPFS_GATEWAY_URL,
  type AttemptRef,
  type BridgeEvidence,
  type CapturedTask,
  type ManifestBatchPublishDeps,
  type ManifestBatchSetResult,
} from '@jinn-network/jinn-layer';
```

- [ ] **Step 4: Build the layer and typecheck the consumer**

```bash
cd packages/layer && yarn install --immutable && yarn typecheck && yarn build && yarn test
cd ../../client && yarn install --immutable && yarn typecheck
```
Expected: all green. The layer build must run before the client typecheck — the portal resolves to `dist/`.

- [ ] **Step 5: Run the guard to verify it passes**

Run: `node --test .github/scripts/operator-source-boundaries.test.mjs`
Expected: PASS, both tests.

- [ ] **Step 6: Commit**

```bash
git add packages/layer/src/index.ts client/scripts/distill-run-manifest-live.ts
git commit -m "fix(operator): consume jinn-layer through its public entrypoint

Closes #2297"
```

---

### Task 3: Operator package-inventory guard

The operator tree is a single published package with two nested workspaces. The inventory guard pins its `@jinn-network/*` dependency shape so a portal edge cannot be added or silently re-pointed without review — the same discipline the stack trees carry.

**Files:**
- Create: `.github/scripts/operator-package-inventory.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: a `node --test`-runnable guard. Task 5 wires it into `ci.yml`; Task 6 flips its `TREE` constant.

- [ ] **Step 1: Write the guard**

Create `.github/scripts/operator-package-inventory.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'client';
const treeRoot = join(root, TREE);

function manifest() {
  const path = join(treeRoot, 'package.json');
  assert.ok(existsSync(path), `missing manifest: ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

// The published identity is NOT renamed by the directory rename (design §3
// renames the physical tree only). Pin it so the rename cannot drift it.
test('operator package keeps its published identity', () => {
  const pkg = manifest();
  assert.equal(pkg.name, '@jinn-network/client');
  assert.equal(pkg.main, './dist/index.js');
  assert.equal(pkg.types, './dist/index.d.ts');
  assert.equal(pkg.packageManager, 'yarn@4.13.0');
});

test('operator workspaces are exactly the two declared nested projects', () => {
  assert.deepEqual(manifest().workspaces, ['src/dashboard/spa', 'packages/*']);
});

// Runtime deps are versioned (the tarball must resolve them from the
// registry); dev/portal edges are relative and depth-preserving, so the
// rename must leave every spec byte-identical.
const EXPECTED_JINN_DEPENDENCIES = {
  '@jinn-network/core': '0.1.2',
  '@jinn-network/plugin': '0.1.2',
};
const EXPECTED_JINN_DEV_DEPENDENCIES = {
  '@jinn-network/jinn-layer': 'portal:../packages/layer',
  '@jinn-network/sdk': 'portal:../packages/sdk',
};
const EXPECTED_JINN_RESOLUTIONS = {
  '@jinn-network/core': 'portal:../packages/core',
  '@jinn-network/jinn-layer': 'portal:../packages/layer',
  '@jinn-network/plugin': 'portal:../packages/plugin',
};

function jinnEntries(section) {
  return Object.fromEntries(
    Object.entries(manifest()[section] ?? {})
      .filter(([name]) => name.startsWith('@jinn-network/'))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

test('operator jinn dependency graph is the approved shape', () => {
  assert.deepEqual(jinnEntries('dependencies'), EXPECTED_JINN_DEPENDENCIES);
  assert.deepEqual(jinnEntries('devDependencies'), EXPECTED_JINN_DEV_DEPENDENCIES);
  assert.deepEqual(jinnEntries('resolutions'), EXPECTED_JINN_RESOLUTIONS);
  assert.deepEqual(jinnEntries('optionalDependencies'), {});
  assert.deepEqual(jinnEntries('peerDependencies'), {});
});

// Every portal target must exist on disk at the declared relative path. This
// is the check that fails loudly if the rename changes the tree's depth.
test('every operator portal target resolves on disk', () => {
  for (const spec of [
    ...Object.values(EXPECTED_JINN_DEV_DEPENDENCIES),
    ...Object.values(EXPECTED_JINN_RESOLUTIONS),
  ]) {
    const target = resolve(treeRoot, spec.slice('portal:'.length));
    assert.ok(
      existsSync(join(target, 'package.json')),
      `portal target does not resolve: ${spec}`,
    );
  }
});
```

- [ ] **Step 2: Run the guard**

Run: `node --test .github/scripts/operator-package-inventory.test.mjs`
Expected: PASS, four tests. If the dependency-shape test fails, the manifest drifted since this plan was written — report the delta as a finding rather than editing the manifest to match.

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/operator-package-inventory.test.mjs
git commit -m "test(operator): pin package inventory and portal graph"
```

---

### Task 4: Operator packed-types canary

The operator publishes `main` + `types`. The canary proves the tarball's declarations actually resolve for an external consumer — the same property the stack trees' packed-types guards assert, and the property a directory rename could plausibly break through `files` globs or vendoring scripts.

**Files:**
- Create: `.github/scripts/operator-packed-types.test.mjs`

**Interfaces:**
- Consumes: `yarn build` and `npm pack` from the operator tree.
- Produces: a `node --test`-runnable guard. Task 5 wires it into `ci.yml`; Task 6 flips its `TREE` constant.

- [ ] **Step 1: Write the canary**

Create `.github/scripts/operator-packed-types.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
// Flipped to 'operator' by the stage-5 rename commit.
const TREE = 'client';
const treeRoot = join(root, TREE);

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const out = [];
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => out.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      const text = Buffer.concat(out).toString('utf8');
      if (code === 0) resolvePromise(text);
      else reject(new Error(`${command} ${args.join(' ')} exited with ${code}:\n${text}`));
    });
  });
}

test('packed operator tarball exposes resolvable declarations', async (t) => {
  assert.ok(
    existsSync(join(treeRoot, 'dist', 'index.d.ts')),
    `run \`cd ${TREE} && yarn build\` before this canary`,
  );

  const scratch = await mkdtemp(join(tmpdir(), 'jinn-operator-packed-types-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));

  await run('npm', ['pack', '--silent', '--pack-destination', scratch], { cwd: treeRoot });
  const [archive] = (await readdir(scratch)).filter((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'npm pack produced no tarball');

  const consumer = join(scratch, 'consumer');
  await run('mkdir', ['-p', consumer]);
  await writeFile(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'operator-packed-types-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    `${JSON.stringify({
      compilerOptions: {
        module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022',
        strict: true, noEmit: true, skipLibCheck: true, types: [],
      },
      files: ['probe.ts'],
    }, null, 2)}\n`,
  );
  await writeFile(
    join(consumer, 'probe.ts'),
    "import * as operator from '@jinn-network/client';\nexport type Probe = typeof operator;\n",
  );

  await run('npm', ['install', '--no-audit', '--no-fund', join(scratch, archive)], { cwd: consumer });
  await run('npx', ['--yes', 'typescript@5.9.3', '--project', 'tsconfig.json'], { cwd: consumer });
});
```

- [ ] **Step 2: Build the tree, then run the canary**

```bash
cd client && yarn install --immutable && yarn build
cd .. && node --test .github/scripts/operator-packed-types.test.mjs
```
Expected: PASS. If `npx typescript@…` cannot reach the registry, the canary fails loudly — that is correct behavior for a canary; do not add a network-optional skip.

- [ ] **Step 3: Commit**

```bash
git add .github/scripts/operator-packed-types.test.mjs
git commit -m "test(operator): add packed-types canary"
```

---

### Task 5: Wire the guard trio into CI

The trio must run in CI before the rename, so the rename commit is measured by guards that were already green.

**Files:**
- Modify: `.github/workflows/ci.yml` (add one job; `paths:` still say `client/**` at this point)

**Interfaces:**
- Consumes: the three guard scripts from Tasks 1, 3, 4.
- Produces: a CI job named `architecture` in the `CI` workflow. Its name is a branch-protection context candidate and must never be renamed thereafter (finding F2).

- [ ] **Step 1: Add the architecture job**

In `.github/workflows/ci.yml`, insert this job immediately after the `jobs:` line, before `check:`. Note the explicit `working-directory: .` — the workflow-level default is `client`, and these guards resolve paths from the repository root:

```yaml
  architecture:
    name: Operator tree architecture
    runs-on: ubuntu-latest
    timeout-minutes: 20
    defaults:
      run:
        working-directory: .
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
      - run: corepack enable
      - name: Verify package inventory and portal graph
        run: node --test .github/scripts/operator-package-inventory.test.mjs
      - name: Verify source boundaries
        run: node --test .github/scripts/operator-source-boundaries.test.mjs
      - name: Build the tree for the packed-types canary
        working-directory: client
        run: |
          yarn install --immutable
          yarn build
      - name: Verify packed types
        run: node --test .github/scripts/operator-packed-types.test.mjs
```

- [ ] **Step 2: Add the guard scripts to the workflow's path triggers**

In `.github/workflows/ci.yml`, add this line to **both** the `pull_request.paths` list and the `push.paths` list, after the existing `'.github/scripts/npm-publish-workflow.test.mjs'` entry:

```yaml
      - '.github/scripts/operator-*.test.mjs'
```

- [ ] **Step 3: Validate the workflow parses and the job list is right**

```bash
node -e "const y=require('fs').readFileSync('.github/workflows/ci.yml','utf8'); if(!y.includes('Operator tree architecture')) throw new Error('job missing'); console.log('ci.yml carries the architecture job')"
git diff --stat .github/workflows/ci.yml
```
Expected: the job is present; the diff touches only `.github/workflows/ci.yml`.

- [ ] **Step 4: Run the trio locally exactly as CI will**

```bash
node --test .github/scripts/operator-package-inventory.test.mjs
node --test .github/scripts/operator-source-boundaries.test.mjs
cd client && yarn build && cd ..
node --test .github/scripts/operator-packed-types.test.mjs
```
Expected: all three PASS.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci(operator): run the guard trio on the operator tree"
```

---

### Task 6: The rename — `client/` → `operator/` in one paths-only commit

This is the stage's single mechanical commit. Its correctness claim is entirely: *the tree still builds, every guard still runs against it, and nothing but paths changed.* Do not fold any other change into it.

**Files:** every file listed in the steps below. Nothing else.

**Interfaces:**
- Consumes: Tasks 1–5 (guards exist and are green against `client/`).
- Produces: the tree at `operator/`, with `operator/OPERATOR-APP-SPEC.md` finally matching its home. The npm package name, OCI image name, `~/.jinn-client` state directory, `client-v*` tags, `bin` aliases, and all CI job names are unchanged (findings F1, F2).

- [ ] **Step 1: Record the pre-rename build as the baseline**

```bash
cd client && yarn install --immutable && yarn typecheck && yarn build && cd ..
node --test .github/scripts/operator-package-inventory.test.mjs \
              .github/scripts/operator-source-boundaries.test.mjs
```
Expected: green. Save the output; the post-rename run must match.

- [ ] **Step 2: Move the tree**

```bash
rm -rf client/node_modules client/dist client/src/dashboard/spa/node_modules client/src/dashboard/spa/dist
git mv client operator
git status --short | head
```
Expected: a large block of `R  client/… -> operator/…` rename entries and no other change class. Removing the build outputs first keeps `git mv` fast and keeps untracked artifacts out of the new path.

- [ ] **Step 3: Flip the three guard scripts' `TREE` constant**

In each of `.github/scripts/operator-source-boundaries.test.mjs`, `.github/scripts/operator-package-inventory.test.mjs`, `.github/scripts/operator-packed-types.test.mjs`, change:

```javascript
const TREE = 'client';
```
to:
```javascript
const TREE = 'operator';
```

- [ ] **Step 4: Update the stack guards' forbidden-escape roots (finding F3)**

Four files, each `join(root, 'client')` → `join(root, 'operator')`:

- `.github/scripts/marketplace-source-boundaries.test.mjs:11` — `join(root, 'apps'), join(root, 'client'),` → `join(root, 'apps'), join(root, 'operator'),`
- `.github/scripts/task-execution-source-boundaries.test.mjs:16` — `join(root, 'client'),` → `join(root, 'operator'),`
- `.github/scripts/record-discovery-source-boundaries.test.mjs:11` — `join(root, 'apps'), join(root, 'client'),` → `join(root, 'apps'), join(root, 'operator'),`
- `.github/scripts/evidence-source-boundaries.test.mjs` — three sites: line 17 `join(root, 'client'),`; line 625 `localSpecifier(join(root, 'client', 'src'))`; line 628 `localSpecifier(join(root, 'client', 'plugins'))`. All three take `'operator'`.

Also: `.github/scripts/layer-publish-workflow.test.mjs:119` — `resolve(root, 'client', testPath)` → `resolve(root, 'operator', testPath)`; and `.github/scripts/upsert-changelog-section.mjs:4` — the default `'client/CHANGELOG.md'` → `'operator/CHANGELOG.md'`.

- [ ] **Step 5: Update the twelve workflow files**

Path-bearing edits only. Do **not** touch job names, workflow `name:` fields, `@jinn-network/client` specs, `ghcr.io/…/client` image repos, `client-v*` tag patterns, or `jinn-client.tgz` (finding F1, F2).

| File | Edits |
| --- | --- |
| `.github/workflows/ci.yml` | `pull_request.paths` and `push.paths`: `'client/**'` → `'operator/**'` (lines 6, 16); workflow-level `defaults.run.working-directory: client` → `operator` (line 31); the Task 5 architecture job's `working-directory: client` → `operator`; artifact `path: client/test-results/` → `operator/test-results/` (line 152) |
| `.github/workflows/npm-publish.yml` | `defaults.run.working-directory: client` → `operator` (line 40); the error string `does not match client/package.json version` → `operator/package.json` (line 166). Leave every `@jinn-network/client@…`, `client-v*`, and `../packages/sdk` reference alone — `../packages/sdk` is depth-preserving |
| `.github/workflows/docker.yml` | `defaults.run.working-directory: client` → `operator` (line 13); `file: client/Dockerfile` → `operator/Dockerfile` (lines 73, 105); the comment `# working-directory default is \`client/\`` → `` `operator/` `` (line 45); the error string `client/package.json version` → `operator/package.json version` (line 48). Leave the `client-v*` tag branches and `IMAGE_REPO=…/client` alone |
| `.github/workflows/operator-images.yml` | `paths: 'client/**'` → `'operator/**'` (line 23); `file: client/Dockerfile` → `operator/Dockerfile` (lines 68, 89); the header comment `builds … (\`client/Dockerfile\`)` → `` `operator/Dockerfile` `` (line 5). Leave `base_repo=ghcr.io/${OWNER}/client` alone |
| `.github/workflows/hermetic-gate.yml` | every `working-directory: client` → `operator` (lines 101, 105, 159, 171, 180, 239); cache `path: client/node_modules` → `operator/node_modules` and `hashFiles('client/yarn.lock')` → `hashFiles('operator/yarn.lock')` (lines 95-96); `STATE_DIR="client/test/_support/fixtures/anvil-base-v3-state"` → `operator/test/…` (line 125); the remediation string `cd client && …` → `cd operator && …` (line 131); artifact `path: client/test-results/` → `operator/test-results/` (line 188); the comment referencing `client/scripts/release/post-check-run-verdict.mjs` → `operator/scripts/…` (line 20). Leave the cache-key literal `${{ runner.os }}-client-nodemodules-…` alone or rename it consistently in both `key` and `restore-keys` — a mismatch silently disables the cache |
| `.github/workflows/environment-suite.yml` | `working-directory: client` → `operator` (line 64); the evidence globs `client/tier-2-evidence/**/*` and `client/tier-3-evidence/**/*` → `operator/…` (lines 603-604); the upload paths `${{ github.workspace }}/client/tier-2-evidence/` and `…/client/tier-3-evidence/` → `…/operator/…` (lines 621-622). **Leave every `~/.jinn-client`, `.jinn-client-b`, and `--jinn-client-dir` reference alone** — those are operator state paths, not repo paths (finding F1) |
| `.github/workflows/jinn-agent-ci.yml` | the ten `'client/…'` path-filter entries (lines 10-15 and 24-29) → `'operator/…'`; `working-directory: client` → `operator` (lines 202, 205, 227) |
| `.github/workflows/layer-ci.yml` | `paths: 'client/**'` → `'operator/**'` (lines 12, 26); the six `working-directory: client` → `operator` (lines 84-94). Leave the job name `client-compat` (finding F2) |
| `.github/workflows/core-ci.yml` | `working-directory: client` → `operator` (line 52). Leave the job name `client-compat` |
| `.github/workflows/plugin-ci.yml` | `working-directory: client` → `operator` (line 38). Leave the job name `client-compat` |
| `.github/workflows/sdk-ci.yml` | `working-directory: client` → `operator` (line 45). Leave the job name `client-compat` |
| `.github/workflows/sdk-npm-publish.yml` | `paths: 'client/**'` → `'operator/**'` (line 7) |
| `.github/workflows/net-liveness.yml` | `yarn --cwd client install --immutable` → `--cwd operator` (line 48); `yarn --cwd client net-liveness` → `--cwd operator` (lines 134, 201) |
| `.github/workflows/changelog-mirror.yml` | `git add client/CHANGELOG.md` → `operator/CHANGELOG.md` (line 79); the three comment/description mentions of `client/CHANGELOG.md` (lines 4, 10, 38, 70) |
| `.github/workflows/release-notes-scaffold.yml` | `readFileSync('client/package.json','utf8')` → `'operator/package.json'` (line 78). Leave every `client-v*` tag pattern alone |

- [ ] **Step 6: Update CODEOWNERS (finding F4)**

In `.github/CODEOWNERS`, rewrite the seven operator-app paths and their section comment:

```
# Operator app (operator/src/dashboard/spa)
/operator/src/dashboard/spa/src/App.tsx     @oaksprout @ritsukai
/operator/src/dashboard/spa/src/routes.ts   @oaksprout @ritsukai
/operator/src/dashboard/spa/src/pages/      @oaksprout @ritsukai
/operator/src/dashboard/spa/src/components/ @oaksprout @ritsukai
/operator/src/dashboard/spa/src/regions/    @oaksprout @ritsukai
/operator/src/dashboard/spa/src/shell/      @oaksprout @ritsukai
/operator/src/dashboard/spa/src/styles/     @oaksprout @ritsukai
```

- [ ] **Step 7: Update the Dockerfile's build-context paths**

`operator/Dockerfile` copies five trees from the repository root. Every `client/…` build-context path becomes `operator/…`; the `packages/{sdk,core,plugin,layer}` paths are unchanged. The edits, in file order:

- Header comment: `docker build -f client/Dockerfile -t jinn-client .` → `docker build -f operator/Dockerfile -t jinn-client .`
- `COPY client/package.json client/yarn.lock client/.yarnrc.yml ./client/` → `COPY operator/package.json operator/yarn.lock operator/.yarnrc.yml ./operator/`
- `COPY client/src/dashboard/spa/package.json ./client/src/dashboard/spa/package.json` → `operator/…` on both sides
- `RUN corepack enable && cd client && yarn install --immutable` → `cd operator`
- The comment block naming `client/docs/` and the `IntroCard.tsx` relative path: `client/` → `operator/`, and `/app/client/docs/build/quickstart.md` → `/app/operator/docs/build/quickstart.md`
- The six source copies: `COPY client/{src,deployments,docs,plugins,scripts,templates}/ ./client/…/` → `operator/…` on both sides
- `COPY client/tsconfig.json ./client/` → `operator/`
- `WORKDIR /app/client` → `WORKDIR /app/operator`
- The five runtime-stage copies `COPY --from=build /app/client/{dist,deployments,plugins,node_modules,package.json}` → `/app/operator/…`
- `COPY client/docker-entrypoint.sh /usr/local/bin/jinn-entrypoint.sh` → `operator/docker-entrypoint.sh`

Leave the image's `WORKDIR /app` in the runtime stage, `ENV JINN_STATE_DIR=/data`, and the `# @jinn-network/client — OCI image` header identity alone.

- [ ] **Step 8: Update the deploy tree**

- `deploy/railway-launcher-operator/Dockerfile:33` — `COPY client/plugins/learner/hooks/session-start /app/dist/plugins/learner/hooks/session-start` → `COPY operator/plugins/learner/hooks/session-start …`. This is a build-context path and is load-bearing for the Railway launcher image.
- `deploy/railway-launcher-operator/README.md:26` — the same `COPY client/plugins/…` line quoted in the README.
- `deploy/railway-launcher-operator/seed.sh:102` — the comment `the daemon walks at startup (client/src/main.ts)` → `operator/src/main.ts`.
- Both `railway.toml` files reference only `deploy/…` paths — **no change**. Railway `watchPatterns` for these services are set through the Railway API, not in-repo; note in the stage PR description that any service whose watch pattern names `client/**` must be re-pointed to `operator/**` in the Railway dashboard at deploy time.
- Leave every `ghcr.io/jinn-network/client`, `BASE_TAG`, `BASE_IMAGE`, and `~/.jinn-client` reference in `deploy/` alone (finding F1); `deploy/README.md` prose is swept in Task 7.

- [ ] **Step 9: Update the four reverse cross-tree references**

- `packages/core/test/architecture/no-client-src.test.ts:12` — the doc comment and the asserted path `../../client/src` → `../../operator/src`. Read the whole file and update every occurrence of the literal; leave the file name as-is (renaming a test file is not a path the build depends on, and it keeps this commit smaller).
- `packages/sdk/test/solvernets/swe-rebench-v2-held-out-slate-cross-source.test.ts:23` — `'../../../../client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json'` → `'../../../../operator/src/…'`.
- `contracts/scripts/build-anvil-snapshot.ts:12` — `new URL('../../client/scripts/build-anvil-snapshot.ts', import.meta.url)` → `'../../operator/scripts/build-anvil-snapshot.ts'`. The hermetic gate calls this.
- `packages/indexer/explorer/EXPLORER-APP-SPEC.md:5` — the link `../../../client/OPERATOR-APP-SPEC.md` → `../../../operator/OPERATOR-APP-SPEC.md` (two occurrences on that line: the href and the link text).

- [ ] **Step 10: Update the ignore files**

- `.gitignore:24` — `client/start-daemon.sh` → `operator/start-daemon.sh`
- `.dockerignore` — the four `client/` entries (`client/.acceptance`, `client/.env`, `client/.env.*`, `client/acceptance-runs`, `client/release-runs`) → `operator/…`
- `.railwayignore` — the comment at line 4 mentioning "artefacts under client/" → "under operator/". The exclude rules themselves name only `packages/`; no functional change.

- [ ] **Step 11: Sweep literal repo paths inside the renamed tree**

Inside `operator/`, source comments and a handful of functional strings still carry the old prefix. Rewrite only these exact prefixes:

```bash
cd operator
git grep -lE 'client/(src|test|scripts|fixtures|plugins|docs|deployments|templates|package\.json|CHANGELOG\.md|README\.md|Dockerfile)|cd client|--cwd client' -- . \
  | xargs sed -i '' -E \
      -e 's#(^|[^-a-zA-Z0-9/.])client/(src|test|scripts|fixtures|plugins|docs|deployments|templates|package\.json|CHANGELOG\.md|README\.md|Dockerfile)#\1operator/\2#g' \
      -e 's#\bcd client\b#cd operator#g' \
      -e 's#--cwd client\b#--cwd operator#g'
cd ..
```

The leading `[^-a-zA-Z0-9/.]` guard is what keeps `@jinn-network/client`, `~/.jinn-client`, `jinn-client.tgz`, `ghcr.io/jinn-network/client`, `packages/discovery/client`, and `client-v` out of the rewrite. Verify that immediately:

```bash
git grep -nE '@jinn-network/client|~/\.jinn-client|jinn-client\.tgz|ghcr\.io/jinn-network/client|client-v' -- operator | wc -l
git grep -nE 'operator-network/|jinn-operator\.tgz|~/\.jinn-operator' -- operator
```
Expected: the first count is non-zero (those identities survived); the second returns nothing (no identity was corrupted).

- [ ] **Step 12: Fix the one functional pathspec the sweep must have caught**

Confirm `operator/src/solver-types/jinn-repo-extract.ts:31` now reads `':(exclude)operator/test/**'` — it is a git pathspec, not a comment, and a miss here silently changes what the extractor includes:

```bash
git grep -n "exclude)operator/test" -- operator/src/solver-types/jinn-repo-extract.ts
```
Expected: one hit. If it still says `client/test`, fix it by hand.

- [ ] **Step 13: Reinstall and rebuild from the new path**

```bash
cd operator
yarn install --immutable
```
Expected: **no lockfile change.** `operator/yarn.lock` keys its portal entries by the package *name* (`locator=%40jinn-network%2Fclient%40workspace%3A.`) and the portal specs are depth-preserving, so `--immutable` must succeed untouched. A lockfile diff here means something in Step 11 rewrote a dependency spec — revert and narrow the sweep.

```bash
yarn typecheck && yarn build && cd ..
```
Expected: green, matching the Step 1 baseline.

- [ ] **Step 14: Run every guard from the renamed tree**

```bash
node --test .github/scripts/operator-package-inventory.test.mjs
node --test .github/scripts/operator-source-boundaries.test.mjs
node --test .github/scripts/operator-packed-types.test.mjs
node --test .github/scripts/marketplace-source-boundaries.test.mjs
node --test .github/scripts/task-execution-source-boundaries.test.mjs
node --test .github/scripts/record-discovery-source-boundaries.test.mjs
node --test .github/scripts/evidence-source-boundaries.test.mjs
node --test .github/scripts/layer-publish-workflow.test.mjs
node --test .github/scripts/npm-publish-workflow.test.mjs
node --test .github/scripts/repository-gitlinks.test.mjs
```
Expected: all PASS.

- [ ] **Step 15: Prove no stale repo-path reference survives outside the excluded doc set**

```bash
git grep -nE '(^|[^-a-zA-Z0-9/.])client/' -- \
  ':!docs/superpowers/plans' ':!docs/superpowers/specs' ':!spec' ':!log' ':!docs/press' ':!legacy' \
  ':!*.md'
```
Expected: **no output.** Markdown is excluded here because Task 7 owns the doc sweep; every non-Markdown hit is a functional path this step must have fixed.

- [ ] **Step 16: Confirm CODEOWNERS coverage did not lapse**

```bash
git grep -c '^/operator/src/dashboard/spa/' -- .github/CODEOWNERS
git grep -n '^/client/' -- .github/CODEOWNERS
```
Expected: `7`, then no output.

- [ ] **Step 17: Verify the commit is a pure rename plus the enumerated edits**

```bash
git add -A
git diff --cached --stat -M | tail -5
git diff --cached -M --diff-filter=ACD --name-only
```
Expected: the `--stat` summary is dominated by renames; the `ACD` list (added / copied / deleted files) is **empty** — nothing was created or destroyed by the rename.

- [ ] **Step 18: Commit**

```bash
git commit -m "refactor(operator): rename client/ to operator/

Paths only. The published package name (@jinn-network/client), the OCI
image name (ghcr.io/jinn-network/client), the ~/.jinn-client state
directory, the client-v* release tags, the bin aliases, and every CI job
name are unchanged.

Design: docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md
sections 3 and 10 (stage 5)."
```

---

### Task 7: Sweep live operational docs and agent-skill references

Docs-only, separate commit, so the rename commit stays reviewable. Per finding F7 this sweep covers **live** surfaces only. Dated historical documents under `docs/superpowers/plans/`, `docs/superpowers/specs/`, `spec/`, `log/`, and `docs/press/` are not retro-edited.

**Files (exact set, with current `client/` occurrence counts):**
- Root: `README.md` (1), `CONTRIBUTING.md` (1), `SPEC.md` (1), `DEPLOY.md` (7), `CLAUDE.md` (19)
- `docs/engineering/handbook.md` (4), `docs/operator/rotating-harness-keys.md` (9)
- `docs/runbooks/`: `add-solver-type.md` (19), `v0-testnet-deploy.md` (11), `stage2-mono-curated-seeds.md` (8), `harvest-e2e-smoke.md` (6), `jinn-test-store-cleanup.md` (6), `sepolia-olas-rails-smoke.md` (6), `testing.md` (6), `autopilot-v2-cutover.md` (5), `launch-swe-rebench-v2.md` (4), `2026-05-06-testnet-manifest-digest-cutover.md` (3), `task-creator-amd64-gold-proof.md` (3), `conformance.md` (2), `stage1-evidence-seeding.md` (2), `task-creator-public-repo-proof.md` (2), `net-liveness.md` (1), `task-creator-environment-publish.md` (1)
- `deploy/README.md` (5), `deploy/railway-operator-codex/README.md` (1)
- `.claude/skills/`: `testing-jinn-app/SKILL.md` and its four `references/*.md`; `release-prep/SKILL.md` and its four `references/*.md`; `release-readiness/references/{handoff-doc-template.md,tier-3-scenario.md,static-checklist.md}`; `create-plugin/SKILL.md`, `create-plugin/references/{cli-cheatsheet.md,RESULTS.md,load-probe.mjs}`; `create-press-release/SKILL.md`; `file-issue/SKILL.md`, `file-issue/references/RESULTS.md`; `implement-issue/fixtures/{docs,spike,fix,feat}-fixture.md`

**Interfaces:**
- Consumes: the renamed tree from Task 6.
- Produces: nothing code-facing. `CLAUDE.md` and `README.md` are CODEOWNERS-gated — this commit needs canon-owner review with the stage PR.

- [ ] **Step 1: Sweep with the same prefix guard**

```bash
git grep -lE '(^|[^-a-zA-Z0-9/.])client/' -- \
  README.md CONTRIBUTING.md SPEC.md DEPLOY.md CLAUDE.md \
  docs/engineering/handbook.md docs/operator/ docs/runbooks/ \
  deploy/README.md deploy/railway-operator-codex/README.md .claude/skills/ \
  | xargs sed -i '' -E 's#(^|[^-a-zA-Z0-9/.])client/#\1operator/#g'
```

- [ ] **Step 2: Sweep the shell-command forms the prefix rule does not reach**

```bash
git grep -lE 'cd client\b|--cwd client\b|yarn --cwd client\b' -- \
  README.md CONTRIBUTING.md SPEC.md DEPLOY.md CLAUDE.md \
  docs/engineering/handbook.md docs/operator/ docs/runbooks/ \
  deploy/README.md .claude/skills/ \
  | xargs sed -i '' -E -e 's#\bcd client\b#cd operator#g' -e 's#--cwd client\b#--cwd operator#g'
```

- [ ] **Step 3: Verify no identity was corrupted**

```bash
git diff -U0 -- README.md CLAUDE.md DEPLOY.md deploy/README.md \
  | grep -E '^\+' | grep -E 'jinn-network/operator|\.jinn-operator|operator-v[0-9]'
```
Expected: **no output.** Any hit means the sweep ate an npm/image/state identity — revert that file and fix by hand.

- [ ] **Step 4: Verify the swept files carry no stale repo path**

```bash
git grep -nE '(^|[^-a-zA-Z0-9/.])client/' -- \
  README.md CONTRIBUTING.md SPEC.md DEPLOY.md CLAUDE.md \
  docs/engineering/handbook.md docs/operator/ docs/runbooks/ \
  deploy/README.md deploy/railway-operator-codex/README.md .claude/skills/
```
Expected: no output.

- [ ] **Step 5: Verify the `load-probe.mjs` path is real**

`.claude/skills/create-plugin/references/load-probe.mjs` resolves a compiled loader path at runtime. Confirm the swept value points at something that exists after a build:

```bash
git grep -n 'operator/dist/plugins/index.js' -- .claude/skills/create-plugin/references/load-probe.mjs
ls operator/dist/plugins/index.js
```
Expected: the grep hits; the file exists (Task 6 Step 13 built the tree).

- [ ] **Step 6: Commit**

```bash
git add README.md CONTRIBUTING.md SPEC.md DEPLOY.md CLAUDE.md \
  docs/engineering/handbook.md docs/operator/ docs/runbooks/ \
  deploy/README.md deploy/railway-operator-codex/README.md .claude/skills/
git commit -m "docs(operator): point live docs and skills at operator/

Dated plans, specs, decision records, and press releases are deliberately
not retro-edited."
```

---

### Task 8: Delete the `task_runs` state machine

Design §4: crash recovery is derivation-first; the chain (through the projector) and the backend's own journal are the sources of truth, with a thin engagement ledger for what the chain cannot say. `task_runs` is the machine that replaced. Stages 1–2 retired the TaskEngine, so this task removes the **residue** — it starts by measuring what is left rather than assuming.

**Files:**
- Delete / modify: whatever the Step 1 census reports. At plan time the pre-cutover surface was `operator/src/harnesses/engine/persistence.ts` (schema, migrations, CRUD), `operator/src/harnesses/engine/backfill-failed-deliveries.ts`, `operator/src/cli/commands/backfill-failed-deliveries.ts`, `operator/src/types/task-run.ts`, `operator/src/types/task-run-read-model.ts`, `operator/src/api/task-run-routing.ts`, and the `operator/scripts/{audit-task-run-failures,classify-failure,cleanup-engine-work}.ts` trio.

**Interfaces:**
- Consumes: the renamed tree.
- Produces: zero `task_runs` references in `operator/`.

- [ ] **Step 1: Census the residue**

```bash
git grep -n 'task_runs' -- operator > /tmp/task-runs-census.txt
git grep -ln 'task_runs' -- operator | sort
wc -l /tmp/task-runs-census.txt
```
Record the file list in the stage PR description. If a file in that list is still *reachable from the daemon's boot path* (not just from a script or a test), that is a **finding**: it means stage 1 or stage 2 left a live consumer behind, and this task stops and reports rather than deleting a live read model. Check reachability with:

```bash
git grep -n "task-run\|task_runs" -- operator/src/daemon operator/src/api operator/src/main.ts
```

- [ ] **Step 2: Write the failing guard**

Add to `operator/test/architecture/` a new file `no-task-runs.test.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('task_runs state machine is retired', () => {
  it('has no remaining references in operator source', () => {
    // git grep exits 1 with no output when there are no matches.
    let output = '';
    try {
      output = execFileSync(
        'git',
        ['grep', '-n', 'task_runs', '--', 'src', 'scripts'],
        { cwd: new URL('../../', import.meta.url).pathname, encoding: 'utf8' },
      );
    } catch {
      output = '';
    }
    expect(output.trim()).toBe('');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd operator && yarn vitest run test/architecture/no-task-runs.test.ts`
Expected: FAIL, listing the census hits.

- [ ] **Step 4: Delete the machine**

Working from the Step 1 census, in this order:

1. Delete the whole `task_runs` schema block, its `CREATE INDEX` statements, the additive-migration table, and the CRUD helpers from `operator/src/harnesses/engine/persistence.ts`. If the file has no remaining exports afterwards, delete the file and its test.
2. Delete `operator/src/harnesses/engine/backfill-failed-deliveries.ts`, `operator/src/cli/commands/backfill-failed-deliveries.ts`, and the CLI registration that references the command.
3. Delete `operator/src/types/task-run.ts` and `operator/src/types/task-run-read-model.ts` and every import of them.
4. Delete `operator/scripts/audit-task-run-failures.ts`, `operator/scripts/classify-failure.ts`, and any `package.json` script entry that invokes them.
5. Delete the matching tests under `operator/test/harnesses/engine/` and `operator/test/scripts/` that exist only to exercise the deleted code.

**Do not add a `DROP TABLE task_runs` migration** (finding F6). Existing operator databases keep the orphaned table; that is deliberate and reversible.

- [ ] **Step 5: Run the guard and the full suite**

```bash
cd operator
yarn vitest run test/architecture/no-task-runs.test.ts
yarn typecheck
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY SKIP_HL_TESTS=1 yarn test
yarn build
```
Expected: the guard PASSes; typecheck, tests, and build are green.

- [ ] **Step 6: Commit**

```bash
git add -A operator
git commit -m "refactor(operator): delete the task_runs state machine

Recovery is derivation-first (design section 4): the projector and the
backend journal are the sources of truth, with the engagement ledger for
operator-local decisions. Existing databases keep the orphaned table; no
DROP migration ships."
```

---

### Task 9: Delete the legacy SolverNet config keys

Program §6 contract 4: the legacy keys live until this stage. Design §9's retirement table retires `joinedSolverNets` claim gating at stage 1 (behavior) and completes the deletion here (schema). By this point `claimPolicy`, `executionWiring[]`, and `posting[]` under `configShapeVersion: 2` are the only shape the daemon reads.

**Files:**
- Modify: `operator/src/config.ts` — the `joinedSolverNets` Zod field (around line 417), `migrateLegacySolverNets` (around line 840), the openrouter-provider backfill over legacy entries (around line 917), the migration log line (around line 1326), and the `migrateLegacySolverNets(raw)` call site (around line 1451)
- Modify: whatever else the Step 1 census names
- Test: `operator/test/config/` — the existing config tests that assert legacy-key acceptance

**Interfaces:**
- Consumes: the stage-1 `configShapeVersion: 2` migration.
- Produces: a config schema with no `joinedSolverNets` and no `solverNets`.

- [ ] **Step 1: Census the legacy-key surface**

```bash
cd operator
git grep -n 'joinedSolverNets\|solverNets' -- src | tee /tmp/legacy-keys-census.txt | wc -l
git grep -ln 'joinedSolverNets\|solverNets' -- test | sort
```
Record both lists in the stage PR description.

- [ ] **Step 2: Write the failing test**

Add `operator/test/config/legacy-solvernet-keys-rejected.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../../src/config.js';

describe('legacy SolverNet config keys are retired', () => {
  it('does not carry a joinedSolverNets field', () => {
    expect(Object.keys(ConfigSchema.shape)).not.toContain('joinedSolverNets');
  });

  it('does not carry a solverNets field', () => {
    expect(Object.keys(ConfigSchema.shape)).not.toContain('solverNets');
  });

  it('parses a v2 config that has neither key', () => {
    const parsed = ConfigSchema.parse({ configShapeVersion: 2 });
    expect(parsed).not.toHaveProperty('joinedSolverNets');
    expect(parsed).not.toHaveProperty('solverNets');
  });
});
```

If the exported schema symbol is not named `ConfigSchema`, use the actual export from `operator/src/config.ts`; the assertion shape is unchanged.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd operator && yarn vitest run test/config/legacy-solvernet-keys-rejected.test.ts`
Expected: FAIL on the first two assertions — the fields are still in the schema.

- [ ] **Step 4: Delete the schema fields and the migration**

In `operator/src/config.ts`:
1. Delete the `joinedSolverNets: z.record(…)` field and its doc comment.
2. Delete `migrateLegacySolverNets` entirely, along with its call site and the `[config] Migrated N legacy solverNets …` log line.
3. Delete the openrouter-`provider` backfill that walks `merged['joinedSolverNets']`.
4. Delete every consumer named by the Step 1 census.

Zod's default behavior strips unknown keys, so an operator config file that still carries `joinedSolverNets` (for example, one that never rebooted between stages) parses cleanly and the key is simply ignored. Verify that is the behavior rather than assuming it — if the schema is `.strict()`, add an explicit test that a legacy-key-bearing file still parses, because failing to boot on a stale key would strand operators.

- [ ] **Step 5: Run the tests**

```bash
cd operator
yarn vitest run test/config/legacy-solvernet-keys-rejected.test.ts
yarn typecheck
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY SKIP_HL_TESTS=1 yarn test
```
Expected: the new test PASSes; the full suite is green.

- [ ] **Step 6: Commit**

```bash
git add -A operator
git commit -m "refactor(operator): delete legacy SolverNet config keys

Claim policy and execution wiring under configShapeVersion 2 are the only
shape the daemon reads (design section 9). A stale joinedSolverNets key on
an operator file is ignored, not rejected."
```

---

### Task 10: Prune the stage-1 migration backups

Design §9: the timestamped pre-migration backup "is pruned at stage 5." The backup can carry paid RPC keys, so pruning is a real hygiene deliverable, not cosmetic.

**Files:**
- Modify: `operator/src/config.ts` or wherever stage 1 put the migration writer — add a boot-time prune
- Test: `operator/test/config/prune-migration-backups.test.ts`

**Interfaces:**
- Consumes: stage 1's backup writer. Expected shape (finding F5): `<configDir>/config.json.pre-v2.<ISO8601-basic>.bak`, e.g. `config.json.pre-v2.20260730T142233Z.bak`.
- Produces: `pruneMigrationBackups(configDir: string): { removed: string[] }` — exported from the same module as the migration writer.

- [ ] **Step 1: Confirm the actual backup shape**

```bash
cd operator
git grep -n 'pre-v2\|\.bak\|backup' -- src/config.ts src/config
```
If stage 1 shipped a different filename shape, use *its* shape in every step below and note the deviation in the stage PR description — the code is right, the plan is amended.

- [ ] **Step 2: Write the failing test**

Create `operator/test/config/prune-migration-backups.test.ts`:

```typescript
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneMigrationBackups } from '../../src/config.js';

describe('pruneMigrationBackups', () => {
  it('removes migration backups and leaves everything else alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-prune-'));
    writeFileSync(join(dir, 'config.json'), '{"configShapeVersion":2}\n');
    writeFileSync(join(dir, 'config.json.pre-v2.20260730T142233Z.bak'), '{}\n');
    writeFileSync(join(dir, 'config.json.pre-v2.20260731T090000Z.bak'), '{}\n');
    writeFileSync(join(dir, 'keystore-password'), 'secret\n');

    const result = pruneMigrationBackups(dir);

    expect(result.removed.sort()).toEqual([
      'config.json.pre-v2.20260730T142233Z.bak',
      'config.json.pre-v2.20260731T090000Z.bak',
    ]);
    expect(readdirSync(dir).sort()).toEqual(['config.json', 'keystore-password']);
  });

  it('is a no-op on a directory with no backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-prune-empty-'));
    writeFileSync(join(dir, 'config.json'), '{"configShapeVersion":2}\n');
    expect(pruneMigrationBackups(dir).removed).toEqual([]);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd operator && yarn vitest run test/config/prune-migration-backups.test.ts`
Expected: FAIL with "pruneMigrationBackups is not a function" / an unresolved import.

- [ ] **Step 4: Implement the prune**

In `operator/src/config.ts` (beside the migration writer):

```typescript
const MIGRATION_BACKUP_PATTERN = /^config\.json\.pre-v2\.\d{8}T\d{6}Z\.bak$/u;

/**
 * Stage-5 completion of the config migration (design section 9): the
 * timestamped pre-v2 backups are pruned once the legacy keys are gone. The
 * backups can carry paid RPC keys, so they do not linger indefinitely.
 */
export function pruneMigrationBackups(configDir: string): { removed: string[] } {
  if (!existsSync(configDir)) return { removed: [] };
  const removed: string[] = [];
  for (const entry of readdirSync(configDir)) {
    if (!MIGRATION_BACKUP_PATTERN.test(entry)) continue;
    rmSync(join(configDir, entry), { force: true });
    removed.push(entry);
  }
  return { removed: removed.sort() };
}
```

Add `readdirSync` / `rmSync` to the existing `node:fs` import if they are not already there.

- [ ] **Step 5: Call it once at boot**

In the config-load path, immediately after the loaded config is confirmed to be at `configShapeVersion: 2`, call `pruneMigrationBackups(configDir)` and log one line when it removed anything:

```typescript
const pruned = pruneMigrationBackups(configDir);
if (pruned.removed.length > 0) {
  console.log(
    `[config] Pruned ${pruned.removed.length} pre-v2 migration ${pruned.removed.length === 1 ? 'backup' : 'backups'}.`,
  );
}
```

- [ ] **Step 6: Run the tests**

```bash
cd operator
yarn vitest run test/config/prune-migration-backups.test.ts
yarn typecheck
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY SKIP_HL_TESTS=1 yarn test
```
Expected: PASS, and the full suite green.

- [ ] **Step 7: Commit**

```bash
git add -A operator
git commit -m "chore(operator): prune pre-v2 config migration backups at boot"
```

---

### Task 11: File the bridge-retirement chore

Design §12.3: "delete the `legacyManifestDigest` annotation once the venue's open manifest-digest Submissions are terminal (§9) — filed as a chore when stage 5 lands." The chore is filed here; it is **not** executed here, because the trigger is an on-venue condition this stage cannot satisfy.

**Files:** none in the repository. The deliverable is a GitHub Issue.

**Interfaces:**
- Consumes: the design's §9 retirement table and §11.9 freeze on the bridge.
- Produces: a GitHub Issue whose number is recorded in the stage PR description.

- [ ] **Step 1: Establish the current open manifest-digest Submission count**

Before writing the issue body, get a real number so the trigger condition is checkable:

```bash
cd operator
yarn jinn tasks list --json 2>/dev/null | head -40
```
If that verb does not expose the manifest-digest annotation, say so in the issue body and name the query the closer must run instead (the projector archive's Submission facts filtered on the `legacyManifestDigest` annotation). Do not invent a count.

- [ ] **Step 2: File the chore**

```bash
gh issue create \
  --repo Jinn-Network/mono \
  --title "chore: retire the legacyManifestDigest bridge annotation" \
  --body "$(cat <<'EOF'
## Context

The operator-daemon cutover's stage 1 shipped a compile-down bridge: each joined
SolverNet became an execution-wiring entry carrying a `legacyManifestDigest`
annotation, and the claim predicate compiled down to manifest-digest matching —
behavior-identical on day one, by design (marketplace binding design section 7,
frozen section 11.9; composition design section 9).

Stage 5 has landed. The bridge annotation is now the only surviving piece of the
SolverNet vocabulary.

## Trigger

Delete the annotation **only once every open manifest-digest Submission on the
venue has reached a terminal state.** Until then a claim predicate without the
annotation cannot match a legacy-posted task, and the operator silently claims
nothing.

## Acceptance criteria

- Zero open Submissions on the canonical venue carry a manifest-digest gate.
- The `legacyManifestDigest` field is removed from the execution-wiring entry
  schema, its compile-down path in the claim predicate, and the projector's
  `legacy` derivation annotation for synthesized facts cards.
- Operator configs that still carry the annotation parse without it (ignored,
  not rejected) so no operator is stranded mid-upgrade.
- The composition design's section 9 retirement table records the bridge as
  retired.

## References

- Design: `docs/superpowers/specs/2026-07-30-operator-daemon-composition-design.md`
  sections 9, 10, and 12.3
- Program: `docs/superpowers/plans/2026-07-30-operator-daemon-composition-program.md`
  section 7 (follow-ups registry)
EOF
)"
```

- [ ] **Step 3: Set the Issue Type and record the number**

```bash
gh issue list --repo Jinn-Network/mono --limit 3 --search "retire the legacyManifestDigest"
```
Set the Issue Type to `chore` (org-level Issue Type, set through the GitHub UI or GraphQL — `gh issue edit --type` is not supported). Record the issue number in the stage PR description under "Follow-ups filed".

---

### Task 12: Stage gate — the extraction-gate-shaped check

Design §10, stage 5 gate: "extraction-gate-shaped check: the tree builds green with guards." This task performs it as a *clean-clone* check, because the point of an extraction gate is proving the tree does not secretly depend on state that only exists in a warm working copy.

**Files:** none. The deliverable is the recorded gate output attached to the stage PR.

**Interfaces:**
- Consumes: Tasks 1–11.
- Produces: the gate evidence block pasted into the stage PR description.

- [ ] **Step 1: Clean-clone the branch**

```bash
GATE=$(mktemp -d)
git clone --branch integration/evidence-v1 --single-branch \
  "$(git rev-parse --show-toplevel)" "$GATE/mono"
cd "$GATE/mono" && git log --oneline -1
```

- [ ] **Step 2: Build the operator tree from cold**

```bash
cd "$GATE/mono/packages/sdk"    && corepack enable && yarn install --immutable && yarn build
cd "$GATE/mono/packages/plugin" && yarn install --immutable && yarn build
cd "$GATE/mono/packages/core"   && yarn install --immutable && yarn build
cd "$GATE/mono/packages/layer"  && yarn install --immutable && yarn build
cd "$GATE/mono/operator"        && yarn install --immutable
```
Expected: `--immutable` succeeds in `operator/` with no lockfile change — the single strongest signal the rename was path-pure.

```bash
cd "$GATE/mono/operator" && yarn typecheck && yarn build
```
Expected: zero errors; `dist/dashboard/` and `dist/bin/jinn.js` exist.

- [ ] **Step 3: Run the tree's own suite**

```bash
cd "$GATE/mono/operator"
env -u CLAUDE_CODE_OAUTH_TOKEN -u ANTHROPIC_API_KEY SKIP_HL_TESTS=1 yarn test
yarn lint:no-late-mount
```
Expected: green.

- [ ] **Step 4: Run every guard from the clean clone**

```bash
cd "$GATE/mono"
node --test .github/scripts/operator-package-inventory.test.mjs
node --test .github/scripts/operator-source-boundaries.test.mjs
node --test .github/scripts/operator-packed-types.test.mjs
node --test .github/scripts/marketplace-source-boundaries.test.mjs \
            .github/scripts/task-execution-source-boundaries.test.mjs \
            .github/scripts/record-discovery-source-boundaries.test.mjs \
            .github/scripts/evidence-source-boundaries.test.mjs \
            .github/scripts/layer-publish-workflow.test.mjs \
            .github/scripts/npm-publish-workflow.test.mjs \
            .github/scripts/repository-gitlinks.test.mjs
```
Expected: all PASS.

- [ ] **Step 5: Build the operator image from the renamed Dockerfile**

The Dockerfile is the one artifact whose build-context paths no test covers:

```bash
cd "$GATE/mono"
docker build -f operator/Dockerfile -t jinn-operator-gate --build-arg JINN_BUILD_COMMIT="$(git rev-parse HEAD)" .
docker run --rm jinn-operator-gate version --json
```
Expected: the image builds and `version --json` prints a payload whose `client.version` matches `operator/package.json`. (The JSON key stays `client` — finding F1; `docker.yml:90` asserts exactly that.)

- [ ] **Step 6: Assert the deletions actually landed**

```bash
cd "$GATE/mono"
git grep -n 'task_runs' -- operator || echo "OK: no task_runs"
git grep -n 'joinedSolverNets' -- operator/src || echo "OK: no joinedSolverNets"
test ! -d client && echo "OK: client/ is gone"
git grep -nE '(^|[^-a-zA-Z0-9/.])client/' -- \
  ':!docs/superpowers/plans' ':!docs/superpowers/specs' ':!spec' ':!log' ':!docs/press' ':!legacy' \
  || echo "OK: no stale repo path outside the historical-doc set"
```
Expected: all four `OK:` lines.

- [ ] **Step 7: Clean up and record the gate**

```bash
docker image rm jinn-operator-gate
rm -rf "$GATE"
```

Paste the Step 2–6 outputs into the stage PR description under a **Stage 5 gate** heading, alongside the drain statement (stage 5 retires no flow, so the drain section reads "not applicable — no flow retires at this stage; the deletions remove already-dead code") and the rollback statement ("revert the stage PR train; the rename is path-only and reverts cleanly, and no chain state is involved").

---

## Self-review

**1. Spec coverage.** Design §10's stage-5 row has four deliverables plus one gate: the rename (Task 6), the guard trio on the operator tree (Tasks 1, 3, 4, 5), `task_runs` deleted (Task 8), bridge retirement begun (Task 11), and the extraction-gate-shaped check (Task 12). §9's retirement completions add the legacy-key deletion (Task 9) and backup pruning (Task 10). §10's standing rules add #2297 landing "no later than stage 5's guard installation" (Tasks 1–2, deliberately first so the guard is what proves the fix) and the `core`/`layer`/`plugin` portal surface surviving intact (asserted by the Task 3 portal-resolution test and by the depth-preserving-portal note in Global Constraints). §12.3's chore is Task 11. Program §6 contract 4 is Task 9. No spec requirement is unclaimed.

**2. Placeholders.** Every step carries the actual command, the actual code, or the actual file-and-line edit. The two places that legitimately cannot be enumerated at plan time — the `task_runs` residue after stages 1–2, and the stage-1 backup filename — each open with a census step that measures reality and a stated disposition for the case where reality differs from the assumption (findings F5, and Task 8 Step 1's stop-and-report rule).

**3. Type consistency.** `pruneMigrationBackups(configDir: string): { removed: string[] }` is defined in Task 10 Step 4 and used with that exact signature in Task 10 Steps 2 and 5. The `TREE` constant is introduced in Tasks 1, 3, 4 and flipped in Task 6 Step 3 in all three files. The guard job name `architecture` is introduced in Task 5 and never renamed thereafter (finding F2). `ConfigSchema` in Task 9 Step 2 carries an explicit instruction to substitute the module's real export name if it differs.

**4. The completeness risk this plan is most exposed to** is a missed workflow path — a `paths:` filter still saying `client/**` means the job silently stops running rather than failing loudly. Task 6 Step 15's repo-wide non-Markdown grep is the backstop for exactly that class, and Task 12 Step 6 re-runs it from a clean clone.
