# Marketplace Surfaces — Immediate Tranche Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the three ungated deliverables of the 2026-07-30 marketplace-surfaces design: sdk R1 with the release-train parameterization ([#2305](https://github.com/Jinn-Network/mono/issues/2305)), the #2296 step-1 logical split (slate re-home, sdk edge severed, boundary guard), and the custody + docs guards ([#2304](https://github.com/Jinn-Network/mono/issues/2304)).

**Architecture:** Three independent tasks, each its own branch + PR to `next`, each referencing its issue. Task 1 removes the sdk's `./benchmarking` surface and makes `npm-publish.yml` track the sdk version from `packages/sdk/package.json` instead of four hard-coded `0.1.1` literals. Task 2 makes `packages/benchmarking/records` the surviving canonical home of the swe-rebench-v2 held-out slate and re-points the indexer (the sole sdk-edge consumer) at it, with a fail-by-omission boundary guard so the edge cannot return. Task 3 adds the custody tripwire guard (spec §4.1 C2/C3) over the signer-accepting marketplace packages and the docs key guard (spec §8.3), both with violation self-tests.

**Tech Stack:** Node 22, Yarn (corepack), vitest (package tests), `node --test` (guard scripts in `.github/scripts/`), GitHub Actions.

**Design authority:** `docs/superpowers/specs/2026-07-30-marketplace-surfaces-and-consumption-boundary-design.md` (§4.1, §6 R1, §7 step 1, §8.3, §10 follow-ups 3/7/9). Discovering the design is wrong here is a finding with a proposed disposition, never a silent patch.

## Global Constraints

- Node 22; `corepack enable` so Yarn matches each package's `packageManager`.
- PRs target `next`, never `main` (AI workflow rule 10). One branch + PR per task, with `Closes #<issue>` in the PR body (except Task 2, whose issue #2296 stays open for step 2 — use `Part of #2296`).
- 0.x semver: minor = breaking, patch = additive (spec §8.2). The sdk bump in Task 1 is `0.1.1 → 0.2.0`.
- Guard scripts live in `.github/scripts/*.test.mjs`, run via `node --test`, and follow the existing pattern (`node:assert/strict` + `node:test`, self-tests via `mkdtempSync`).
- American English throughout; no emoji anywhere.
- Conventional Commit prefixes match each issue's type: `chore(sdk)`, `refactor(indexer)`, `chore(guards)`.
- Do not touch `packages/sdk`'s `./autopilot`, `./solvernets/*`, or fixtures surfaces — those retire in R2/R3 on their own gates (spec §6).
- Worktrees: create one per task via superpowers:using-git-worktrees at execution time, branched from `origin/next` (fetch first — see the stale-worktree-base rule).

---

### Task 1: sdk R1 — drop `./benchmarking`, parameterize the release train (#2305)

**Files:**
- Modify: `.github/scripts/npm-publish-workflow.test.mjs` (add regression test)
- Modify: `.github/workflows/npm-publish.yml` (lines 114, 178, 184–186, 293, 546)
- Delete: `packages/sdk/src/benchmarking.ts`, `packages/sdk/test/benchmarking.test.ts`
- Modify: `packages/sdk/package.json` (remove `./benchmarking` export, bump version to 0.2.0)
- Modify: `packages/sdk/test/surface.test.ts` (remove the two benchmarking import blocks at lines ~40–52 and the `exposes benchmarking contracts` test at ~161)
- Modify: `packages/sdk/README.md` (changelog note)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: sdk `0.2.0` with the `./benchmarking` subpath gone; `npm-publish.yml` reading the sdk version from `packages/sdk/package.json`. No other task depends on this.

- [ ] **Step 1: Write the failing workflow regression test**

Append to `.github/scripts/npm-publish-workflow.test.mjs`:

```js
test('npm-publish.yml carries no hard-coded @jinn-network/sdk version literal', () => {
  const workflow = readFileSync(
    resolve(import.meta.dirname, '../workflows/npm-publish.yml'),
    'utf8',
  );
  // The sdk version must be derived from packages/sdk/package.json at run
  // time (marketplace-surfaces design §6 R1): a pinned literal red-lines
  // every client canary the moment the sdk version bumps.
  const pinned = workflow.match(/@jinn-network\/sdk@\d+\.\d+\.\d+/g) ?? [];
  assert.deepEqual(pinned, [], `hard-coded sdk version literals: ${pinned.join(', ')}`);
  const versionAssignments = workflow.match(/sdk\.version\s*=\s*'\d+\.\d+\.\d+/g) ?? [];
  assert.deepEqual(versionAssignments, [], 'sdk.version must derive from the manifest, not a literal');
});
```

(Match the file's existing import style for `readFileSync`/`resolve`/`test`/`assert` — they are already imported at the top.)

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test .github/scripts/npm-publish-workflow.test.mjs`
Expected: FAIL listing the `@jinn-network/sdk@0.1.1` literals.

- [ ] **Step 3: Parameterize `npm-publish.yml`**

The client job's working directory is `client/`, so the sdk manifest is at `../packages/sdk/package.json`. Four edits:

(a) In the meta step (~line 110), derive the sdk version beside `PACKAGE_VERSION` and use it in both `SDK_SPEC` arms; add it to the step outputs:

```bash
SDK_PACKAGE_VERSION=$(node -e "console.log(JSON.parse(require('fs').readFileSync('../packages/sdk/package.json','utf8')).version)")
# workflow_run arm:
SDK_SPEC="@jinn-network/sdk@${SDK_PACKAGE_VERSION}-canary.sha.${JINN_BUILD_COMMIT}"
```

and in the outputs block (~line 178):

```bash
echo "sdk_version=${SDK_PACKAGE_VERSION}"
echo "sdk_spec=${SDK_SPEC:-@jinn-network/sdk@${SDK_PACKAGE_VERSION}}"
```

(b) "Require published SDK" step (~lines 184–186):

```bash
EXPECTED_SDK="${{ steps.meta.outputs.sdk_version }}"
SDK_VERSION="$(npm view "@jinn-network/sdk@${EXPECTED_SDK}" version)"
if [ "${SDK_VERSION}" != "${EXPECTED_SDK}" ]; then
  echo "::error::Stable client release requires @jinn-network/sdk@${EXPECTED_SDK}"
  exit 1
fi
```

(c) Canary version-patch step (~line 293) — append the suffix to whatever version the manifest carries instead of assigning a literal:

```js
sdk.version = sdk.version + '-canary.sha.' + process.env.JINN_BUILD_COMMIT;
```

(ensure `JINN_BUILD_COMMIT` is in that step's `env:`; it already is for the surrounding steps — copy the `env:` block if the node -e step lacks it).

(d) Stable acceptance env (~line 546):

```yaml
SDK_SPEC: '@jinn-network/sdk@${{ steps.meta.outputs.sdk_version }}'
```

- [ ] **Step 4: Run the workflow guard to verify it passes**

Run: `node --test .github/scripts/npm-publish-workflow.test.mjs`
Expected: PASS (all pre-existing tests plus the new one).

- [ ] **Step 5: Commit the workflow change**

```bash
git add .github/workflows/npm-publish.yml .github/scripts/npm-publish-workflow.test.mjs
git commit -m "chore(ci): derive sdk version in npm-publish.yml from the sdk manifest

Four hard-coded @jinn-network/sdk@0.1.1 literals red-lined every client
canary the moment the sdk version bumped. Part of #2305."
```

- [ ] **Step 6: Remove the `./benchmarking` surface**

```bash
git rm packages/sdk/src/benchmarking.ts packages/sdk/test/benchmarking.test.ts
```

In `packages/sdk/package.json`: delete the `"./benchmarking"` exports entry (lines 57–60) and set `"version": "0.2.0"`.

In `packages/sdk/test/surface.test.ts`: delete both import blocks from `'../src/benchmarking.js'` (~lines 40–52) and the entire `it('exposes benchmarking contracts via @jinn-network/sdk/benchmarking', ...)` test (~line 161 onward).

- [ ] **Step 7: Add the migration note**

In `packages/sdk/README.md`, add (create a `## Changelog` section at the end if none exists):

```markdown
### 0.2.0 (2026-07-30)

Breaking (0.x policy: minor = breaking): the `./benchmarking` subpath is
removed. Its schemas were superseded by the benchmarking application design;
the successor surfaces will live in `@jinn-network/benchmarking-records`
once the platform stack publishes. No in-repo importer remained at removal
time. All other subpaths are unchanged; `@jinn-network/sdk@0.1.1` remains
on the registry for pinned consumers.
```

- [ ] **Step 8: Verify the sdk package**

Run, from `packages/sdk/`: `yarn install && yarn typecheck && yarn test && yarn pack:smoke`
Expected: zero type errors; all tests pass (benchmarking tests gone, cross-source slate test still green); pack smoke green with no `./benchmarking` in the tarball.

Then from repo root: `node --test .github/scripts/npm-publish-workflow.test.mjs` — still PASS.

- [ ] **Step 9: Commit and open the PR**

```bash
git add -A packages/sdk
git commit -m "chore(sdk): drop the superseded ./benchmarking subpath (0.2.0)

R1 of the sdk retirement map (marketplace-surfaces design §6). Zero
importers verified; successor is @jinn-network/benchmarking-records.

Closes #2305"
```

PR to `next`. PR body notes the release-time coordination: the next Monday stable client cut requires publishing `@jinn-network/sdk@0.2.0` stable first (`yarn release:sdk`), which the parameterized gate now checks for automatically.

---

### Task 2: #2296 step 1 — slate re-home, sever the sdk edge, indexer boundary guard

**Files:**
- Create: `packages/benchmarking/records/src/slates/swe-rebench-v2-held-out.ts`
- Create: `packages/benchmarking/records/src/slates/swe-rebench-v2-held-out.test.ts`
- Modify: `packages/benchmarking/records/package.json` (new export subpath)
- Modify: `packages/indexer/src/api/explorer.ts:51-54` (import swap)
- Modify: `packages/indexer/package.json:30` (portal swap)
- Modify: `.github/workflows/indexer-ci.yml` (build-dep step + guard step)
- Create: `.github/scripts/indexer-boundaries.test.mjs`
- Modify: `packages/indexer/README.md` (tier map note; create if absent)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `@jinn-network/benchmarking-records/slates/swe-rebench-v2-held-out` exporting **exactly the sdk module's public surface**: `HELD_OUT_SLATE_SCHEMA_VERSION`, `HeldOutSlateArtifact`, `LoadedHeldOutSlate`, `HELD_OUT_SLATE_V1`, `hashHeldOutSlateArtifact(artifact): \`sha256:${string}\``, `loadHeldOutSlate(version): LoadedHeldOutSlate`. The indexer's call site (`loadHeldOutSlate`, `LoadedHeldOutSlate`) must compile against it with only the specifier changed.

- [ ] **Step 1: Port the slate module**

```bash
mkdir -p packages/benchmarking/records/src/slates
cp packages/sdk/src/solvernets/swe-rebench-v2-held-out-slate.ts \
   packages/benchmarking/records/src/slates/swe-rebench-v2-held-out.ts
```

Then edit only the header comment of the new file: replace the paragraph explaining "embedded here, in the SDK" with:

```
 * Canonical home per the 2026-07-30 marketplace-surfaces design (§7 step 1):
 * this module is the surviving single source of the held-out membership as
 * the SolverNet-era copies (client artifact, legacy sdk embed) retire. The
 * cross-source parity test beside this file holds all copies byte-identical
 * until then.
```

Do not change any exported identifier, the embedded data, or the hashing logic — the sdk's cross-source drift test and this package's new parity test both depend on byte-identical membership.

- [ ] **Step 2: Write the parity test (failing until the export wiring lands)**

`packages/benchmarking/records/src/slates/swe-rebench-v2-held-out.test.ts`:

```ts
/**
 * Cross-source parity: the records embed must stay byte-identical to the
 * canonical client artifact (the membership hub until client/ retires) —
 * same discipline as packages/sdk/test/solvernets/
 * swe-rebench-v2-held-out-slate-cross-source.test.ts, which covers the
 * sdk ↔ client pair. Transitively, all three copies agree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadHeldOutSlate, HELD_OUT_SLATE_V1 } from './swe-rebench-v2-held-out.js';

const here = dirname(fileURLToPath(import.meta.url));
const clientArtifactPath = resolve(
  here,
  '../../../../../client/src/solver-types/slates/held-out-slate.swe-rebench-v2.v1.json',
);

describe('held-out slate cross-source parity (records ↔ client)', () => {
  const clientArtifact = JSON.parse(readFileSync(clientArtifactPath, 'utf8')) as {
    instanceIds: string[];
    hash: string;
    version: string;
    solverType: string;
  };

  it('records embedded instanceId set === client artifact instanceIds', () => {
    const slate = loadHeldOutSlate('v1');
    expect([...slate.instanceIds].sort()).toEqual([...clientArtifact.instanceIds].sort());
  });

  it('records declared hash === client artifact hash (and self-verifies)', () => {
    expect(HELD_OUT_SLATE_V1.hash).toBe(clientArtifact.hash);
    expect(() => loadHeldOutSlate('v1')).not.toThrow();
  });

  it('records version + solverType === client artifact', () => {
    expect(HELD_OUT_SLATE_V1.version).toBe(clientArtifact.version);
    expect(HELD_OUT_SLATE_V1.solverType).toBe(clientArtifact.solverType);
  });
});
```

Verify the relative path depth (`src/slates/` is five levels from repo root's `client/`); adjust the `../` count if the test runner reports ENOENT.

- [ ] **Step 3: Run records tests — new test must pass, package must build**

From `packages/benchmarking/records/`: `yarn test && yarn typecheck` (use the package's actual script names from its `package.json`; fall back to `yarn vitest run` / `yarn tsc --noEmit`).
Expected: PASS, including the new parity test.

- [ ] **Step 4: Add the export subpath**

In `packages/benchmarking/records/package.json` exports, after the `"."` entry:

```json
"./slates/swe-rebench-v2-held-out": {
  "import": "./dist/slates/swe-rebench-v2-held-out.js",
  "types": "./dist/slates/swe-rebench-v2-held-out.d.ts"
},
```

- [ ] **Step 5: Run the benchmarking guard trio; update expectations if they enumerate subpaths**

Run: `node --test .github/scripts/benchmarking-package-inventory.test.mjs .github/scripts/benchmarking-source-boundaries.test.mjs && node .github/scripts/benchmarking-packed-types.test.mjs`

If a guard asserts the records export map or packed type surface, add the new subpath to its expectation (the guard failure output names the assertion). The source-boundaries guard must stay green without allowlist changes — the module imports nothing new.

- [ ] **Step 6: Commit the records half**

```bash
git add packages/benchmarking/records .github/scripts
git commit -m "refactor(benchmarking): re-home the swe-rebench-v2 held-out slate

Canonical single source per marketplace-surfaces design §7 step 1, with a
records↔client parity test mirroring the existing sdk↔client one.
Part of #2296."
```

- [ ] **Step 7: Sever the indexer's sdk edge**

`packages/indexer/src/api/explorer.ts` — change the import specifier only:

```ts
import {
  loadHeldOutSlate,
  type LoadedHeldOutSlate,
} from '@jinn-network/benchmarking-records/slates/swe-rebench-v2-held-out';
```

`packages/indexer/package.json:30` — replace the dependency line:

```json
"@jinn-network/benchmarking-records": "portal:../benchmarking/records",
```

(removing `"@jinn-network/sdk": "portal:../sdk"`), then run `yarn install` at the repo root so the lockfile updates.

`.github/workflows/indexer-ci.yml` — the "Build @jinn-network/sdk" step exists only to compile the portal target's `dist/`; re-point it:

```yaml
      - name: Build @jinn-network/benchmarking-records
        working-directory: packages/benchmarking/records
        run: |
          yarn install --immutable
          yarn build
```

(keep the surrounding comment's explanation, updated to name benchmarking-records).

- [ ] **Step 8: Write the failing boundary guard**

`.github/scripts/indexer-boundaries.test.mjs`:

```js
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const indexerRoot = join(root, 'packages', 'indexer');

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.ponder', 'generated'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

// #2296 step 1 (marketplace-surfaces design §7): the indexer's legacy-sdk
// edge is severed and must not return. Fail-by-omission: any import of the
// deprecated @jinn-network/sdk from indexer sources is a violation.
test('packages/indexer imports nothing from @jinn-network/sdk', () => {
  const offenders = [];
  for (const file of sourceFiles(indexerRoot)) {
    const text = readFileSync(file, 'utf8');
    if (/from\s+['"]@jinn-network\/sdk(?:\/|['"])/.test(text) ||
        /require\(\s*['"]@jinn-network\/sdk(?:\/|['"])/.test(text)) {
      offenders.push(file.slice(root.length + 1));
    }
  }
  assert.deepEqual(offenders, [], `legacy sdk imports: ${offenders.join(', ')}`);
});

test('packages/indexer/package.json declares no @jinn-network/sdk dependency', () => {
  const manifest = JSON.parse(readFileSync(join(indexerRoot, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.equal(manifest[key]?.['@jinn-network/sdk'], undefined,
      `@jinn-network/sdk found in ${key}`);
  }
});
```

Run it BEFORE Step 7's edits land in the working tree to see it fail (or stash Step 7, run, unstash). If executing in Step-7-then-8 order, instead verify failure by temporarily re-adding the old import line, observing the red, and reverting. Either way: observe the guard red once against an sdk import, then green against the real tree.

- [ ] **Step 9: Wire the guard into indexer CI and run everything**

Add to `.github/workflows/indexer-ci.yml` steps (before the build steps; it needs no install) — note `defaults.run.working-directory` is `packages/indexer`, so override it:

```yaml
      - name: Indexer boundary guard
        working-directory: ${{ github.workspace }}
        run: node --test .github/scripts/indexer-boundaries.test.mjs
```

Run locally from repo root:
`node --test .github/scripts/indexer-boundaries.test.mjs` → PASS.
From `packages/indexer/`: `yarn typecheck && yarn test` (actual script names from its package.json) → PASS.

- [ ] **Step 10: Record the logical split (naming half)**

In `packages/indexer/README.md` (create if absent), add at the top:

```markdown
## Tier map (DR-2026-07-30 logical split, #2296 step 1)

This package hosts two roles pending the physical split (#2296 step 2,
gated on the operator-daemon cutover's discovery-serving stage):

- **Projector role** (`src/` handlers, enrichment): aspirationally tier 3;
  being replaced by the stack projector (`packages/marketplace/projector`
  is projector #1). Post-split this process's role is hosted archive +
  query plane.
- **Explorer SPA** (`explorer/`, `src/api/explorer.ts`): tier 4 product;
  physically separates at step 2.

The legacy `@jinn-network/sdk` edge is severed and guarded
(`.github/scripts/indexer-boundaries.test.mjs`).
```

- [ ] **Step 11: Commit and open the PR**

```bash
git add packages/indexer .github/workflows/indexer-ci.yml .github/scripts/indexer-boundaries.test.mjs yarn.lock
git commit -m "refactor(indexer): sever the legacy sdk edge; boundary guard + tier map

The held-out slate now resolves from @jinn-network/benchmarking-records;
the indexer no longer depends on the deprecated SolverNet sdk. #2296
step 1 per the marketplace-surfaces design §7. Part of #2296."
```

PR to `next` with `Part of #2296` (the issue stays open for step 2). PR body names the deploy check: the indexer's Railway image build must still pass (the portal swap changes the build graph — watch the Dockerfile/watchPatterns if the deploy config enumerates `packages/sdk`).

---

### Task 3: Custody tripwire guard and docs key guard (#2304)

**Files:**
- Create: `.github/scripts/custody-boundaries.test.mjs`
- Create: `.github/scripts/docs-key-guard.test.mjs`
- Modify: `.github/workflows/marketplace-ci.yml` (wire custody guard; add script to `paths`)
- Modify: `.github/workflows/repository-structure.yml` (wire docs guard)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: two repo-global guard scripts. The custody set auto-discovers future trees (`venue-base`, `work-client`) by directory existence, so the daemon-cutover and work-client sessions inherit coverage without editing the guard.

- [ ] **Step 1: Write the custody guard with violation self-tests**

`.github/scripts/custody-boundaries.test.mjs`:

```js
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// The custody law's tripwire (marketplace-surfaces design §4.1 C2/C3),
// scoped to the signer-accepting marketplace packages — NOT the whole
// stack (the evidence repository uses node:fs by design). This guard is a
// tripwire, not the control; the control is review plus signer-object-only
// API shape. Future trees (venue-base, work-client) are picked up by
// existence, so new signer-accepting packages inherit coverage.
const CUSTODY_SET = ['binding', 'pipeline', 'venue-base', 'work-client']
  .map((d) => join(root, 'packages', 'marketplace', d))
  .filter((d) => existsSync(d));

// C2: no ambient authority acquisition — no env, no filesystem, no
// process spawning, no keystore reads inside package sources.
const AMBIENT_PATTERNS = [
  [/process\.env/, 'process.env access'],
  [/from\s+['"](?:node:)?fs['"]/, 'filesystem import'],
  [/from\s+['"](?:node:)?child_process['"]/, 'child_process import'],
  [/require\(\s*['"](?:node:)?(?:fs|child_process)['"]\s*\)/, 'fs/child_process require'],
];
// C3: signer objects only — key-construction helpers and key-material
// parameter names are refused in any position, source or public type.
const KEY_PATTERNS = [
  [/privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey/, 'key-construction helper'],
  [/\b(?:privateKey|mnemonic|seedPhrase)\s*[:?]/i, 'key-material parameter or property'],
];

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', 'test', 'fixtures'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|mts)$/.test(entry) && !/\.test\./.test(entry)) out.push(full);
  }
  return out;
}

function scan(dirs) {
  const violations = [];
  for (const dir of dirs) {
    const src = join(dir, 'src');
    if (!existsSync(src)) continue;
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      for (const [pattern, label] of [...AMBIENT_PATTERNS, ...KEY_PATTERNS]) {
        if (pattern.test(text)) violations.push(`${file.slice(root.length + 1)}: ${label}`);
      }
    }
  }
  return violations;
}

test('custody set has no ambient authority or key-material surface', () => {
  assert.ok(CUSTODY_SET.length >= 2, 'custody set unexpectedly empty — check paths');
  assert.deepEqual(scan(CUSTODY_SET), []);
});

test('self-test: the scanner flags a violating fixture', () => {
  const dir = mkdtempSync(join(tmpdir(), 'custody-guard-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'src', 'bad.ts'),
      "import { readFileSync } from 'node:fs';\n" +
        "export function poster(opts: { privateKey: string }) {\n" +
        '  return readFileSync(process.env.KEYSTORE_PATH ?? "", "utf8") + opts.privateKey;\n' +
        '}\n',
    );
    const violations = scan([dir]);
    assert.ok(violations.some((v) => v.includes('filesystem import')));
    assert.ok(violations.some((v) => v.includes('process.env')));
    assert.ok(violations.some((v) => v.includes('key-material parameter')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it — the tree must already pass, the self-test must exercise red**

Run: `node --test .github/scripts/custody-boundaries.test.mjs`
Expected: PASS (binding and pipeline are clean today — this pins it; the self-test proves the scanner catches violations). If the tree test FAILS, stop: that is a real finding against `packages/marketplace` — triage before proceeding (do not widen patterns or allowlist to get green).

- [ ] **Step 3: Write the docs key guard with self-test**

`.github/scripts/docs-key-guard.test.mjs`:

```js
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '../..');

// Docs guard (marketplace-surfaces design §8.3): no raw private keys in any
// documentation or example. The single allowlisted literal is the
// well-known Anvil dev key — the one string every reader knows is burned.
const ANVIL_DEV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
// 64-hex literals alone are tx hashes and digests everywhere; only flag
// them in key-shaped contexts.
const KEY_CONTEXTS = [
  /(?:private[-_ ]?key|PRIVATE_KEY)\s*[=: ]\s*["'`]?(0x[0-9a-fA-F]{64})/g,
  /privateKeyToAccount\(\s*["'`](0x[0-9a-fA-F]{64})/g,
  /--private-key\s+["'`]?(0x[0-9a-fA-F]{64})/g,
];
const SCAN_ROOTS = ['docs', 'examples', 'spec', 'client/README.md', 'README.md', 'CLAUDE.md'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

function markdownAndExampleFiles(path, out = []) {
  if (!statSync(path, { throwIfNoEntry: false })) return out;
  if (statSync(path).isFile()) { out.push(path); return out; }
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(path, entry);
    if (statSync(full).isDirectory()) markdownAndExampleFiles(full, out);
    else if (/\.(md|mdx|ts|js|mjs|sh|json)$/.test(entry)) out.push(full);
  }
  return out;
}

function scan(paths) {
  const violations = [];
  for (const file of paths) {
    const text = readFileSync(file, 'utf8');
    for (const context of KEY_CONTEXTS) {
      for (const match of text.matchAll(context)) {
        if (match[1].toLowerCase() !== ANVIL_DEV_KEY) {
          violations.push(`${file.slice(root.length + 1) || file}: ${match[1].slice(0, 12)}…`);
        }
      }
    }
  }
  return violations;
}

test('docs and examples carry no raw private keys beyond the Anvil dev key', () => {
  const files = SCAN_ROOTS.flatMap((p) => markdownAndExampleFiles(join(root, p)));
  assert.ok(files.length > 0, 'scan roots resolved no files — check paths');
  assert.deepEqual(scan(files), []);
});

test('self-test: a non-Anvil key in key context is flagged; the Anvil key is not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-key-guard-'));
  try {
    const bad = join(dir, 'bad.md');
    writeFileSync(bad,
      'PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d\n' +
      `cast send --private-key ${ANVIL_DEV_KEY} ...\n`);
    const violations = scan([bad]);
    assert.equal(violations.length, 1);
    assert.ok(violations[0].includes('0x59c6995e99'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run it and triage any real hits**

Run: `node --test .github/scripts/docs-key-guard.test.mjs`
Expected: PASS (CLAUDE.md's `--private-key 0xac0974…` is the allowlisted Anvil key). If real hits surface in `docs/` or `spec/`, each is a genuine leak: replace the literal with the Anvil key or a `<your-key>` placeholder in the same change — never widen the allowlist.

- [ ] **Step 5: Wire both guards into CI**

`.github/workflows/marketplace-ci.yml`: add `.github/scripts/custody-boundaries.test.mjs` to the workflow's `paths:` trigger list (~line 10 pattern already covers `marketplace-*.test.mjs` — the custody script needs its own entry), and beside the existing guard steps (~line 31):

```yaml
      - name: Custody boundaries (tripwire, marketplace-surfaces design §4.1)
        run: node --test .github/scripts/custody-boundaries.test.mjs
```

`.github/workflows/repository-structure.yml`: beside the existing `node --test` steps (~line 22):

```yaml
      - run: node --test .github/scripts/docs-key-guard.test.mjs
```

- [ ] **Step 6: Full local verification**

```bash
node --test .github/scripts/custody-boundaries.test.mjs .github/scripts/docs-key-guard.test.mjs
```

Expected: 4 tests, all PASS.

- [ ] **Step 7: Commit and open the PR**

```bash
git add .github/scripts/custody-boundaries.test.mjs .github/scripts/docs-key-guard.test.mjs .github/workflows/marketplace-ci.yml .github/workflows/repository-structure.yml
git commit -m "chore(guards): custody tripwire (C2/C3) and docs key guard

Pins the custody law of the marketplace-surfaces design §4.1 over the
signer-accepting marketplace packages (auto-including venue-base and the
work client when they land) and refuses raw private keys in docs and
examples outside the Anvil dev literal (§8.3). Both guards carry
violation self-tests.

Closes #2304"
```

PR to `next`.

---

## Execution notes

- **Order:** any; the tasks share no files. If run in one session, Task 3 first pins the custody state before other changes land.
- **Not in this tranche (gated, per the design §10):** the work client (follow-up 5, daemon stage 3 + #2293 canaries), CLI convergence (follow-up 6), sdk R2/R3 (follow-up 8), #2296 step 2 (follow-up 10), quickstarts (follow-up 11), profile-URI hosting (follow-up 1), fixture-immutability CI (follow-up 2).
- **Design-conflict rule:** if implementation contradicts the design (e.g. a records guard forbids the slate module's shape), surface a finding with a proposed disposition on the PR — never patch silently.

> **Execution addendum (2026-07-30):** Task 1 Step 7's README text was amended during execution (hedged successor tense, in-repo-importer claim) per the task review's plan-mandated finding; Tasks 2-3 branch from and PR into `integration/evidence-v1`, not `next` — their target trees exist only there. Task 1's Step 8 verification is extended by the review: run `client/` `yarn vitest run test/scripts/pack-workflows.test.ts` as well.

> **Execution addendum 2 (2026-07-30):** Task 2 Step 1's verbatim port conflicted with `benchmarking-source-boundaries.test.mjs` (locale-sensitive API ban — the ported loader's `localeCompare` hash canonicalizer). Ruled per the design's own "data module" wording: the records module ships constants + types + a non-recomputing loader; hash verification (with the legacy comparator) lives in the parity test; the module header documents the v1 hash's legacy locale-collation derivation and the code-unit rule for any v2. `hashHeldOutSlateArtifact` is not exported from the records module. Latent finding (out of scope here): the sdk and client copies recompute the v1 hash with locale-default collation today — environment-dependent; consider a follow-up issue.

> **Execution addendum 3 (2026-07-30):** Task 3's docs-guard allowlist is the standard Anvil dev-account key set, not the single account-0 literal — the first real run false-positived on Anvil account #1 in `docs/superpowers/plans/2026-04-24-envelope-v1-f-conformance.md` (whose key pairs with account #1's TEST_ADDRESS in four conformance fixtures), and the mandated "fix" degraded that doc. Spec §8.3 amended; the doc edit reverts in the fix round; the guard's failure message names the burned-key exception path.
