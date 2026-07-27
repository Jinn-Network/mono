# Emit intermediateFailureDiffs from production coding harnesses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude-code restoration via the learner plugin captures non-empty `Solution.intermediateFailureDiffs` at failed in-session test Bash boundaries so the existing engine `RUNNING → POST_SNAPSHOT` path persists §10 field 4; Codex and Hermes stay honest omit/`[]` with named follow-ups.

**Architecture:** Extend the learner plugin: SessionStart records `$WORKING_DIR/repo` HEAD into `.jinn/session-repo-base-head`. A new `PostToolUseFailure` hook (matcher `Bash`) ports jinn-agent `isTestCommand` + `accepted_diff` semantics into a shared TS helper module, appends non-empty deduped patches to `.jinn/intermediate-failure-diffs.json`, and never mutates the git index. `harvestOutput` reads that store and attaches `intermediateFailureDiffs` when non-empty. Engine persistence is already correct (#1643 redesign) — do not touch it.

**Tech Stack:** TypeScript, Vitest, bash Claude Code hooks, `node:child_process` `execFileSync` for hook-latency git, existing learner plugin under `client/plugins/learner/`.

**Design:** [`docs/superpowers/specs/2026-07-27-intermediate-failure-diffs-production-harnesses-design.md`](../specs/2026-07-27-intermediate-failure-diffs-production-harnesses-design.md)  
**Parent design / plan:** [`2026-07-25-intermediate-failure-diffs-harness-emitted-design.md`](../specs/2026-07-25-intermediate-failure-diffs-harness-emitted-design.md) · [`2026-07-25-intermediate-failure-diffs-harness-emitted.md`](./2026-07-25-intermediate-failure-diffs-harness-emitted.md)  
**Issue:** [#2225](https://github.com/Jinn-Network/mono/issues/2225)  
**Reference:** `apps/jinn-agent/plugins/jinn/session_bridge.py` (`_is_test_command`, `accepted_diff`) + `__init__.py` `_on_post_tool_call`

## Global Constraints

- **Failure-time capture only.** Never reconstruct intermediates from the final tree or parse transcripts after `run()` ends (Approach 2 rejected).
- **No Approach A / no mid-RUNNING engine fiction (AC6).** Do **not** edit `client/src/harnesses/engine/{engine,persistence}.ts`.
- **Claude first.** Ship learner-plugin `PostToolUseFailure` for Claude Code. Codex and Hermes remain honest omit/`[]` this issue (AC5 soft).
- **Test-command gate (AC4).** Port `session_bridge._is_test_command` exactly — do not invent extra heuristics.
- **Store paths stay outside `repo/`:** `$WORKING_DIR/.jinn/session-repo-base-head` and `$WORKING_DIR/.jinn/intermediate-failure-diffs.json` so solution-patch harvest stays clean.
- **Hook must not disrupt the agent:** exit 0 always; empty stdout; diagnostics on stderr only; swallow I/O errors.
- **American English** in identifiers/comments (`distill`, not `distil`).
- Work exclusively in this attempt worktree. Do not push, open/mutate PRs, or run `autopilot session`.

## Acceptance criteria → tasks map

| AC | Covered by |
|---|---|
| **AC1** Claude-code run with ≥1 in-session test Bash failure + non-empty tree → non-empty field after harvest → POST_SNAPSHOT | Tasks 1–4 (store + hook + harvest); engine path already green (`intermediate-failure-diffs.test.ts`) |
| **AC2** First-success / no failed test boundary → []/null | Task 1 (empty store), Task 4 (harvest omits), Task 5 |
| **AC3** Dedupe + non-empty only | Task 1 (`appendIntermediateFailureDiff` + engine `normalizeIntermediateFailureDiffs`) |
| **AC4** Only test-like commands | Task 1 (`isTestCommand`), Task 3 (hook ignores non-tests) |
| **AC5** Hermes: emit if cheap, else honest [] + follow-up | Task 5 (document honest [] + follow-up titles); harvest auto-omits when store absent |
| **AC6** No Approach A / no mid-RUNNING fiction | Global constraint + Task 6 (verify engine files untouched) |
| **AC7** Unit-testable helpers + hook/harvester without live Claude | Tasks 1–4 (fixture git repos + stdin JSON) |

## File map

| File | Responsibility |
|---|---|
| `client/src/harnesses/impls/learner/intermediate-failure-diffs.ts` | **Create** — `isTestCommand`, `workingTreeDiff`, store append/read, `processPostToolUseFailure`, `attachIntermediateFailureDiffs`, CLI entry |
| `client/test/harnesses/impls/learner/intermediate-failure-diffs.test.ts` | **Create** — command gate, diff fixture, dedupe, read, attach |
| `client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts` | **Create** — drive hook / `processPostToolUseFailure` with fixture stdin + temp repo |
| `client/plugins/learner/hooks/hooks.json` | Register `PostToolUseFailure` matcher `Bash` |
| `client/plugins/learner/hooks/session-start` | Also write `.jinn/session-repo-base-head` when `repo/.git` exists |
| `client/plugins/learner/hooks/post-tool-use-failure` | **Create** — thin bash wrapper: stdin → `node` helper CLI → exit 0 |
| `client/src/harnesses/impls/learner/plugin-path.ts` | `requireAsset` for new hook script |
| `client/test/harnesses/impls/learner/plugin-path.test.ts` | Assert new hook asset presence / missing-asset error |
| `client/src/harnesses/impls/learner/harvest.ts` | Attach `intermediateFailureDiffs` on all Solution return paths |
| `client/test/harnesses/impls/learner/harvest.test.ts` | Seed store → field present; absent store → field omitted |
| `client/src/harnesses/impls/learner/index.ts` | Re-export helpers used by tests/docs |
| `client/plugins/learner/README.md` + `CLAUDE.md` | Document capture seam + Codex/Hermes honest-[] follow-ups |

**Out of scope / do not touch:** `client/src/harnesses/engine/{engine,persistence}.ts`; Hermes adapter/plugin surface; Codex failure notify/hook; Approach A helpers; jinn-agent Python (reference only).

### Store / path constants (lock these names)

```ts
export const JINN_CAPTURE_DIR = '.jinn';
export const SESSION_REPO_BASE_HEAD_FILE = '.jinn/session-repo-base-head';
export const INTERMEDIATE_FAILURE_DIFFS_FILE = '.jinn/intermediate-failure-diffs.json';
```

Repo checkout for coding tasks: `join(workingDir, 'repo')`.

### Helper CLI (hook → node)

Compiled path when plugin is under `dist/plugins/learner`:

`../../harnesses/impls/learner/intermediate-failure-diffs.js`

Source-checkout fallback (after `yarn build` / `tsc`):

`../../dist/harnesses/impls/learner/intermediate-failure-diffs.js`

CLI subcommands:

- `node <helper> post-tool-use-failure` — read stdin JSON, append if gated
- (optional, unused by bash session-start) `node <helper> record-base-head` — write base HEAD

---

### Task 1: Shared helpers — `isTestCommand`, `workingTreeDiff`, store append/read (AC3, AC4, AC7)

**Files:**
- Create: `client/src/harnesses/impls/learner/intermediate-failure-diffs.ts`
- Create: `client/test/harnesses/impls/learner/intermediate-failure-diffs.test.ts`
- Modify: `client/src/harnesses/impls/learner/index.ts` (re-export)

**Interfaces:**
- Consumes: `node:child_process.execFileSync`, `node:fs`, `node:path`, `node:url`
- Produces:
  - `isTestCommand(command: string): boolean`
  - `workingTreeDiff(repoDir: string, baseHead: string): string`
  - `appendIntermediateFailureDiff(storePath: string, diff: string): void`
  - `readIntermediateFailureDiffs(workingDir: string): string[]`
  - `attachIntermediateFailureDiffs<T extends { intermediateFailureDiffs?: string[] }>(solution: T, workingDir: string): T`
  - `processPostToolUseFailure(stdinJson: string, env: NodeJS.ProcessEnv): void` (used in Task 3)

- [ ] **Step 1: Write the failing unit tests**

Create `client/test/harnesses/impls/learner/intermediate-failure-diffs.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isTestCommand,
  workingTreeDiff,
  appendIntermediateFailureDiff,
  readIntermediateFailureDiffs,
  attachIntermediateFailureDiffs,
  INTERMEDIATE_FAILURE_DIFFS_FILE,
} from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';

describe('isTestCommand (port of session_bridge._is_test_command)', () => {
  it.each([
    ['pytest', true],
    ['pytest -q tests/', true],
    ['tox', true],
    ['jest', true],
    ['vitest', true],
    ['./run_tests.sh', true],
    ['bash run_tests.sh', true],
    ['yarn test', true],
    ['npm test', true],
    ['pnpm test', true],
    ['bun test', true],
    ['cargo test', true],
    ['go test', true],
    ['make test', true],
    ['ls', false],
    ['yarn build', false],
    ['npm run build', false],
    ['git status', false],
    ['', false],
    ['yarn', false],
  ])('%j → %s', (cmd, expected) => {
    expect(isTestCommand(cmd)).toBe(expected);
  });

  it('returns false on unparseable shell quoting', () => {
    expect(isTestCommand(`echo 'unterminated`)).toBe(false);
  });
});

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('workingTreeDiff', () => {
  let repo: string;
  let base: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'jinn-ifd-repo-'));
    base = initRepo(repo);
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns empty string on a clean tree', () => {
    expect(workingTreeDiff(repo, base)).toBe('');
  });

  it('includes tracked edits and untracked files without mutating the index', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    writeFileSync(join(repo, 'new.txt'), 'u\n');
    const beforeIndex = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' });
    const diff = workingTreeDiff(repo, base);
    const afterIndex = execFileSync('git', ['ls-files', '-s'], { cwd: repo, encoding: 'utf8' });
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('tracked.txt');
    expect(diff).toContain('new.txt');
    expect(afterIndex).toBe(beforeIndex);
  });
});

describe('appendIntermediateFailureDiff / readIntermediateFailureDiffs', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-wd-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('ignores empty diffs and dedupes identical strings', () => {
    const store = join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE);
    appendIntermediateFailureDiff(store, '');
    appendIntermediateFailureDiff(store, 'diff --git a/x b/x\n');
    appendIntermediateFailureDiff(store, 'diff --git a/x b/x\n');
    appendIntermediateFailureDiff(store, 'diff --git a/y b/y\n');
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([
      'diff --git a/x b/x\n',
      'diff --git a/y b/y\n',
    ]);
  });

  it('returns [] when the store file is absent', () => {
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
    expect(existsSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE))).toBe(false);
  });

  it('returns [] on corrupt JSON without throwing', () => {
    mkdirSync(join(workingDir, '.jinn'), { recursive: true });
    writeFileSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE), '{not-json');
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });
});

describe('attachIntermediateFailureDiffs', () => {
  let workingDir: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ifd-attach-'));
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('sets intermediateFailureDiffs only when the store is non-empty', () => {
    const store = join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE);
    appendIntermediateFailureDiff(store, 'diff-a\n');
    const withDiffs = attachIntermediateFailureDiffs(
      { venueRef: { name: 'claude-code-learner' }, gating: {} },
      workingDir,
    );
    expect(withDiffs.intermediateFailureDiffs).toEqual(['diff-a\n']);

    const emptyWd = mkdtempSync(join(tmpdir(), 'jinn-ifd-empty-'));
    try {
      const omitted = attachIntermediateFailureDiffs(
        { venueRef: { name: 'claude-code-learner' }, gating: {} },
        emptyWd,
      );
      expect(omitted.intermediateFailureDiffs).toBeUndefined();
    } finally {
      rmSync(emptyWd, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
cd client && yarn vitest run test/harnesses/impls/learner/intermediate-failure-diffs.test.ts
```

Expected: FAIL — module / exports not found.

- [ ] **Step 3: Implement the helpers**

Create `client/src/harnesses/impls/learner/intermediate-failure-diffs.ts` with:

1. **`isTestCommand`** — port of Python:

```python
# Reference (do not import Python):
# executables = {"pytest", "tox", "jest", "vitest"}
# first = Path(words[0]).name
# if first in executables or first == "run_tests.sh": return True
# if any(Path(word).name == "run_tests.sh" for word in words): return True
# return len(words) >= 2 and first in {"yarn","npm","pnpm","bun","cargo","go","make"} and words[1] == "test"
```

Use a small argv splitter that matches `shlex.split` for the cases in the table (handle quotes; on `ValueError` equivalent → `false`). Prefer implementing with a careful regex/state machine or reuse a tiny in-file splitter — do **not** add a new npm dependency.

2. **`workingTreeDiff(repoDir, baseHead)`** — port of `accepted_diff`:

```ts
// tracked: git -c core.quotepath=false diff --binary --no-ext-diff <baseHead> --
// untracked: ls-files --others --exclude-standard -z
// each untracked: git diff --no-index --binary -- /dev/null <name>  (accept exit 0|1)
// never git add -N / never mutate index
```

Use `execFileSync` with `cwd: repoDir`, `encoding: 'utf8'`, and catch non-zero for tracked diff only when appropriate (`git diff` returns 0 with empty or 1 with changes depending on version — treat stdout as authoritative; ignore exit codes `{0,1}`).

3. **Store helpers:**

```ts
export function appendIntermediateFailureDiff(storePath: string, diff: string): void {
  if (!diff) return;
  // mkdir parent; read JSON array or []; if includes(diff) return; push; write atomic-ish
}

export function readIntermediateFailureDiffs(workingDir: string): string[] {
  // missing / corrupt / non-array → []; filter non-empty strings; preserve order; dedupe
}

export function attachIntermediateFailureDiffs<T extends { intermediateFailureDiffs?: string[] }>(
  solution: T,
  workingDir: string,
): T {
  const diffs = readIntermediateFailureDiffs(workingDir);
  if (diffs.length === 0) return solution;
  return { ...solution, intermediateFailureDiffs: diffs };
}
```

Stub `processPostToolUseFailure` as a no-op export for now if Task 3 is separate — or implement it fully here and cover it in Task 3's tests only. Prefer implementing the full function body in Task 3; Task 1 may export a placeholder that throws `not implemented` **only if** no Task-1 test imports it. Cleaner: implement `processPostToolUseFailure` in Task 3.

Re-export from `index.ts`:

```ts
export {
  isTestCommand,
  workingTreeDiff,
  appendIntermediateFailureDiff,
  readIntermediateFailureDiffs,
  attachIntermediateFailureDiffs,
  INTERMEDIATE_FAILURE_DIFFS_FILE,
  SESSION_REPO_BASE_HEAD_FILE,
} from './intermediate-failure-diffs.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd client && yarn vitest run test/harnesses/impls/learner/intermediate-failure-diffs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  client/src/harnesses/impls/learner/intermediate-failure-diffs.ts \
  client/src/harnesses/impls/learner/index.ts \
  client/test/harnesses/impls/learner/intermediate-failure-diffs.test.ts
git commit -m "$(cat <<'EOF'
feat(learner): add intermediateFailureDiffs capture helpers

Port jinn-agent test-command gate and accepted_diff semantics into a
shared TypeScript module with append/read store helpers for §10 field 4.

EOF
)"
```

---

### Task 2: SessionStart records repo base HEAD (AC1, AC2)

**Files:**
- Modify: `client/plugins/learner/hooks/session-start`
- Test: extend `client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts` (created in Task 3) **or** add a focused bash-invoking case in that file. For TDD this task, add a small Node test that shells out to the hook script.

**Interfaces:**
- Consumes: env `WORKING_DIR` or `JINN_WORKING_DIR`; `$WORKING_DIR/repo/.git`
- Produces: `$WORKING_DIR/.jinn/session-repo-base-head` (single-line SHA) when repo exists; no-op otherwise; must not break existing SessionStart JSON stdout contract

- [ ] **Step 1: Write the failing test**

Add to a new file `client/test/harnesses/impls/learner/session-start-base-head.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePluginRoot } from '../../../../src/harnesses/impls/learner/plugin-path.js';
import { SESSION_REPO_BASE_HEAD_FILE } from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), '1\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('session-start records repo base HEAD', () => {
  let root: string;
  let workingDir: string;
  let implStateDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jinn-ss-'));
    workingDir = join(root, 'work');
    implStateDir = join(root, 'impl');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(implStateDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes .jinn/session-repo-base-head when repo/.git exists', () => {
    const head = initRepo(join(workingDir, 'repo'));
    const hook = join(resolvePluginRoot(), 'hooks', 'session-start');
    chmodSync(hook, 0o755);
    execFileSync('bash', [hook], {
      env: { ...process.env, IMPL_STATE_DIR: implStateDir, WORKING_DIR: workingDir },
      encoding: 'utf8',
    });
    const recorded = readFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), 'utf8').trim();
    expect(recorded).toBe(head);
  });

  it('skips base-head write when repo is absent', () => {
    const hook = join(resolvePluginRoot(), 'hooks', 'session-start');
    execFileSync('bash', [hook], {
      env: { ...process.env, IMPL_STATE_DIR: implStateDir, WORKING_DIR: workingDir },
      encoding: 'utf8',
    });
    expect(existsSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && yarn vitest run test/harnesses/impls/learner/session-start-base-head.test.ts
```

Expected: FAIL — base-head file not written.

- [ ] **Step 3: Extend `session-start`**

After the existing implStateDir git init block (and before the stdout JSON steer), append:

```bash
# Record session-start HEAD of the coding checkout for intermediateFailureDiffs
# capture (#2225). Base is fixed for the session — do not re-read on failures.
WORKING="${WORKING_DIR:-${JINN_WORKING_DIR:-}}"
if [[ -n "$WORKING" && -d "$WORKING/repo/.git" ]]; then
  mkdir -p "$WORKING/.jinn"
  if git -C "$WORKING/repo" rev-parse HEAD >"$WORKING/.jinn/session-repo-base-head" 2>/dev/null; then
    echo "session-start: recorded repo base HEAD=$(tr -d '\n' <"$WORKING/.jinn/session-repo-base-head")" >&2
  else
    rm -f "$WORKING/.jinn/session-repo-base-head"
    echo "session-start: repo present but rev-parse failed; skipping base HEAD" >&2
  fi
fi
```

Keep the existing SessionStart stdout JSON (`hookSpecificOutput`) unchanged — base-head logging stays on stderr only.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd client && yarn vitest run test/harnesses/impls/learner/session-start-base-head.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  client/plugins/learner/hooks/session-start \
  client/test/harnesses/impls/learner/session-start-base-head.test.ts
git commit -m "$(cat <<'EOF'
feat(learner): record session repo base HEAD at SessionStart

Persist repo HEAD under workingDir/.jinn so PostToolUseFailure can
diff failed test attempt trees against a fixed session base.

EOF
)"
```

---

### Task 3: `PostToolUseFailure` hook + `processPostToolUseFailure` (AC1, AC4, AC7)

**Files:**
- Modify: `client/src/harnesses/impls/learner/intermediate-failure-diffs.ts` (add `processPostToolUseFailure` + CLI `main`)
- Create: `client/plugins/learner/hooks/post-tool-use-failure`
- Modify: `client/plugins/learner/hooks/hooks.json`
- Modify: `client/src/harnesses/impls/learner/plugin-path.ts`
- Modify: `client/test/harnesses/impls/learner/plugin-path.test.ts`
- Create: `client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts`

**Interfaces:**
- Consumes: stdin Claude `PostToolUseFailure` JSON shape `{ tool_name, tool_input: { command }, error? }`; env `WORKING_DIR` / `JINN_WORKING_DIR`; files from Task 2
- Produces: appends to `.jinn/intermediate-failure-diffs.json` when Bash + test command + non-empty diff; always process exit 0 from the bash wrapper

- [ ] **Step 1: Write the failing hook tests**

Create `client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  processPostToolUseFailure,
  readIntermediateFailureDiffs,
  SESSION_REPO_BASE_HEAD_FILE,
  INTERMEDIATE_FAILURE_DIFFS_FILE,
} from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';
import { resolvePluginRoot } from '../../../../src/harnesses/impls/learner/plugin-path.js';

function initRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: dir });
  writeFileSync(join(dir, 'tracked.txt'), 'v1\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
}

describe('processPostToolUseFailure', () => {
  let workingDir: string;
  let repo: string;
  let base: string;

  beforeEach(() => {
    workingDir = mkdtempSync(join(tmpdir(), 'jinn-ptuf-'));
    repo = join(workingDir, 'repo');
    base = initRepo(repo);
    mkdirSync(join(workingDir, '.jinn'), { recursive: true });
    writeFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), `${base}\n`);
  });
  afterEach(() => {
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('appends a non-empty diff for a failed Bash test command', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'pytest -q' },
        error: 'Command exited with non-zero status code 1',
      }),
      { WORKING_DIR: workingDir },
    );
    const diffs = readIntermediateFailureDiffs(workingDir);
    expect(diffs.length).toBe(1);
    expect(diffs[0]).toContain('tracked.txt');
  });

  it('ignores non-test Bash failures', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        error: 'Command exited with non-zero status code 1',
      }),
      { WORKING_DIR: workingDir },
    );
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });

  it('ignores non-Bash tools', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { command: 'pytest' },
      }),
      { WORKING_DIR: workingDir },
    );
    expect(readIntermediateFailureDiffs(workingDir)).toEqual([]);
  });

  it('no-ops when base HEAD file is missing', () => {
    rmSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE));
    writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
    processPostToolUseFailure(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'yarn test' },
      }),
      { WORKING_DIR: workingDir },
    );
    expect(existsSync(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE))).toBe(false);
  });

  it('never throws on corrupt stdin', () => {
    expect(() => processPostToolUseFailure('not-json{', { WORKING_DIR: workingDir })).not.toThrow();
  });
});

describe('post-tool-use-failure bash wrapper', () => {
  it('is registered and executable; pipes stdin into the helper without failing the agent', () => {
    const pluginRoot = resolvePluginRoot();
    const hook = join(pluginRoot, 'hooks', 'post-tool-use-failure');
    const hooksJson = JSON.parse(readFileSync(join(pluginRoot, 'hooks', 'hooks.json'), 'utf8')) as {
      hooks: Record<string, unknown>;
    };
    expect(hooksJson.hooks.PostToolUseFailure).toBeDefined();
    expect(existsSync(hook)).toBe(true);

    const workingDir = mkdtempSync(join(tmpdir(), 'jinn-ptuf-bash-'));
    try {
      const repo = join(workingDir, 'repo');
      const base = initRepo(repo);
      mkdirSync(join(workingDir, '.jinn'), { recursive: true });
      writeFileSync(join(workingDir, SESSION_REPO_BASE_HEAD_FILE), `${base}\n`);
      writeFileSync(join(repo, 'tracked.txt'), 'v2\n');
      chmodSync(hook, 0o755);
      execFileSync('bash', [hook], {
        input: JSON.stringify({
          tool_name: 'Bash',
          tool_input: { command: 'npm test' },
          error: 'Command exited with non-zero status code 1',
        }),
        env: { ...process.env, WORKING_DIR: workingDir, CLAUDE_PLUGIN_ROOT: pluginRoot },
        encoding: 'utf8',
      });
      expect(readIntermediateFailureDiffs(workingDir).length).toBe(1);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });
});
```

Also add a `plugin-path` negative test for missing `hooks/post-tool-use-failure` mirroring the session-start case.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd client && yarn vitest run \
  test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts \
  test/harnesses/impls/learner/plugin-path.test.ts
```

Expected: FAIL — `processPostToolUseFailure` / hook / requireAsset missing.

- [ ] **Step 3: Implement process + hook + registration**

In `intermediate-failure-diffs.ts`:

```ts
export function processPostToolUseFailure(stdinJson: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const workingDir = env.WORKING_DIR || env.JINN_WORKING_DIR;
    if (!workingDir) return;
    const event = JSON.parse(stdinJson) as {
      tool_name?: unknown;
      tool_input?: { command?: unknown };
    };
    if (event.tool_name !== 'Bash') return;
    const command = event.tool_input?.command;
    if (typeof command !== 'string' || !isTestCommand(command)) return;
    const basePath = join(workingDir, SESSION_REPO_BASE_HEAD_FILE);
    if (!existsSync(basePath)) return;
    const baseHead = readFileSync(basePath, 'utf8').trim();
    if (!baseHead) return;
    const repoDir = join(workingDir, 'repo');
    if (!existsSync(join(repoDir, '.git'))) return;
    const diff = workingTreeDiff(repoDir, baseHead);
    appendIntermediateFailureDiff(join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE), diff);
  } catch (err) {
    console.error(
      `[intermediate-failure-diffs] processPostToolUseFailure: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// CLI entry when executed as node script:
async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === 'post-tool-use-failure') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    processPostToolUseFailure(Buffer.concat(chunks).toString('utf8'), process.env);
    return;
  }
  console.error(`unknown command: ${cmd ?? '(none)'}`);
  process.exitCode = 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) {
  void main();
}
```

Create `client/plugins/learner/hooks/post-tool-use-failure`:

```bash
#!/usr/bin/env bash
# PostToolUseFailure hook — capture intermediateFailureDiffs for failed test Bash (#2225).
# Always exit 0 so hook noise never blocks the agent.
set +e
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

HELPER=""
for candidate in \
  "$PLUGIN_ROOT/../../harnesses/impls/learner/intermediate-failure-diffs.js" \
  "$PLUGIN_ROOT/../../dist/harnesses/impls/learner/intermediate-failure-diffs.js"
do
  if [[ -f "$candidate" ]]; then
    HELPER="$candidate"
    break
  fi
done

if [[ -z "$HELPER" ]]; then
  echo "post-tool-use-failure: helper not found (build client so dist/harnesses/... exists)" >&2
  exit 0
fi

node "$HELPER" post-tool-use-failure
exit 0
```

`chmod +x` the script in git (`git update-index --chmod=+x` if needed).

Update `hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start\"",
            "async": false
          }
        ]
      }
    ],
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash \"${CLAUDE_PLUGIN_ROOT}/hooks/post-tool-use-failure\"",
            "async": false
          }
        ]
      }
    ]
  }
}
```

In `plugin-path.ts` after the session-start require:

```ts
requireAsset(pluginRoot, 'hooks/post-tool-use-failure', 'plugin assets may be stale or incomplete; rebuild the plugin');
```

Mirror a missing-asset test in `plugin-path.test.ts`.

**Vitest note:** the bash-wrapper test needs the compiled `.js` helper on disk. Before that case, either:

1. Prefer calling `processPostToolUseFailure` in unit tests (already covered), and for the bash wrapper set `HELPER` by compiling with `tsc` / ensuring `yarn build` artifacts exist; **or**
2. Point the wrapper at the TS source via `npx tsx` in test-only env — **do not** ship `tsx` as the production hook path.

Recommended production path: compiled `dist/...js`. For the bash integration test in CI/dev without a full package build, resolve helper thus in the wrapper (still exit 0):

```bash
# After the two dist candidates, optional source fallback for repo-dev:
if [[ -z "$HELPER" && -f "$PLUGIN_ROOT/../../src/harnesses/impls/learner/intermediate-failure-diffs.ts" ]]; then
  if command -v tsx >/dev/null 2>&1; then
    tsx "$PLUGIN_ROOT/../../src/harnesses/impls/learner/intermediate-failure-diffs.ts" post-tool-use-failure
    exit 0
  fi
fi
```

Keep production preference on compiled `node` + `.js`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd client && yarn vitest run \
  test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts \
  test/harnesses/impls/learner/plugin-path.test.ts \
  test/harnesses/impls/learner/intermediate-failure-diffs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add \
  client/src/harnesses/impls/learner/intermediate-failure-diffs.ts \
  client/src/harnesses/impls/learner/plugin-path.ts \
  client/plugins/learner/hooks/hooks.json \
  client/plugins/learner/hooks/post-tool-use-failure \
  client/test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts \
  client/test/harnesses/impls/learner/plugin-path.test.ts
git commit -m "$(cat <<'EOF'
feat(learner): capture intermediateFailureDiffs on PostToolUseFailure

Wire a Bash-matcher failure hook that appends non-empty test-failure
working-tree diffs to the session store for harvest.

EOF
)"
```

---

### Task 4: Harvest attaches `intermediateFailureDiffs` (AC1, AC2, AC7)

**Files:**
- Modify: `client/src/harnesses/impls/learner/harvest.ts`
- Modify: `client/test/harnesses/impls/learner/harvest.test.ts`

**Interfaces:**
- Consumes: `attachIntermediateFailureDiffs` / `readIntermediateFailureDiffs`
- Produces: every `harvestOutput` return path that yields a `Solution` includes `intermediateFailureDiffs` iff the store is non-empty after read/dedupe

- [ ] **Step 1: Write the failing harvest tests**

Append to `harvest.test.ts` (reuse existing `writeFullPipeline` / temp `workingDir` helpers already in that file):

```typescript
import { appendIntermediateFailureDiff } from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';
import { INTERMEDIATE_FAILURE_DIFFS_FILE } from '../../../../src/harnesses/impls/learner/intermediate-failure-diffs.js';

// inside describe('harvestOutput', ...):

it('attaches intermediateFailureDiffs when the capture store is non-empty (AC1)', async () => {
  writeFullPipeline(workingDir);
  writeFileSync(
    join(workingDir, '.execute', 'solution-payload.json'),
    JSON.stringify({
      schemaVersion: 'swe-rebench-v2-solution.v1',
      patch: 'diff --git a/x b/x\n',
    }),
  );
  // If this fixture shape is wrong for current validatePayload, reuse an
  // existing typed-payload write helper from this file's other cases.
  mkdirSync(join(workingDir, '.jinn'), { recursive: true });
  appendIntermediateFailureDiff(
    join(workingDir, INTERMEDIATE_FAILURE_DIFFS_FILE),
    'diff --git a/fail.py b/fail.py\n+broken\n',
  );

  const solution = await harvestOutput(workingDir, 'full', {
    id: 't1',
    description: 'x',
    solverType: 'swe-rebench-v2.v1',
    role: 'restoration',
    spec: { repo: 'o/r', base_commit: 'a'.repeat(40), instance_id: 'i' },
  } as Task);

  expect(solution.intermediateFailureDiffs).toEqual([
    'diff --git a/fail.py b/fail.py\n+broken\n',
  ]);
});

it('omits intermediateFailureDiffs when the capture store is absent (AC2)', async () => {
  writeFullPipeline(workingDir);
  // Prefer the same minimal gating-only or typed path used elsewhere in this file
  // that already passes without a store file.
  const solution = await harvestOutput(workingDir, 'full');
  expect(solution.intermediateFailureDiffs).toBeUndefined();
});
```

**Implementer note:** Match whatever typed-payload / gating-only pattern already passes in `harvest.test.ts` — do not invent a new SolverType schema. If swe-rebench materialize requires a real `repo/` git checkout, either:

- use the gating-only return (`writeFullPipeline` without typed payload) for both cases, or
- copy an existing swe-rebench harvest test fixture from the same file.

Prefer gating-only + seeded store for the attach assertion — attach must run on **all** return paths, including gating-only.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd client && yarn vitest run test/harnesses/impls/learner/harvest.test.ts -t 'intermediateFailureDiffs'
```

Expected: FAIL — field undefined even with seeded store.

- [ ] **Step 3: Wire attach into `harvestOutput`**

At top of `harvest.ts`:

```ts
import { attachIntermediateFailureDiffs } from './intermediate-failure-diffs.js';
```

Apply attach on **every** return:

1. prediction.v1 `return attachIntermediateFailureDiffs(buildSolutionOutput(...) as Solution, workingDir);`
2. typed-payload `return attachIntermediateFailureDiffs({ ... } as Solution, workingDir);`
3. gating-only `return attachIntermediateFailureDiffs({ ... }, workingDir);`

Do not invent diffs when the store is absent. Do not set `[]` explicitly — omit the field (engine treats undefined/`[]` as null column; design prefers omit-or-empty consistently with optional field docs; omit is fine).

HermesHarness calls the same `harvestOutput` — without the learner plugin hooks the store stays empty → honest omit (AC5) with no Hermes special-case.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd client && yarn vitest run test/harnesses/impls/learner/harvest.test.ts
```

Expected: PASS (full file, not only the new cases).

- [ ] **Step 5: Commit**

```bash
git add \
  client/src/harnesses/impls/learner/harvest.ts \
  client/test/harnesses/impls/learner/harvest.test.ts
git commit -m "$(cat <<'EOF'
feat(learner): attach intermediateFailureDiffs in harvestOutput

Read the session capture store and set Solution.intermediateFailureDiffs
when non-empty so POST_SNAPSHOT persists §10 field 4.

EOF
)"
```

---

### Task 5: Document Codex / Hermes honest-[] + follow-ups (AC5)

**Files:**
- Modify: `client/plugins/learner/README.md`
- Modify: `client/plugins/learner/CLAUDE.md` (hook list)
- Optional one-line comment near Codex adapter SessionStart invoke noting no failure-hook surface yet

**Decision (headless Stage 2):** Hermes is **not** cheap (does not load learner plugin). Document honest omit/`[]` and name concrete follow-up Issue titles. Do **not** file GitHub Issues in this stage (authority capsule forbids GitHub mutate); leave titles in docs so Stage 3 / coordinator can file.

- [ ] **Step 1: Update plugin docs**

In `README.md` Components / Hook section, replace “1 hook” with the SessionStart + PostToolUseFailure pair and add:

```markdown
## intermediateFailureDiffs (§10 field 4)

On Claude Code, `PostToolUseFailure` (Bash) appends non-empty working-tree
diffs vs session-start `repo` HEAD into `.jinn/intermediate-failure-diffs.json`
when the failed command is test-like (`pytest` / `yarn test` / …). Harvest
attaches the list onto `Solution.intermediateFailureDiffs`.

**Codex / Hermes (this Issue):** honest omit / empty field 4. Follow-ups:

- `feat: emit intermediateFailureDiffs from Codex coding harness`
- `feat: emit intermediateFailureDiffs from Hermes coding harness` (Hermes
  `post_tool_call` plugin writing the same `.jinn/intermediate-failure-diffs.json`
  contract so harvest lights up without LearnerHarness)
```

Update `CLAUDE.md` Hook bullet accordingly.

- [ ] **Step 2: No code behavior change — skip RED/GREEN**

Docs-only. Verify wording names both follow-ups and does not claim Codex/Hermes emit today.

- [ ] **Step 3: Commit**

```bash
git add client/plugins/learner/README.md client/plugins/learner/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(learner): document intermediateFailureDiffs capture and honest gaps

Record Claude PostToolUseFailure semantics and name Codex/Hermes
follow-ups for §10 field 4 emitters.

EOF
)"
```

---

### Task 6: Verification gate (AC1–AC7, AC6 no-engine-touch)

**Files:** none new — run commands only.

- [ ] **Step 1: Confirm engine files untouched**

```bash
git diff --name-only HEAD | grep -E 'harnesses/engine/(engine|persistence)\.ts' && exit 1 || true
```

Expected: no output (those paths not in the working tree diff for this branch’s #2225 commits). If they appear, revert them.

- [ ] **Step 2: Run focused learner + engine regression suites**

```bash
cd client && yarn vitest run \
  test/harnesses/impls/learner/intermediate-failure-diffs.test.ts \
  test/harnesses/impls/learner/session-start-base-head.test.ts \
  test/harnesses/impls/learner/post-tool-use-failure-hook.test.ts \
  test/harnesses/impls/learner/plugin-path.test.ts \
  test/harnesses/impls/learner/harvest.test.ts \
  test/harnesses/engine/intermediate-failure-diffs.test.ts
```

Expected: all PASS. Engine suite proves POST_SNAPSHOT still consumes harness-emitted lists (stub harness from #1643 redesign).

- [ ] **Step 3: Typecheck**

```bash
cd client && yarn typecheck
```

Expected: zero errors.

- [ ] **Step 4: Optional smoke — helper CLI**

```bash
cd client && yarn build
# or at least tsc so dist/harnesses/impls/learner/intermediate-failure-diffs.js exists
node dist/harnesses/impls/learner/intermediate-failure-diffs.js post-tool-use-failure <<'EOF'
{"tool_name":"Bash","tool_input":{"command":"ls"}}
EOF
echo exit:$?
```

Expected: exit 0 (non-test command → no-op).

- [ ] **Step 5: Final commit only if Step 1–4 forced small fixes**

If verification required fixes, commit them with a focused message (`fix(learner): …`). Otherwise stop — no empty commit.

---

## Spec coverage self-check

| Design section | Plan task |
|---|---|
| Option 1 chosen — learner PostToolUseFailure + harvest | Tasks 2–4 |
| Capture contract (Bash / test / failure / non-empty / dedupe / harvest) | Tasks 1, 3, 4 |
| Session base HEAD path + skip when no repo | Task 2 |
| Diff shape = `accepted_diff` (tracked + untracked, no index mutate) | Task 1 |
| Shared TS module exports | Task 1 |
| Hook exit 0 / stderr-only | Task 3 |
| Harvest attach on restoration return paths | Task 4 |
| Hermes honest [] + follow-up | Task 5 (Hermes shares harvest; no emitter) |
| Codex soft defer + follow-up title | Task 5 |
| No engine edits / no Approach A | Global + Task 6 |
| Unit tests without live Claude | Tasks 1–4 |
| Engine regression remains green | Task 6 |

## Placeholder scan

No TBD / “similar to Task N” / empty test stubs. Implementers may need to align the harvest typed-payload fixture with existing `harvest.test.ts` helpers — that is an explicit implementer note, not a missing step.

## Type consistency

- Store file constants: `SESSION_REPO_BASE_HEAD_FILE`, `INTERMEDIATE_FAILURE_DIFFS_FILE`
- Functions: `isTestCommand`, `workingTreeDiff`, `appendIntermediateFailureDiff`, `readIntermediateFailureDiffs`, `attachIntermediateFailureDiffs`, `processPostToolUseFailure`
- Solution field: `intermediateFailureDiffs?: string[]` (already on `Solution` in `client/src/harnesses/types.ts`)

## Codex / Hermes honest-[] summary (for PR body)

| Harness | This issue | Why | Follow-up title |
|---|---|---|---|
| Claude Code + learner plugin | Emits via `PostToolUseFailure` | Failure-boundary hook exists | — |
| Codex | Honest omit/`[]` | Adapter runs SessionStart manually; no PostToolUseFailure surface | `feat: emit intermediateFailureDiffs from Codex coding harness` |
| Hermes | Honest omit/`[]` | Does not load learner plugin; Hermes plugin surface not cheap | `feat: emit intermediateFailureDiffs from Hermes coding harness` |

---

## Task checklist summary

- [ ] **Task 1** — Helpers: `isTestCommand`, `workingTreeDiff`, store append/read, attach (`intermediate-failure-diffs.ts` + unit tests)
- [ ] **Task 2** — SessionStart writes `.jinn/session-repo-base-head`
- [ ] **Task 3** — `processPostToolUseFailure` + bash hook + `hooks.json` + `plugin-path` requireAsset
- [ ] **Task 4** — `harvestOutput` attaches non-empty store to `Solution`
- [ ] **Task 5** — Document Claude capture + Codex/Hermes honest-[] follow-up titles
- [ ] **Task 6** — Verify: no engine edits, focused vitest suites green, `yarn typecheck` clean
