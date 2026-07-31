# C0 — Frozen Adapter Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** move the **frozen** Hermes adapter — the 21 files under `apps/jinn-agent/plugins/jinn/`, including `layer-runtime.json` — to a first-party, clearly-frozen home at `plugin/frozen/`, **byte for byte**, and re-point every consumer at the new home, so that [#2294](https://github.com/Jinn-Network/mono/issues/2294) (remove `apps/jinn-agent`) is unblocked without waiting for the clean-slate product.

**Architecture:** this is a relocation, not a change. The published slim repository `Jinn-Network/jinn-plugin` is a deterministic content-mirror of one mono directory; move the directory, re-point the mirror's `PLUGIN_DIR`, and the published bytes are unchanged. Two properties make that claim mechanically checkable rather than asserted: (1) git's own tree identity — `HEAD:plugin/frozen` must hash to the same tree object as `<base>:apps/jinn-agent/plugins/jinn`; and (2) a live mirror dry-run against a clone of the published repo must report `changed=false`. The fork keeps working meanwhile through one committed symlink at the old path, which dies with the fork under #2294.

**Tech stack:** git (`git mv`, tree-object identity); Node 22 (`node --test` for the two `.github/scripts` suites); vitest 4 (`packages/layer`); bash (the cold-stock gate script); Python 3.11 (the fork's import machinery, spot-checked only).

---

## Branch and stack position

- **Branch:** `plugin/c0-adapter-relocation`
- **Base branch:** `integration/evidence-v1` — C0 is a **stack root** with no component dependencies.
- **PRs target the BASE branch:** open the PR against `integration/evidence-v1`. Do not target `next` or `main`.
- **Sibling stack root:** C3 (`2026-07-30-plugin-c3-product-tree.md`) also creates content under `plugin/`. See "Coordination with C3" below — the two are disjoint by construction and must stay that way.

Create the branch:

```bash
git fetch origin
git checkout -b plugin/c0-adapter-relocation origin/integration/evidence-v1
```

### Restacking

The base moves as other components merge. Never assume a sibling's code exists on `integration/evidence-v1`; C0 depends on none of it.

**Ordinary fast-forward of the base** (base advanced, your commits untouched):

```bash
git fetch origin
git rebase origin/integration/evidence-v1
```

**The base was squash-merged or otherwise rewritten** (this repo squash-merges, so the old base commits are gone and a plain rebase replays your work onto a history that already contains it):

```bash
git fetch origin
# OLD_BASE = the commit this branch was created from; find it before rebasing:
git merge-base plugin/c0-adapter-relocation origin/integration/evidence-v1   # if this is empty, use the reflog
git rebase --onto origin/integration/evidence-v1 <OLD_BASE> plugin/c0-adapter-relocation
```

**Verify the stack is still coherent after any restack** — run all of these on the restacked head and show the output:

```bash
# 1. the relocation is intact and byte-identical
git rev-parse HEAD:plugin/frozen
git cat-file -t HEAD:apps/jinn-agent/plugins/jinn        # must print: blob   (the symlink)
git ls-files -s apps/jinn-agent/plugins/jinn             # must start: 120000

# 2. no consumer still names the old path
grep -rn "apps/jinn-agent/plugins/jinn" .github/ packages/layer/test/ apps/jinn-agent/scripts/ \
  | grep -v 'DO NOT EDIT HERE'                           # must print nothing

# 3. every re-pointed check is green
node .github/scripts/verify-layer-stable-version.mjs --root . --version 0.1.2
node --test .github/scripts/layer-publish-workflow.test.mjs
node --test .github/scripts/jinn-plugin-split.test.mjs
node --test .github/scripts/published-artifacts-smoke-workflow.test.mjs
(cd packages/layer && yarn install --immutable && yarn vitest run test/architecture/package-contract.test.ts)
bash -n apps/jinn-agent/scripts/cold-stock-e2e.sh

# 4. the mirror still produces the published tree (Task 9's gate)
bash /tmp/c0-mirror-gate.sh
```

If the base rewrite touched `apps/jinn-agent/plugins/jinn` (a freeze critical-fix landing underneath you), **stop** — that is a freeze event, not a rebase. Re-run Task 1's baseline capture against the new base, redo Task 2's `git mv` from the new content, and record the incident in the PR description.

### Coordination with C3

Both C0 and C3 create the top-level `plugin/` directory. Git merges them cleanly **only because their paths are disjoint**, so the split is stated here as a binding contract:

| Owner | Creates | Must not create |
| --- | --- | --- |
| **C0** (this plan) | `plugin/frozen/**` — and nothing else under `plugin/` | any file directly at `plugin/` (no `plugin/README.md`, no `plugin/package.json`, no `plugin/.gitignore`) |
| **C3** | `plugin/runtime/**`, `plugin/adapter-hermes/**`, and any file directly at `plugin/` | anything under `plugin/frozen/` |

Two consequences C3's implementer must know:

1. **`plugin/frozen/` is not a Node package and must stay outside C3's guard trio.** It contains no `package.json` (its manifest is `pyproject.toml`), so a manifest-driven package-inventory guard (`plugin/*/package.json`) does not see it. If C3's inventory guard instead enumerates directories, it must exclude `frozen`.
2. **Nothing may be added inside `plugin/frozen/`, ever.** The mirror publishes that directory's entire contents to the root of `Jinn-Network/jinn-plugin`; a `FROZEN.md` marker placed there would ship to every installed host. The freeze signal is the *directory name* plus the re-pointed workflow header (see Findings F3).

---

## Global constraints

- **This is a relocation. No content changes.** The 21 files under `plugin/frozen/` must be byte-identical to their originals at every commit of this branch. No version bumps, no lint fixes, no comment tidying, no README edits — not even ones that look obviously right.
- **The reviewer's mechanical check is a pure-rename diff.** `git diff -M --summary origin/integration/evidence-v1...HEAD` must show every one of the 21 files as `rename ... (100%)`, plus exactly one `create mode 120000` for the symlink. Anything else in that directory is a freeze violation.
- **The published slim repository must not churn.** The relocation lands with `changed=false` from the mirror; the next `main` promote produces no new slim commit.
- No new npm package, no `yarn install` in a new tree, no CI workflow created.
- Every task ends with its verification command run and its output shown (principles §13.3).
- Do not edit the spec or the program plan. Anything that contradicts them goes in the Findings section of this file and in the PR description.

---

## Fixed values used throughout

These were read at authoring time (2026-07-30) against `integration/evidence-v1` @ `34a7b3cbd45c7e0760daf733405c9a04d0bb3c0a`. They are **expectations, not pass conditions where noted** — if one differs at execution time, that is information, not a failure to paper over.

| Name | Value | Meaning |
| --- | --- | --- |
| `BASELINE_TREE` | `1073efeda203601ea99fa90f93a340e6dc377dd2` | git tree object of `apps/jinn-agent/plugins/jinn` on the base |
| slim head commit | `83ababfca6b194f79a78401626602edac5ca325b` | `Jinn-Network/jinn-plugin` `main` at authoring time (informational) |
| last mirrored mono SHA | `f1ff996b333bcef6f208a7a2ac232cc92239012b` | from the slim `.jinn-split-source` (informational) |
| trio version | `0.1.2` | `packages/{plugin,core,layer}` and the `layer-runtime.json` pin, all in lockstep |
| new frozen home | `plugin/frozen` | repo-relative |
| symlink target | `../../../plugin/frozen` | relative from `apps/jinn-agent/plugins/` |

---

## File structure

| Path | Change | Why |
| --- | --- | --- |
| `apps/jinn-agent/plugins/jinn/**` (21 files) | **moved** → `plugin/frozen/**` | the relocation itself |
| `apps/jinn-agent/plugins/jinn` | **new symlink** → `../../../plugin/frozen` | keeps the fork's bundled-plugin loader and its 36 in-fork consumers working until #2294 deletes them |
| `.github/scripts/verify-layer-stable-version.mjs` | line 58 re-point | the lockstep verifier reads the runtime pin (#2294 item 2) |
| `.github/scripts/layer-publish-workflow.test.mjs` | line 65 fixture re-point | drives the verifier over a temp fixture tree |
| `packages/layer/test/architecture/package-contract.test.ts` | line 33 re-point | **fourth consumer, not named in the program plan** (Finding F1) |
| `.github/scripts/jinn-plugin-split.mjs` | header, `buildCommitMessage`, CLI default | the mirror helper (#2294 item 1) |
| `.github/scripts/jinn-plugin-split.test.mjs` | line 206 expected commit message | pins the helper's message string |
| `.github/workflows/jinn-plugin-split.yml` | header + `PLUGIN_DIR` env | the mirror workflow |
| `.github/workflows/jinn-agent-ci.yml` | `paths` filters ×2 | the cold-stock gate must still fire on frozen-adapter changes (#2294 item 3) |
| `apps/jinn-agent/scripts/cold-stock-e2e.sh` | line 86 wheel source | the gate builds the adapter wheel from the relocated dir |
| `.github/scripts/published-artifacts-smoke-workflow.test.mjs` | line 115 guard | forbids the smoke workflow from reaching into the in-repo adapter — must forbid the new path too |

**Deliberately not touched:** `.github/scripts/jinn-plugin-split.mjs:192` and `.github/scripts/jinn-plugin-split.test.mjs:305` — the `knownLegacy` provenance string `'DO NOT EDIT HERE — edit apps/jinn-agent/plugins/jinn/ in Jinn-Network/mono.'`. That is a **historical marker contract**: it describes bytes already published into the slim repo by an earlier workflow generation. Changing it would break the one-time marker repair path.

---

### Task 1: Capture the freeze baseline and prove the published channel matches it

**Files:** none — read-only.

**Interfaces:**
- Consumes: nothing (first task).
- Produces: the two facts every later task's verification depends on — `BASELINE_TREE` (the git tree object id of the adapter directory on the base branch) and the confirmation that the working tree's adapter content is blob-for-blob identical to what `Jinn-Network/jinn-plugin` currently publishes.

- [x] **Step 1: Record the baseline tree object**

Run:

```bash
git rev-parse origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn
```

Expected: `1073efeda203601ea99fa90f93a340e6dc377dd2`.

If it differs, the frozen directory moved under the freeze since authoring. That is allowed (critical fixes only) — record the new value as `BASELINE_TREE` and use it everywhere below instead of the literal. Do not proceed with a stale literal.

- [x] **Step 2: Confirm the directory inventory is 21 files, no symlinks, three directories**

Run:

```bash
git ls-tree -r --name-only origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn | wc -l
git ls-tree -r origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn | awk '$1 != "100644" && $1 != "100755"'
```

Expected: `21`, then no output (no symlinks, no submodules, no gitlinks).

- [x] **Step 3: Prove the local content equals the published slim content, blob for blob**

Run:

```bash
diff \
  <(git ls-tree -r origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn \
      | awk '{print $3, $4}' | sort) \
  <(gh api 'repos/Jinn-Network/jinn-plugin/git/trees/main?recursive=1' \
      --jq '.tree[] | select(.type=="blob") | "\(.sha) \(.path)"' \
      | grep -v ' \.jinn-split-source$' | sort) \
  && echo "BASELINE MATCHES PUBLISHED CHANNEL"
```

Expected: no diff output, then `BASELINE MATCHES PUBLISHED CHANNEL`. (`.jinn-split-source` is the mirror's provenance marker, written at the slim root and kept by `DEFAULT_KEEP`; it has no mono counterpart.)

If this diff is non-empty, the base branch has adapter content that has not yet been promoted to `main`. That does not block the relocation, but it **weakens Task 9's live gate** — say so in the PR description and fall back to Task 9's offline half only.

- [x] **Step 4: Record the two verifier facts the relocation must preserve**

Run:

```bash
cat apps/jinn-agent/plugins/jinn/layer-runtime.json
node .github/scripts/verify-layer-stable-version.mjs --root . --version 0.1.2
```

Expected:

```
{
  "package": "@jinn-network/jinn-layer",
  "version": "0.1.2",
  "bin": "runtime/node_modules/.bin/jinn-layer"
}
layer stable release check: coherent 0.1.2 package and runtime pins
```

- [x] **Step 5: Record the fork-side consumer census (the symlink's justification)**

Run:

```bash
grep -rl "plugins\.jinn\|plugins/jinn" apps/jinn-agent/tests apps/jinn-agent/scripts apps/jinn-agent/hermes_cli | wc -l
grep -n "plugins.jinn" apps/jinn-agent/hermes_cli/banner.py
```

Expected: `36`, and `907:        from plugins.jinn import jinn_layer`.

That second line is the load-bearing one: the fork's **production** code imports the adapter as a Python package rooted at `apps/jinn-agent/`. Re-pointing 36 call sites in a tree scheduled for deletion is neither mechanical nor a freeze-permitted edit, which is why Task 2 leaves a symlink.

---

### Task 2: Relocate the directory, then restore the fork with one symlink

**Files:**
- Move: `apps/jinn-agent/plugins/jinn/**` → `plugin/frozen/**` (21 files)
- Create: `apps/jinn-agent/plugins/jinn` (symlink, mode 120000)

**Interfaces:**
- Consumes: `BASELINE_TREE` (Task 1).
- Produces: the canonical frozen home `plugin/frozen/`, whose git tree object equals `BASELINE_TREE`; the runtime pin at `plugin/frozen/layer-runtime.json`; and the compatibility shim `apps/jinn-agent/plugins/jinn → ../../../plugin/frozen`, which every Task 3–8 re-point must be provably independent of (Task 10).

- [x] **Step 1: Move the directory**

Run:

```bash
mkdir -p plugin
git mv apps/jinn-agent/plugins/jinn plugin/frozen
git status --porcelain | head -30
```

Expected: 21 `R  apps/jinn-agent/plugins/jinn/... -> plugin/frozen/...` lines (git may render them as paired `D`/`A` until commit; either is fine — Step 3 is the real check).

- [x] **Step 2: Observe the fork break — this is the red phase**

Run:

```bash
(cd apps/jinn-agent && python3 -c "import importlib.util,sys; sys.path.insert(0,'.'); print(importlib.util.find_spec('plugins.jinn'))")
test -f apps/jinn-agent/plugins/jinn/pyproject.toml && echo PRESENT || echo MISSING
```

Expected: `None`, then `MISSING`. The fork's production import (`hermes_cli/banner.py:907`), its bundled-plugin loader (`hermes_cli/plugins.py:65`, `get_bundled_plugins_dir()` = `<repo>/plugins`), and 34 in-fork test files are all broken at this instant. That is the fact the shim exists to answer.

- [x] **Step 3: Verify the moved content is byte-identical (pre-commit)**

Compare the base tree against the staged index, mode by mode and blob by blob. (The authoritative single-hash check — tree-object equality — needs a commit and lands in Step 7.)

Run:

```bash
diff \
  <(git ls-tree -r origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn | awk '{print $1, $3, $4}' | sort) \
  <(git ls-files -s plugin/frozen | sed 's|plugin/frozen/||' | awk '{print $1, $2, $4}' | sort) \
  && echo "CONTENT IDENTICAL"
```

Expected: no diff output, then `CONTENT IDENTICAL`. Modes, blob ids, and relative paths all match.

- [x] **Step 4: Add the compatibility shim**

Run:

```bash
ln -s ../../../plugin/frozen apps/jinn-agent/plugins/jinn
git add apps/jinn-agent/plugins/jinn
git ls-files -s apps/jinn-agent/plugins/jinn
readlink apps/jinn-agent/plugins/jinn
```

Expected: a line beginning `120000` for `apps/jinn-agent/plugins/jinn`, and `../../../plugin/frozen`.

(Directory symlinks are an established pattern in this repository — 179 are already tracked, e.g. `.codex/skills/eng-day → ../../.claude/skills/eng-day`. The fork's bundled-plugin scan at `hermes_cli/plugins.py:1484-1485` uses `iterdir()` + `is_dir()`, which follow symlinks and reject nothing.)

- [x] **Step 5: Verify the fork is green again**

Run:

```bash
(cd apps/jinn-agent && python3 -c "import importlib.util,sys; sys.path.insert(0,'.'); print(importlib.util.find_spec('plugins.jinn').origin)")
test -f apps/jinn-agent/plugins/jinn/pyproject.toml && echo PRESENT || echo MISSING
test -f apps/jinn-agent/plugins/jinn/layer-runtime.json && echo PIN-PRESENT || echo PIN-MISSING
```

Expected: a path ending `apps/jinn-agent/plugins/jinn/__init__.py`, then `PRESENT`, then `PIN-PRESENT`.

(`find_spec` locates without executing, so this needs none of the fork's Python dependencies. It exercises exactly the machinery `hermes_cli/banner.py:907` and `tests/plugins/test_jinn_*.py` rely on.)

- [x] **Step 6: Commit**

```bash
git add -A plugin/frozen apps/jinn-agent/plugins
git commit -m "chore(plugin): relocate the frozen Hermes adapter to plugin/frozen

Content-unchanged relocation permitted under the freeze (spec §4.1). The fork
keeps loading the adapter through a symlink at the old path until #2294 removes
apps/jinn-agent."
```

- [x] **Step 7: Prove tree identity against the base**

Run:

```bash
test "$(git rev-parse HEAD:plugin/frozen)" = "$(git rev-parse origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn)" \
  && echo "TREE IDENTITY PROVEN: $(git rev-parse HEAD:plugin/frozen)"
git cat-file -t HEAD:apps/jinn-agent/plugins/jinn
git diff -M --summary origin/integration/evidence-v1...HEAD
```

Expected: `TREE IDENTITY PROVEN: 1073efeda203601ea99fa90f93a340e6dc377dd2`; then `blob`; then 21 `rename apps/jinn-agent/plugins/jinn/{...} => plugin/frozen/{...} (100%)` lines plus exactly one `create mode 120000 apps/jinn-agent/plugins/jinn`. Nothing else.

---

### Task 3: Re-point the lockstep verifier (#2294 item 2)

**Files:**
- Modify: `.github/scripts/layer-publish-workflow.test.mjs:65`
- Modify: `.github/scripts/verify-layer-stable-version.mjs:58`

**Interfaces:**
- Consumes: `plugin/frozen/layer-runtime.json` (Task 2).
- Produces: `verify-layer-stable-version.mjs` reading its runtime pin from `plugin/frozen/layer-runtime.json`. Its CLI contract is unchanged: `node .github/scripts/verify-layer-stable-version.mjs --root <dir> --version <x.y.z>`, exit 0 on a coherent four-way lockstep (`packages/plugin`, `packages/core`, `packages/layer`, and the runtime pin all at `<x.y.z>`, with `bin === 'runtime/node_modules/.bin/jinn-layer'`), exit 1 with `layer stable release check failed: …` otherwise. Consumed by `.github/workflows/layer-npm-publish.yml:226`.

This task has a genuine red phase: the test builds its fixture in a fresh temp directory, so no symlink can mask the path change.

- [x] **Step 1: Move the test fixture to the new path (failing test first)**

In `.github/scripts/layer-publish-workflow.test.mjs`, replace:

```js
  writeJson(
    resolve(fixture, 'apps/jinn-agent/plugins/jinn/layer-runtime.json'),
```

with:

```js
  writeJson(
    resolve(fixture, 'plugin/frozen/layer-runtime.json'),
```

- [x] **Step 2: Run the test to verify it fails**

Run: `node --test .github/scripts/layer-publish-workflow.test.mjs`

Expected: FAIL — the verifier subprocess exits 1 with `layer stable release check failed: cannot read apps/jinn-agent/plugins/jinn/layer-runtime.json: ENOENT…`, so the "accepts a coherent release" assertion fails.

- [x] **Step 3: Re-point the verifier**

In `.github/scripts/verify-layer-stable-version.mjs`, replace:

```js
  const runtime = readJson('apps/jinn-agent/plugins/jinn/layer-runtime.json');
```

with:

```js
  const runtime = readJson('plugin/frozen/layer-runtime.json');
```

- [x] **Step 4: Run the test to verify it passes**

Run:

```bash
node --test .github/scripts/layer-publish-workflow.test.mjs
node .github/scripts/verify-layer-stable-version.mjs --root . --version 0.1.2
```

Expected: all tests pass; then `layer stable release check: coherent 0.1.2 package and runtime pins`.

- [x] **Step 5: Commit**

```bash
git add .github/scripts/verify-layer-stable-version.mjs .github/scripts/layer-publish-workflow.test.mjs
git commit -m "chore(plugin): read the layer runtime pin from plugin/frozen"
```

---

### Task 4: Re-point the layer package-contract test

**Files:**
- Modify: `packages/layer/test/architecture/package-contract.test.ts:29-39`

**Interfaces:**
- Consumes: `plugin/frozen/layer-runtime.json` (Task 2).
- Produces: nothing new — this is the in-package assertion that `packages/layer/package.json`'s `version` equals the runtime pin's `version`, i.e. the same four-way lockstep the verifier enforces, checked from the layer's own test suite.

This consumer is **not listed in the program plan's C0 row** (Finding F1). It currently passes through the shim, which is precisely the hazard: it would keep passing until #2294 deletes the fork, then break in an unrelated PR. The red phase below is the shim-aside rehearsal, which is the honest test of whether the re-point is load-bearing.

- [x] **Step 1: Park the shim and observe the failure**

Run:

```bash
mv apps/jinn-agent/plugins/jinn /tmp/c0-shim-parked
(cd packages/layer && yarn install --immutable && yarn vitest run test/architecture/package-contract.test.ts)
```

Expected: FAIL — `ENOENT: no such file or directory, open '…/apps/jinn-agent/plugins/jinn/layer-runtime.json'` in the test `pins the plugin-local runtime contract to this exact package version`.

- [x] **Step 2: Re-point the test**

In `packages/layer/test/architecture/package-contract.test.ts`, replace:

```ts
        resolve(repoRoot, 'apps/jinn-agent/plugins/jinn/layer-runtime.json'),
```

with:

```ts
        resolve(repoRoot, 'plugin/frozen/layer-runtime.json'),
```

- [x] **Step 3: Run the test with the shim still parked, to verify it passes on the real path**

Run: `(cd packages/layer && yarn vitest run test/architecture/package-contract.test.ts)`

Expected: PASS (3 tests). Passing while the shim is absent proves the test now reads the relocated file, not the symlink.

- [x] **Step 4: Restore the shim and re-run**

Run:

```bash
mv /tmp/c0-shim-parked apps/jinn-agent/plugins/jinn
git status --porcelain apps/jinn-agent/plugins/jinn        # must print nothing
(cd packages/layer && yarn vitest run test/architecture/package-contract.test.ts)
```

Expected: no git output (the symlink is back exactly as committed), then PASS.

- [x] **Step 5: Commit**

```bash
git add packages/layer/test/architecture/package-contract.test.ts
git commit -m "chore(plugin): point the layer package-contract test at plugin/frozen"
```

---

### Task 5: Re-point the mirror helper and its offline suite (#2294 item 1, part 1)

**Files:**
- Modify: `.github/scripts/jinn-plugin-split.mjs` (header comment, `buildCommitMessage`, CLI default `PLUGIN_DIR`, one new clarifying comment)
- Modify: `.github/scripts/jinn-plugin-split.test.mjs:206`

**Interfaces:**
- Consumes: `plugin/frozen/` (Task 2).
- Produces: the mirror helper's unchanged exported surface — `validatePluginDir(pluginDirPath)`, `validateMonoSha(monoSha)`, `validateMirrorDestination(pluginDir, slimCheckout)`, `mirrorContent(pluginDir, slimCheckout, {keep})`, `writeProvenance(slimCheckout, {monoSha, workflowPath})`, `inspectProvenance(slimCheckout, workflowPath)`, `treeChanged(slimCheckout)`, `buildCommitMessage({monoSha})`, `run({pluginDir, slimDir, monoSha, workflowPath}) → {changed, message}` — with two string constants changed: the default `PLUGIN_DIR` is now `plugin/frozen`, and the commit-message subject now names `plugin/frozen`. **The provenance file contract is untouched**: `writeProvenance` still emits exactly `source: Jinn-Network/mono@<sha>\ngenerated-by: <workflowPath>\n`, so the mirrored tree is unchanged.

- [x] **Step 1: Update the expected commit message (failing test first)**

In `.github/scripts/jinn-plugin-split.test.mjs`, replace:

```js
      'chore(plugin-split): mirror apps/jinn-agent/plugins/jinn @ abc123',
```

with:

```js
      'chore(plugin-split): mirror plugin/frozen @ abc123',
```

**Do not touch line 305** (`'DO NOT EDIT HERE — edit apps/jinn-agent/plugins/jinn/ in Jinn-Network/mono.'`) — that string is the historical legacy-marker contract, tested by `(g) run repairs a legacy provenance marker`.

- [x] **Step 2: Run the suite to verify it fails**

Run: `node --test .github/scripts/jinn-plugin-split.test.mjs`

Expected: FAIL — 1 of 19, `(e) buildCommitMessage produces the canonical string from the mono SHA`, with the actual string still naming `apps/jinn-agent/plugins/jinn`.

- [x] **Step 3: Update `buildCommitMessage`**

In `.github/scripts/jinn-plugin-split.mjs`, replace:

```js
    `chore(plugin-split): mirror apps/jinn-agent/plugins/jinn @ ${monoSha}`,
```

with:

```js
    `chore(plugin-split): mirror plugin/frozen @ ${monoSha}`,
```

- [x] **Step 4: Run the suite to verify it passes**

Run: `node --test .github/scripts/jinn-plugin-split.test.mjs`

Expected: PASS — 19/19.

- [x] **Step 5: Update the CLI default and the header comment**

In `.github/scripts/jinn-plugin-split.mjs`, replace:

```js
  const pluginDir = process.env.PLUGIN_DIR ?? 'apps/jinn-agent/plugins/jinn';
```

with:

```js
  const pluginDir = process.env.PLUGIN_DIR ?? 'plugin/frozen';
```

and replace the header lines:

```js
// Purpose: mirror `apps/jinn-agent/plugins/jinn/` (in Jinn-Network/mono) to the
// ROOT of the slim release repo `Jinn-Network/jinn-plugin` so that
```

with:

```js
// Purpose: mirror `plugin/frozen/` (in Jinn-Network/mono) to the
// ROOT of the slim release repo `Jinn-Network/jinn-plugin` so that
```

- [x] **Step 6: Fence the legacy marker so a later reader does not "fix" it**

In `.github/scripts/jinn-plugin-split.mjs`, replace:

```js
  const knownLegacy =
    lines.length === 3 &&
```

with:

```js
  // The legacy third line is a HISTORICAL contract: it is the exact text an
  // earlier workflow generation wrote into the slim repo. It names the adapter's
  // pre-relocation path on purpose and must never be re-pointed.
  const knownLegacy =
    lines.length === 3 &&
```

- [x] **Step 7: Verify the helper's default resolves and the suite is still green**

Run:

```bash
node -e "import('./.github/scripts/jinn-plugin-split.mjs').then(m => console.log(m.validatePluginDir('plugin/frozen')))"
node --test .github/scripts/jinn-plugin-split.test.mjs
```

Expected: `plugin/frozen`; then 19/19 pass.

- [x] **Step 8: Commit**

```bash
git add .github/scripts/jinn-plugin-split.mjs .github/scripts/jinn-plugin-split.test.mjs
git commit -m "chore(plugin): mirror the frozen adapter from plugin/frozen"
```

---

### Task 6: Re-point the mirror workflow (#2294 item 1, part 2)

**Files:**
- Modify: `.github/workflows/jinn-plugin-split.yml` (header comments at lines 4-5 and 25-27; `PLUGIN_DIR` env at line 94)

**Interfaces:**
- Consumes: `plugin/frozen/` (Task 2); the helper's env contract (Task 5) — `PLUGIN_DIR`, `SLIM_DIR`, `MONO_SHA`, `WORKFLOW_PATH`, and the emitted `$GITHUB_OUTPUT` key `changed`.
- Produces: `PLUGIN_DIR: mono/plugin/frozen` in the mirror step. `WORKFLOW_PATH` stays `.github/workflows/jinn-plugin-split.yml`, so the `generated-by:` provenance line — and therefore the published tree — is unchanged.

- [x] **Step 1: Re-point `PLUGIN_DIR`**

In `.github/workflows/jinn-plugin-split.yml`, replace:

```yaml
          PLUGIN_DIR: mono/apps/jinn-agent/plugins/jinn
```

with:

```yaml
          PLUGIN_DIR: mono/plugin/frozen
```

- [x] **Step 2: Re-point the two header comments**

Replace:

```yaml
# WHAT: On each Monday `main` promote (and on plugin hotfixes that land on
# `main`), mirror `apps/jinn-agent/plugins/jinn/` to the ROOT of the slim
```

with:

```yaml
# WHAT: On each Monday `main` promote (and on plugin hotfixes that land on
# `main`), mirror `plugin/frozen/` to the ROOT of the slim
```

and replace:

```yaml
# EDIT IN MONO, NOT HERE: the slim repo is generated. The source of truth is the
# plugin dir in Jinn-Network/mono. Never hand-edit the slim repo — it is
# overwritten on the next promote.
```

with:

```yaml
# EDIT IN MONO, NOT HERE: the slim repo is generated. The source of truth is
# `plugin/frozen/` in Jinn-Network/mono. Never hand-edit the slim repo — it is
# overwritten on the next promote. That directory is FROZEN (spec §4.1): critical
# fixes only, and nothing may be added to it, because every file in it is
# published to the root of Jinn-Network/jinn-plugin.
```

- [x] **Step 3: Verify the workflow parses and its safety assertions still hold**

Run:

```bash
python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/jinn-plugin-split.yml')); print(d['jobs']['split']['steps'][4]['env'])"
node --test .github/scripts/jinn-plugin-split.test.mjs
grep -c "secrets.JINN_PLUGIN_PUSH_TOKEN" .github/workflows/jinn-plugin-split.yml
```

Expected: an env dict containing `'PLUGIN_DIR': 'mono/plugin/frozen'`; 19/19 pass (test `(l)` re-reads this YAML); `2`.

- [x] **Step 4: Commit**

```bash
git add .github/workflows/jinn-plugin-split.yml
git commit -m "chore(plugin): point the plugin split workflow at plugin/frozen"
```

---

### Task 7: Re-point the cold-stock product gate (#2294 item 3, partial)

**Files:**
- Modify: `apps/jinn-agent/scripts/cold-stock-e2e.sh:86`
- Modify: `.github/workflows/jinn-agent-ci.yml` (`on.pull_request.paths` and `on.push.paths`)

**Interfaces:**
- Consumes: `plugin/frozen/` (Task 2). The script already defines `REPO_ROOT="$(cd "$HERE/../.." && pwd)"` at line 8 and uses it for `PLUGIN`/`CORE`/`LAYER`, so no new variable is needed.
- Produces: a cold-stock gate that builds its adapter wheel from `$REPO_ROOT/plugin/frozen` and a `jinn-agent-ci.yml` whose path filters fire on `plugin/frozen/**` as well as `apps/jinn-agent/**`.

**Scope note:** the program plan's C0 row says *re-point* the cold-stock gate. Fully **re-homing** it (moving `cold-stock-e2e.sh` and its 1,072-line driver `stage1-stock-product.py` out of the fork) stays with #2294, per spec §4.2: "its removal ordering is entangled with #2294 item 3 — the cold-stock gate re-homes or retires with the fork." See Finding F4.

- [x] **Step 1: Re-point the wheel source**

In `apps/jinn-agent/scripts/cold-stock-e2e.sh`, replace:

```bash
python3 -m pip wheel --no-deps --wheel-dir "$WORK/wheels" "$HERE/plugins/jinn"
```

with:

```bash
python3 -m pip wheel --no-deps --wheel-dir "$WORK/wheels" "$REPO_ROOT/plugin/frozen"
```

- [x] **Step 2: Add `plugin/frozen/**` to both path filters**

In `.github/workflows/jinn-agent-ci.yml`, in the `on.pull_request.paths` list, replace:

```yaml
      - 'apps/jinn-agent/**'
      - 'packages/plugin/**'
      - 'packages/core/**'
      - 'packages/layer/**'
      - 'client/src/solver-types/_swe-rebench-v2-*.ts'
      - 'client/src/adapters/mech/ipfs.ts'
      - 'client/src/harnesses/impls/swe-rebench-v2-evaluator/**'
      - 'client/scripts/stage1-task-creator-acceptance.mjs'
      - 'client/package.json'
      - 'client/yarn.lock'
      - '.github/workflows/jinn-agent-ci.yml'
  push:
```

with:

```yaml
      - 'apps/jinn-agent/**'
      - 'plugin/frozen/**'
      - 'packages/plugin/**'
      - 'packages/core/**'
      - 'packages/layer/**'
      - 'client/src/solver-types/_swe-rebench-v2-*.ts'
      - 'client/src/adapters/mech/ipfs.ts'
      - 'client/src/harnesses/impls/swe-rebench-v2-evaluator/**'
      - 'client/scripts/stage1-task-creator-acceptance.mjs'
      - 'client/package.json'
      - 'client/yarn.lock'
      - '.github/workflows/jinn-agent-ci.yml'
  push:
```

Then, in the `on.push.paths` list, replace:

```yaml
      - 'apps/jinn-agent/**'
      - 'packages/plugin/**'
      - 'packages/core/**'
      - 'packages/layer/**'
      - 'client/src/solver-types/_swe-rebench-v2-*.ts'
      - 'client/src/adapters/mech/ipfs.ts'
      - 'client/src/harnesses/impls/swe-rebench-v2-evaluator/**'
      - 'client/scripts/stage1-task-creator-acceptance.mjs'
      - 'client/package.json'
      - 'client/yarn.lock'
      - '.github/workflows/jinn-agent-ci.yml'
  workflow_dispatch:
```

with:

```yaml
      - 'apps/jinn-agent/**'
      - 'plugin/frozen/**'
      - 'packages/plugin/**'
      - 'packages/core/**'
      - 'packages/layer/**'
      - 'client/src/solver-types/_swe-rebench-v2-*.ts'
      - 'client/src/adapters/mech/ipfs.ts'
      - 'client/src/harnesses/impls/swe-rebench-v2-evaluator/**'
      - 'client/scripts/stage1-task-creator-acceptance.mjs'
      - 'client/package.json'
      - 'client/yarn.lock'
      - '.github/workflows/jinn-agent-ci.yml'
  workflow_dispatch:
```

- [x] **Step 3: Verify syntax and the in-fork static contract on the gate**

Run:

```bash
bash -n apps/jinn-agent/scripts/cold-stock-e2e.sh && echo "SHELL SYNTAX OK"
python3 -c "
import yaml
d = yaml.safe_load(open('.github/workflows/jinn-agent-ci.yml'))
t = d[True]
for k in ('pull_request','push'):
    assert 'plugin/frozen/**' in t[k]['paths'], k
    assert 'apps/jinn-agent/**' in t[k]['paths'], k
    assert 'packages/layer/**' in t[k]['paths'], k
print('PATH FILTERS OK')
print(d['jobs']['cold-stock-e2e']['name'])
"
grep -n 'plugin/frozen\|REPO_ROOT=' apps/jinn-agent/scripts/cold-stock-e2e.sh
```

Expected: `SHELL SYNTAX OK`; `PATH FILTERS OK`; `Cold-stock Stage 1 product gate`; and the two grep hits at lines 8 and 86.

(The in-fork static contract `apps/jinn-agent/tests/plugins/test_jinn_stage1_acceptance_gate.py` asserts membership only — `assert "apps/jinn-agent/**" in pull_request_paths` etc. — so additions are safe. It also asserts on the script body via `in` checks for `pip wheel`, `PLUGIN="$REPO_ROOT/packages/plugin"`, `stage1-stock-product.py` and `stage1-task-creator-acceptance.mjs`, none of which this edit touches.)

- [x] **Step 4: Verify the wheel builds from the new path**

Run:

```bash
python3 -m pip wheel --no-deps --wheel-dir /tmp/c0-wheel plugin/frozen \
  && ls /tmp/c0-wheel/jinn_plugin-*.whl && rm -rf /tmp/c0-wheel
```

Expected: a built `jinn_plugin-0.1.0-py3-none-any.whl`. This exercises `plugin/frozen/pyproject.toml`'s `package-dir = {"jinn_plugin" = "."}` from the relocated root — the exact step the gate performs.

If `pip wheel` is unavailable locally, skip and record that the gate's own CI run is the verification; do not mark this step done on assumption.

- [x] **Step 5: Commit**

```bash
git add apps/jinn-agent/scripts/cold-stock-e2e.sh .github/workflows/jinn-agent-ci.yml
git commit -m "chore(plugin): build the cold-stock wheel from plugin/frozen"
```

---

### Task 8: Re-point the published-artifacts-smoke path guard

**Files:**
- Modify: `.github/scripts/published-artifacts-smoke-workflow.test.mjs:115`

**Interfaces:**
- Consumes: nothing from earlier tasks; this is a negative guard.
- Produces: an assertion that the published-artifacts smoke workflow reaches into **neither** adapter path — it must install only from the published channels (`hermes plugins install Jinn-Network/jinn-plugin --enable`), never from the in-repo tree.

- [x] **Step 1: Strengthen the guard**

In `.github/scripts/published-artifacts-smoke-workflow.test.mjs`, replace:

```js
  assert.doesNotMatch(workflow, /apps\/jinn-agent\/plugins\/jinn/);
```

with:

```js
  assert.doesNotMatch(workflow, /apps\/jinn-agent\/plugins\/jinn/);
  assert.doesNotMatch(workflow, /plugin\/frozen/);
```

- [x] **Step 2: Run the suite**

Run: `node --test .github/scripts/published-artifacts-smoke-workflow.test.mjs`

Expected: PASS. (The smoke workflow installs from the published channel only, so both assertions hold; the second is what keeps that true after the relocation.)

- [x] **Step 3: Commit**

```bash
git add .github/scripts/published-artifacts-smoke-workflow.test.mjs
git commit -m "chore(plugin): forbid the smoke workflow from reaching into plugin/frozen"
```

---

### Task 9: The bit-identical mirror gate

**Files:**
- Create (untracked, scratch only): `/tmp/c0-mirror-gate.sh`

**Interfaces:**
- Consumes: `plugin/frozen/` (Task 2); `.github/scripts/jinn-plugin-split.mjs`'s CLI env contract (Task 5) — `PLUGIN_DIR`, `SLIM_DIR`, `MONO_SHA`, `WORKFLOW_PATH`; and `run()`'s `changed` semantics (`contentChanged || !provenance.canonical`).
- Produces: the C0 acceptance gate — evidence that the relocated mirror, run against a clone of the live `Jinn-Network/jinn-plugin` head, leaves that repository's tree and HEAD untouched and reports `changed=false`.

This is the program plan §6 gate for C0, made runnable. It is stronger than a tree-hash comparison because it exercises the real helper end to end: validation, destructive `mirrorContent`, `git add -A`, the `treeChanged` oracle, and the provenance-canonicality branch. **`changed=false` means the mirror would produce no new slim commit at all** — the strictest possible statement of "bit-identical to today's."

The gate script is deliberately **not committed**: it pins a live external head and would rot. Its output goes in the PR description.

- [ ] **Step 1: Write the gate script**

Create `/tmp/c0-mirror-gate.sh`:

```bash
#!/usr/bin/env bash
# C0 acceptance gate: the relocated mirror leaves the published slim repo untouched.
# Run from the mono repo root on the C0 branch. Not committed — it pins a live head.
set -euo pipefail

MONO="$PWD"
test -f "$MONO/plugin/frozen/plugin.yaml" || { echo "not at the mono root, or plugin/frozen is missing" >&2; exit 2; }

# The mirror copies the WHOLE directory, including files git ignores. The frozen
# adapter's own .gitignore excludes `runtime/`, which a local `hermes plugins`
# run creates — that would be published. Refuse to run against a dirty source.
EXTRA="$(git -C "$MONO" status --porcelain --ignored -- plugin/frozen)"
test -z "$EXTRA" || { echo "FAIL: plugin/frozen carries untracked or ignored files:" >&2; echo "$EXTRA" >&2; exit 1; }

GATE="${C0_GATE_DIR:-$(mktemp -d)}"
# Set C0_GATE_KEEP=1 to keep the slim clone for diagnosis.
if [ -z "${C0_GATE_KEEP:-}" ]; then trap 'rm -rf "$GATE"' EXIT; else echo "keeping $GATE"; fi

rm -rf "$GATE/slim"
git clone --quiet --depth 1 --branch main https://github.com/Jinn-Network/jinn-plugin.git "$GATE/slim"
git -C "$GATE/slim" config user.name  "c0-gate"
git -C "$GATE/slim" config user.email "c0-gate@localhost"

BEFORE_HEAD="$(git -C "$GATE/slim" rev-parse HEAD)"
BEFORE_TREE="$(git -C "$GATE/slim" rev-parse 'HEAD^{tree}')"
echo "published head : $BEFORE_HEAD"
echo "published tree : $BEFORE_TREE"

PLUGIN_DIR="$MONO/plugin/frozen" \
SLIM_DIR="$GATE/slim" \
MONO_SHA="$(git -C "$MONO" rev-parse HEAD)" \
WORKFLOW_PATH=".github/workflows/jinn-plugin-split.yml" \
  node "$MONO/.github/scripts/jinn-plugin-split.mjs"

AFTER_HEAD="$(git -C "$GATE/slim" rev-parse HEAD)"
AFTER_TREE="$(git -C "$GATE/slim" rev-parse 'HEAD^{tree}')"
DIRTY="$(git -C "$GATE/slim" status --porcelain)"

test "$AFTER_TREE" = "$BEFORE_TREE" || { echo "FAIL: slim tree changed ($BEFORE_TREE -> $AFTER_TREE)" >&2; exit 1; }
test "$AFTER_HEAD" = "$BEFORE_HEAD" || { echo "FAIL: the mirror created a commit ($AFTER_HEAD)" >&2; exit 1; }
test -z "$DIRTY"                    || { echo "FAIL: slim working tree dirty:" >&2; echo "$DIRTY" >&2; exit 1; }

echo "MIRROR BIT-IDENTITY GATE PASS  tree=$AFTER_TREE  head=$AFTER_HEAD"
```

- [ ] **Step 2: Run the gate**

Run: `bash /tmp/c0-mirror-gate.sh`

Expected, in order:

```
published head : 83ababfca6b194f79a78401626602edac5ca325b
published tree : <tree sha>
changed=false
::notice::slim tree unchanged — idempotent no-op
MIRROR BIT-IDENTITY GATE PASS  tree=<tree sha>  head=83ababfca6b194f79a78401626602edac5ca325b
```

The head sha will differ if the slim repo has been promoted since authoring; that is fine. The two things that must hold are `changed=false` and `GATE PASS`.

**If it prints `changed=true`:** do not weaken the gate. `run()` sets `changed = contentChanged || !provenance.canonical`, so exactly one of two causes fired. Diagnose both:

```bash
# (a) content difference — the relocation is not byte-identical, or the base branch
#     carries adapter content that has not yet been promoted to main:
git ls-tree -r HEAD:plugin/frozen | awk '{print $3, $4}' | sort > /tmp/c0-mono.txt
gh api 'repos/Jinn-Network/jinn-plugin/git/trees/main?recursive=1' \
  --jq '.tree[] | select(.type=="blob") | "\(.sha) \(.path)"' \
  | grep -v ' \.jinn-split-source$' | sort > /tmp/c0-slim.txt
diff /tmp/c0-mono.txt /tmp/c0-slim.txt

# (b) provenance non-canonicality — the published marker is legacy or malformed.
#     Re-run the gate keeping the clone, then read the marker:
C0_GATE_KEEP=1 C0_GATE_DIR=/tmp/c0-gate bash /tmp/c0-mirror-gate.sh || true
cat /tmp/c0-gate/slim/.jinn-split-source
```

A canonical marker is exactly two lines — `source: Jinn-Network/mono@<40 hex>` then `generated-by: .github/workflows/jinn-plugin-split.yml`. Cause (b) is not a C0 defect: it means the next promote will rewrite the marker once, which changes no adapter bytes. Say so in the PR and treat cause (a) as the only blocking outcome.

A content diff that matches Task 1 Step 3's recorded delta is the base-ahead-of-`main` case (expected, not a C0 defect): record it in the PR description and fall back to the offline half — `git rev-parse HEAD:plugin/frozen` equals `BASELINE_TREE` (Task 2 Step 7). A content diff that does **not** match Task 1's is a freeze violation: stop and fix.

- [ ] **Step 3: Run the offline half of the gate too, so the PR carries both**

Run:

```bash
test "$(git rev-parse HEAD:plugin/frozen)" = "$(git rev-parse origin/integration/evidence-v1:apps/jinn-agent/plugins/jinn)" \
  && echo "OFFLINE TREE IDENTITY PASS: $(git rev-parse HEAD:plugin/frozen)"
```

Expected: `OFFLINE TREE IDENTITY PASS: 1073efeda203601ea99fa90f93a340e6dc377dd2`.

- [ ] **Step 4: No commit**

Nothing to commit — the gate is evidence, not code. Capture both outputs for the PR description.

---

### Task 10: The post-#2294 rehearsal, the freeze proof, and the PR

**Files:** none — verification and the pull request.

**Interfaces:**
- Consumes: every re-point from Tasks 3–8; the shim from Task 2.
- Produces: proof that **every** re-pointed consumer works with the shim absent — i.e. that #2294's deletion of `apps/jinn-agent` (which takes the symlink with it) breaks nothing outside the fork.

- [ ] **Step 1: Confirm no consumer still names the old path**

Run:

```bash
grep -rn "apps/jinn-agent/plugins/jinn" \
  .github/ packages/ client/ apps/jinn-agent/scripts/ apps/jinn-agent/hermes_cli/ \
  | grep -v 'DO NOT EDIT HERE'
```

Expected: no output.

(The `DO NOT EDIT HERE` exclusion covers the two intentional historical-marker sites: `.github/scripts/jinn-plugin-split.mjs:192` and `.github/scripts/jinn-plugin-split.test.mjs:305`. Dated design documents under `docs/` and `spec/` are **not** re-pointed — they are historical records under the American-English/dated-document rule and describe the pre-relocation world truthfully.)

- [ ] **Step 2: Park the shim and run every re-pointed check**

Run:

```bash
mv apps/jinn-agent/plugins/jinn /tmp/c0-shim-parked

node .github/scripts/verify-layer-stable-version.mjs --root . --version 0.1.2
node --test .github/scripts/layer-publish-workflow.test.mjs
node --test .github/scripts/jinn-plugin-split.test.mjs
node --test .github/scripts/published-artifacts-smoke-workflow.test.mjs
(cd packages/layer && yarn vitest run test/architecture/package-contract.test.ts)
bash -n apps/jinn-agent/scripts/cold-stock-e2e.sh && echo "SHELL SYNTAX OK"
bash /tmp/c0-mirror-gate.sh

mv /tmp/c0-shim-parked apps/jinn-agent/plugins/jinn
git status --porcelain
```

Expected: the coherence line; four green `node --test` suites; 3 passing vitest tests; `SHELL SYNTAX OK`; `MIRROR BIT-IDENTITY GATE PASS`; and finally **empty** `git status --porcelain` (the shim restored byte-identically).

This is the answer to "what breaks when #2294 lands": nothing outside `apps/jinn-agent` itself.

- [ ] **Step 3: Prove the fork still works with the shim in place**

Run:

```bash
(cd apps/jinn-agent && python3 -c "import importlib.util,sys; sys.path.insert(0,'.'); print(importlib.util.find_spec('plugins.jinn').origin)")
python3 -c "
from pathlib import Path
for p in ['pyproject.toml','README.md','layer-runtime.json','plugin.yaml','skin/jinn.yaml','soul/SOUL.md']:
    q = Path('apps/jinn-agent/plugins/jinn')/p
    assert q.is_file(), q
print('FORK SHIM OK')
"
```

Expected: a path ending `apps/jinn-agent/plugins/jinn/__init__.py`, then `FORK SHIM OK`. These are exactly the paths `tests/plugins/test_jinn_packaging.py:7,12` and the bundled loader use.

(The fork's full pytest suite runs in CI: the `jinn-agent CI` workflow triggers on `apps/jinn-agent/**`, which this branch touches, and the four test slices cover `tests/plugins/test_jinn_*.py`. Do not attempt the full `uv sync` locally; let CI be the gate and check it before requesting review.)

- [ ] **Step 4: The freeze proof — a pure-rename diff**

Run:

```bash
git diff -M --summary origin/integration/evidence-v1...HEAD -- plugin/frozen apps/jinn-agent/plugins
git diff origin/integration/evidence-v1...HEAD --stat -- plugin/frozen
```

Expected: 21 `rename apps/jinn-agent/plugins/jinn/{…} => plugin/frozen/{…} (100%)` lines and exactly one `create mode 120000 apps/jinn-agent/plugins/jinn`; then a `--stat` showing **zero insertions and zero deletions** for `plugin/frozen`.

Paste both into the PR description under a heading "Freeze proof (pure renames)". A reviewer confirms the freeze by reading these two outputs plus the tree-identity line from Task 9 Step 3 — no file-by-file reading required.

- [ ] **Step 5: Full branch diff review**

Run: `git diff origin/integration/evidence-v1...HEAD --stat`

Expected: the 21 renames, the one symlink, and exactly nine modified files:

```
.github/scripts/jinn-plugin-split.mjs
.github/scripts/jinn-plugin-split.test.mjs
.github/scripts/layer-publish-workflow.test.mjs
.github/scripts/published-artifacts-smoke-workflow.test.mjs
.github/scripts/verify-layer-stable-version.mjs
.github/workflows/jinn-agent-ci.yml
.github/workflows/jinn-plugin-split.yml
apps/jinn-agent/scripts/cold-stock-e2e.sh
packages/layer/test/architecture/package-contract.test.ts
```

Anything else means scope crept — remove it.

- [ ] **Step 6: Push and open the PR against the base branch**

```bash
git push -u origin plugin/c0-adapter-relocation
gh pr create \
  --base integration/evidence-v1 \
  --head plugin/c0-adapter-relocation \
  --title "chore(plugin): relocate the frozen Hermes adapter to plugin/frozen" \
  --body-file /tmp/c0-pr-body.md
```

The PR body must carry, in this order:

1. **What this is** — a content-unchanged relocation permitted under spec §4.1; discharges #2294 checklist items 1 and 2, and re-points (but does not re-home) item 3.
2. **Freeze proof** — the Task 10 Step 4 outputs and the Task 9 Step 3 tree-identity line.
3. **Mirror bit-identity gate** — the Task 9 Step 2 output, including `changed=false`.
4. **Post-#2294 rehearsal** — the Task 10 Step 2 output (every check green with the shim parked).
5. **The shim, stated plainly** — why `apps/jinn-agent/plugins/jinn` is now a symlink, what it protects (`hermes_cli/banner.py:907`, the bundled-plugin loader, 34 in-fork test files), and that it is deleted by #2294, not by a follow-up.
6. **What of #2294 remains** — the section below, verbatim.
7. **Findings** — F1–F5 below.

Do **not** self-merge (AI workflow rule 4).

- [ ] **Step 7: Post the #2294 status comment**

```bash
gh issue comment 2294 --body-file /tmp/c0-2294-status.md
```

Content — what this PR discharges and what it does not:

| #2294 item | After C0 |
| --- | --- |
| 1. Plugin source-of-truth relocated | **Done.** The editing home is `plugin/frozen/`; `jinn-plugin-split.yml` mirrors from there; the "EDIT IN MONO, NOT HERE" header names it. |
| 2. `layer-runtime.json` re-homed | **Done.** `verify-layer-stable-version.mjs`, `layer-publish-workflow.test.mjs`, and `packages/layer/test/architecture/package-contract.test.ts` all read `plugin/frozen/layer-runtime.json`. |
| 3. Cold-stock gate re-homed | **Partial.** The gate now builds its wheel from `plugin/frozen` and fires on `plugin/frozen/**`, but `cold-stock-e2e.sh` and its 1,072-line driver `stage1-stock-product.py` still live in the fork. Moving or retiring them stays with the fork's removal (spec §4.2), because they are entangled with the fork's own static-contract tests. |
| 4. Other Jinn-owned assets have first-party homes | **Not started.** The adapter was the largest; a sweep of the remaining fork tree is still owed. |
| 5. `apps/jinn-agent` removed | **Not started.** Its removal must also delete the compatibility symlink `apps/jinn-agent/plugins/jinn` and the 34 `tests/plugins/test_jinn_*.py` files, which test the frozen adapter and have no first-party home. |
| 6. CI green with no workflow referencing the removed path | **Not started**, but rehearsed: Task 10 Step 2 shows every non-fork consumer green with the symlink absent. |

---

## Findings

Recorded per the designs-are-law rule (program plan, Global constraints). None blocks C0; each carries a proposed disposition. **Do not edit the spec or the program plan** — these belong in the PR description and, where they amend a design, in a dated amendment authored by whoever ratifies them.

### F1 — the runtime-pin consumer census is one short

The program plan's C0 row names three consumers to re-point (`jinn-plugin-split.yml`, `verify-layer-stable-version.mjs`, the cold-stock gate). There are **six** files naming the adapter path, and two of them are runtime-pin readers the row does not mention:

- `packages/layer/test/architecture/package-contract.test.ts:33` — a vitest assertion inside the frozen `packages/layer` tree, reading `apps/jinn-agent/plugins/jinn/layer-runtime.json`.
- `.github/scripts/layer-publish-workflow.test.mjs:65` — the fixture that drives the verifier.
- `.github/scripts/published-artifacts-smoke-workflow.test.mjs:115` — a negative guard naming the path.

**Why it matters:** all three pass *through the compatibility symlink* after a naive relocation and would break silently, in an unrelated PR, when #2294 deletes the fork. **Disposition (taken in this plan):** re-point all three in C0; Task 10 Step 2's shim-parked rehearsal is the standing proof that the census is now complete. No design amendment needed — the row's list was illustrative, not exhaustive.

### F2 — "mechanical, content-unchanged relocation" is not sufficient on its own; the fork loads the adapter in place

Spec §9.1 and the program plan both frame C0 as a mechanical move of a mirror *source*. The directory is also a **live bundled plugin of the fork**: `hermes_cli/plugins.py:65` resolves bundled plugins to `<apps/jinn-agent>/plugins/`, the fork's production `hermes_cli/banner.py:907` does `from plugins.jinn import jinn_layer`, and 34 `tests/plugins/test_jinn_*.py` files plus `tests/support/jinn_store.py`, `tests/test_consent_mineable.py`, `tests/run_agent/test_codex_app_server_integration.py` and `scripts/clean_jinn_test_pollution.py` import it as a Python package rooted at the fork. A bare `git mv` breaks 36 consumers inside a tree that is frozen and scheduled for deletion.

**Disposition (taken in this plan):** one committed directory symlink at the old path (`apps/jinn-agent/plugins/jinn → ../../../plugin/frozen`). It edits nothing in the fork, matches an established repository pattern (179 tracked symlinks), is followed transparently by both the Python import machinery and the loader's `iterdir()`/`is_dir()` scan, and is deleted by #2294 along with everything that needs it. The alternative — re-pointing 36 call sites in a tree being deleted — is neither mechanical nor freeze-permitted.

**Proposed amendment (for whoever ratifies):** spec §9.1's sentence "move the *frozen* adapter directory and `layer-runtime.json` content-unchanged to a first-party in-repo home" should gain "…leaving a compatibility symlink at the fork's bundled-plugin path until #2294 removes the fork."

### F3 — "under a clearly-frozen path" cannot be signalled from inside the directory

The program plan §4 asks for the relocated adapter to sit "under a clearly-frozen path", and one would ordinarily drop a `FROZEN.md` beside the code. **That is impossible here:** `mirrorContent` deletes everything at the slim root except `.git` and `.jinn-split-source`, then copies the *entire* `plugin/frozen/` tree in. Any marker file added to that directory would be published to the root of `Jinn-Network/jinn-plugin` and land in every user's `~/.hermes/plugins/jinn`.

**Disposition (taken in this plan):** the freeze signal is the directory name (`frozen`) plus an explicit freeze paragraph in the re-pointed `jinn-plugin-split.yml` header (Task 6 Step 2), which is the file anyone touching the mirror reads first. **Alternative for a ratifier who wants a file-level marker:** nest the mirrored content one level deeper (`plugin/frozen/adapter-hermes/`, with `PLUGIN_DIR: mono/plugin/frozen/adapter-hermes`) so `plugin/frozen/README.md` sits outside the published tree. That contradicts program plan §4's literal layout, so this plan does not take it unilaterally.

### F4 — #2294 item 3 ("cold-stock gate re-homed") cannot be fully discharged by C0

The gate is `apps/jinn-agent/scripts/cold-stock-e2e.sh` (142 lines) plus `apps/jinn-agent/scripts/stage1-stock-product.py` (1,072 lines). Both are asserted on, by text, from inside the fork: `tests/plugins/test_jinn_stock_load.py:10,33` and `tests/plugins/test_jinn_stage1_acceptance_gate.py:18,35` (the script) plus `:56` (the driver). Moving the scripts out re-points those assertions — an edit to fork tests, which is exactly the work #2294 exists to make unnecessary. There is also no home for them under `plugin/` that does not either collide with C3 (`plugin/` root) or get published to users (`plugin/frozen/`).

**Disposition (taken in this plan):** C0 *re-points* the gate (wheel source + path filters) and leaves *re-homing* to #2294, which is what spec §4.2 already says ("the cold-stock gate re-homes or retires with the fork"). The program plan's C0 row wording "re-point … the cold-stock gate" is consistent with this reading. No amendment needed; the PR and the #2294 comment state the residue explicitly.

### F5 — the mirror helper's test suite is not wired to any CI workflow

`.github/scripts/jinn-plugin-split.test.mjs` (19 tests, the entire safety contract of the publication path: token-free dry-run, publish-only-on-`refs/heads/main`, validation-before-destructive-mirror, provenance shape) is referenced by **no** workflow. `grep -rn "jinn-plugin-split.test" .github/workflows/` returns nothing. A regression in the mirror helper — including one introduced by C0 — would reach `main` unnoticed and take the published channel with it.

**Disposition (proposed, not taken):** out of scope for a relocation, and adding a workflow is not a mechanical re-point. C0 runs the suite locally at Tasks 5, 6, 9 and 10 and attaches the output to the PR. **Proposed follow-up:** a small `chore` that adds a paths-filtered job running `node --test .github/scripts/jinn-plugin-split.test.mjs` on changes to `.github/scripts/jinn-plugin-split*.mjs` and `.github/workflows/jinn-plugin-split.yml`. The natural moment is #2294's own PR, which touches the same files. File it as an issue when C0 opens, so it is not discovered during a channel incident.
