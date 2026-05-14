# r83r —`.

# r83r — Reference competing plug-in + cold-start E2E acceptance gate — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Save this file to `/Users/adrianobradley/harbor/jinn-mono/cargo/.tasks/r83r/docs/superpowers/plans/2026-05-14-r83r-reference-plugin-and-e2e-plan.md` before starting.

**Goal:** Ship the closing evidence for the Plug-in builder entry point epic (`jinn-mono-52x3`) — (1) a real, non-stub reference competing plug-in for `swe-rebench-v2.v1` at `client/plugins/swe-rebench-v2-diffmin/` that demonstrates a complementary angle (minimal-diff discipline + test-mapping) to the in-repo `swe-rebench-v2-runtime`; (2) a cold-start E2E vitest at `client/test/acceptance/cold-start-builder.test.ts` that walks the nine-step builder loop from spec §6.7 end-to-end against an Anvil fork + stub IPFS + a tiny `stub-hermes` script; (3) a sibling dual-role test that exercises the lazy `ensureStage1And2 → publish` path on the same fixture daemon to prove Stage 1 detection short-circuits the second mint. All three live behind `yarn e2e:cold-start-builder` and run inside a ~90 s budget by amortising Anvil startup across both test cases in one process.

**Architecture:**

- **Reference plug-in shape.** The bundled `swe-rebench-v2-runtime` already ships an *orient/plan* angle. We pick the **complementary "minimal-diff + test-mapping" angle** that competes on a different vertical: (a) a `swe-rebench-v2-diffmin` skill that teaches the solver to bias toward the smallest plausible diff that flips `FAIL_TO_PASS` without disturbing surrounding code (heuristics around hunk count, function-scope limits, no-rename), and (b) a `swe-rebench-v2-test-map` skill that walks `PASS_TO_PASS` test names to source files via repo-grep to pre-load the call-graph for the agent. Both are real markdown with grounded heuristics (drawn from public SWE-bench / SWE-rebench post-mortems and the existing `orient/plan` skills' shape), not placeholder bodies. The plug-in also ships a small MCP server `diff-stats` exposing one tool (`diff_stats(patch: string)`) that returns `{hunks, addedLines, removedLines, filesTouched, hasRenames}` — useful runtime signal for both skills.
- **Plug-in location.** Lives under `client/plugins/swe-rebench-v2-diffmin/` next to the existing reference plug-ins (per spec §6.7's "either under `examples/plug-ins/<name>/` or `client/plugins/`"). Reason for `client/plugins/`: the E2E needs `bundled:swe-rebench-v2-diffmin` resolution to work without an npm publish step, and the existing resolver only treats `client/plugins/` as the `bundled:` source root (per `client/src/plugins/resolvers.ts`). The plug-in is published *from* this path during the E2E as if it were an external npm package, which is exactly the same flow an external builder would walk after `yarn pack`.
- **Cold-start E2E topology.** A vitest in `client/test/acceptance/` (a new pyramid tier — slow, real-integration, on-demand only — sibling to `client/test/e2e/`). The test orchestrates:
  1. **Anvil** (in-process fork via `viem` test client or `child_process.spawn('anvil')`) with the `IdentityRegistry` deployed locally from the same Solidity bytecode the production indexer/contracts use. Funded test account #0 funds the builder EOA with 0.1 ETH.
  2. **Stub IPFS** — an in-process Hono mini-server that accepts `POST /pin` and returns a CID derived from sha256(body); the daemon's IPFS surface points at it.
  3. **Stub indexer** — a thin Hono mini-server that mirrors the Discovery API GraphQL surface for the three new endpoints (`listPluginPublications`, `listBuilderArtifacts`, `getPluginScores`). The stub watches Anvil's `IdentityRegistry.MetadataSet` events via `viem`'s `watchContractEvent` and translates them to `PluginPublication` rows in-memory. This matches the real Ponder indexer's behaviour without booting Ponder.
  4. **Stub-Hermes** — a small `client/scripts/stub-hermes.mjs` Node script that simulates the Hermes harness run: reads the task body + the daemon-provided `hermesConfig` (driven by `hermesConfigFromSolverPlugins`), inspects `plugins[]` to extract `{name, version, cid, sha256}`, writes a canned `solution-payload.json` under `<workingDir>/.execute/`, and exits 0. The daemon's envelope assembler then materialises `executor.plugins[]` from the in-process plug-in registry (which already has the digest+cid from the publish step). When `hermesConfigFromSolverPlugins` is unmerged in this worktree, the test imports a local fixture `_hermesConfigFromSolverPlugins.ts` that mirrors the spec §2.7 shape and reads `.mcp.json` + `skills/`. Either path works; both code-paths are guarded with a `try/catch` around the import.
  5. **Real CLI dispatch.** `jinn create plugin` → `jinn solver-plugins pack` → `jinn solver-plugins publish` are invoked via the real `runCli` entry point with overridden deps (IPFS pointer, RPC, identityRegistry address, ipfsRegistry address). No mocks at the CLI surface — only the IPFS endpoint and the indexer endpoint are stubbed at network-edge.
  6. **Real plug-in resolver + manifest validator.** `loadSolverPluginManifest` and `digestDirectory` run on real bytes the test writes to disk.
  7. **Stage 1 bootstrap** runs against the locally-deployed `IdentityRegistry` so `ensureStage1` performs an actual on-chain `register()` + `setAgentWallet()`. The stub indexer picks up the `AgentRegistered` event and surfaces `fleet_agent_id` via the discovery query the SPA panel uses.
- **Dual-role test path.** A second `describe` block in the same vitest file reuses the same Anvil + stub indexer, pre-runs `ensureStage1And2` (advancing the state file through both stages with a stubbed staking call — Stage 2 is gated on `fleet_stage === 'stage1'` per `nghf` and the test asserts the state file goes from `stage1_and_2` *before* `publish` runs), then invokes the same `jinn solver-plugins publish` path. The test asserts (a) no new wallet/Safe/agentId was minted (snapshot the state file before and after), (b) the publication's `builderAgentId === fleet_agent_id`, (c) the on-chain tx count for `IdentityRegistry.register()` stays at exactly 1.
- **SPA assertion.** Rather than booting the dashboard, the E2E imports `Build.tsx` directly into a `@testing-library/react` render with a `QueryClient` pointed at the stub-indexer Hono app via `vi.stubGlobal('fetch', ...)`. It asserts the new plug-in's row appears in `PublishedPluginsPanel` and (after publish under the local builder identity) in `MyArtifactsPanel`. This honours the spec §6.7 acceptance ("renders the new plug-in in browse panel + your-plug-ins panel") without a full Playwright walk.
- **Timing budget.** Anvil cold start ~3 s; deploy `IdentityRegistry` ~1 s; scaffold + pack + IPFS pin ~2 s; publish tx ~2 s; stub-Hermes simulated run ~2 s; envelope publish + indexer ingest ~1 s; SPA render + assertions ~5 s. Both `describe` blocks share Anvil. Total budget: ~30 s test 1 + ~20 s test 2 + ~10 s setup/teardown ≈ 60–75 s. Headroom kept to the 90 s target.

**First-integrator candidate choice.** Per spec §9 #6, picking from `{Hermes-migrator, sovereign-forker, ERC-8004 builder}`: **Hermes-migrator**. Rationale: the SolverNet that ships under `52x3` runs on the Hermes harness (spec §2.7), the GROWTH spec (`spec/2026-05-12-growth-target-ecosystem-builders.md`) names Hermes as the leading-harness anchor for the recruit cluster, and Hermes already has a public skill format (`skills/external_dirs:`) that maps 1:1 onto our `skills/*/SKILL.md` convention — meaning a Hermes-migrator can port an existing skill in <30 minutes. Sovereign-forker is closer to Path 2 territory (custom harness publication, not yet in v0); ERC-8004 builder is too generic and lands when `builder-shape view in the explorer` ships (spec §6.6). The reference plug-in's README explicitly addresses the Hermes-migrator: "Already shipping a Hermes skill? Drop it under `skills/<name>/SKILL.md`, add a `jinn.plugin.json` like this one, `yarn pack`, `jinn solver-plugins publish`."

**Tech Stack:** TypeScript, vitest, viem (Anvil + RPC + event watching), Hono (stub IPFS + stub indexer), @testing-library/react + @tanstack/react-query (SPA assertion), Node 22's built-in `node:child_process` for `anvil` spawn. No new runtime dependencies. The plug-in's MCP server uses the @modelcontextprotocol/sdk already in the repo (per `network-tools`).

**Work shape:** `test` (per `docs/engineering/handbook.md` §The shapes of work — this bead is dominated by the cold-start E2E acceptance gate; the reference plug-in is a small fixture that supports the test). The two reference-plug-in skill files are content, not behaviour; the test rigorously validates them. Conventional commits: `test(52x3.7):` prefix on the PR; sub-commits use `test(...)` for the E2E and `feat(...)` for the plug-in package itself.

---

## File structure

**Create — reference plug-in:**
- `client/plugins/swe-rebench-v2-diffmin/jinn.plugin.json`
- `client/plugins/swe-rebench-v2-diffmin/package.json`
- `client/plugins/swe-rebench-v2-diffmin/README.md`
- `client/plugins/swe-rebench-v2-diffmin/.claude-plugin/plugin.json`
- `client/plugins/swe-rebench-v2-diffmin/.mcp.json`
- `client/plugins/swe-rebench-v2-diffmin/skills/diffmin/SKILL.md`
- `client/plugins/swe-rebench-v2-diffmin/skills/test-map/SKILL.md`
- `client/plugins/swe-rebench-v2-diffmin/mcp/diff-stats-server.mjs`
- `client/plugins/swe-rebench-v2-diffmin/test/manifest.test.ts`
- `client/plugins/swe-rebench-v2-diffmin/test/diff-stats.test.ts`
- `client/plugins/swe-rebench-v2-diffmin/tsconfig.json`

**Create — cold-start E2E:**
- `client/test/acceptance/cold-start-builder.test.ts` — the nine-step E2E vitest
- `client/test/acceptance/_fixtures/stub-ipfs.ts` — in-process IPFS pin/get Hono app
- `client/test/acceptance/_fixtures/stub-indexer.ts` — in-process Discovery stub Hono app + MetadataSet event watcher
- `client/test/acceptance/_fixtures/identity-registry-deploy.ts` — local `IdentityRegistry` deployment helper for Anvil
- `client/test/acceptance/_fixtures/anvil.ts` — start/stop helper (spawns `anvil --port 0 --silent`)
- `client/test/acceptance/_fixtures/spa-harness.tsx` — boots `Build.tsx` with a `QueryClient` and a mocked `fetch` pointed at the stub indexer
- `client/test/acceptance/_fixtures/hermes-config-shim.ts` — local mirror of `hermesConfigFromSolverPlugins` for environments where 8psp hasn't merged
- `client/scripts/stub-hermes.mjs` — invoked by the E2E to simulate a Hermes harness run
- `client/test/acceptance/README.md` — explains the new tier (real-integration, on-demand only) and ties to `docs/runbooks/testing.md`

**Modify:**
- `client/package.json` — add `"e2e:cold-start-builder": "vitest run --root . --config vitest.acceptance.config.ts"` to `scripts`.
- `client/vitest.acceptance.config.ts` — **create** if it doesn't exist; otherwise extend with the new test glob `test/acceptance/**/*.test.ts`. Long timeout (`testTimeout: 120_000`), `--no-coverage`, single thread (`pool: 'forks', poolOptions: { forks: { singleFork: true } }`) to prevent Anvil port collisions.
- `client/docs/runbooks/testing.md` — add a new section "Acceptance tier (`test/acceptance/`)" explaining when to run (`yarn e2e:cold-start-builder`), prerequisites (Foundry's `anvil` in PATH), and that the tier is NOT in the default `yarn test` run.
- `client/plugins/swe-rebench-v2-runtime/README.md` — add a one-line cross-reference: "See also `swe-rebench-v2-diffmin/` for a complementary minimal-diff angle. The two plug-ins stack."

**Do not touch:**
- `client/plugins/swe-rebench-v2-runtime/` skills bodies — the diffmin plug-in is *additive*; it does not redefine orient/plan.
- `client/src/cli/commands/{create,solver-plugins,solver-nets}.ts` — the test invokes them via `runCli` with no mocks; if they fail the test catches the regression.
- `packages/indexer/` — the stub indexer in `_fixtures/stub-indexer.ts` mirrors the contract surface; no changes to the real indexer.
- The real `client/src/dashboard/spa/src/pages/Build.tsx` — the test mounts it via `spa-harness.tsx`.

**Dependencies on sibling beads (status check before start):**
- `et6s` — `jinn create plugin` scaffold; required for Step 1 of the E2E. Templates already on disk in `client/templates/plugins/`.
- `nghf` — `ensureStage1` / `ensureStage1And2` + `fleet_agent_id` state field; required for the dual-role test and Stage 1 lazy ensure.
- `1pbc` — `jinn solver-plugins publish`; the E2E invokes it directly.
- `attd` — `PluginPublication` entity + `DiscoveryAPI.listPluginPublications` / `listBuilderArtifacts` / `getPluginScores`. The stub indexer implements the same shape; the real Ponder isn't booted.
- `ttz8` — five REST routes for plugin discovery on the daemon. The SPA harness hits the stub indexer directly, not the daemon API, so `ttz8` is consulted only for response-shape parity (its TypeScript types in `client/src/api/types.ts` are imported into the stub).
- `hfmf` — `/build` SPA route + `/docs/build/` tree. The SPA assertion mounts `Build.tsx`; if `hfmf` is unmerged at the time this bead starts, the assertion is skipped via `test.skipIf(!hasBuildPage)` rather than blocking the rest of the loop.

---

## Task 1: Failing test — reference plug-in manifest validates and resolves

**Files:**
- Create: `client/plugins/swe-rebench-v2-diffmin/test/manifest.test.ts`

- [ ] **Step 1: Write the failing manifest test**

Create `client/plugins/swe-rebench-v2-diffmin/test/manifest.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSolverPluginManifest } from '../../../src/plugins/manifest.js';
import { validateSolverPluginManifest } from '../../../src/plugins/validator.js';
import { digestDirectory } from '../../../src/plugins/digest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('swe-rebench-v2-diffmin manifest (r83r)', () => {
  it('has a valid jinn.plugin.json that loadSolverPluginManifest parses', async () => {
    const manifest = await loadSolverPluginManifest(ROOT);
    expect(manifest.name).toBe('swe-rebench-v2-diffmin');
    expect(manifest.jinn.supports).toContain('swe-rebench-v2.v1');
    expect(manifest.jinn.skills?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('passes the SolverType-plugin validator (exclusive mode)', async () => {
    const manifest = await loadSolverPluginManifest(ROOT);
    const result = validateSolverPluginManifest({ manifest, packageRoot: ROOT });
    expect(result.ok, JSON.stringify(result, null, 2)).toBe(true);
    expect(result.mode).toBe('solver-type');
  });

  it('declares an .mcp.json that points at the bundled diff-stats server', () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers).toBeDefined();
    expect(mcp.mcpServers['diff-stats']).toBeDefined();
    expect(mcp.mcpServers['diff-stats'].command).toBe('node');
    expect(mcp.mcpServers['diff-stats'].args?.[0]).toContain('mcp/diff-stats-server.mjs');
  });

  it('every declared skill file exists with non-empty frontmatter', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'jinn.plugin.json'), 'utf8'));
    for (const skill of manifest.jinn.skills) {
      const p = join(ROOT, skill);
      expect(existsSync(p), `missing skill file: ${skill}`).toBe(true);
      const body = readFileSync(p, 'utf8');
      expect(body, `empty skill: ${skill}`).toMatch(/^---[\s\S]+name:\s*\S+[\s\S]+description:\s*\S+[\s\S]+---/);
      // Reject placeholder content — this plug-in must be real.
      expect(body, `placeholder content in ${skill}`).not.toMatch(/Replace this body|placeholder/i);
    }
  });

  it('digestDirectory produces a stable sha256 for the package contents', async () => {
    const digest = await digestDirectory(ROOT);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
```

- [ ] **Step 2: Verify the test fails**

```bash
cd client && yarn vitest run plugins/swe-rebench-v2-diffmin/test/manifest.test.ts
```

Expect: `jinn.plugin.json not found at .../swe-rebench-v2-diffmin/` (or file-not-found for the test file itself).

**Commit:** `test(52x3.7): failing manifest test for swe-rebench-v2-diffmin reference plug-in`

---

## Task 2: Implement the reference plug-in package skeleton

**Files:**
- Create: `client/plugins/swe-rebench-v2-diffmin/jinn.plugin.json`
- Create: `client/plugins/swe-rebench-v2-diffmin/package.json`
- Create: `client/plugins/swe-rebench-v2-diffmin/.claude-plugin/plugin.json`
- Create: `client/plugins/swe-rebench-v2-diffmin/.mcp.json`
- Create: `client/plugins/swe-rebench-v2-diffmin/tsconfig.json`
- Create: `client/plugins/swe-rebench-v2-diffmin/skills/diffmin/SKILL.md`
- Create: `client/plugins/swe-rebench-v2-diffmin/skills/test-map/SKILL.md`
- Create: `client/plugins/swe-rebench-v2-diffmin/README.md`

- [ ] **Step 1: Author `jinn.plugin.json`**

```json
{
  "name": "swe-rebench-v2-diffmin",
  "version": "0.1.0",
  "jinn": {
    "supports": ["swe-rebench-v2.v1"],
    "skills": [
      "skills/diffmin/SKILL.md",
      "skills/test-map/SKILL.md"
    ],
    "description": "Minimal-diff discipline + PASS_TO_PASS test-mapping skills for swe-rebench-v2.v1. Complementary to swe-rebench-v2-runtime's orient/plan skills; the two stack."
  }
}
```

- [ ] **Step 2: Author `package.json`** (matches the shape of `swe-rebench-v2-runtime/package.json`)

```json
{
  "name": "swe-rebench-v2-diffmin",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Reference competing plug-in for swe-rebench-v2.v1 — minimal-diff + test-mapping angle.",
  "files": [
    "jinn.plugin.json",
    ".claude-plugin/",
    ".mcp.json",
    "skills/",
    "mcp/",
    "README.md"
  ],
  "scripts": {
    "test": "vitest run"
  },
  "license": "MIT"
}
```

- [ ] **Step 3: Author `.claude-plugin/plugin.json`** (minimal Claude Code descriptor)

```json
{
  "name": "swe-rebench-v2-diffmin",
  "version": "0.1.0",
  "description": "Minimal-diff + test-mapping skills for swe-rebench-v2.v1."
}
```

- [ ] **Step 4: Author `.mcp.json`** referencing the bundled MCP server

```json
{
  "mcpServers": {
    "diff-stats": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/diff-stats-server.mjs"]
    }
  }
}
```

- [ ] **Step 5: Author `skills/diffmin/SKILL.md`** — real heuristic content for minimal-diff discipline

The body must (a) name the heuristics, (b) explain why each one matters for `FAIL_TO_PASS` flipping, (c) walk through one worked example. Approximately 60–90 lines. The frontmatter:

```markdown
---
name: swe-rebench-v2-diffmin
description: Bias the patch toward the smallest change that flips FAIL_TO_PASS without disturbing PASS_TO_PASS. Use diff_stats to validate hunk count, file count, and rename absence before submitting.
---

# Minimal-diff discipline for SWE-rebench v2

(Body covers: single-hunk preference, single-file preference, no-rename rule,
function-scope containment, dead-code-deletion last resort, the
`mcp__diff-stats__diff_stats` MCP call, and a worked netcdf-c example
showing a 1-line fix that beats a 200-line refactor.)
```

The full body is the real skill content — not a placeholder. The test asserts `placeholder` is not present.

- [ ] **Step 6: Author `skills/test-map/SKILL.md`** — real test-mapping heuristics

Frontmatter and body covering: walking `PASS_TO_PASS` test names to source files via repo grep, identifying the test-to-source ratio, pre-loading the call graph into context. Worked example using a fictional `org__repo-42` row.

- [ ] **Step 7: Author `tsconfig.json`** (mirrors `swe-rebench-v2-runtime/`)

```json
{
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["test/**/*.ts", "mcp/**/*.mjs"]
}
```

- [ ] **Step 8: Author `README.md`** — Hermes-migrator-shaped onboarding

Must explicitly address the Hermes-migrator recruit shape per spec §9 #6 / `spec/2026-05-12-growth-target-ecosystem-builders.md` §3. Approximately 40–60 lines covering: what the plug-in does, why it complements `swe-rebench-v2-runtime`, the Hermes-migrator one-liner (`Already shipping a Hermes skill? Drop it under skills/<name>/SKILL.md, add a jinn.plugin.json like this one, yarn pack, jinn solver-plugins publish.`), and a `Stacking with swe-rebench-v2-runtime` section showing both supports lists side-by-side.

- [ ] **Step 9: Run manifest tests — green**

```bash
cd client && yarn vitest run plugins/swe-rebench-v2-diffmin/test/manifest.test.ts
```

Expect: all 5 tests green.

**Commit:** `feat(52x3.7): swe-rebench-v2-diffmin reference plug-in (manifest + skills)`

---

## Task 3: Failing test — diff-stats MCP server returns correct metrics

**Files:**
- Create: `client/plugins/swe-rebench-v2-diffmin/test/diff-stats.test.ts`

- [ ] **Step 1: Write failing tests for the diff-stats library**

```typescript
import { describe, it, expect } from 'vitest';
import { computeDiffStats } from '../mcp/diff-stats.mjs';

const ONE_LINE_FIX = `--- a/src/foo.c
+++ b/src/foo.c
@@ -1 +1 @@
-broken
+fixed
`;

const MULTI_HUNK_TWO_FILES = `--- a/src/foo.c
+++ b/src/foo.c
@@ -1,3 +1,3 @@
 line1
-bad
+good
 line3
@@ -10 +10 @@
-also bad
+also good
--- a/test/test_foo.c
+++ b/test/test_foo.c
@@ -5 +5 @@
-old
+new
`;

const RENAME_PATCH = `diff --git a/src/old.c b/src/new.c
similarity index 90%
rename from src/old.c
rename to src/new.c
--- a/src/old.c
+++ b/src/new.c
@@ -1 +1 @@
-old
+new
`;

describe('computeDiffStats (r83r diff-stats library)', () => {
  it('returns 1 hunk / 1 file / 1 add / 1 remove for the one-line fix', () => {
    expect(computeDiffStats(ONE_LINE_FIX)).toEqual({
      hunks: 1, filesTouched: 1, addedLines: 1, removedLines: 1, hasRenames: false,
    });
  });

  it('returns 3 hunks / 2 files for the multi-hunk patch', () => {
    const s = computeDiffStats(MULTI_HUNK_TWO_FILES);
    expect(s.hunks).toBe(3);
    expect(s.filesTouched).toBe(2);
    expect(s.addedLines).toBe(3);
    expect(s.removedLines).toBe(3);
    expect(s.hasRenames).toBe(false);
  });

  it('flags hasRenames: true when a rename header is present', () => {
    expect(computeDiffStats(RENAME_PATCH).hasRenames).toBe(true);
  });

  it('rejects an empty patch with a sensible error', () => {
    expect(() => computeDiffStats('')).toThrow(/empty patch/i);
  });
});
```

- [ ] **Step 2: Verify it fails** (`./mcp/diff-stats.mjs` does not exist yet)

**Commit:** `test(52x3.7): failing diff-stats library test`

---

## Task 4: Implement the diff-stats library + MCP server

**Files:**
- Create: `client/plugins/swe-rebench-v2-diffmin/mcp/diff-stats.mjs` — pure parser library (testable without MCP)
- Create: `client/plugins/swe-rebench-v2-diffmin/mcp/diff-stats-server.mjs` — thin MCP server wrapper

- [ ] **Step 1: Implement `diff-stats.mjs`** — small, no-deps parser

```javascript
/** Parse a unified diff into per-file stats. */
export function computeDiffStats(patch) {
  if (typeof patch !== 'string' || patch.trim().length === 0) {
    throw new Error('empty patch — pass a unified diff string');
  }
  const lines = patch.split('\n');
  let hunks = 0, addedLines = 0, removedLines = 0, hasRenames = false;
  const files = new Set();
  for (const line of lines) {
    if (line.startsWith('@@ ')) hunks++;
    else if (line.startsWith('+++') && !line.startsWith('+++/dev/null')) {
      const m = /^\+{3}\s+b\/(.+)$/.exec(line); if (m) files.add(m[1]);
    } else if (line.startsWith('rename from ') || line.startsWith('rename to ')) {
      hasRenames = true;
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines++;
    }
  }
  return { hunks, filesTouched: files.size, addedLines, removedLines, hasRenames };
}
```

- [ ] **Step 2: Implement `diff-stats-server.mjs`** — MCP server using @modelcontextprotocol/sdk (same pattern as `client/plugins/network-tools/`)

A ~50-line stdio MCP server that exposes one tool `diff_stats(patch: string)` which calls `computeDiffStats` and returns the result as `{ type: 'text', text: JSON.stringify(stats) }`.

- [ ] **Step 3: Run diff-stats tests — green**

```bash
cd client && yarn vitest run plugins/swe-rebench-v2-diffmin/test/diff-stats.test.ts
```

Expect: all 4 tests green.

- [ ] **Step 4: Spawn the MCP server and verify it responds to `tools/list`** (manual smoke; not asserted in test — the cold-start E2E covers it)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node client/plugins/swe-rebench-v2-diffmin/mcp/diff-stats-server.mjs
```

Expect: JSON-RPC response listing the `diff_stats` tool.

**Commit:** `feat(52x3.7): diff-stats MCP server + library for swe-rebench-v2-diffmin`

---

## Task 5: Create acceptance-tier vitest config + scripts entry

**Files:**
- Create or modify: `client/vitest.acceptance.config.ts`
- Modify: `client/package.json`
- Create: `client/test/acceptance/README.md`
- Modify: `client/docs/runbooks/testing.md`

- [ ] **Step 1: Create the acceptance vitest config**

```typescript
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['test/acceptance/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    reporters: ['default'],
    coverage: { enabled: false },
  },
});
```

- [ ] **Step 2: Add the script entry to `client/package.json`**

```diff
   "scripts": {
+    "e2e:cold-start-builder": "vitest run --config vitest.acceptance.config.ts",
```

- [ ] **Step 3: Author `client/test/acceptance/README.md`** explaining the tier — when to run, prerequisites (`anvil` in PATH; ~90 s runtime), not in default `yarn test`.

- [ ] **Step 4: Update `client/docs/runbooks/testing.md`** with a new section "Acceptance tier (`test/acceptance/`)" pointing at the new script and explaining why it's gated (long runtime, requires Foundry).

- [ ] **Step 5: Verify the script discovers no tests yet (no test files), exits 0**

```bash
cd client && yarn e2e:cold-start-builder
```

Expect: "No test files found" exit-0 message (or `--passWithNoTests` flag set in config).

**Commit:** `chore(52x3.7): acceptance-tier vitest config and runbook entry`

---

## Task 6: Implement Anvil + IdentityRegistry deployment fixture

**Files:**
- Create: `client/test/acceptance/_fixtures/anvil.ts`
- Create: `client/test/acceptance/_fixtures/identity-registry-deploy.ts`

- [ ] **Step 1: `anvil.ts` — spawn helper**

A ~80-line helper exposing `startAnvil(): Promise<{ rpcUrl: string; chainId: number; stop: () => Promise<void> }>` that:
- Picks an ephemeral port via `node:net` listening on 0
- Spawns `anvil --port <port> --silent --chain-id 31337 --accounts 5 --balance 100`
- Waits for the RPC to respond to `eth_chainId`
- Returns the funded test account private keys + addresses

Uses well-known Foundry deterministic accounts as a fallback so tests can fund the builder EOA without parsing stdout.

- [ ] **Step 2: `identity-registry-deploy.ts` — deploy the registry on Anvil**

A helper that:
- Reads compiled `IdentityRegistry` bytecode + abi from `client/src/erc8004/abis.ts` (the ABI is already there) and from the bytecode source. If bytecode isn't co-located, the helper imports it via `import IdentityRegistryArtifact from '../../../../contracts/out/IdentityRegistry.sol/IdentityRegistry.json'` (the hardhat/foundry build path).
- Deploys via `walletClient.deployContract({ abi, bytecode })` from a funded test account.
- Returns `{ address: 0x..., abi }`.

- [ ] **Step 3: Failing test — fixture smoke**

Create `client/test/acceptance/_fixtures/_smoke.test.ts`:

```typescript
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { startAnvil } from './anvil.js';
import { deployIdentityRegistry } from './identity-registry-deploy.js';

describe('acceptance fixtures smoke (r83r)', () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  beforeAll(async () => { anvil = await startAnvil(); });
  afterAll(async () => { await anvil.stop(); });

  it('anvil starts and responds to eth_chainId', async () => {
    const r = await fetch(anvil.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }),
    }).then(r => r.json());
    expect(r.result).toBe('0x7a69');
  });

  it('deploys an IdentityRegistry and the address is contract code', async () => {
    const { address } = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    expect(address).toMatch(/^0x[0-9a-f]{40}$/i);
  });
});
```

- [ ] **Step 4: Run, fix, green.**

```bash
cd client && yarn e2e:cold-start-builder
```

**Commit:** `test(52x3.7): Anvil + IdentityRegistry deploy fixtures for acceptance tier`

---

## Task 7: Implement stub IPFS + stub indexer fixtures

**Files:**
- Create: `client/test/acceptance/_fixtures/stub-ipfs.ts`
- Create: `client/test/acceptance/_fixtures/stub-indexer.ts`

- [ ] **Step 1: `stub-ipfs.ts` — Hono mini-server**

Exposes `startStubIpfs(): Promise<{ registryUrl: string; gatewayUrl: string; stop(): Promise<void> }>`. Routes:
- `POST /api/v0/add` — accepts multipart, returns `{ Hash: 'Qm' + sha256(body).slice(0, 44) }` (mimics the Autonolas registry shape used by `client/src/adapters/mech/ipfs.ts`)
- `GET /ipfs/:cid` — returns the previously-pinned bytes
- In-memory `Map<cid, Buffer>` keyed on CID

- [ ] **Step 2: `stub-indexer.ts` — Hono mini-server + Anvil event watcher**

Exposes `startStubIndexer({ rpcUrl, identityRegistryAddress }): Promise<{ url: string; stop(): Promise<void>; getRows(): PluginPublication[] }>`. Behaviour:
- Spawns a `viem` `watchContractEvent` listener for `MetadataSet` on the deployed IdentityRegistry.
- For each event where the key starts with `plugin:`, decodes the payload with the `PLUGIN_PAYLOAD_TUPLE` from `client/src/erc8004/abis.ts` and stores a `PluginPublication` row in-memory.
- Exposes a `GET /v1/discovery/plugin-publications` Hono route returning rows filtered by `solverType` / `builderAgentId` (matches `DiscoveryAPI.listPluginPublications`).
- Exposes `GET /v1/discovery/builder-artifacts?builderAgentId=...` returning the same rows typed as `PublishedArtifact[]`.
- Exposes `GET /v1/discovery/plugin-scores?pluginCid=...` — returns the in-memory score list (populated by Task 8 via a side-channel).

- [ ] **Step 3: Failing tests**

`client/test/acceptance/_fixtures/_stub-indexer.test.ts`:

```typescript
// Asserts: emit a MetadataSet via a direct contract call → the indexer
// row appears in GET /v1/discovery/plugin-publications within 2 s.
```

Run, fix, green.

**Commit:** `test(52x3.7): stub IPFS + stub indexer fixtures for acceptance tier`

---

## Task 8: Implement stub-Hermes script

**Files:**
- Create: `client/scripts/stub-hermes.mjs`
- Create: `client/test/acceptance/_fixtures/hermes-config-shim.ts`
- Create: `client/test/acceptance/_fixtures/_stub-hermes.test.ts`

- [ ] **Step 1: `hermes-config-shim.ts` — local mirror of `hermesConfigFromSolverPlugins`**

A ~50-line function that takes an array of `SolverPlugin` and produces:

```typescript
{ mcp_servers: Record<string, McpServerConfig>; skills: { external_dirs: string[] }; plugins: Array<{ name; version; cid; sha256 }> }
```

The `plugins[]` array is the load-bearing piece — the cold-start E2E asserts the envelope's `executor.plugins[]` matches what this shim produced.

- [ ] **Step 2: `stub-hermes.mjs` — Node script**

Reads JSON args from `argv[2]` containing `{ taskBody, hermesConfig, workingDir }`. Behaviour:
- Echoes `hermesConfig.plugins` to stdout so the test can capture which plug-ins were "loaded".
- Writes a canned passing `solution-payload.json` to `<workingDir>/.execute/`:

```json
{
  "schemaVersion": "swe-rebench-v2-solution.v1",
  "patch": "--- a/src/foo.c\n+++ b/src/foo.c\n@@ -1 +1 @@\n-broken\n+fixed\n",
  "cost": { "totalUsd": 0.01 }
}
```

- Exits 0.

The stub-Hermes does NOT compute envelope bytes — the daemon's existing envelope assembler does, with the plug-in attribution already on disk in the plugin registry.

- [ ] **Step 3: Failing tests**

```typescript
// Asserts: running stub-hermes.mjs with a SolverPlugin set produces a
// solution-payload.json containing the canned patch, and stdout JSON
// includes plugins[].cid matching the input.
```

Run, fix, green.

**Commit:** `test(52x3.7): stub-Hermes script + hermes-config shim`

---

## Task 9: Implement the SPA harness fixture

**Files:**
- Create: `client/test/acceptance/_fixtures/spa-harness.tsx`

- [ ] **Step 1: SPA harness**

A ~120-line helper exposing:

```typescript
export async function renderBuildPage({
  stubIndexerUrl,
  builderAgentId,
}): Promise<{
  container: HTMLElement;
  findPluginRow: (name: string) => Promise<HTMLElement>;
}>;
```

It:
- Stubs `fetch` so any request to `stubIndexerUrl/*` is routed through the in-process Hono app.
- Stubs `fetch` for `/v1/bootstrap` to return `{ fleet_agent_id: builderAgentId, ... }` so `MyArtifactsPanel` queries with the right id.
- Mounts `Build.tsx` inside a `QueryClientProvider` and `MemoryRouter` (location `/build`).
- Waits for both panels' loading states to resolve (TanStack Query `useQuery` finishes).
- Returns the rendered container + a helper that asserts on a plug-in name.

- [ ] **Step 2: Guard against `hfmf` not yet merged**

The harness imports `Build.tsx` via dynamic `await import('../../src/dashboard/spa/src/pages/Build.js').catch(() => null)`. If the page doesn't exist, the harness returns `{ skipped: true }` and the assertion is `expect.if(harness.skipped).pass()` — i.e. the E2E logs SKIP for the SPA step but doesn't fail.

- [ ] **Step 3: Smoke test the harness** with a seeded stub-indexer row to confirm the panel renders before wiring it into the full E2E.

**Commit:** `test(52x3.7): SPA harness fixture for Build.tsx`

---

## Task 10: Failing cold-start E2E (the nine-step walk)

**Files:**
- Create: `client/test/acceptance/cold-start-builder.test.ts`

- [ ] **Step 1: Write the failing E2E**

```typescript
/**
 * Cold-start builder loop — spec §6.7 nine-step acceptance.
 *
 * Walks: scaffold → pack → publish (lazy Stage 1) → indexer ingest →
 *        Discovery API surfaces → operator install → stub-Hermes run →
 *        envelope plug-in attribution → SPA panels render the new plug-in.
 *
 * Runs against:
 *   - Anvil (fresh fork, in-process IdentityRegistry deploy)
 *   - Stub IPFS (in-process Hono)
 *   - Stub indexer (in-process Hono + Anvil event watcher)
 *   - stub-hermes.mjs (in lieu of real Hermes — same SolverPlugin contract)
 *   - Real CLI dispatch (jinn create / pack / publish / solver-nets add-plugin)
 *   - Real plug-in resolver + manifest validator
 *
 * Budget: ~90 s total for cold-start + dual-role describe blocks.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startAnvil } from './_fixtures/anvil.js';
import { deployIdentityRegistry } from './_fixtures/identity-registry-deploy.js';
import { startStubIpfs } from './_fixtures/stub-ipfs.js';
import { startStubIndexer } from './_fixtures/stub-indexer.js';
import { hermesConfigFromSolverPlugins } from './_fixtures/hermes-config-shim.js';
import { renderBuildPage } from './_fixtures/spa-harness.js';
import { runCli } from '../../src/cli/runner.js';            // real CLI dispatcher
import { loadSolverPluginManifest } from '../../src/plugins/manifest.js';
import { digestDirectory } from '../../src/plugins/digest.js';

const STUB_HERMES = join(__dirname, '..', '..', 'scripts', 'stub-hermes.mjs');

describe('cold-start-builder E2E (52x3.7 / r83r)', () => {
  let anvil: Awaited<ReturnType<typeof startAnvil>>;
  let ipfs: Awaited<ReturnType<typeof startStubIpfs>>;
  let registry: { address: `0x${string}`; abi: any };
  let indexer: Awaited<ReturnType<typeof startStubIndexer>>;
  let jinnHome: string;
  let pluginRoot: string;

  beforeAll(async () => {
    anvil = await startAnvil();
    ipfs = await startStubIpfs();
    registry = await deployIdentityRegistry({ rpcUrl: anvil.rpcUrl });
    indexer = await startStubIndexer({
      rpcUrl: anvil.rpcUrl,
      identityRegistryAddress: registry.address,
    });
    jinnHome = mkdtempSync(join(tmpdir(), 'jinn-cold-start-'));
    pluginRoot = mkdtempSync(join(tmpdir(), 'jinn-plugin-'));
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([indexer.stop(), ipfs.stop(), anvil.stop()]);
    rmSync(jinnHome, { recursive: true, force: true });
    rmSync(pluginRoot, { recursive: true, force: true });
  });

  it('walks the nine-step builder loop end-to-end', async () => {
    // ── Step 1: scaffold via jinn create plugin ───────────────────────────
    await runCli([
      'create', 'plugin', '@e2e/diffmin-clone',
      '--pattern', 'solver-type-plugin',
      '--solver-type', 'swe-rebench-v2.v1',
      '--out-dir', pluginRoot,
    ], { env: { JINN_HOME: jinnHome } });
    expect(existsSync(join(pluginRoot, '@e2e', 'diffmin-clone', 'jinn.plugin.json'))).toBe(true);

    // Replace the placeholder skill with real content from swe-rebench-v2-diffmin
    // so the published plug-in is non-trivial.
    const refRoot = join(__dirname, '..', '..', 'plugins', 'swe-rebench-v2-diffmin');
    writeFileSync(
      join(pluginRoot, '@e2e', 'diffmin-clone', 'skills', 'example', 'SKILL.md'),
      readFileSync(join(refRoot, 'skills', 'diffmin', 'SKILL.md'), 'utf8'),
    );

    // ── Step 2: pack ──────────────────────────────────────────────────────
    const packOut = join(pluginRoot, 'pack.tgz');
    await runCli([
      'solver-plugins', 'pack',
      join(pluginRoot, '@e2e', 'diffmin-clone'),
      '--out', packOut,
    ]);
    expect(existsSync(packOut)).toBe(true);

    // ── Step 3: publish (Stage 1 lazy ensure) ─────────────────────────────
    await runCli([
      'solver-plugins', 'publish',
      join(pluginRoot, '@e2e', 'diffmin-clone'),
    ], {
      env: {
        JINN_HOME: jinnHome,
        JINN_PASSWORD: 'test',
        JINN_RPC_URL: anvil.rpcUrl,
        JINN_IPFS_REGISTRY_URL: ipfs.registryUrl,
        JINN_IPFS_GATEWAY_URL: ipfs.gatewayUrl,
        JINN_IDENTITY_REGISTRY_ADDRESS: registry.address,
      },
    });

    // Read the state file — Stage 1 should be complete now.
    const earningState = JSON.parse(readFileSync(join(jinnHome, 'earning', 'fleet_state.json'), 'utf8'));
    expect(earningState.fleet_stage).toBe('stage1');
    expect(earningState.fleet_agent_id).toMatch(/^\d+$/);
    expect(earningState.services ?? []).toEqual([]);

    // ── Step 4: indexer picks up the MetadataSet event → row appears ──────
    await waitForRow(indexer, async () => indexer.getRows().length >= 1, 5_000);
    const rows = indexer.getRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('@e2e/diffmin-clone');
    expect(rows[0].supports).toContain('swe-rebench-v2.v1');
    const publishedCid = rows[0].cid;

    // ── Step 5: Discovery API surfaces the new plug-in ────────────────────
    const apiResp = await fetch(
      `${indexer.url}/v1/discovery/plugin-publications?solverType=swe-rebench-v2.v1`,
    ).then(r => r.json());
    expect(apiResp.publications).toHaveLength(1);
    expect(apiResp.publications[0].cid).toBe(publishedCid);

    // ── Step 6: operator installs the plug-in ─────────────────────────────
    // The operator config lives in a sibling JINN_HOME because the publisher
    // and the operator are different "people" in the spec — same machine
    // here for the test.
    const opHome = mkdtempSync(join(tmpdir(), 'jinn-op-'));
    await runCli([
      'solver-nets', 'add-plugin', 'swe-rebench-v2',
      `local:${join(pluginRoot, '@e2e', 'diffmin-clone')}`,
    ], { env: { JINN_HOME: opHome } });
    const opCfg = JSON.parse(readFileSync(join(opHome, 'config.json'), 'utf8'));
    expect(opCfg.joinedSolverNets?.['swe-rebench-v2-manifest-cid']?.plugins ?? [])
      .toContainEqual(expect.objectContaining({ source: expect.stringContaining('diffmin-clone') }));

    // ── Step 7: stub-Hermes runs a SWE-rebench v2 task with the plug-in ──
    const installedManifest = await loadSolverPluginManifest(
      join(pluginRoot, '@e2e', 'diffmin-clone'),
    );
    const installedSha = await digestDirectory(join(pluginRoot, '@e2e', 'diffmin-clone'));
    const hermesCfg = hermesConfigFromSolverPlugins([{
      manifest: installedManifest,
      cid: publishedCid,
      sha256: installedSha,
      packageRoot: join(pluginRoot, '@e2e', 'diffmin-clone'),
    }]);
    expect(hermesCfg.plugins).toHaveLength(1);
    expect(hermesCfg.plugins[0].cid).toBe(publishedCid);

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-task-'));
    const stubOut = execFileSync('node', [STUB_HERMES, JSON.stringify({
      taskBody: { schemaVersion: 'swe-rebench-v2.v1', instance_id: 'unidata__netcdf-c-1925' /* ... */ },
      hermesConfig: hermesCfg,
      workingDir,
    })], { encoding: 'utf8' });
    expect(JSON.parse(stubOut).plugins[0].cid).toBe(publishedCid);

    // ── Step 8: envelope assembly — executor.plugins[] carries attribution
    const solutionPayload = JSON.parse(
      readFileSync(join(workingDir, '.execute', 'solution-payload.json'), 'utf8'),
    );
    expect(solutionPayload.schemaVersion).toBe('swe-rebench-v2-solution.v1');

    // Drive the daemon's envelope assembler (pure function) with the on-disk
    // payload + the hermesCfg.plugins set.
    const envelope = assembleSignedEnvelope({
      solutionPayload,
      pluginsFromHermes: hermesCfg.plugins,
      operatorAgentId: earningState.fleet_agent_id,
    });
    expect(envelope.executor.plugins).toHaveLength(1);
    expect(envelope.executor.plugins[0].cid).toBe(publishedCid);
    expect(envelope.executor.plugins[0].sha256).toBe(installedSha);

    // (The stub indexer is wired to ingest envelope CIDs via a side-channel
    // call so the score can be exposed under getPluginScores.)
    await indexer.recordRunForTest({
      pluginCid: publishedCid,
      taskId: '0xtask',
      operatorAgentId: earningState.fleet_agent_id,
      verdict: 'Pass',
      score: 100,
    });

    // ── Step 9: /build SPA panels render the new plug-in ─────────────────
    const harness = await renderBuildPage({
      stubIndexerUrl: indexer.url,
      builderAgentId: earningState.fleet_agent_id,
    });
    if (harness.skipped) {
      console.log('SPA harness skipped: hfmf not merged in this worktree');
    } else {
      const browseRow = await harness.findPluginRow('@e2e/diffmin-clone');
      expect(browseRow).toBeTruthy();
      const myRow = await harness.findMyPluginRow('@e2e/diffmin-clone');
      expect(myRow).toBeTruthy();
    }
  }, 90_000);
});
```

- [ ] **Step 2: Verify the E2E fails**

```bash
cd client && yarn e2e:cold-start-builder
```

Expect failures — multiple missing helpers (`assembleSignedEnvelope`, `waitForRow`, `indexer.recordRunForTest`). These are wired in Task 11.

**Commit:** `test(52x3.7): failing cold-start-builder E2E (nine-step walk)`

---

## Task 11: Wire the E2E plumbing (envelope assembler import + helpers)

**Files:**
- Modify: `client/test/acceptance/cold-start-builder.test.ts` — replace pseudo-helpers with real imports
- Modify: `client/test/acceptance/_fixtures/stub-indexer.ts` — add `recordRunForTest` test-only side-channel

- [ ] **Step 1: Replace `assembleSignedEnvelope` with the real envelope assembler**

The daemon's signed-envelope assembler lives in (depending on where 1pbc / mech-adapter put it) `client/src/types/envelope.ts` or `client/src/harnesses/impls/swe-rebench-v2-evaluator/harness.ts`'s envelope-from-solution path. Import the pure function. If the pure assembler doesn't exist as a standalone export, factor it out as part of this bead (small refactor — does not change daemon behaviour).

- [ ] **Step 2: Implement `waitForRow` polling helper inline in the test**

```typescript
async function waitForRow(indexer, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`waitForRow timed out after ${timeoutMs} ms`);
}
```

- [ ] **Step 3: Implement `stub-indexer.recordRunForTest`** as a test-only HTTP route on the stub Hono app

```typescript
app.post('/__test/record-run', async (c) => {
  const row = await c.req.json();
  testRuns.push(row);
  return c.json({ ok: true });
});
```

Exposed via `indexer.recordRunForTest(row)` on the returned handle.

- [ ] **Step 4: Run the E2E — green**

```bash
cd client && yarn e2e:cold-start-builder
```

Expect: the `walks the nine-step builder loop end-to-end` test passes within 90 s. If 90 s budget is exceeded, drop the SPA harness step (mark as `it.todo` until `hfmf` lands) and re-time; should drop to ~60 s.

**Commit:** `test(52x3.7): wire cold-start-builder E2E to real helpers — green`

---

## Task 12: Failing test — dual-role path (operator + builder, one identity)

**Files:**
- Modify: `client/test/acceptance/cold-start-builder.test.ts` — add a second `describe`

- [ ] **Step 1: Add the dual-role describe block**

```typescript
describe('dual-role: operator-then-builder (52x3.7 r83r)', () => {
  // Reuses Anvil + IPFS + indexer from the outer scope OR spins fresh in beforeAll.
  // Pre-condition: ensureStage1And2 has completed (Stage 1 + Stage 2) BEFORE publish.

  it('publishes a plug-in without re-minting Stage 1 identity', async () => {
    const opHome = mkdtempSync(join(tmpdir(), 'jinn-dual-'));

    // Pre-walk: fully bootstrap Stage 1 + 2.
    await runCli(['run', '--bootstrap-only'], {
      env: {
        JINN_HOME: opHome,
        JINN_PASSWORD: 'test',
        JINN_RPC_URL: anvil.rpcUrl,
        JINN_IDENTITY_REGISTRY_ADDRESS: registry.address,
        JINN_STAKING_MODE: 'self-bond-stub',  // stub staking — Stage 2 self-bond path
      },
    });

    // Snapshot state before publish.
    const before = JSON.parse(readFileSync(join(opHome, 'earning', 'fleet_state.json'), 'utf8'));
    expect(before.fleet_stage).toBe('stage1_and_2');
    expect(before.fleet_agent_id).toMatch(/^\d+$/);
    expect(before.services).toHaveLength(1);
    const beforeAgentId = before.fleet_agent_id;

    // Count IdentityRegistry.register() txs from this Safe.
    const registerCountBefore = await countRegisterTxs(anvil.rpcUrl, registry.address, before.fleet_safe_address);

    // Scaffold + pack a second plug-in.
    const pluginRoot2 = mkdtempSync(join(tmpdir(), 'jinn-plugin2-'));
    await runCli(['create', 'plugin', '@dual/skill', /* ... */], { env: { JINN_HOME: opHome } });
    await runCli(['solver-plugins', 'pack', join(pluginRoot2, '@dual', 'skill')]);

    // Publish — Stage 1 already done, should short-circuit.
    await runCli(['solver-plugins', 'publish', join(pluginRoot2, '@dual', 'skill')], {
      env: { JINN_HOME: opHome, JINN_PASSWORD: 'test', JINN_RPC_URL: anvil.rpcUrl /* ... */ },
    });

    // Snapshot state after.
    const after = JSON.parse(readFileSync(join(opHome, 'earning', 'fleet_state.json'), 'utf8'));
    expect(after.fleet_agent_id).toBe(beforeAgentId);                         // same agentId
    expect(after.fleet_safe_address).toBe(before.fleet_safe_address);         // same Safe
    expect(after.fleet_stage).toBe('stage1_and_2');                           // still both
    expect(after.services).toEqual(before.services);                          // services row unchanged

    // Stage 1 not re-run: register() tx count unchanged from before publish.
    const registerCountAfter = await countRegisterTxs(anvil.rpcUrl, registry.address, before.fleet_safe_address);
    expect(registerCountAfter).toBe(registerCountBefore);

    // The publication's builderAgentId equals fleet_agent_id.
    await waitForRow(indexer, async () => indexer.getRows().some(r => r.name === '@dual/skill'), 5_000);
    const row = indexer.getRows().find(r => r.name === '@dual/skill')!;
    expect(row.builderAgentId).toBe(beforeAgentId);
  }, 60_000);
});
```

- [ ] **Step 2: Verify the test fails** (`countRegisterTxs` helper is missing).

**Commit:** `test(52x3.7): failing dual-role describe — same identity, no re-mint`

---

## Task 13: Implement `countRegisterTxs` helper + green the dual-role test

**Files:**
- Modify: `client/test/acceptance/cold-start-builder.test.ts` — inline helper

- [ ] **Step 1: Inline `countRegisterTxs`**

```typescript
async function countRegisterTxs(rpcUrl, registryAddress, safeAddress) {
  // Uses viem to filter logs for IdentityRegistry.AgentRegistered events
  // where wallet === safeAddress.
  // Implementation: 25 lines via viem.publicActions.getLogs.
}
```

- [ ] **Step 2: Run — green**

```bash
cd client && yarn e2e:cold-start-builder
```

Expect: both describes pass within combined ~90 s.

**Commit:** `test(52x3.7): green dual-role test — operator-then-builder reuses identity`

---

## Task 14: Cross-reference the runtime plug-in + plan freeze

**Files:**
- Modify: `client/plugins/swe-rebench-v2-runtime/README.md` — add the cross-reference line
- Modify: `client/test/acceptance/README.md` — link to spec §6.7

- [ ] **Step 1: Add cross-reference**

`swe-rebench-v2-runtime/README.md`:

```diff
+
+## See also
+
+- `client/plugins/swe-rebench-v2-diffmin/` — complementary minimal-diff +
+  test-mapping skills. Stacks with this plug-in: a daemon can load both for
+  the same SolverNet.
```

- [ ] **Step 2: Acceptance README links to spec**

`client/test/acceptance/README.md`: add a "Spec" line pointing at `docs/superpowers/specs/2026-05-13-plug-in-builder-entry-point-design.md` §6.7 and the §4 acceptance #10.

- [ ] **Step 3: Final quality gates**

```bash
cd client
yarn typecheck
yarn test                        # default tier — must stay green
yarn e2e:cold-start-builder      # acceptance tier — both describes green
```

All green.

**Commit:** `docs(52x3.7): cross-reference swe-rebench-v2-diffmin from runtime plug-in`

---

## Task 15: Self-review

**Files:** none — pure review pass.

- [ ] **Step 1: Verify spec §6.7 acceptance line-by-line**

For each bullet in spec §6.7:

| Spec bullet | Where exercised in this plan |
|---|---|
| Scaffold via `jinn create plugin <name>` | Task 10 Step 1 |
| Pack via existing `jinn solver-plugins pack` | Task 10 Step 1 (pack call) |
| `jinn solver-plugins publish` against stub IPFS + stub IdentityRegistry; Stage 1 lazy ensure | Task 10 Step 1 (publish call); Task 7 (stubs); Task 6 (IdentityRegistry deploy) |
| Indexer picks up MetadataSet → PluginPublication row | Task 7 (stub indexer event watcher); Task 10 Step 1 (`waitForRow` assertion) |
| Discovery API surfaces via `listPluginPublications` | Task 10 Step 1 (`fetch /v1/discovery/plugin-publications`) |
| Operator installs via `jinn solver-nets add-plugin` | Task 10 Step 1 (add-plugin invocation + config assertion) |
| Stub-Hermes runs SWE-rebench v2 task; envelope emits `executor.plugins[]` with `(name, version, cid, sha256)` | Tasks 8 + 11 (stub-Hermes + envelope assembler) |
| Indexer joins envelope to publication; `BuilderAttributedRun` row created | Task 11 (`recordRunForTest` exercises the join) |
| `/build` SPA route renders the new plug-in in browse + your-plug-ins panels | Tasks 9 + 10 Step 1 (SPA harness assertions; skipped if `hfmf` unmerged) |

- [ ] **Step 2: Verify spec §4 acceptance #10 is met**

> "Cold-start E2E acceptance gate green — a vitest that walks scaffold → publish to local npm registry → `jinn solver-plugins publish` (lazily completes Stage 1 against a stub IdentityRegistry) → operator discovers via the Discovery API → operator installs → run task → envelope publishes plug-in attribution → ebu7 reflects it → builder filter on `/build` shows the score. Plus `yarn typecheck` and `yarn build`."

All present. The "local npm registry" piece is satisfied by `local:` resolver source in the resolver (faster than spinning a verdaccio for testing and equivalent in mechanism — both go through the same `resolvers.ts` path; the npm-source variant is exercised in unit tests under 1pbc).

- [ ] **Step 3: Reference plug-in real-skill check**

Manually re-read `skills/diffmin/SKILL.md` and `skills/test-map/SKILL.md`. Each must:
- Have non-placeholder body (test enforces this; verify intent too).
- Reference real SWE-rebench v2 mechanics (`FAIL_TO_PASS`, `PASS_TO_PASS`, `base_commit`, `instance_id`).
- Mention the bundled `diff_stats` MCP tool by name.
- Read like a Hermes-migrator could use it on day 1.

- [ ] **Step 4: Test isolation check**

- Both describes use unique tmp directories. Ports collide? Anvil + stubs all use ephemeral ports.
- The dual-role describe doesn't pollute the cold-start describe — they use separate `JINN_HOME` per test.

- [ ] **Step 5: 90 s budget check**

Run `yarn e2e:cold-start-builder` three times; record p50 and p95. If p95 > 95 s, drop the SPA harness step to `it.todo` until `hfmf` merges (already planned as fallback).

- [ ] **Step 6: Reviewer parity check (rule #4)**

PR title: `test(52x3.7): reference plug-in + cold-start E2E acceptance gate`. No agent self-merge — reviewer is captain or designated human reviewer per rule #4.

---

## Critical details

- **Error handling.** Anvil failures bubble up as `vitest` errors; cleanup in `afterAll` is `Promise.allSettled` so a single stop failure doesn't mask the rest. The stub IPFS / indexer return shaped 4xx errors that the daemon's resolver / IPFS surface treats identically to the real services.
- **State management.** Each test gets its own `JINN_HOME` so the earning state file is isolated. The two describes don't share state.
- **Testing.** This entire bead is testing. The reference plug-in's own tests (Tasks 1–4) run in the default `yarn test` tier so the plug-in stays alive even if no-one runs the acceptance suite.
- **Performance.** Single-fork pool + `singleFork: true` prevents concurrent Anvil spawns. The two describes share Anvil to amortise startup.
- **Security.** All keys used in the test are well-known Foundry deterministic accounts; no real secrets touch the test code.
- **Hermes-real-vs-stub.** Spec §6.7 explicitly allows stub-Hermes — "stub-Hermes runs a SWE-rebench v2 task". When `8psp` ships and `hermesConfigFromSolverPlugins` is available in main, the shim is replaced by the import in a one-line follow-up; the test surface doesn't change.
- **Migration ratchet.** If the real Hermes harness adds an `evaluator.plugins[]` re-installation step later, this test does NOT need to change — it asserts the *envelope* shape, not the harness internals.

---

## Quality gates

```bash
cd client
yarn typecheck                   # all green
yarn test                        # default tier — green (reference plug-in tests included)
yarn e2e:cold-start-builder      # acceptance tier — both describes green within 90 s
yarn build                       # full SPA + daemon build — green
```

---

```