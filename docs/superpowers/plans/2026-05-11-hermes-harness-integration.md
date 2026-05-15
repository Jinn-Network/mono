# Hermes harness integration — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate NousResearch's `hermes-agent` as a third solver harness option on the SWE-rebench v2 SolverNet, alongside Claude Code and Codex. Adapter package at `client/src/harnesses/impls/hermes-agent/`; configures Hermes per-Task via `$HERMES_HOME/config.yaml`; freeze contract enforced by daemon hash-fence on `HERMES_HOME = ctx.implStateDir`.

**Architecture:** Two-PR-stack: a preconditional naming refactor (`claude-code-learner/` → `learner/` for impl dir + plugin dir; preserves on-chain `Executor.implName` via existing alias logic in `names.ts`), then a sibling `hermes-agent/` Harness package that does not load the `learner` plugin. The adapter reads each SolverPlugin's standard `.mcp.json` and `skills/` dir, emits Hermes's `mcp_servers:` and `skills.external_dirs:` in a per-Task config.yaml, writes an explicit `platform_toolsets:` allowlist (Hermes defaults include footguns under unattended automation), and spawns `hermes chat -q "<prompt>" --model X --provider Y -w <workingDir>` with `HERMES_HOME=ctx.implStateDir`. Followed by a dashboard PR adding the `/operator` join row option with a `hermes doctor` precheck, and a runbook + e2e PR.

**Tech Stack:** TypeScript / Node.js, vitest, Hardhat (for Anvil e2e), Hermes (external CLI installed via `curl -fsSL …/install.sh | bash`), agentskills.io SKILL.md format, standard MCP stdio protocol.

**Spec:** `docs/superpowers/specs/2026-05-11-hermes-harness-design.md` (v0.1)

**Bead lineage:** `jinn-mono-8psp` (epic) · `jinn-mono-8psp.1` (design — closed by this plan landing) · file follow-ups for the implementation child beads as new bd issues.

---

## File structure map

### Files moved (Phase A — naming refactor)

| From | To |
|---|---|
| `client/src/harnesses/impls/claude-code-learner/` | `client/src/harnesses/impls/learner/` |
| `client/plugins/claude-code-learner/` | `client/plugins/learner/` |
| `client/test/harnesses/impls/claude-code-learner/` | `client/test/harnesses/impls/learner/` |
| `client/test/e2e/claude-code-learner-full-cycle.ts` | `client/test/e2e/learner-full-cycle.ts` |
| `client/test/e2e/claude-code-learner-portfolio-v0.ts` | `client/test/e2e/learner-portfolio-v0.ts` |

### Files renamed / changed in place (Phase A)

| File | Change |
|---|---|
| `client/src/harnesses/impls/learner/harness.ts` | Class rename: `ClaudeCodeLearnerImpl` → `LearnerHarness` |
| `client/src/harnesses/impls/learner/plugin-path.ts` | Resolve `plugins/learner/` instead of `plugins/claude-code-learner/` |
| `client/src/harnesses/names.ts` | `harnessStateDirName()` still returns `'claude-code-learner'` / `'codex-code-learner'` (on-chain stability) — verify the alias logic remains intact |
| All importers of `from './claude-code-learner/...'` | Mechanical s/claude-code-learner/learner/ on imports only |

### Files created (Phase B — hermes-agent package)

| File | Responsibility |
|---|---|
| `client/src/harnesses/impls/hermes-agent/index.ts` | Re-exports HermesHarness and HermesHarnessAdapter |
| `client/src/harnesses/impls/hermes-agent/harness.ts` | `class HermesHarness implements Harness` — entry point; delegates lifecycle to adapter |
| `client/src/harnesses/impls/hermes-agent/adapter.ts` | `class HermesHarnessAdapter` — spawn lifecycle, abort handling, log piping |
| `client/src/harnesses/impls/hermes-agent/config-builder.ts` | `hermesConfigFromSolverPlugins()` — reads `.mcp.json` + `skills/`, emits Hermes config snippet |
| `client/src/harnesses/impls/hermes-agent/prompt.ts` | `buildInitialPrompt(inputs)` — Jinn-task prompt template, reuses `sweRebenchV2Guidance` |
| `client/src/harnesses/impls/hermes-agent/bootstrap.ts` | Per-Task: HERMES_HOME setup, config.yaml + .env write, env scrub |
| `client/src/harnesses/impls/hermes-agent/freeze.ts` | Wraps daemon hash-fence around HERMES_HOME |
| `client/src/harnesses/impls/hermes-agent/harvest.ts` | Reads `.execute/solution-payload.json` from workingDir (delegates to shared harvest) |
| `client/src/harnesses/impls/hermes-agent/test-utils.ts` | Stub spawn helper + fake `.mcp.json` fixtures for unit tests |

### Files modified (Phase B + D)

| File | Change |
|---|---|
| `client/src/harnesses/names.ts` | Add `HERMES_AGENT_HARNESS = 'hermes-agent'` |
| `client/src/harnesses/impls/index.ts` | Register `HermesHarness` in `buildHarnesses()`; extend `HarnessEnv` with `hermesPath`, `hermesModel`, `hermesProvider` |
| `client/src/config.ts` | Add config keys: `hermesPath`, `hermesModel`, `hermesProvider`, `hermesDoctorTimeoutMs` + env overrides |
| `client/src/dashboard/spa/src/pages/configuration/harnessNames.ts` | Add `HERMES_AGENT_HARNESS = 'hermes-agent'` constant + display name entry |
| `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx` | Add Hermes Agent radio to the harness selector + install precheck panel for `hermes-agent` selection |
| `client/src/dashboard/spa/src/pages/configuration/NetCard.tsx` and `JoinedNetCard.tsx` | Display `hermes-agent` as a known harness option |
| `client/src/api/server.ts` | Add an endpoint that runs `hermes doctor` and returns exit-code + stdout (used by the precheck panel) |
| `docs/runbooks/swe-rebench-v2-public-testnet.md` | Add Hermes selection section after Claude/Codex paragraph |

### Files created (Phase C — tests)

| File | Responsibility |
|---|---|
| `client/test/harnesses/impls/hermes-agent/config-builder.test.ts` | Manifest translator unit tests against `network-tools` + `swe-rebench-v2-runtime` fixtures + hypothetical HTTP MCP fixture |
| `client/test/harnesses/impls/hermes-agent/prompt.test.ts` | Prompt builder unit tests (covers SWE-rebench v2 guidance injection) |
| `client/test/harnesses/impls/hermes-agent/adapter.test.ts` | Spawn lifecycle unit tests (mirrors `codex-code-adapter.test.ts`) |
| `client/test/harnesses/impls/hermes-agent/freeze.test.ts` | Deliberate-violation fixture → hash-fence rejection + rollback |
| `client/test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts` | Full local roundtrip with stubbed Hermes binary |
| `client/test/dashboard/HarnessSection.e2e.test.ts` | Extend existing test for the three-option harness selector + Hermes precheck |
| `client/test/e2e/hermes-agent-full-cycle.ts` | Anvil-fork e2e mirroring `learner-full-cycle.ts` shape |

---

# PR 1 — Naming refactor (preconditional)

This PR is mechanical: directory moves + import-path updates + one class rename + one plugin-path-resolution update. No behavior change. All existing tests pass after; on-chain `Executor.implName` values stay `'claude-code'` / `'codex'` via the alias logic in `names.ts`. Lands as its own clean-diff PR before any Hermes work.

### Task 1.1: Verify baseline green

**Files:**
- None — read-only check

- [ ] **Step 1: Confirm we're on the worktree branch**

```bash
cd cargo/.claude/worktrees/8psp.1-hermes-design
git branch --show-current
# Expected: worktree-8psp.1-hermes-design
git status
# Expected: clean working tree (or only the spec + plan we just added)
```

- [ ] **Step 2: Run typecheck and tests to baseline**

```bash
cd client
yarn typecheck
yarn vitest run \
  test/harnesses/impls/claude-code-learner \
  test/captures/envelope-shape-isomorphism.test.ts \
  test/cli/commands/solver-nets.test.ts
```

Expected: zero typecheck errors; all referenced tests pass. If any fail before we touch anything, **stop** — establish baseline first by filing a bd and fixing.

### Task 1.2: Rename impl directory

**Files:**
- Move: `client/src/harnesses/impls/claude-code-learner/` → `client/src/harnesses/impls/learner/`

- [ ] **Step 1: Use `git mv` so history follows**

```bash
cd client/src/harnesses/impls
git mv claude-code-learner learner
git status
# Expected: ~7 renames staged (harness.ts, harvest.ts, plugin-path.ts, types.ts, index.ts, plus adapters/ and test-utils/ subdirectories)
```

- [ ] **Step 2: Verify nothing left behind**

```bash
ls claude-code-learner 2>&1
# Expected: "No such file or directory"
ls learner
# Expected: adapters/  harness.ts  harvest.ts  index.ts  plugin-path.ts  test-utils/  types.ts
```

### Task 1.3: Rename plugin directory

**Files:**
- Move: `client/plugins/claude-code-learner/` → `client/plugins/learner/`

- [ ] **Step 1: `git mv` plugin directory**

```bash
cd ../../../plugins  # back to client/plugins
git mv claude-code-learner learner
ls learner
# Expected: AGENTS.md  CLAUDE.md  README.md  .claude-plugin/  .codex-plugin/  hooks/  skills/
```

### Task 1.4: Update `plugin-path.ts` resolution

**Files:**
- Modify: `client/src/harnesses/impls/learner/plugin-path.ts`

- [ ] **Step 1: Update the resolved plugin path**

Replace the line that constructs `pluginRoot`:

```ts
// Before:
const pluginRoot = join(packageRoot, 'plugins', 'claude-code-learner');

// After:
const pluginRoot = join(packageRoot, 'plugins', 'learner');
```

Update the error messages and JSDoc layout assumption in the same file:

```ts
/**
 * Resolve the learner plugin root from the impl directory's
 * runtime location.
 *
 * Layout assumption: this file lives at
 *   <package>/<src-or-dist>/harnesses/impls/learner/plugin-path.{ts,js}
 * and the plugin lives at
 *   <package>/plugins/learner/
 *
 * Walks up four directories from this file (impls → harness → src/dist →
 * package root) then descends into plugins/learner/. Verifies the
 * expected layout exists and throws with a clear message if not.
 */
export function resolvePluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..', '..', '..');
  const pluginRoot = join(packageRoot, 'plugins', 'learner');

  if (!existsSync(pluginRoot)) {
    throw new Error(
      `learner plugin not found at expected path: ${pluginRoot}. ` +
        `Resolved from impl dir: ${here}.`,
    );
  }
  if (!existsSync(join(pluginRoot, 'skills', 'learn', 'SKILL.md'))) {
    throw new Error(
      `learner plugin at ${pluginRoot} is missing skills/learn/SKILL.md`,
    );
  }
  return pluginRoot;
}
```

### Task 1.5: Rename the shell class

**Files:**
- Modify: `client/src/harnesses/impls/learner/harness.ts`

- [ ] **Step 1: Class rename — `ClaudeCodeLearnerImpl` → `LearnerHarness`**

In `client/src/harnesses/impls/learner/harness.ts`, rename the class:

```ts
// Before:
export class ClaudeCodeLearnerImpl implements Harness { … }

// After:
export class LearnerHarness implements Harness { … }
```

Also rename the config type if it references the old name:

```ts
// In types.ts (same dir):
// Before:
export interface ClaudeCodeLearnerConfig { … }

// After:
export interface LearnerHarnessConfig { … }
```

- [ ] **Step 2: Update re-exports in `index.ts`**

```ts
// Before:
export { ClaudeCodeLearnerImpl } from './harness.js';

// After:
export { LearnerHarness } from './harness.js';
```

If `index.ts` re-exports `ClaudeCodeLearnerConfig`, update that name too.

### Task 1.6: Mechanical import-path rewrite across codebase

**Files:**
- Many — touches `client/src/**`, `client/test/**`, root `package.json` if it references the path

This is a search-and-replace of import paths only (not identity strings — those stay).

- [ ] **Step 1: Identify all files importing from the old impl path**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/8psp.1-hermes-design
grep -rl "from.*claude-code-learner" client/src client/test client/scripts 2>&1 | grep -v node_modules
```

- [ ] **Step 2: Sed-rewrite import paths**

```bash
grep -rl "from.*claude-code-learner" client/src client/test client/scripts 2>&1 | grep -v node_modules \
  | xargs sed -i '' "s|impls/claude-code-learner|impls/learner|g"
```

- [ ] **Step 3: Sed-rewrite class-name references**

```bash
grep -rl "ClaudeCodeLearnerImpl" client/src client/test 2>&1 | grep -v node_modules \
  | xargs sed -i '' "s|ClaudeCodeLearnerImpl|LearnerHarness|g"

grep -rl "ClaudeCodeLearnerConfig" client/src client/test 2>&1 | grep -v node_modules \
  | xargs sed -i '' "s|ClaudeCodeLearnerConfig|LearnerHarnessConfig|g"
```

- [ ] **Step 4: Verify the on-chain identity strings are untouched**

```bash
grep -rn "'claude-code-learner'\|\"claude-code-learner\"" client/src/harnesses/names.ts client/src/harnesses/impls
# Expected: at least one match per alias in names.ts:
#   'claude-code-learner': CLAUDE_CODE_HARNESS,
#   'codex-code-learner': CODEX_HARNESS,
# (These are identity strings and MUST stay unchanged.)
```

If those alias rows in `names.ts` were accidentally rewritten, restore them — they're load-bearing for on-chain identity continuity.

### Task 1.7: Update plugin-dir references in test utility constants

**Files:**
- Modify: `client/test/harnesses/impls/learner/codex-code-adapter.test.ts` and any other test with hardcoded plugin path

- [ ] **Step 1: Fix the plugin-root URL constant**

```bash
grep -rln "plugins/claude-code-learner" client/test 2>&1 | head -10
# Expected: a handful of test files
```

In each, update the URL:

```ts
// Before:
const learnerPluginRoot = fileURLToPath(new URL('../../../../plugins/claude-code-learner/', import.meta.url));

// After:
const learnerPluginRoot = fileURLToPath(new URL('../../../../plugins/learner/', import.meta.url));
```

Sed shortcut for the path string (NOT the identity string):

```bash
grep -rl "plugins/claude-code-learner" client/src client/test 2>&1 | grep -v node_modules \
  | xargs sed -i '' "s|plugins/claude-code-learner|plugins/learner|g"
```

### Task 1.8: Verify identity strings stay intact in `names.ts`

**Files:**
- Read-only: `client/src/harnesses/names.ts`

- [ ] **Step 1: Confirm aliases unchanged**

```bash
cat client/src/harnesses/names.ts
```

Expected content (no edits — verify):

```ts
export const CLAUDE_CODE_HARNESS = 'claude-code';
export const CODEX_HARNESS = 'codex';

const HARNESS_ALIASES: Record<string, string> = {
  'claude-code-learner': CLAUDE_CODE_HARNESS,
  'codex-code-learner': CODEX_HARNESS,
};

…

export function harnessStateDirName(name: string): string {
  const canonical = canonicalHarnessName(name);
  if (canonical === CLAUDE_CODE_HARNESS) return 'claude-code-learner';
  if (canonical === CODEX_HARNESS) return 'codex-code-learner';
  return canonical;
}
```

These strings are observable on-chain (`Executor.implName`) and via on-disk state dir paths — they MUST remain unchanged. The directory was renamed; the identity string was not.

### Task 1.9: Update test file path (e2e helpers)

**Files:**
- Move: `client/test/e2e/claude-code-learner-full-cycle.ts` → `client/test/e2e/learner-full-cycle.ts`
- Move: `client/test/e2e/claude-code-learner-portfolio-v0.ts` → `client/test/e2e/learner-portfolio-v0.ts`

- [ ] **Step 1: `git mv` e2e helpers**

```bash
cd client/test/e2e
git mv claude-code-learner-full-cycle.ts learner-full-cycle.ts
git mv claude-code-learner-portfolio-v0.ts learner-portfolio-v0.ts
```

- [ ] **Step 2: Update importers**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/8psp.1-hermes-design
grep -rl "claude-code-learner-full-cycle\|claude-code-learner-portfolio-v0" client/test client/scripts 2>&1 | grep -v node_modules \
  | xargs sed -i '' \
    -e "s|claude-code-learner-full-cycle|learner-full-cycle|g" \
    -e "s|claude-code-learner-portfolio-v0|learner-portfolio-v0|g"
```

### Task 1.10: Run typecheck and tests

**Files:**
- None — verification

- [ ] **Step 1: Typecheck**

```bash
cd client
yarn typecheck
```

Expected: zero errors. If errors appear, they will be import-path-related — read them, fix the missed file, re-run.

- [ ] **Step 2: Run impacted test files**

```bash
yarn vitest run \
  test/harnesses/impls/learner \
  test/captures/envelope-shape-isomorphism.test.ts \
  test/cli/commands/solver-nets.test.ts \
  test/preflight/claude-required.test.ts \
  test/api/launcher-status.test.ts \
  test/dashboard/HarnessSection.e2e.test.ts
```

Expected: all pass.

- [ ] **Step 3: Run full suite to catch anything we missed**

```bash
yarn test
```

Expected: green. Any failures here are missed import paths — `grep -rl "claude-code-learner"` in `client/src` and `client/test` and verify each surviving occurrence is intentional (identity string in `names.ts`, docs reference, plugin dir's own `.claude-plugin/` JSON that references the plugin name verbatim).

### Task 1.11: Verify docs are honest

**Files:**
- Modify: `client/README.md`, `client/TESTNET_ACCEPTANCE.md` — only update if they reference the directory path; leave alone if they reference the historical identity string

- [ ] **Step 1: Find doc references**

```bash
grep -n "claude-code-learner" client/README.md client/TESTNET_ACCEPTANCE.md
```

Read each match and decide:

- If the reference describes a **file path** (e.g., "see `client/src/harnesses/impls/claude-code-learner/`"), update to `learner/`.
- If the reference describes the **historical identity** (e.g., "the `claude-code-learner` impl that was renamed in v1.x"), leave it.

For most doc references in this codebase, they're identity-shaped; minimal edits expected here.

### Task 1.12: Commit Phase A

**Files:**
- None — staging is already done across tasks

- [ ] **Step 1: Stage everything**

```bash
git add -A
git status
# Expected: ~7 file renames in client/src/harnesses/impls/learner/, ~10 renames in client/plugins/learner/,
# ~5 test moves, and modified imports across ~30 files.
```

- [ ] **Step 2: Commit**

```bash
git commit -m "$(cat <<'EOF'
refactor: rename claude-code-learner package to learner (preconditional for hermes-agent)

The `claude-code-learner` impl directory and plugin directory are misnamed:
both are reused by Codex via the same shell class (`ClaudeCodeLearnerImpl` →
`LearnerHarness`) and plugin. Hermes integration would compound the misdirection
if it followed the same naming. This PR renames:

- client/src/harnesses/impls/claude-code-learner/  →  learner/
- client/plugins/claude-code-learner/              →  learner/
- ClaudeCodeLearnerImpl class                      →  LearnerHarness
- Test paths + e2e helpers
- Mechanical import-path updates across ~30 files

The on-chain `Executor.implName` values stay stable via the existing
alias logic in `client/src/harnesses/names.ts` — `'claude-code-learner'` and
`'codex-code-learner'` continue to map to canonical `'claude-code'` and `'codex'`.
No envelope migration, no operator-side state-dir migration.

Precondition for jinn-mono-8psp (Hermes harness integration epic). Spec
`docs/superpowers/specs/2026-05-11-hermes-harness-design.md` §7.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 3: Verify build still clean**

```bash
yarn build
```

Expected: builds cleanly. If `yarn build` errors, fix and amend.

---

# PR 2 — HermesHarness package + unit tests

The meat of the work. Builds the `hermes-agent` Harness package as a sibling to `learner/`, with TDD throughout.

### Task 2.1: Add `HERMES_AGENT_HARNESS` canonical name

**Files:**
- Modify: `client/src/harnesses/names.ts`

- [ ] **Step 1: Add the constant**

```ts
// In client/src/harnesses/names.ts, after CODEX_HARNESS:
export const CLAUDE_CODE_HARNESS = 'claude-code';
export const CODEX_HARNESS = 'codex';
export const HERMES_AGENT_HARNESS = 'hermes-agent';   // NEW
```

Update `harnessStateDirName()` to handle the new canonical:

```ts
export function harnessStateDirName(name: string): string {
  const canonical = canonicalHarnessName(name);
  if (canonical === CLAUDE_CODE_HARNESS) return 'claude-code-learner';
  if (canonical === CODEX_HARNESS) return 'codex-code-learner';
  if (canonical === HERMES_AGENT_HARNESS) return 'hermes-agent';   // NEW — no -learner suffix, no legacy alias
  return canonical;
}
```

No `HARNESS_ALIASES` entry needed — Hermes is new and has no legacy identity to alias.

- [ ] **Step 2: Verify typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/names.ts
git commit -m "feat: add HERMES_AGENT_HARNESS canonical name"
```

### Task 2.2: Write the failing config-builder test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/config-builder.test.ts`

- [ ] **Step 1: Create the test file**

```ts
// client/test/harnesses/impls/hermes-agent/config-builder.test.ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hermesConfigFromSolverPlugins } from '../../../../src/harnesses/impls/hermes-agent/config-builder.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));
const sweRuntimeRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));

function fakeEnv() {
  return {
    storePath: '/tmp/jinn.db',
    daemonApiUrl: 'http://127.0.0.1:7331',
    daemonApiToken: 'tok-test',
    corpusEnv: {
      subgraphUrl: 'https://subgraph.example/',
      ipfsGatewayUrl: 'https://ipfs.example/',
      rpcUrl: 'https://rpc.example/',
      chainId: 8453,
      identityRegistryAddress: '0xabc',
      fromBlock: 0,
    },
  };
}

describe('hermesConfigFromSolverPlugins', () => {
  it('translates network-tools .mcp.json into mcp_servers with absolute paths', () => {
    const out = hermesConfigFromSolverPlugins([networkToolsRoot], fakeEnv());

    expect(out.mcp_servers).toBeDefined();
    const jinnClient = out.mcp_servers!['jinn-client'];
    expect(jinnClient).toBeDefined();
    expect(jinnClient.command).toBe('node');
    // Args must be absolute (resolved against plugin root from the relative "mcp/jinn-client-server.mjs")
    expect(jinnClient.args).toEqual([expect.stringMatching(/network-tools\/mcp\/jinn-client-server\.mjs$/)]);
    // cwd resolves from "." → the plugin root
    expect(jinnClient.cwd).toMatch(/network-tools\/?$/);
    // Env vars passed through from runtime
    expect(jinnClient.env?.STORE_PATH).toBe('/tmp/jinn.db');
    expect(jinnClient.env?.DAEMON_API_URL).toBe('http://127.0.0.1:7331');
    expect(jinnClient.env?.DAEMON_API_TOKEN).toBe('tok-test');
    expect(jinnClient.env?.JINN_CORPUS_SUBGRAPH_URL).toBe('https://subgraph.example/');
    expect(jinnClient.env?.JINN_CORPUS_IPFS_GATEWAY_URL).toBe('https://ipfs.example/');
    expect(jinnClient.env?.JINN_CORPUS_RPC_URL).toBe('https://rpc.example/');
    expect(jinnClient.env?.JINN_CORPUS_CHAIN_ID).toBe('8453');
  });

  it('adds skills/ dir to skills.external_dirs when present', () => {
    const out = hermesConfigFromSolverPlugins([sweRuntimeRoot], fakeEnv());

    expect(out.skills?.external_dirs).toEqual([
      expect.stringMatching(/swe-rebench-v2-runtime\/skills$/),
    ]);
  });

  it('handles plugins with neither .mcp.json nor skills/ as no-op', () => {
    // A plugin root pointing at a tmp dir with nothing relevant
    const tmpRoot = fileURLToPath(new URL('./fixtures/empty-plugin/', import.meta.url));
    const out = hermesConfigFromSolverPlugins([tmpRoot], fakeEnv());

    expect(out.mcp_servers ?? {}).toEqual({});
    expect(out.skills?.external_dirs ?? []).toEqual([]);
  });

  it('does not consult jinn.plugin.json or providedBy', () => {
    // Even if jinn.plugin.json says providedBy: jinn-client-runtime, the translator
    // emits config solely from .mcp.json (which is what we just verified above).
    // No assertion needed beyond the absence of failure — this test exists to
    // document the design intent and catch regressions if someone re-adds
    // a providedBy branch.
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 2: Create the empty fixture dir**

```bash
mkdir -p client/test/harnesses/impls/hermes-agent/fixtures/empty-plugin
touch client/test/harnesses/impls/hermes-agent/fixtures/empty-plugin/.gitkeep
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd client
yarn vitest run test/harnesses/impls/hermes-agent/config-builder.test.ts
```

Expected: FAIL with "Cannot find module '…/config-builder.js'" or similar.

### Task 2.3: Implement config-builder

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/config-builder.ts`

- [ ] **Step 1: Write the implementation**

```ts
// client/src/harnesses/impls/hermes-agent/config-builder.ts
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface McpStdioServer {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpHttpServer {
  url: string;
  headers?: Record<string, string>;
}

export type McpServer = McpStdioServer | McpHttpServer;

export interface HermesConfigSnippet {
  mcp_servers?: Record<string, McpServer>;
  skills?: { external_dirs?: string[] };
}

export interface ConfigBuilderEnv {
  storePath?: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  corpusEnv: {
    subgraphUrl?: string;
    ipfsGatewayUrl?: string;
    rpcUrl?: string;
    chainId?: number;
    identityRegistryAddress?: string;
    fromBlock?: number;
  };
}

function buildJinnRuntimeEnv(env: ConfigBuilderEnv): Record<string, string> {
  const out: Record<string, string> = {
    DAEMON_API_URL: env.daemonApiUrl,
    DAEMON_API_TOKEN: env.daemonApiToken,
  };
  if (env.storePath) out.STORE_PATH = env.storePath;
  if (env.corpusEnv.subgraphUrl) out.JINN_CORPUS_SUBGRAPH_URL = env.corpusEnv.subgraphUrl;
  if (env.corpusEnv.ipfsGatewayUrl) out.JINN_CORPUS_IPFS_GATEWAY_URL = env.corpusEnv.ipfsGatewayUrl;
  if (env.corpusEnv.rpcUrl) out.JINN_CORPUS_RPC_URL = env.corpusEnv.rpcUrl;
  if (env.corpusEnv.chainId != null) out.JINN_CORPUS_CHAIN_ID = String(env.corpusEnv.chainId);
  if (env.corpusEnv.identityRegistryAddress) {
    out.JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS = env.corpusEnv.identityRegistryAddress;
  }
  if (env.corpusEnv.fromBlock != null) out.JINN_CORPUS_FROM_BLOCK = String(env.corpusEnv.fromBlock);
  return out;
}

function resolvePathTemplate(value: string, pluginRoot: string): string {
  // Resolve ${CLAUDE_PLUGIN_ROOT} / ${CODEX_PLUGIN_ROOT} → pluginRoot,
  // then resolve relative paths against pluginRoot.
  const substituted = value
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replaceAll('${CODEX_PLUGIN_ROOT}', pluginRoot);
  if (isAbsolute(substituted)) return substituted;
  return resolve(pluginRoot, substituted);
}

function translateMcpFromFile(pluginRoot: string, jinnEnv: Record<string, string>): Record<string, McpServer> {
  const mcpFile = join(pluginRoot, '.mcp.json');
  if (!existsSync(mcpFile)) return {};

  const raw = JSON.parse(readFileSync(mcpFile, 'utf8')) as {
    mcpServers?: Record<string, McpStdioServer | McpHttpServer>;
  };
  const servers = raw.mcpServers ?? {};
  const out: Record<string, McpServer> = {};

  for (const [name, server] of Object.entries(servers)) {
    if ('url' in server) {
      // HTTP MCP — pass through unchanged (no path resolution needed)
      out[name] = { url: server.url, ...(server.headers ? { headers: server.headers } : {}) };
      continue;
    }
    // Stdio MCP — resolve paths and merge env
    const resolvedArgs = server.args.map((a) => resolvePathTemplate(a, pluginRoot));
    const resolvedCwd = server.cwd ? resolvePathTemplate(server.cwd, pluginRoot) : pluginRoot;
    out[name] = {
      command: server.command,
      args: resolvedArgs,
      cwd: resolvedCwd,
      env: { ...jinnEnv, ...(server.env ?? {}) },
    };
  }
  return out;
}

function translateSkillsDir(pluginRoot: string): string | null {
  const skillsDir = join(pluginRoot, 'skills');
  return existsSync(skillsDir) ? skillsDir : null;
}

export function hermesConfigFromSolverPlugins(
  roots: readonly string[],
  env: ConfigBuilderEnv,
): HermesConfigSnippet {
  const jinnEnv = buildJinnRuntimeEnv(env);
  const mcpServers: Record<string, McpServer> = {};
  const externalDirs: string[] = [];

  for (const root of roots) {
    Object.assign(mcpServers, translateMcpFromFile(root, jinnEnv));
    const skills = translateSkillsDir(root);
    if (skills) externalDirs.push(skills);
  }

  const snippet: HermesConfigSnippet = {};
  if (Object.keys(mcpServers).length > 0) snippet.mcp_servers = mcpServers;
  if (externalDirs.length > 0) snippet.skills = { external_dirs: externalDirs };
  return snippet;
}
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/config-builder.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/config-builder.ts \
        client/test/harnesses/impls/hermes-agent/config-builder.test.ts \
        client/test/harnesses/impls/hermes-agent/fixtures/empty-plugin/.gitkeep
git commit -m "feat(hermes): config-builder translates .mcp.json + skills/ → Hermes config snippet"
```

### Task 2.4: Add HTTP MCP fixture test

**Files:**
- Modify: `client/test/harnesses/impls/hermes-agent/config-builder.test.ts`
- Create: `client/test/harnesses/impls/hermes-agent/fixtures/http-mcp-plugin/.mcp.json`

- [ ] **Step 1: Create fixture for a hypothetical Path-2 HTTP MCP plugin**

```bash
mkdir -p client/test/harnesses/impls/hermes-agent/fixtures/http-mcp-plugin
```

```json
// client/test/harnesses/impls/hermes-agent/fixtures/http-mcp-plugin/.mcp.json
{
  "mcpServers": {
    "third-party": {
      "url": "https://third-party.example/mcp",
      "headers": {
        "Authorization": "Bearer hypothetical-token"
      }
    }
  }
}
```

- [ ] **Step 2: Add the test case**

Append to `config-builder.test.ts` (inside the existing `describe`):

```ts
  it('passes HTTP MCP url/headers through unchanged', () => {
    const httpRoot = fileURLToPath(new URL('./fixtures/http-mcp-plugin/', import.meta.url));
    const out = hermesConfigFromSolverPlugins([httpRoot], fakeEnv());

    const tp = out.mcp_servers!['third-party'] as { url: string; headers?: Record<string, string> };
    expect(tp.url).toBe('https://third-party.example/mcp');
    expect(tp.headers?.Authorization).toBe('Bearer hypothetical-token');
  });
```

- [ ] **Step 3: Run the test**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/config-builder.test.ts
```

Expected: PASS (all four cases).

- [ ] **Step 4: Commit**

```bash
git add client/test/harnesses/impls/hermes-agent
git commit -m "test(hermes): cover HTTP MCP server pass-through in config-builder"
```

### Task 2.5: Write the failing prompt test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/prompt.test.ts`

- [ ] **Step 1: Create the test**

```ts
// client/test/harnesses/impls/hermes-agent/prompt.test.ts
import { describe, expect, it } from 'vitest';
import { buildInitialPrompt } from '../../../../src/harnesses/impls/hermes-agent/prompt.js';
import type { TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

function baseInputs(): TaskSessionInputs {
  return {
    taskId: 't-1',
    requestId: 'req-1',
    taskCid: 'bafy…',
    solverType: 'swe-rebench-v2.v1',
    implStateDir: '/state',
    workingDir: '/wd',
    windowStartTs: 0,
    windowEndTs: 9_999_999_999_999,
    msUntilEndTs: 9_999_999_999,
    abort: new AbortController().signal,
    mode: 'train',
    taskBody: {
      id: 't-1',
      description: 'fix the netcdf bug',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'Unidata/netcdf-c', base_commit: 'a'.repeat(40) },
    },
  };
}

describe('buildInitialPrompt', () => {
  it('includes Jinn task framing and delivery instruction', () => {
    const p = buildInitialPrompt(baseInputs());
    expect(p).toContain('Jinn task');
    expect(p).toContain('submit_typed_payload');
    expect(p).toContain('/wd');
    expect(p).toContain('/state');
    expect(p).toContain('train');
  });

  it('includes SWE-rebench v2 guidance when solverType matches', () => {
    const p = buildInitialPrompt(baseInputs());
    expect(p).toContain('SWE-rebench v2');
    expect(p).toContain('Unidata/netcdf-c');
    expect(p).toContain('a'.repeat(40));
    expect(p).toContain('submit_typed_payload');
  });

  it('omits SWE-rebench guidance for non-SWE solver types', () => {
    const inputs = baseInputs();
    inputs.taskBody!.solverType = 'prediction.v1';
    inputs.solverType = 'prediction.v1';
    const p = buildInitialPrompt(inputs);
    expect(p).not.toContain('SWE-rebench v2 restoration');
  });

  it('omits SWE-rebench guidance for evaluation role', () => {
    const inputs = baseInputs();
    inputs.taskBody!.role = 'evaluation';
    const p = buildInitialPrompt(inputs);
    expect(p).not.toContain('SWE-rebench v2 restoration');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/prompt.test.ts
```

Expected: FAIL — module not found.

### Task 2.6: Implement prompt builder

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/prompt.ts`

- [ ] **Step 1: Implementation — reuse logic from learner adapter**

The codex adapter has a `sweRebenchV2Guidance(inputs)` helper. Copy that pattern (it's short and SWE-specific; modest duplication is fine).

```ts
// client/src/harnesses/impls/hermes-agent/prompt.ts
import type { TaskSessionInputs } from '../learner/types.js';

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function taskBodyRecord(inputs: TaskSessionInputs): Record<string, unknown> | null {
  return nestedRecord(inputs.taskBody);
}

function sweRebenchV2Guidance(inputs: TaskSessionInputs): string[] {
  const body = taskBodyRecord(inputs);
  if (body?.solverType !== 'swe-rebench-v2.v1' || body.role === 'evaluation') {
    return [];
  }
  const spec = nestedRecord(body.spec);
  const repo = typeof spec?.repo === 'string' && spec.repo.trim() ? spec.repo.trim() : '<goal.spec.repo>';
  const baseCommit = typeof spec?.base_commit === 'string' && spec.base_commit.trim()
    ? spec.base_commit.trim()
    : '<goal.spec.base_commit>';
  return [
    '',
    'SWE-rebench v2 restoration requirements:',
    `- Use ${inputs.workingDir}/repo as the only task repository checkout. Do not reuse a repo from another workingDir or from implStateDir.`,
    `- If ${inputs.workingDir}/repo/.git is missing, clone https://github.com/${repo}.git into ${inputs.workingDir}/repo and checkout ${baseCommit} before editing.`,
    '- Before planning, use Network Tools to search donated SWE execution data: call search_records, inspect_record, and acquire_artifact for useful donated IPFS records.',
    `- Submit the final swe-rebench-v2-solution.v1 payload by calling submit_typed_payload. Do not write ${inputs.workingDir}/.execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, write {"schemaVersion":"swe-rebench-v2-solution.v1","patch":"<unified diff>"} to that path.`,
    `- If you rely on the harvester git-diff fallback, the patch must be present as git diff output under ${inputs.workingDir}/repo.`,
  ];
}

export function buildInitialPrompt(inputs: TaskSessionInputs): string {
  return [
    'You are executing a Jinn task.',
    'Complete the task described by the task payload below.',
    'Use the available skills, tools, and runtime context exposed by this harness.',
    'Keep all task work inside `workingDir`.',
    'When the task requires a typed SolverNet payload, call submit_typed_payload. Do not write .execute/solution-payload.json directly unless submit_typed_payload is unavailable; if fallback is required, the file must match the exact SolverNet schema.',
    ...sweRebenchV2Guidance(inputs),
    '',
    'Session inputs:',
    `- goal.id = ${inputs.taskId}`,
    inputs.taskCid ? `- goal.cid = ${inputs.taskCid}` : '',
    `- workingDir = ${inputs.workingDir}`,
    `- implStateDir = ${inputs.implStateDir}`,
    `- goal.deadline = ${inputs.windowEndTs} (ms since epoch)`,
    `- msUntilDeadline = ${inputs.msUntilEndTs}`,
    `- mode = ${inputs.mode}`,
    inputs.taskBody
      ? `\ngoal (full body):\n${JSON.stringify(inputs.taskBody, null, 2)}`
      : '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
```

- [ ] **Step 2: Verify test passes**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/prompt.test.ts
```

Expected: PASS (all four cases).

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/prompt.ts \
        client/test/harnesses/impls/hermes-agent/prompt.test.ts
git commit -m "feat(hermes): buildInitialPrompt with SWE-rebench v2 guidance"
```

### Task 2.7: Write the failing bootstrap test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/bootstrap.test.ts`

- [ ] **Step 1: Test**

```ts
// client/test/harnesses/impls/hermes-agent/bootstrap.test.ts
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { writePerTaskHermesConfig } from '../../../../src/harnesses/impls/hermes-agent/bootstrap.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

describe('writePerTaskHermesConfig', () => {
  it('writes config.yaml with mcp_servers, skills, terminal, and toolset allowlist', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        model: 'anthropic/claude-opus-4.6',
        provider: 'anthropic',
        solverPluginRoots: [networkToolsRoot],
        env: {
          storePath: '/tmp/jinn.db',
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok',
          corpusEnv: {},
        },
      });

      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      expect(yaml).toContain('mcp_servers:');
      expect(yaml).toContain('jinn-client');
      expect(yaml).toContain('terminal:');
      expect(yaml).toContain('backend: local');
      expect(yaml).toContain('cwd: /work');
      expect(yaml).toContain('platform_toolsets:');
      expect(yaml).toContain('hermes-cli:');
      expect(yaml).toContain('- terminal');
      expect(yaml).toContain('- file');
      expect(yaml).toContain('- web');
      expect(yaml).toContain('- skills');
      expect(yaml).toContain('- memory');
      expect(yaml).toContain('- session_search');
      expect(yaml).toContain('- todo');
      expect(yaml).toContain('- code_execution');
      // Footgun toolsets MUST NOT appear
      expect(yaml).not.toContain('- messaging');
      expect(yaml).not.toContain('- cronjob');
      expect(yaml).not.toContain('- browser');
      expect(yaml).not.toContain('- computer_use');
      // Model block
      expect(yaml).toContain("default: \"anthropic/claude-opus-4.6\"");
      expect(yaml).toContain('provider: "anthropic"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes .env with daemon credentials', () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    try {
      writePerTaskHermesConfig({
        hermesHome: home,
        workingDir: '/work',
        solverPluginRoots: [],
        env: {
          daemonApiUrl: 'http://127.0.0.1:7331',
          daemonApiToken: 'tok-xyz',
          corpusEnv: { subgraphUrl: 'https://subgraph.example/' },
        },
      });

      const envFile = readFileSync(join(home, '.env'), 'utf8');
      expect(envFile).toContain('DAEMON_API_TOKEN=tok-xyz');
      expect(envFile).toContain('DAEMON_API_URL=http://127.0.0.1:7331');
      expect(envFile).toContain('JINN_CORPUS_SUBGRAPH_URL=https://subgraph.example/');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/bootstrap.test.ts
```

Expected: FAIL — module not found.

### Task 2.8: Implement bootstrap

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/bootstrap.ts`

- [ ] **Step 1: Implementation**

```ts
// client/src/harnesses/impls/hermes-agent/bootstrap.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hermesConfigFromSolverPlugins,
  type ConfigBuilderEnv,
  type HermesConfigSnippet,
} from './config-builder.js';

const TOOLSET_ALLOWLIST = [
  'terminal',
  'file',
  'web',
  'skills',
  'memory',
  'session_search',
  'todo',
  'code_execution',
];

export interface WritePerTaskConfigInputs {
  hermesHome: string;
  workingDir: string;
  model?: string;
  provider?: string;
  solverPluginRoots: readonly string[];
  env: ConfigBuilderEnv;
}

function snippetToYaml(snippet: HermesConfigSnippet, opts: { model?: string; provider?: string; workingDir: string }): string {
  const lines: string[] = [];

  // Model block
  if (opts.model || opts.provider) {
    lines.push('model:');
    if (opts.model) lines.push(`  default: "${opts.model}"`);
    if (opts.provider) lines.push(`  provider: "${opts.provider}"`);
    lines.push('');
  }

  // Terminal block
  lines.push('terminal:');
  lines.push('  backend: local');
  lines.push(`  cwd: ${opts.workingDir}`);
  lines.push('  timeout: 180');
  lines.push('');

  // Toolset allowlist
  lines.push('platform_toolsets:');
  lines.push('  hermes-cli:');
  for (const ts of TOOLSET_ALLOWLIST) {
    lines.push(`    - ${ts}`);
  }
  lines.push('');

  // MCP servers (translated from SolverPlugin .mcp.json)
  if (snippet.mcp_servers && Object.keys(snippet.mcp_servers).length > 0) {
    lines.push('mcp_servers:');
    for (const [name, server] of Object.entries(snippet.mcp_servers)) {
      lines.push(`  ${name}:`);
      if ('url' in server) {
        lines.push(`    url: "${server.url}"`);
        if (server.headers) {
          lines.push('    headers:');
          for (const [h, v] of Object.entries(server.headers)) {
            lines.push(`      ${h}: "${v}"`);
          }
        }
      } else {
        lines.push(`    command: "${server.command}"`);
        lines.push('    args:');
        for (const a of server.args) lines.push(`      - "${a}"`);
        if (server.cwd) lines.push(`    cwd: "${server.cwd}"`);
        if (server.env && Object.keys(server.env).length > 0) {
          lines.push('    env:');
          for (const [k, v] of Object.entries(server.env)) {
            lines.push(`      ${k}: "${v.replaceAll('"', '\\"')}"`);
          }
        }
      }
    }
    lines.push('');
  }

  // Skills
  if (snippet.skills?.external_dirs && snippet.skills.external_dirs.length > 0) {
    lines.push('skills:');
    lines.push('  external_dirs:');
    for (const d of snippet.skills.external_dirs) {
      lines.push(`    - "${d}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function snippetToEnvFile(env: ConfigBuilderEnv): string {
  const lines: string[] = [];
  lines.push(`DAEMON_API_URL=${env.daemonApiUrl}`);
  lines.push(`DAEMON_API_TOKEN=${env.daemonApiToken}`);
  if (env.storePath) lines.push(`STORE_PATH=${env.storePath}`);
  if (env.corpusEnv.subgraphUrl) lines.push(`JINN_CORPUS_SUBGRAPH_URL=${env.corpusEnv.subgraphUrl}`);
  if (env.corpusEnv.ipfsGatewayUrl) lines.push(`JINN_CORPUS_IPFS_GATEWAY_URL=${env.corpusEnv.ipfsGatewayUrl}`);
  if (env.corpusEnv.rpcUrl) lines.push(`JINN_CORPUS_RPC_URL=${env.corpusEnv.rpcUrl}`);
  if (env.corpusEnv.chainId != null) lines.push(`JINN_CORPUS_CHAIN_ID=${env.corpusEnv.chainId}`);
  if (env.corpusEnv.identityRegistryAddress) lines.push(`JINN_CORPUS_IDENTITY_REGISTRY_ADDRESS=${env.corpusEnv.identityRegistryAddress}`);
  if (env.corpusEnv.fromBlock != null) lines.push(`JINN_CORPUS_FROM_BLOCK=${env.corpusEnv.fromBlock}`);
  return lines.join('\n') + '\n';
}

export function writePerTaskHermesConfig(inputs: WritePerTaskConfigInputs): void {
  mkdirSync(inputs.hermesHome, { recursive: true });

  const snippet = hermesConfigFromSolverPlugins(inputs.solverPluginRoots, inputs.env);
  const yaml = snippetToYaml(snippet, {
    model: inputs.model,
    provider: inputs.provider,
    workingDir: inputs.workingDir,
  });
  writeFileSync(join(inputs.hermesHome, 'config.yaml'), yaml, 'utf8');

  const envFile = snippetToEnvFile(inputs.env);
  writeFileSync(join(inputs.hermesHome, '.env'), envFile, 'utf8');
}
```

- [ ] **Step 2: Run the test**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/bootstrap.ts \
        client/test/harnesses/impls/hermes-agent/bootstrap.test.ts
git commit -m "feat(hermes): writePerTaskHermesConfig emits config.yaml + .env with toolset allowlist"
```

### Task 2.9: Write the failing adapter test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/adapter.test.ts`

- [ ] **Step 1: Test (mirrors codex-code-adapter.test.ts shape)**

```ts
// client/test/harnesses/impls/hermes-agent/adapter.test.ts
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HermesHarnessAdapter } from '../../../../src/harnesses/impls/hermes-agent/adapter.js';
import type { TaskSessionInputs } from '../../../../src/harnesses/impls/learner/types.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));

type SpawnCall = {
  command: string;
  args: string[];
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
};

function fakeHermesChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    return true;
  });
  setImmediate(() => {
    child.emit('exit', 0, null);
  });
  return child;
}

function inputs(workingDir: string, implStateDir: string): TaskSessionInputs {
  return {
    taskId: 'task-1',
    requestId: 'req-1',
    taskCid: 'bafy…',
    solverType: 'swe-rebench-v2.v1',
    model: 'anthropic/claude-opus-4.6',
    implStateDir,
    workingDir,
    pluginRoots: [networkToolsRoot],
    windowStartTs: 0,
    windowEndTs: Date.now() + 60_000,
    msUntilEndTs: 60_000,
    abort: new AbortController().signal,
    mode: 'train',
    taskBody: {
      id: 'task-1',
      description: 'test',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
      spec: { repo: 'Unidata/netcdf-c', base_commit: 'a'.repeat(40) },
    },
  };
}

describe('HermesHarnessAdapter', () => {
  it('spawns hermes chat -q with model/provider flags and HERMES_HOME env', async () => {
    const spawnCalls: SpawnCall[] = [];
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        hermesProvider: 'anthropic',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((command: string, args: string[], options: any) => {
          spawnCalls.push({ command, args, options });
          return fakeHermesChild() as any;
        }) as any,
      });

      await adapter.runTask(inputs(work, home));

      expect(spawnCalls).toHaveLength(1);
      const call = spawnCalls[0];
      expect(call.command).toBe('/bin/fake-hermes');
      expect(call.args).toContain('chat');
      expect(call.args).toContain('-q');
      expect(call.args).toContain('--model');
      expect(call.args).toContain('anthropic/claude-opus-4.6');
      expect(call.args).toContain('--provider');
      expect(call.args).toContain('anthropic');
      expect(call.args).toContain('-w');
      expect(call.args).toContain(work);
      expect(call.options.env?.HERMES_HOME).toBe(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('forwards abort signal to SIGTERM on the child', async () => {
    const controller = new AbortController();
    const home = mkdtempSync(join(tmpdir(), 'hermes-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-wd-'));
    let child: ReturnType<typeof fakeHermesChild> | null = null;

    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn((_c: string, _a: string[], _o: any) => {
          child = fakeHermesChild();
          // Override the auto-exit so the test can abort mid-run
          (child as any).removeAllListeners('exit');
          return child as any;
        }) as any,
      });

      const taskInputs = inputs(work, home);
      taskInputs.abort = controller.signal;

      const runPromise = adapter.runTask(taskInputs);
      // Allow spawn to register listeners
      await new Promise((r) => setImmediate(r));

      controller.abort();
      expect(child!.kill).toHaveBeenCalledWith('SIGTERM');

      // Resolve the run by emitting exit
      child!.emit('exit', null, 'SIGTERM');
      await runPromise;
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/adapter.test.ts
```

Expected: FAIL — module not found.

### Task 2.10: Implement adapter

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/adapter.ts`

- [ ] **Step 1: Implementation (mirrors codex-code.ts structure)**

```ts
// client/src/harnesses/impls/hermes-agent/adapter.ts
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import type { TaskSessionInputs } from '../learner/types.js';
import { writePerTaskHermesConfig } from './bootstrap.js';
import { buildInitialPrompt } from './prompt.js';
import type { ConfigBuilderEnv } from './config-builder.js';

const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'NODE_PATH', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX',
];

export interface HermesHarnessAdapterConfig {
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
  daemonApiUrl: string;
  daemonApiToken: string;
  corpusEnv: ConfigBuilderEnv['corpusEnv'];
  storePath?: string;
  _spawnFn?: typeof spawn;
}

function buildAgentEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return { ...env, ...extra };
}

export class HermesHarnessAdapter {
  readonly name = 'hermes-agent';

  private readonly hermesPath: string;
  private readonly hermesModel: string | undefined;
  private readonly hermesProvider: string | undefined;
  private readonly daemonApiUrl: string;
  private readonly daemonApiToken: string;
  private readonly corpusEnv: ConfigBuilderEnv['corpusEnv'];
  private readonly storePath: string | undefined;
  private readonly spawnFn: typeof spawn;

  constructor(config: HermesHarnessAdapterConfig) {
    this.hermesPath = config.hermesPath ?? 'hermes';
    this.hermesModel = config.hermesModel;
    this.hermesProvider = config.hermesProvider;
    this.daemonApiUrl = config.daemonApiUrl;
    this.daemonApiToken = config.daemonApiToken;
    this.corpusEnv = config.corpusEnv;
    this.storePath = config.storePath;
    this.spawnFn = config._spawnFn ?? spawn;
  }

  async runTask(inputs: TaskSessionInputs): Promise<void> {
    const hermesHome = inputs.implStateDir;
    const model = inputs.model ?? this.hermesModel;

    // Step 1: bootstrap — write config.yaml + .env
    writePerTaskHermesConfig({
      hermesHome,
      workingDir: inputs.workingDir,
      model,
      provider: this.hermesProvider,
      solverPluginRoots: inputs.pluginRoots ?? [],
      env: {
        storePath: this.storePath,
        daemonApiUrl: this.daemonApiUrl,
        daemonApiToken: this.daemonApiToken,
        corpusEnv: this.corpusEnv,
      },
    });

    // Step 2: build prompt + args
    const prompt = buildInitialPrompt(inputs);
    const args: string[] = ['chat', '-q', prompt];
    if (model) {
      args.push('--model', model);
    }
    if (this.hermesProvider) {
      args.push('--provider', this.hermesProvider);
    }
    args.push('-w', inputs.workingDir);

    const env = buildAgentEnv({
      HERMES_HOME: hermesHome,
    });

    const spawnOpts: SpawnOptions = {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      cwd: inputs.workingDir,
    };

    // Step 3: spawn + lifecycle
    return new Promise<void>((resolvePromise, reject) => {
      const logDir = join(inputs.workingDir, '.hermes-agent');
      mkdirSync(logDir, { recursive: true });
      const stdoutLog = createWriteStream(join(logDir, 'stdout.log'), { flags: 'a' });
      const stderrLog = createWriteStream(join(logDir, 'stderr.log'), { flags: 'a' });
      const closeLogs = async (): Promise<void> => {
        if (!stdoutLog.writableEnded) stdoutLog.end();
        if (!stderrLog.writableEnded) stderrLog.end();
        await Promise.all([finished(stdoutLog), finished(stderrLog)]);
      };

      const child: ChildProcess = this.spawnFn(this.hermesPath, args, spawnOpts);

      if (inputs.abort.aborted) {
        if (!child.killed) child.kill('SIGTERM');
      }
      const onAbort = () => {
        if (!child.killed) child.kill('SIGTERM');
      };
      inputs.abort.addEventListener('abort', onAbort);

      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => stdoutLog.write(d));
      child.stderr?.on('data', (d: Buffer) => {
        stderrLog.write(d);
        stderr += d.toString();
      });

      let settled = false;
      const settle = (cb: () => void, onLogErr: (e: Error) => void = reject) => {
        if (settled) return;
        settled = true;
        inputs.abort.removeEventListener('abort', onAbort);
        closeLogs().then(cb, onLogErr);
      };

      child.on('exit', (code, signal) => {
        settle(() => {
          if (code === 0) {
            resolvePromise();
          } else if (inputs.abort.aborted) {
            resolvePromise(); // graceful-abort exits are success
          } else {
            reject(new Error(
              `hermes-agent: child exited code=${code} signal=${signal}: ${stderr.slice(0, 500)}`,
            ));
          }
        });
      });

      child.on('error', (err) => {
        settle(() => reject(err), () => reject(err));
      });
    });
  }
}
```

- [ ] **Step 2: Verify tests pass**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/adapter.test.ts
```

Expected: PASS (both cases).

- [ ] **Step 3: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/adapter.ts \
        client/test/harnesses/impls/hermes-agent/adapter.test.ts
git commit -m "feat(hermes): HermesHarnessAdapter spawns hermes chat -q with per-Task config"
```

### Task 2.11: Write the failing harness shell test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/harness.test.ts`

- [ ] **Step 1: Test**

```ts
// client/test/harnesses/impls/hermes-agent/harness.test.ts
import { describe, expect, it, vi } from 'vitest';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HERMES_AGENT_HARNESS } from '../../../../src/harnesses/names.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

describe('HermesHarness', () => {
  it('reports name = hermes-agent', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.name).toBe(HERMES_AGENT_HARNESS);
    expect(h.name).toBe('hermes-agent');
  });

  it('supports() rejects evaluation role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'evaluation' })).toBe(false);
  });

  it('supports() accepts SWE-rebench v2 restoration role', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'swe-rebench-v2.v1', role: 'restoration' })).toBe(true);
  });

  it('supports() rejects non-SWE solver types for v1', () => {
    const fakeAdapter = { name: 'hermes-agent', runTask: vi.fn() };
    const h = new HermesHarness({ adapter: fakeAdapter as any });
    expect(h.supports({ solverType: 'prediction.v1', role: 'restoration' })).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/harness.test.ts
```

Expected: FAIL — module not found.

### Task 2.12: Implement HermesHarness shell

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/harness.ts`
- Create: `client/src/harnesses/impls/hermes-agent/index.ts`

- [ ] **Step 1: Implement harness.ts**

```ts
// client/src/harnesses/impls/hermes-agent/harness.ts
import type { Harness, HarnessContext, Solution } from '../../types.js';
import { HERMES_AGENT_HARNESS } from '../../names.js';
import type { HermesHarnessAdapter } from './adapter.js';
import { harvestOutput } from '../learner/harvest.js';

export interface HermesHarnessConfig {
  adapter: HermesHarnessAdapter;
  version?: string;
}

/**
 * Hermes Agent harness.
 *
 * v1 scope: SWE-rebench v2 solver role only. Built-in learning loop owned
 * by Hermes (skill self-improvement, memory curation, FTS5 session search);
 * Jinn-side learner plugin is NOT loaded. SolverPlugins (network-tools,
 * swe-rebench-v2-runtime) are mounted via Hermes's mcp_servers + skills
 * config.yaml surface (see config-builder.ts).
 */
export class HermesHarness implements Harness {
  readonly name = HERMES_AGENT_HARNESS;
  readonly version: string;
  private readonly adapter: HermesHarnessAdapter;

  constructor(config: HermesHarnessConfig) {
    this.adapter = config.adapter;
    this.version = config.version ?? '0.1.0';
  }

  supports(spec: { solverType: string; role?: 'restoration' | 'evaluation' }): boolean {
    if (spec.role === 'evaluation') return false;
    // v1 scope: SWE-rebench v2 only.
    return spec.solverType === 'swe-rebench-v2.v1';
  }

  async run(ctx: HarnessContext): Promise<Solution> {
    const window = ctx.task.window ?? { startTs: 0, endTs: 0 };
    await this.adapter.runTask({
      taskId: ctx.task.id,
      requestId: ctx.requestId,
      taskCid: ctx.taskCid,
      solverType: ctx.task.solverType,
      model: ctx.solverNet?.model,
      claudeModel: ctx.solverNet?.model,
      taskBody: ctx.task as any,
      implStateDir: ctx.implStateDir,
      workingDir: ctx.workingDir,
      pluginRoots: [...(ctx.solverPluginRoots ?? [])],
      windowStartTs: window.startTs,
      windowEndTs: window.endTs,
      msUntilEndTs: ctx.msUntilEndTs(),
      abort: ctx.abort,
      mode: ctx.mode,
    });

    const solution = await harvestOutput(ctx.workingDir, undefined, ctx.task);
    return { ...solution, venueRef: { ...solution.venueRef, name: this.name } };
  }
}
```

- [ ] **Step 2: Implement index.ts**

```ts
// client/src/harnesses/impls/hermes-agent/index.ts
export { HermesHarness } from './harness.js';
export { HermesHarnessAdapter } from './adapter.js';
export {
  hermesConfigFromSolverPlugins,
  type HermesConfigSnippet,
  type ConfigBuilderEnv,
  type McpServer,
} from './config-builder.js';
export { buildInitialPrompt } from './prompt.js';
export { writePerTaskHermesConfig } from './bootstrap.js';
```

- [ ] **Step 3: Verify tests pass**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/harness.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/harness.ts \
        client/src/harnesses/impls/hermes-agent/index.ts \
        client/test/harnesses/impls/hermes-agent/harness.test.ts
git commit -m "feat(hermes): HermesHarness shell, supports() scoped to swe-rebench-v2.v1 solver role"
```

### Task 2.13: Add freeze-fence wrapper

**Files:**
- Create: `client/src/harnesses/impls/hermes-agent/freeze.ts`
- Create: `client/test/harnesses/impls/hermes-agent/freeze.test.ts`

The freeze fence is the shared mechanism from `agent-harness-solvernet-design` §6.3 applied to HERMES_HOME. Reuse the existing `hashImplStateDir` and `runHarnessWithFreezeFence` from `client/src/harness/` if they're available; if not, this task adds the Hermes-specific wrapper.

- [ ] **Step 1: Check if shared freeze fence already exists**

```bash
ls client/src/harness/freeze.ts client/src/daemon/freeze-fence.ts 2>&1
```

Two possibilities:

- **(a) Files exist** — they came from a prior freeze-mode implementation (SWE-rebench v2 plan). Wrapper file is trivially small; mainly composes the existing infrastructure.
- **(b) Files don't exist** — freeze-fence has not landed yet. In that case, this task and the freeze-fence test below are deferred until the SWE-rebench v2 freeze-mode plan lands them; file a bd to track. The Hermes adapter still works in train mode without the fence; frozen mode acceptance is gated on the upstream work.

- [ ] **Step 2: If (a), write the Hermes-specific wrapper**

```ts
// client/src/harnesses/impls/hermes-agent/freeze.ts
import { runHarnessWithFreezeFence } from '../../../daemon/freeze-fence.js';
import type { Harness, HarnessContext, Solution } from '../../types.js';
import type { HermesHarness } from './harness.js';

/**
 * Wraps a HermesHarness run with the daemon hash-fence. In frozen mode,
 * HERMES_HOME (= ctx.implStateDir) is snapshotted before the run and
 * re-hashed after; mismatch → rollback + envelope rejection.
 *
 * In train mode, the wrapper is pass-through.
 */
export async function runHermesWithFreezeFence(
  harness: HermesHarness,
  ctx: HarnessContext,
): Promise<Solution> {
  const result = await runHarnessWithFreezeFence(harness as unknown as Harness, ctx);
  if (!result.ok) {
    throw new Error(`hermes-agent: freeze contract violated: ${JSON.stringify(result.violation)}`);
  }
  return result.output as Solution;
}
```

- [ ] **Step 3: Write the freeze fence test (deliberate-violation fixture)**

```ts
// client/test/harnesses/impls/hermes-agent/freeze.test.ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runHermesWithFreezeFence } from '../../../../src/harnesses/impls/hermes-agent/freeze.js';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';

describe('runHermesWithFreezeFence', () => {
  it('rolls back HERMES_HOME on frozen-mode mutation and rejects the envelope', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-frozen-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-frozen-wd-'));
    writeFileSync(join(home, 'before.txt'), 'snapshot');

    try {
      // Build a HermesHarness whose adapter intentionally writes to HERMES_HOME
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          writeFileSync(join(home, 'violation.txt'), 'forbidden write');
        },
      };
      const harness = new HermesHarness({ adapter: fakeAdapter as any });

      const ctx = {
        task: { id: 't', solverType: 'swe-rebench-v2.v1', role: 'restoration', window: { startTs: 0, endTs: Date.now() + 60_000 }, spec: {} },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'frozen' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
        // … other fields the actual HarnessContext requires
      } as unknown as HarnessContext;

      await expect(runHermesWithFreezeFence(harness, ctx)).rejects.toThrow(/freeze contract violated/);
      // Rollback: violation.txt should have been removed
      expect(() => readFileSync(join(home, 'violation.txt'))).toThrow();
      expect(readFileSync(join(home, 'before.txt'), 'utf8')).toBe('snapshot');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('train mode is pass-through (writes are allowed)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-train-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-train-wd-'));
    try {
      const fakeAdapter = {
        name: 'hermes-agent',
        runTask: async () => {
          writeFileSync(join(home, 'learned.txt'), 'continuous learning');
        },
      };
      const harness = new HermesHarness({ adapter: fakeAdapter as any });
      const ctx = {
        task: { id: 't', solverType: 'swe-rebench-v2.v1', role: 'restoration', window: { startTs: 0, endTs: Date.now() + 60_000 }, spec: {} },
        requestId: 'r',
        implStateDir: home,
        workingDir: work,
        mode: 'train' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
        solverPluginRoots: [],
      } as unknown as HarnessContext;

      // Mock harvestOutput to return a stub solution for this train-mode test
      vi.mock('../learner/harvest.js', () => ({
        harvestOutput: async () => ({ schemaVersion: 'swe-rebench-v2-solution.v1', patch: '', venueRef: { name: 'hermes-agent' } }),
      }));

      await runHermesWithFreezeFence(harness, ctx).catch(() => null); // ignore mocking complications; we only care about the side effect
      expect(readFileSync(join(home, 'learned.txt'), 'utf8')).toBe('continuous learning');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 4: Run the freeze test**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/freeze.test.ts
```

Expected: PASS if the shared freeze fence exists; if not, file `bd create --type=task --title="Hermes freeze-fence integration once shared fence lands"` and skip until upstream lands.

- [ ] **Step 5: Commit**

```bash
git add client/src/harnesses/impls/hermes-agent/freeze.ts \
        client/test/harnesses/impls/hermes-agent/freeze.test.ts
git commit -m "feat(hermes): freeze-fence wrapper composes daemon hash-fence on HERMES_HOME"
```

### Task 2.14: Wire HermesHarness into `buildHarnesses()`

**Files:**
- Modify: `client/src/harnesses/impls/index.ts`

- [ ] **Step 1: Add Hermes config fields to HarnessEnv**

```ts
// In client/src/harnesses/impls/index.ts, extend HarnessEnv:
export interface HarnessEnv {
  // … existing fields …
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
}
```

- [ ] **Step 2: Add HermesHarness construction at end of buildHarnesses()**

After the existing Codex registration:

```ts
import { HermesHarness, HermesHarnessAdapter } from './hermes-agent/index.js';

// … inside buildHarnesses(), after the Codex push:

const hermesAdapter = new HermesHarnessAdapter({
  hermesPath: env.hermesPath,
  hermesModel: env.hermesModel,
  hermesProvider: env.hermesProvider,
  daemonApiUrl: env.daemonApiUrl ?? 'http://127.0.0.1:7331',
  daemonApiToken: env.daemonApiToken ?? '',
  storePath: env.storePath,
  corpusEnv: env.corpusEnv ?? {},
});
out.push(new HermesHarness({ adapter: hermesAdapter }));
```

- [ ] **Step 3: Run unit tests on the impls registry**

```bash
yarn vitest run test/harnesses/impls
yarn typecheck
```

Expected: green.

- [ ] **Step 4: Commit**

```bash
git add client/src/harnesses/impls/index.ts
git commit -m "feat(hermes): register HermesHarness in buildHarnesses()"
```

### Task 2.15: Add config schema for Hermes

**Files:**
- Modify: `client/src/config.ts`

- [ ] **Step 1: Add config keys + env overrides**

```ts
// In client/src/config.ts, find the existing config schema and add:

export interface Config {
  // … existing fields …
  hermesPath?: string;
  hermesModel?: string;
  hermesProvider?: string;
  hermesDoctorTimeoutMs?: number;
}

// In loadConfig() or equivalent, add env overrides:
// (Pattern mirrors existing codexPath / codexModel handling)
const hermesPath = process.env['JINN_HERMES_PATH']?.trim() || fileConfig.hermesPath || 'hermes';
const hermesModel = process.env['JINN_HERMES_MODEL']?.trim() || fileConfig.hermesModel;
const hermesProvider = process.env['JINN_HERMES_PROVIDER']?.trim() || fileConfig.hermesProvider;
const hermesDoctorTimeoutMs = parseInt(process.env['JINN_HERMES_DOCTOR_TIMEOUT_MS'] ?? '', 10) || fileConfig.hermesDoctorTimeoutMs || 30_000;
```

- [ ] **Step 2: Pass through to main.ts entry**

In `client/src/main.ts` where `buildHarnesses({ ... })` is called, add the new fields:

```ts
const harnesses = buildHarnesses({
  // … existing fields …
  hermesPath: config.hermesPath,
  hermesModel: config.hermesModel,
  hermesProvider: config.hermesProvider,
});
```

- [ ] **Step 3: Add config test coverage**

In `client/test/config.test.ts`, add cases for each new key:

```ts
it('loads hermesPath / hermesModel / hermesProvider from config file', () => {
  const cfg = parseConfig({
    rpcUrl: 'http://anvil',
    hermesPath: '/usr/local/bin/hermes',
    hermesModel: 'anthropic/claude-opus-4.6',
    hermesProvider: 'anthropic',
  });
  expect(cfg.hermesPath).toBe('/usr/local/bin/hermes');
  expect(cfg.hermesModel).toBe('anthropic/claude-opus-4.6');
  expect(cfg.hermesProvider).toBe('anthropic');
});

it('env vars override hermes config values', () => {
  process.env.JINN_HERMES_PATH = '/opt/hermes/bin/hermes';
  try {
    const cfg = parseConfig({ rpcUrl: 'http://anvil' });
    expect(cfg.hermesPath).toBe('/opt/hermes/bin/hermes');
  } finally {
    delete process.env.JINN_HERMES_PATH;
  }
});
```

- [ ] **Step 4: Run tests**

```bash
yarn vitest run test/config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/config.ts client/src/main.ts client/test/config.test.ts
git commit -m "feat(hermes): add hermesPath/hermesModel/hermesProvider config keys + env overrides"
```

### Task 2.16: Add SWE-rebench v2 roundtrip test

**Files:**
- Create: `client/test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts`

- [ ] **Step 1: Write the roundtrip test (mirrors codex roundtrip pattern, with stubbed Hermes)**

```ts
// client/test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { SweRebenchV2SolutionPayloadSchema } from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { HermesHarness } from '../../../../src/harnesses/impls/hermes-agent/harness.js';
import { HermesHarnessAdapter } from '../../../../src/harnesses/impls/hermes-agent/adapter.js';
import type { HarnessContext } from '../../../../src/harnesses/types.js';
import type { Task } from '../../../../src/types/task.js';

const networkToolsRoot = fileURLToPath(new URL('../../../../plugins/network-tools/', import.meta.url));
const sweRuntimeRoot = fileURLToPath(new URL('../../../../plugins/swe-rebench-v2-runtime/', import.meta.url));

function fakeHermes(workingDir: string): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; killed: boolean; kill: any } {
  // Simulate Hermes: writes a valid solution payload to workingDir/.execute/solution-payload.json then exits 0
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = vi.fn();
  setImmediate(() => {
    mkdirSync(join(workingDir, '.execute'), { recursive: true });
    writeFileSync(
      join(workingDir, '.execute/solution-payload.json'),
      JSON.stringify({ schemaVersion: 'swe-rebench-v2-solution.v1', patch: '--- a/file\n+++ b/file\n' }),
    );
    child.emit('exit', 0, null);
  });
  return child;
}

function sweTask(): Task {
  return {
    id: 'swe-rebench-task-1',
    description: 'swe-rebench-v2 restoration task',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    window: { startTs: 0, endTs: Date.now() + 60_000 },
    spec: {
      schemaVersion: 'swe-rebench-v2.v1',
      instance_id: 'unidata__netcdf-c-1925',
      repo: 'Unidata/netcdf-c',
      base_commit: 'a'.repeat(40),
      language: 'c',
      problem_statement: 'fix the netcdf bug',
      interface: '',
      hf_dataset: 'nebius/SWE-rebench-leaderboard',
      hf_split: '2026_02',
      deadline_unix: Math.floor(Date.now() / 1000) + 3600,
      round_month: '2026-05',
    },
  } as unknown as Task;
}

describe('hermes-agent SWE-rebench v2 roundtrip', () => {
  it('produces a Solution conforming to the schema with stubbed Hermes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hermes-rt-home-'));
    const work = mkdtempSync(join(tmpdir(), 'hermes-rt-wd-'));
    try {
      const adapter = new HermesHarnessAdapter({
        hermesPath: '/bin/fake-hermes',
        hermesModel: 'anthropic/claude-opus-4.6',
        hermesProvider: 'anthropic',
        daemonApiUrl: 'http://127.0.0.1:7331',
        daemonApiToken: 'tok',
        corpusEnv: {},
        _spawnFn: vi.fn(() => fakeHermes(work) as any) as any,
      });
      const harness = new HermesHarness({ adapter });

      const ctx = {
        task: sweTask(),
        requestId: '0x' + '7'.repeat(64),
        solverNet: { model: 'anthropic/claude-opus-4.6' },
        implStateDir: home,
        workingDir: work,
        solverPluginRoots: [networkToolsRoot, sweRuntimeRoot],
        mode: 'train' as const,
        abort: new AbortController().signal,
        msUntilEndTs: () => 60_000,
      } as unknown as HarnessContext;

      const solution = await harness.run(ctx);

      // Verify the Solution validates against the SDK schema
      const parsed = SweRebenchV2SolutionPayloadSchema.safeParse(solution.solutionPayload);
      expect(parsed.success).toBe(true);
      expect(solution.venueRef.name).toBe('hermes-agent');

      // Verify Hermes config was written
      const yaml = readFileSync(join(home, 'config.yaml'), 'utf8');
      expect(yaml).toContain('mcp_servers:');
      expect(yaml).toContain('platform_toolsets:');
      expect(yaml).toContain('skills:');
      expect(yaml).toContain('swe-rebench-v2-runtime/skills');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run roundtrip**

```bash
yarn vitest run test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/test/harnesses/impls/hermes-agent/swe-rebench-v2-roundtrip.test.ts
git commit -m "test(hermes): SWE-rebench v2 roundtrip with stubbed Hermes binary"
```

### Task 2.17: Run full test suite and typecheck

**Files:**
- None — verification

- [ ] **Step 1: Typecheck**

```bash
cd client
yarn typecheck
```

Expected: zero errors.

- [ ] **Step 2: Run all impl tests**

```bash
yarn vitest run test/harnesses/impls
yarn vitest run test/config.test.ts
```

Expected: green.

- [ ] **Step 3: Run full suite (catches integration regressions)**

```bash
yarn test
```

Expected: green. If reds appear in unrelated areas, investigate — most likely cause is a missed import path from Phase A (run the same `grep -rl "claude-code-learner"` audit and inspect each remaining match).

- [ ] **Step 4: Build**

```bash
yarn build
```

Expected: builds cleanly. Verify `dist/harnesses/impls/hermes-agent/` exists.

### Task 2.18: Open PR 2

**Files:**
- None — PR creation

- [ ] **Step 1: Push branch and open PR**

```bash
cd /Users/adrianobradley/harbor/jinn-mono/cargo/.claude/worktrees/8psp.1-hermes-design
git push -u origin worktree-8psp.1-hermes-design
gh pr create --title "feat: hermes-agent harness package (jinn-mono-8psp.2)" --body "$(cat <<'EOF'
## Summary

- Adds `client/src/harnesses/impls/hermes-agent/` as a sibling Harness package to `learner/`.
- Adapter spawns `hermes chat -q` with per-Task `\$HERMES_HOME/config.yaml` (model, mcp_servers from SolverPlugin .mcp.json, skills from SolverPlugin skills/, explicit toolset allowlist).
- Hermes's built-in learning loop drives orchestration; no learner plugin loaded.
- Freeze contract via `HERMES_HOME = ctx.implStateDir` + daemon hash-fence (composes with existing freeze-fence infrastructure).
- Restricted to SWE-rebench v2 solver role for v1; expands later.
- Config keys: hermesPath / hermesModel / hermesProvider / hermesDoctorTimeoutMs.

Implements spec: docs/superpowers/specs/2026-05-11-hermes-harness-design.md
Plan: docs/superpowers/plans/2026-05-11-hermes-harness-integration.md (PR 2 of 4)

## Test plan
- [ ] yarn typecheck passes
- [ ] yarn vitest run test/harnesses/impls/hermes-agent passes (config-builder, prompt, bootstrap, adapter, harness, freeze, roundtrip)
- [ ] yarn test full suite green
- [ ] yarn build produces dist/harnesses/impls/hermes-agent

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

PR 2 includes the changes from PR 1 if they haven't been merged yet (stacked PRs). If PR 1 has merged to main, rebase before opening.

---

# PR 3 — Operator dashboard UX

Adds the third harness radio to the `/operator` join row + the `hermes doctor` precheck.

### Task 3.1: Add `HERMES_AGENT_HARNESS` to dashboard harness names

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/configuration/harnessNames.ts`

- [ ] **Step 1: Mirror the server-side constant + add display name**

```ts
// client/src/dashboard/spa/src/pages/configuration/harnessNames.ts

export const CLAUDE_CODE_HARNESS = 'claude-code';
export const CODEX_HARNESS = 'codex';
export const HERMES_AGENT_HARNESS = 'hermes-agent';   // NEW

const HARNESS_ALIASES: Record<string, string> = {
  'claude-code-learner': CLAUDE_CODE_HARNESS,
  'codex-code-learner': CODEX_HARNESS,
};

const DISPLAY_NAMES: Record<string, string> = {
  [CLAUDE_CODE_HARNESS]: 'Claude Code',
  [CODEX_HARNESS]: 'Codex',
  [HERMES_AGENT_HARNESS]: 'Hermes Agent',   // NEW
  'swe-rebench-v2-evaluator': 'SWE-rebench v2 Evaluator',
};

// ... rest unchanged
```

- [ ] **Step 2: Typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors. Any TS errors in this file mean we missed an import expecting the new constant — read and fix.

### Task 3.2: Add Hermes Agent radio to `JoinFlow.tsx`

**Files:**
- Modify: `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx`
- Modify: `client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx`

- [ ] **Step 1: Find the existing harness radio group**

```bash
grep -n "Claude Code\|CLAUDE_CODE_HARNESS\|CODEX_HARNESS\|harness" client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx | head -20
```

The component renders radios using `CLAUDE_CODE_HARNESS` and `CODEX_HARNESS` as values. Identify the JSX block (or `HARNESS_OPTIONS` const if extracted).

- [ ] **Step 2: Add the third radio**

```tsx
// In JoinFlow.tsx — inside the harness radio group:

import {
  CLAUDE_CODE_HARNESS,
  CODEX_HARNESS,
  HERMES_AGENT_HARNESS,   // NEW
  harnessDisplayName,
} from '../configuration/harnessNames.js';

// In the radio JSX:
<label>
  <input type="radio" value={CLAUDE_CODE_HARNESS} checked={harness === CLAUDE_CODE_HARNESS} onChange={…} />
  {harnessDisplayName(CLAUDE_CODE_HARNESS)} (default)
</label>
<label>
  <input type="radio" value={CODEX_HARNESS} checked={harness === CODEX_HARNESS} onChange={…} />
  {harnessDisplayName(CODEX_HARNESS)}
</label>
<label>
  <input type="radio" value={HERMES_AGENT_HARNESS} checked={harness === HERMES_AGENT_HARNESS} onChange={…} />
  {harnessDisplayName(HERMES_AGENT_HARNESS)} (requires separate install)
</label>
```

If the component currently uses a `HARNESS_OPTIONS` const array, extend that array instead. Keep the description copy aligned with the runbook:

```ts
const HERMES_AGENT_DESCRIPTION =
  'Self-improving agent by Nous Research. Built-in learning loop, 200+ models via OpenRouter plus Nous Portal, NVIDIA NIM, GLM, Kimi, and more.';
```

- [ ] **Step 3: Extend `JoinFlow.test.tsx`**

Add an assertion that the new radio renders:

```ts
it('renders three harness options including Hermes Agent', () => {
  render(<JoinFlow … />);
  expect(screen.getByRole('radio', { name: /Claude Code/i })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Codex/i })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Hermes Agent/i })).toBeInTheDocument();
});
```

- [ ] **Step 4: Run tests**

```bash
yarn vitest run test/dashboard/spa-config.e2e.test.ts \
                client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add client/src/dashboard/spa/src/pages/configuration/harnessNames.ts \
        client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.tsx \
        client/src/dashboard/spa/src/pages/operator-catalog/JoinFlow.test.tsx
git commit -m "feat(operator): Hermes Agent option in /operator join flow harness selector"
```

### Task 3.3: Add `/api/hermes/doctor` daemon endpoint

**Files:**
- Modify: `client/src/api/server.ts` (or wherever operator-API routes live)

- [ ] **Step 1: Add the route**

```ts
// In server.ts, add a GET route that runs `hermes doctor` and returns exit code + stdout/stderr
app.get('/api/hermes/doctor', async (c) => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(config.hermesPath ?? 'hermes', ['doctor'], {
    timeout: config.hermesDoctorTimeoutMs ?? 30_000,
    encoding: 'utf8',
  });
  return c.json({
    installed: result.status !== null && result.error?.code !== 'ENOENT',
    exitCode: result.status,
    stdout: result.stdout?.slice(0, 4000) ?? '',
    stderr: result.stderr?.slice(0, 4000) ?? '',
  });
});
```

- [ ] **Step 2: Add a route test**

```ts
// client/test/api/hermes-doctor-endpoint.test.ts
import { describe, expect, it } from 'vitest';
// Use the existing API test harness if there is one — pattern from launcher-status.test.ts
// Test cases:
//   - hermes binary not installed → installed: false, exitCode: null
//   - hermes binary present, exits 0 → installed: true, exitCode: 0
//   - hermes binary present, exits 1 (config issue) → installed: true, exitCode: 1, stderr contains diagnostic
```

- [ ] **Step 3: Run the new test**

```bash
yarn vitest run test/api/hermes-doctor-endpoint.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/api/server.ts client/test/api/hermes-doctor-endpoint.test.ts
git commit -m "feat(operator): /api/hermes/doctor endpoint for install precheck"
```

### Task 3.4: Add install-required panel to operator UX

**Files:**
- Modify: dashboard component handling the harness selector

- [ ] **Step 1: Wire the precheck**

When the operator selects `hermes-agent` and clicks Save, fire `GET /api/hermes/doctor` first. Three cases:

```tsx
function HermesPrecheckPanel({ onSuccess, onCancel }: { onSuccess: () => void; onCancel: () => void }) {
  const [state, setState] = useState<'checking' | 'not-installed' | 'config-issue' | 'ok'>('checking');
  const [stderr, setStderr] = useState<string>('');

  const runPrecheck = async () => {
    setState('checking');
    const r = await fetch('/api/hermes/doctor').then(r => r.json());
    if (!r.installed) { setState('not-installed'); return; }
    if (r.exitCode !== 0) { setState('config-issue'); setStderr(r.stderr); return; }
    setState('ok');
    onSuccess();
  };

  useEffect(() => { runPrecheck(); }, []);

  if (state === 'checking') return <div>Checking hermes install…</div>;
  if (state === 'not-installed') {
    return (
      <div>
        <h4>Hermes Agent is not installed.</h4>
        <p>Run this in your terminal to install it:</p>
        <pre><code>curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code></pre>
        <button onClick={runPrecheck}>I've installed Hermes — retry precheck</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  if (state === 'config-issue') {
    return (
      <div>
        <h4>Hermes is installed but reports config issues:</h4>
        <pre>{stderr}</pre>
        <p>Run <code>hermes model</code> or <code>hermes setup</code> to configure a provider, then retry.</p>
        <button onClick={runPrecheck}>Retry precheck</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    );
  }
  return null;
}
```

Wire it into the existing save flow when `harnessValue === 'hermes-agent'`.

- [ ] **Step 2: Add e2e test coverage in `HarnessSection.e2e.test.ts`**

```ts
// Test cases:
//   - select hermes-agent, mock /api/hermes/doctor → installed:false → install panel shows
//   - mock installed:true, exitCode:0 → save proceeds
//   - mock installed:true, exitCode:1 → config-issue panel shows
```

- [ ] **Step 3: Run e2e**

```bash
yarn vitest run test/dashboard/HarnessSection.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/dashboard/spa/src client/test/dashboard/HarnessSection.e2e.test.ts
git commit -m "feat(operator): hermes-agent install precheck panel in /operator join flow"
```

### Task 3.5: Browser-verify the join flow

**Files:**
- None — manual verification

- [ ] **Step 1: Run the dev daemon**

```bash
cd client
yarn build:spa
node dist/bin/jinn.js run --config fixtures/local-config.json
```

- [ ] **Step 2: Open the dashboard and walk the flow**

In a browser, navigate to the dashboard URL, open `/operator`, find the SWE-rebench v2 row in Discover, select `hermes-agent` as the harness. Verify the precheck panel renders correctly in:

1. Hermes not installed (`hermes` not in PATH).
2. Hermes installed but no model configured (returns non-zero from `hermes doctor`).
3. Hermes installed and configured (returns zero) — save proceeds.

Use `testing-jinn-app` skill if applicable.

- [ ] **Step 3: Verify joined-row appears after save + restart**

After successful save, restart the daemon. The joined-row should appear in the joined list with harness `hermes-agent`. The daemon's logs should show `HermesHarness` registered.

### Task 3.6: Open PR 3

```bash
gh pr create --title "feat(operator): hermes-agent in /operator join flow (jinn-mono-8psp.3)" --body "..."
```

---

# PR 4 — Runbook + e2e + acceptance

### Task 4.1: Update SWE-rebench v2 runbook

**Files:**
- Modify: `docs/runbooks/swe-rebench-v2-public-testnet.md`

- [ ] **Step 1: Add Hermes section after the existing Claude/Codex paragraph**

Insert after the line "Solver joins default to Claude Code (`claude-code-learner`). Operators may switch to Codex (`codex-code-learner`) when intentionally running a Codex-backed solver.":

```markdown
Operators may also select Hermes Agent (`hermes-agent`) as the solver harness.
Hermes is a self-improving agent by Nous Research with its own learning loop
(skill self-improvement, MEMORY/USER curation, FTS5 session search), supporting
200+ models via OpenRouter plus additional providers (Nous Portal, NVIDIA NIM,
Xiaomi MiMo, GLM, Kimi, etc.). Install via the Hermes one-liner:

​```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
hermes model     # interactive provider + model picker
hermes doctor    # verify install
​```

The daemon's `/operator` join flow runs a `hermes doctor` precheck before
allowing the join to save. If `hermes doctor` reports issues, the dashboard
surfaces the install one-liner or the missing-config diagnostic with retry.

Hermes's own learning loop drives orchestration — the Jinn-side seven-phase
`learner` plugin is not loaded for Hermes operators. SolverPlugins
(`network-tools`, `swe-rebench-v2-runtime`) are mounted via Hermes's native
MCP and skill loading. The freeze contract is enforced by daemon hash-fence
on `HERMES_HOME = ctx.implStateDir`; no Hermes-internal changes required.

For HarnessCheckpoint publication: Hermes operators must record the
`hermesGitSha` of their `\$HERMES_HOME/hermes-agent/` clone in the checkpoint
manifest (the published version) because `hermes update` does not currently
support a `--version` flag. Forking operators check out that SHA before
restore.
```

- [ ] **Step 2: Add Hermes-specific acceptance gate to the gates list**

In the existing `## Acceptance Gates` section, add:

```bash
yarn vitest run test/harnesses/impls/hermes-agent
yarn vitest run test/api/hermes-doctor-endpoint.test.ts
```

- [ ] **Step 3: Commit**

```bash
git add docs/runbooks/swe-rebench-v2-public-testnet.md
git commit -m "docs(runbook): add Hermes Agent selection + install precheck to SWE-rebench v2 runbook"
```

### Task 4.2: Add Anvil-fork e2e for hermes-agent

**Files:**
- Create: `client/test/e2e/hermes-agent-full-cycle.ts`

- [ ] **Step 1: Copy `learner-full-cycle.ts` as a starting template**

```bash
cp client/test/e2e/learner-full-cycle.ts client/test/e2e/hermes-agent-full-cycle.ts
```

- [ ] **Step 2: Modify to use HermesHarness**

Open `hermes-agent-full-cycle.ts` and:

- Replace `LearnerHarness` construction with `HermesHarness` construction.
- Replace `--harness claude-code` config flag with `--harness hermes-agent`.
- Point `hermesPath` at a stub binary (`scripts/stub-hermes.js`) that produces a valid solution payload on exit, so this e2e runs without a real Hermes install in CI.

- [ ] **Step 3: Create the stub Hermes binary**

```js
// client/scripts/stub-hermes.js
#!/usr/bin/env node
// Stub binary used in e2e tests. Reads HERMES_HOME, parses the last arg as
// the prompt, writes a valid SWE-rebench v2 solution payload to
// $JINN_WORKING_DIR/.execute/solution-payload.json, exits 0.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const wIdx = args.indexOf('-w');
const workingDir = wIdx >= 0 ? args[wIdx + 1] : process.cwd();
mkdirSync(join(workingDir, '.execute'), { recursive: true });
writeFileSync(
  join(workingDir, '.execute/solution-payload.json'),
  JSON.stringify({ schemaVersion: 'swe-rebench-v2-solution.v1', patch: '--- a/file\n+++ b/file\n' }),
);
process.exit(0);
```

```bash
chmod +x client/scripts/stub-hermes.js
```

- [ ] **Step 4: Run the e2e**

```bash
cd client
yarn build  # ensure dist is current
node test/e2e/hermes-agent-full-cycle.ts
```

Expected: cycles through bootstrap → task claim → Hermes spawn (stub) → solution delivery → settlement. Exit 0.

- [ ] **Step 5: Wire into yarn scripts**

```jsonc
// client/package.json — scripts:
"e2e:hermes": "node test/e2e/hermes-agent-full-cycle.ts",
```

- [ ] **Step 6: Commit**

```bash
git add client/test/e2e/hermes-agent-full-cycle.ts client/scripts/stub-hermes.js client/package.json
git commit -m "test(e2e): hermes-agent SWE-rebench v2 full-cycle on Anvil fork with stub binary"
```

### Task 4.3: Acceptance proof — real Hermes binary

**Files:**
- None — manual verification + evidence capture

- [ ] **Step 1: Install Hermes locally on the test machine**

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc  # or ~/.zshrc
hermes model      # pick a provider; suggest Anthropic for reproducible test
hermes doctor     # verify
```

- [ ] **Step 2: Run a real-Hermes Task on Anvil**

Same as Task 4.2 but with `JINN_HERMES_PATH=$(which hermes)` instead of the stub. Expect actual model inference, real Hermes session, and a Solution that validates against the SWE-rebench v2 schema.

```bash
JINN_HERMES_PATH=$(which hermes) node test/e2e/hermes-agent-full-cycle.ts
```

- [ ] **Step 3: Capture evidence**

Per the SWE-rebench v2 runbook's "Evidence To Retain" section, capture:

- `hermes --version` output
- Task ID, task CID, claim count, solution / verdict envelope CIDs, settlement tx hash
- A redacted donated artifact envelope showing IPFS sources (if donation mode active)
- Screenshot of the `/operator` join row with `hermes-agent` selected and the precheck passing
- The e2e command output

Store evidence with the release notes under `client/.local/evidence/2026-05-XX-hermes-acceptance/`.

### Task 4.4: Open PR 4 + close beads

- [ ] **Step 1: Open PR 4**

```bash
gh pr create --title "docs+test: hermes-agent runbook + e2e (jinn-mono-8psp.4)" --body "..."
```

- [ ] **Step 2: After PR 4 merges, close beads**

```bash
bd close jinn-mono-8psp.1
bd close jinn-mono-8psp        # epic closes when all children done
```

If there are remaining children (e.g., default-swap decision bead 8psp.3), the epic stays open until those land.

---

# Coverage / scope check

Spec coverage map:

- **Spec §1 (Purpose and scope):** Phase A naming refactor + Phase B sibling package address §1.1.1–§1.1.4. Operator UX (§1.1.5) is PR 3. DRs (§1.1.6) ratified via the spec itself.
- **Spec §2 (three-plugin distinction):** Configuration in PR 2 task 2.3 (config-builder) honors it — Hermes never loads the `learner` plugin; SolverPlugins are read from `ctx.solverPluginRoots`.
- **Spec §3 (Hermes plug-in surface):** PR 2 tasks 2.3 (config-builder), 2.7–2.8 (bootstrap with explicit toolset allowlist), 2.9–2.10 (adapter passing model/provider through).
- **Spec §4 (Adapter design):** PR 2 tasks 2.9–2.12.
- **Spec §5 (Freeze contract):** PR 2 task 2.13. Composes the shared daemon hash-fence; no new mechanism.
- **Spec §6 (Composition with Hermes's loop):** Implicit — no learner plugin loaded; verified by config-builder unit tests not emitting any `learner/skills/` reference.
- **Spec §7 (Naming refactor):** Phase A.
- **Spec §8 (Operator UX):** PR 3.
- **Spec §9 (Model routing):** PR 2 tasks 2.10, 2.15.
- **Spec §10 (Default-swap):** Out of scope of this plan; filed as `jinn-mono-8psp.3`.
- **Spec §11 (Implementation surface):** This plan IS the breakdown of §11.1.
- **Spec §12 (Open items):** §12.1 (`hermes doctor` exit codes) addressed by PR 3 endpoint runs `doctor` and reports exit code raw — we don't interpret per-check semantics, the operator UI surfaces the raw stderr. §12.2 (concurrency) verified in PR 4 e2e. §12.3 (`hermes update --version`) noted in runbook; upstream ask filed as `jinn-mono-8psp.5`. §12.4 (toolset override) deferred to v1.x.

---

# Post-merge follow-ups (file as new bd issues)

- **`jinn-mono-8psp.3`** — Default-swap decision (data-driven criteria per spec §10.2). File once at least one operator publishes a Hermes HarnessCheckpoint.
- **`jinn-mono-8psp.5`** — Upstream feature request: `hermes update --version <tag>`. File issue at NousResearch/hermes-agent.
- **`jinn-mono-8psp.6`** — Toolset allowlist override surface (per-SolverNet config? per-operator env?). Implement when first operator asks.
- **`jinn-mono-8psp.7`** — Hermes-agent on `prediction.v1`. File when operator demand emerges.
- **`jinn-mono-8psp.8`** — Hermes-as-evaluator on judge-graded SolverNets (e.g., apex-agents, GDPval). File when those SolverNets ship.
