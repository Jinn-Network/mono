# Per-Session stdout/stderr Log Files Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each dispatched implement-issue session's stdout+stderr into a stable, tailable per-session log file at `~/.jinn-client/eng-loop/sessions/<N>.log`, surface that path on the in-flight session and in the dispatch log line, and append (never overwrite) across re-dispatches.

**Architecture:** A new I/O-free helper module (`session-log.ts`) computes the deterministic log dir + per-issue path. `dispatchIssue` stays a pure orchestrator: it computes the path, passes it through the injected `SpawnFn` opts, surfaces it on `InFlightSession`, and emits one dispatch log line. The actual fd-opening (`mkdirSync` + append-mode `openSync`) lives only inside the production `SpawnFn` lambda in `run-eng-loop.ts`, preserving the existing fake-spawn test seam. fd 1 and fd 2 both point at the same append-mode log so stdout and stderr interleave into one `tail -f`-able file.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Node `node:fs` / `node:os` / `node:path` / `node:child_process`, Vitest.

**Scope:** Covers ONLY the implement-issue spawn in `dispatchIssue` (the `stdio: 'ignore'` call). The review-session spawn in `runReviewPass` / `dispatchReview` is explicitly OUT of scope (follow-up). The `session-log.ts` helper is kept reusable so the review path can adopt it later.

---

## File Structure

- **Create:** `src/dispatcher/session-log.ts` — exports `SESSIONS_LOG_DIR` (resolved from `os.homedir()`) and `sessionLogPath(issueNumber)`. I/O-free (pure path math). One clear responsibility: the on-disk log path scheme.
- **Create:** `test/dispatcher/session-log.test.ts` — unit tests for the path scheme.
- **Modify:** `src/dispatcher/types.ts` — add `logPath: string` to `InFlightSession`.
- **Modify:** `src/dispatcher/dispatch.ts` — widen `SpawnFn` opts (`logPath?`, `stdio` allows `number`); compute log path; pass it through spawn opts; populate `InFlightSession.logPath`; emit one `[dispatch] #<N> pid=<pid> log=<path>` line.
- **Modify:** `test/dispatcher/dispatch.test.ts` — extend the `SpawnCall` capture; add AC#1/AC#2 assertions; update the existing `InFlightSession`-shape assertion to expect `logPath`.
- **Modify:** `scripts/run-eng-loop.ts` — the production lambda in `runOneCycle` opens the fd (mkdir + append-mode openSync), passes both fds as stdio, closes the parent fd after spawn; the dry-run stub gains `logPath: '(dry-run)'`.

---

## Task 1: `session-log.ts` path-scheme helper (AC#1, AC#3, AC#4 path-stability)

**Files:**
- Create: `src/dispatcher/session-log.ts`
- Test: `test/dispatcher/session-log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dispatcher/session-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SESSIONS_LOG_DIR, sessionLogPath } from '../../src/dispatcher/session-log.js';

describe('session-log path scheme', () => {
  it('SESSIONS_LOG_DIR is ~/.jinn-client/eng-loop/sessions resolved from homedir', () => {
    expect(SESSIONS_LOG_DIR).toBe(join(homedir(), '.jinn-client', 'eng-loop', 'sessions'));
    // Absolute path so tail -f works from any cwd (AC#3).
    expect(SESSIONS_LOG_DIR).toMatch(/^\//);
  });

  it('sessionLogPath(N) is <dir>/<N>.log — stable + deterministic (AC#1, AC#4)', () => {
    expect(sessionLogPath(418)).toBe(join(SESSIONS_LOG_DIR, '418.log'));
    // Deterministic: same input → same output (stable path, not timestamped).
    expect(sessionLogPath(418)).toBe(sessionLogPath(418));
  });

  it('uses the numeric issue number verbatim in the filename', () => {
    expect(sessionLogPath(7)).toBe(join(SESSIONS_LOG_DIR, '7.log'));
    expect(sessionLogPath(1234)).toBe(join(SESSIONS_LOG_DIR, '1234.log'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `yarn test session-log`
Expected: FAIL — cannot resolve `../../src/dispatcher/session-log.js` (module does not exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/dispatcher/session-log.ts`:

```typescript
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Stable directory for per-session stdout/stderr logs (jinn-mono#533).
 * Lives under the operator's `~/.jinn-client` tree alongside other client
 * state. Resolved once from `os.homedir()` at module load — a fixed,
 * absolute path so `tail -f <dir>/<N>.log` works from any terminal/cwd.
 */
export const SESSIONS_LOG_DIR = join(homedir(), '.jinn-client', 'eng-loop', 'sessions');

/**
 * The log-file path for one dispatched session, keyed by issue number:
 * `<SESSIONS_LOG_DIR>/<N>.log`. Deterministic and I/O-free — opening the
 * file (and creating the dir) is the caller's job. The path is intentionally
 * NOT timestamped so it stays predictable for `tail -f`; re-dispatch
 * stability across runs is achieved by opening this path in append mode
 * (see the production SpawnFn lambda).
 */
export function sessionLogPath(issueNumber: number): string {
  return join(SESSIONS_LOG_DIR, `${issueNumber}.log`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `yarn test session-log`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/dispatcher/session-log.ts test/dispatcher/session-log.test.ts
git commit -m "feat(eng-loop): add per-session log path helper (#533)"
```

---

## Task 2: Surface `logPath` on `InFlightSession` (AC#2 type)

**Files:**
- Modify: `src/dispatcher/types.ts:61-68`

- [ ] **Step 1: Add the field to the interface**

In `src/dispatcher/types.ts`, change the `InFlightSession` interface from:

```typescript
/** A session the dispatcher has spawned and is tracking. */
export interface InFlightSession {
  issueNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;     // epoch ms
}
```

to:

```typescript
/** A session the dispatcher has spawned and is tracking. */
export interface InFlightSession {
  issueNumber: number;
  branch: string;
  worktreePath: string;
  pid: number | null;
  startedAt: number;     // epoch ms
  /**
   * Absolute path to the per-session stdout+stderr log
   * (`~/.jinn-client/eng-loop/sessions/<N>.log`, jinn-mono#533). Deterministic
   * from the issue number; `tail -f` this to watch a running session.
   */
  logPath: string;
}
```

- [ ] **Step 2: Run typecheck to verify it fails (callers not yet updated)**

Run: `yarn typecheck`
Expected: FAIL — `dispatch.ts` and the dry-run stub in `run-eng-loop.ts` build `InFlightSession` literals missing `logPath`. This confirms every construction site is caught by the compiler. (Tasks 3 and 4 fix these.)

- [ ] **Step 3: Commit**

```bash
git add src/dispatcher/types.ts
git commit -m "feat(eng-loop): add logPath to InFlightSession (#533)"
```

Note: typecheck stays red until Task 3 + Task 4. That is expected and acceptable for an intermediate TDD commit; do not "fix" it by stubbing `logPath` anywhere other than the two real construction sites.

---

## Task 3: `dispatchIssue` computes path, threads it through spawn, surfaces it, logs it (AC#1 path-pass, AC#2)

**Files:**
- Modify: `src/dispatcher/dispatch.ts:62-79` (widen `SpawnFn` types)
- Modify: `src/dispatcher/dispatch.ts:152-264` (compute path, spawn opts, return, log line)
- Modify: `test/dispatcher/dispatch.test.ts:185-197` (capture opts already; no change needed) and add new tests

### Step group A — tests first

- [ ] **Step 1: Extend the dispatch tests with AC#1 + AC#2 assertions**

The existing `makeSpawn` helper already records `opts` (`test/dispatcher/dispatch.test.ts:186-197`), so no helper change is required. Add these tests inside the `describe('dispatchIssue', …)` block (after the existing `returns an InFlightSession …` test at line 453). Import `SESSIONS_LOG_DIR` / `sessionLogPath` at the top of the file alongside the other imports:

Add to the import block near the top of `test/dispatcher/dispatch.test.ts`:

```typescript
import { SESSIONS_LOG_DIR, sessionLogPath } from '../../src/dispatcher/session-log.js';
```

Add these tests:

```typescript
  // -------------------------------------------------------------------------
  // #533 — per-session log file
  // -------------------------------------------------------------------------

  it('passes the per-session logPath (sessions/<N>.log) through the spawn opts (#533 AC#1)', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn, fieldCache: { ...FIELD_CACHE } });

    const [spawnCall] = calls;
    expect(spawnCall.opts.logPath).toBe(sessionLogPath(418));
    expect(spawnCall.opts.logPath).toBe(`${SESSIONS_LOG_DIR}/418.log`);
  });

  it('requests captured (non-ignore) stdio so the lambda can attach fds (#533 AC#1)', async () => {
    const { runner } = makeRunner();
    const { spawn, calls } = makeSpawn();

    await dispatchIssue(ISSUE, CFG, { runner, spawn, fieldCache: { ...FIELD_CACHE } });

    const [spawnCall] = calls;
    // dispatch.ts must NOT hard-code stdio:'ignore' anymore — it hands the log
    // path to the lambda, which opens the fds. The contract here is just that
    // stdio is no longer the string 'ignore'.
    expect(spawnCall.opts.stdio).not.toBe('ignore');
  });

  it('returns an InFlightSession whose logPath is deterministic from the issue number (#533 AC#2)', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn();

    const session = await dispatchIssue(ISSUE, CFG, { runner, spawn, fieldCache: { ...FIELD_CACHE } });

    expect(session.logPath).toBe(sessionLogPath(418));
    expect(session.logPath).toMatch(/\/418\.log$/);
  });

  it('logs a [dispatch] line with the pid and log path (#533 AC#2)', async () => {
    const { runner } = makeRunner();
    const { spawn } = makeSpawn(54321);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await dispatchIssue(ISSUE, CFG, { runner, spawn, fieldCache: { ...FIELD_CACHE } });

    const line = logSpy.mock.calls.map((c) => String(c[0])).find((s) => s.includes('[dispatch]'));
    expect(line).toBeDefined();
    expect(line).toContain('#418');
    expect(line).toContain('pid=54321');
    expect(line).toContain(sessionLogPath(418));

    logSpy.mockRestore();
  });
```

This block uses `vi`; add `vi` to the existing `vitest` import (currently `import { describe, it, expect, beforeEach } from 'vitest';` at line 1):

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
```

- [ ] **Step 2: Update the existing InFlightSession-shape test to expect `logPath`**

The test at `test/dispatcher/dispatch.test.ts:429-453` (`returns an InFlightSession with the correct issue number, branch, absolute worktree path, pid, and startedAt`) asserts the full session shape. Add one assertion to it, right after the `expect(session.pid).toBe(77777);` line:

```typescript
    expect(session.logPath).toBe(sessionLogPath(418));
```

- [ ] **Step 3: Run the new tests to verify they fail**

Run: `yarn test dispatch`
Expected: FAIL — `spawnCall.opts.logPath` is `undefined`, `stdio` is still `'ignore'`, `session.logPath` is `undefined`, and no `[dispatch]` line is logged.

### Step group B — implementation

- [ ] **Step 4: Widen the `SpawnFn` opts type**

In `src/dispatcher/dispatch.ts`, change the `SpawnFn` type (lines 70-79) from:

```typescript
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    detached: boolean;
    stdio: 'ignore' | Array<string | null>;
    [key: string]: unknown;
  },
) => SpawnResult;
```

to:

```typescript
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    detached: boolean;
    // `number` allows file descriptors (the log fd) as stdio targets;
    // `'ignore'` is retained for the fallback / review path. (#533)
    stdio: 'ignore' | Array<string | number | null>;
    /**
     * Absolute path to the per-session log file (#533). The production
     * lambda opens this in append mode and wires it to stdout+stderr;
     * the fake spawn in tests just records it.
     */
    logPath?: string;
    [key: string]: unknown;
  },
) => SpawnResult;
```

- [ ] **Step 5: Add the import**

At the top of `src/dispatcher/dispatch.ts`, add to the import group (after the `buildHeadlessPrompt` import at line 12):

```typescript
import { sessionLogPath } from './session-log.js';
```

- [ ] **Step 6: Compute the path, pass it through spawn, log it, and return it**

In `dispatchIssue`, replace the spawn + return block (lines 249-263) which currently reads:

```typescript
  // 5. Spawn — NO plan-posture flags (spec Appendix)
  const result = spawn('claude', ['-p', fullPrompt], {
    cwd: worktreePath,
    detached: true,
    stdio: 'ignore',
  });

  // 6. Return InFlightSession
  return {
    issueNumber: number,
    branch,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
  };
```

with:

```typescript
  // 5. Spawn — NO plan-posture flags (spec Appendix).
  //    Per #533 we capture the session's stdout+stderr to a per-session log
  //    file. `dispatchIssue` stays I/O-free: it only computes the (stable,
  //    deterministic) log path and hands it to the injected spawn via opts.
  //    The production lambda (run-eng-loop.ts) does the actual mkdir + append-
  //    mode openSync and wires the fd to stdout+stderr; the test fake just
  //    records the opts. `stdio` is the placeholder the lambda overrides with
  //    [ 'ignore', fd, fd ]; it must not be 'ignore' so the captured-stdio
  //    test holds. We send stdin to 'ignore' (the session is headless) and
  //    inherit for 1/2 as a safe default the lambda replaces.
  const logPath = sessionLogPath(number);
  const result = spawn('claude', ['-p', fullPrompt], {
    cwd: worktreePath,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    logPath,
  });

  // AC#2: surface pid + log path on the dispatch log line so an operator can
  // tail the session straight from the cycle output.
  console.log(`[dispatch] #${number} pid=${result.pid ?? 'unknown'} log=${logPath}`);

  // 6. Return InFlightSession (logPath surfaced for downstream visibility).
  return {
    issueNumber: number,
    branch,
    worktreePath,
    pid: result.pid ?? null,
    startedAt: Date.now(),
    logPath,
  };
```

- [ ] **Step 7: Run the dispatch tests to verify they pass**

Run: `yarn test dispatch`
Expected: PASS — all existing dispatch tests plus the four new #533 tests and the extended shape assertion. (The fake spawn never opens an fd, so `stdio: ['ignore','inherit','inherit']` is harmless in tests.)

- [ ] **Step 8: Commit**

```bash
git add src/dispatcher/dispatch.ts test/dispatcher/dispatch.test.ts
git commit -m "feat(eng-loop): thread per-session logPath through dispatchIssue (#533)"
```

---

## Task 4: Production lambda opens the append-mode fd + dry-run stub (AC#1, AC#3, AC#4)

**Files:**
- Modify: `scripts/run-eng-loop.ts:40-44` (imports)
- Modify: `scripts/run-eng-loop.ts:182-190` (dry-run stub adds `logPath`)
- Modify: `scripts/run-eng-loop.ts:404-415` (production spawn lambda opens fd)

This is the seam where real I/O lives. The existing dry-run regression test (`test/run-eng-loop-dry-run.test.ts`) exercises `runDryRun`; the dry-run stub change is covered by re-running that test after adding `logPath`. The production lambda's append-mode fd-open is asserted by a focused spy test (Step group A below) plus the manual `tail -f` smoke check in Task 5.

### Step group A — append-mode regression test

- [ ] **Step 1: Write a focused test asserting the lambda opens the log in append mode**

The production lambda is an inline closure inside `runOneCycle`, not separately exported, so we test the append-mode contract at the unit boundary that IS reachable: assert that `session-log` + an `openSync` spy compose to an append (`'a'`) open with both fds pointing at the same fd. Add a new file `test/dispatcher/session-log-append.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { sessionLogPath } from '../../src/dispatcher/session-log.js';

// #533 AC#4 — re-dispatches must NOT silently overwrite an existing log.
// The production SpawnFn lambda (scripts/run-eng-loop.ts) opens the per-session
// log with openSync(path, 'a'). This test pins that contract by exercising the
// exact open call the lambda performs against a spied fs, proving:
//   (a) the flag is 'a' (append) — not 'w' (truncate);
//   (b) both stdout(1) and stderr(2) are wired to the SAME fd so the two
//       streams interleave into one tailable file (AC#1/AC#3).
//
// We replicate the lambda's open+wire logic here rather than importing it
// (it is an inline closure); run-eng-loop-dry-run.test.ts + the manual
// tail -f smoke check (plan Task 5) cover the wired-up path end to end.

function openSessionStdio(issueNumber: number): {
  stdio: ['ignore', number, number];
  fd: number;
} {
  const logPath = sessionLogPath(issueNumber);
  const fd = fs.openSync(logPath, 'a');
  return { stdio: ['ignore', fd, fd], fd };
}

describe('session log append-mode wiring (#533 AC#4)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('opens the per-session log in append mode and wires both fds to it', () => {
    const FAKE_FD = 42;
    const openSpy = vi
      .spyOn(fs, 'openSync')
      .mockReturnValue(FAKE_FD as unknown as number);

    const { stdio, fd } = openSessionStdio(418);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith(sessionLogPath(418), 'a');
    expect(fd).toBe(FAKE_FD);
    // stdin ignored; stdout + stderr both → the same log fd.
    expect(stdio[0]).toBe('ignore');
    expect(stdio[1]).toBe(FAKE_FD);
    expect(stdio[2]).toBe(FAKE_FD);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `yarn test session-log-append`
Expected: PASS (1 test). This test does not depend on the lambda edit; it locks the append-mode contract the lambda must implement. (Implementing the lambda in Step 4 must mirror this `openSync(path, 'a')` + `['ignore', fd, fd]` shape exactly.)

- [ ] **Step 3: Add imports to `run-eng-loop.ts`**

In `scripts/run-eng-loop.ts`, the file already imports `spawn` and `SpawnOptions` from `node:child_process` (lines 40-41). Add an `fs` import and the session-log import. After line 41 (`import type { SpawnOptions } from 'node:child_process';`) add:

```typescript
import { mkdirSync, openSync, closeSync } from 'node:fs';
```

And alongside the other dispatcher imports (after the `dispatchIssue` import at line 19) add:

```typescript
import { SESSIONS_LOG_DIR } from '../src/dispatcher/session-log.js';
```

- [ ] **Step 4: Implement the fd-opening production lambda**

In `runOneCycle`, the production spawn lambda is at lines 406-413:

```typescript
            spawn: (cmd, args, opts) => {
              const child = spawn(cmd, args, opts as SpawnOptions);
              if (child.pid != null) {
                child.unref();
              }
              return { pid: child.pid };
            },
```

Replace it with:

```typescript
            spawn: (cmd, args, opts) => {
              // #533: open the per-session log in append mode and wire it to
              // BOTH stdout(1) and stderr(2) so the two streams interleave in
              // one tailable file. Append (not truncate, not timestamp) keeps
              // the path stable for `tail -f` while never clobbering a prior
              // run's output. `dispatchIssue` supplied opts.logPath; if it is
              // somehow absent we fall back to the opts.stdio it set.
              const logPath = opts.logPath;
              let fd: number | undefined;
              let stdio = opts.stdio;
              if (typeof logPath === 'string') {
                mkdirSync(SESSIONS_LOG_DIR, { recursive: true });
                fd = openSync(logPath, 'a');
                // Visual delimiter so successive append runs are separable.
                const delimiter =
                  `\n===== dispatch ${new Date().toISOString()} ` +
                  `pid=pending cwd=${opts.cwd} =====\n`;
                require('node:fs').writeSync(fd, delimiter);
                stdio = ['ignore', fd, fd];
              }
              const child = spawn(cmd, args, { ...opts, stdio } as SpawnOptions);
              if (child.pid != null) {
                child.unref();
              }
              // Close the parent's copy of the fd: the detached child inherited
              // its own dup, so closing here avoids leaking an fd per dispatch.
              if (fd != null) {
                closeSync(fd);
              }
              return { pid: child.pid };
            },
```

Note on `writeSync`: this module is ESM (`"type": "module"`), so `require` is not defined. Use the imported `writeSync` instead. Replace the `require('node:fs').writeSync(fd, delimiter);` line with a top-level import addition — change the Step 3 fs import to:

```typescript
import { mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
```

and the delimiter write line to:

```typescript
                writeSync(fd, delimiter);
```

(The plan author flags this explicitly so the engineer does not ship a broken `require` in an ESM file — final lambda uses the imported `writeSync`.)

- [ ] **Step 5: Update the dry-run stub to include `logPath`**

In `runDryRun`, the `dryDispatch` stub builds a fake `InFlightSession` (lines 182-190):

```typescript
      return {
        issueNumber: issue.number,
        branch: `(dry-run)`,
        worktreePath: `(dry-run)`,
        pid: null,
        startedAt: Date.now(),
      };
```

Change it to:

```typescript
      return {
        issueNumber: issue.number,
        branch: `(dry-run)`,
        worktreePath: `(dry-run)`,
        pid: null,
        startedAt: Date.now(),
        logPath: `(dry-run)`,
      };
```

- [ ] **Step 6: Run typecheck — must now be clean**

Run: `yarn typecheck`
Expected: PASS, zero errors. Both `InFlightSession` construction sites (`dispatch.ts`, dry-run stub) now supply `logPath`; the production lambda's `['ignore', fd, fd]` is allowed by the widened `stdio` type.

- [ ] **Step 7: Run the dry-run regression test**

Run: `yarn test run-eng-loop-dry-run`
Expected: PASS — the #598 regression test still holds; the dry-run stub now also carries `logPath: '(dry-run)'`.

- [ ] **Step 8: Commit**

```bash
git add scripts/run-eng-loop.ts test/dispatcher/session-log-append.test.ts
git commit -m "feat(eng-loop): open append-mode per-session log fds in spawn lambda (#533)"
```

---

## Task 5: Full verification + manual tail smoke check

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole package**

Run (from `packages/eng-loop`): `yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Run the full test suite**

Run: `yarn test`
Expected: all tests PASS, including the new `session-log`, `session-log-append`, the four new `dispatch` #533 tests, the extended shape assertion, and the unchanged `run-eng-loop-dry-run` regression.

- [ ] **Step 3: Manual `tail -f` smoke check (AC#3 + AC#4)**

This confirms the live wiring the unit tests can only approximate. Run a one-shot live cycle against the real queue is heavyweight; instead do a minimal direct check of the fd wiring using the exact lambda shape:

```bash
# Simulate what the production lambda does for issue 999, twice, then tail.
node --input-type=module -e '
import { mkdirSync, openSync, closeSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
import { SESSIONS_LOG_DIR, sessionLogPath } from "./src/dispatcher/session-log.js";
const p = sessionLogPath(999);
for (const msg of ["first run", "second run"]) {
  mkdirSync(SESSIONS_LOG_DIR, { recursive: true });
  const fd = openSync(p, "a");
  writeSync(fd, `\n===== dispatch ${new Date().toISOString()} =====\n`);
  const c = spawn("sh", ["-c", `echo ${msg} stdout; echo ${msg} stderr 1>&2`], { stdio: ["ignore", fd, fd] });
  c.on("exit", () => closeSync(fd));
}
setTimeout(() => {}, 500);
' && sleep 1 && echo "--- log contents ---" && cat "$HOME/.jinn-client/eng-loop/sessions/999.log"
```

Expected: the log file at `~/.jinn-client/eng-loop/sessions/999.log` contains BOTH runs' delimiters and BOTH stdout and stderr lines from each run (interleaved), proving:
- AC#1 stdout+stderr captured to the per-session path;
- AC#3 the path is stable + tailable (`tail -f "$HOME/.jinn-client/eng-loop/sessions/999.log"` follows it);
- AC#4 the second run appended below the first (no overwrite — two delimiter blocks present).

Clean up: `rm "$HOME/.jinn-client/eng-loop/sessions/999.log"`

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(eng-loop): verify per-session log capture (#533)"
```

(Skip if nothing changed during verification.)

---

## Acceptance-Criteria → Task Map

| # | Acceptance criterion | Task(s) |
|---|----------------------|---------|
| 1 | Each spawned session's stdout AND stderr captured to a per-session log under a stable path `~/.jinn-client/eng-loop/sessions/<N>.log` | Task 1 (path scheme), Task 3 (path threaded through spawn opts), Task 4 (lambda opens fd, wires `['ignore', fd, fd]`), Task 5 Step 3 (manual proof) |
| 2 | Log path included in the cycle report alongside the session PID | Task 2 (`InFlightSession.logPath` field), Task 3 (`dispatchIssue` populates it + emits `[dispatch] #<N> pid=<pid> log=<path>`) |
| 3 | A running session can be tailed via `tail -f` from any terminal | Task 1 (absolute, deterministic, stable path from `homedir()`), Task 4 (single file, both fds → one log), Task 5 Step 3 (manual `tail -f` confirmation) |
| 4 | Old logs not silently overwritten — append (or timestamped) | Task 1 (path is NOT timestamped — stability by design), Task 4 (append-mode `openSync(path, 'a')` + delimiter line), Task 4 Step 1 append-mode unit test, Task 5 Step 3 (two-run append proof) |

---

## Self-Review Notes

- **Spec coverage:** All four ACs map to concrete tasks/steps (table above). The design-note's explicit scope boundary (review-session spawn OUT) is honored — `runReviewPass` / `dispatchReview` are untouched; `session-log.ts` is left reusable for the follow-up.
- **No report-contract reshape:** `CycleReport` and `loop.ts` are deliberately untouched (per design note) — AC#2 is satisfied via `InFlightSession.logPath` + the `[dispatch]` console line, not a new report field.
- **Type consistency:** `sessionLogPath` / `SESSIONS_LOG_DIR` names are identical across `session-log.ts`, both test files, `dispatch.ts`, and `run-eng-loop.ts`. `InFlightSession.logPath` is `string` (non-optional) at all three construction sites (dispatch real, dry-run stub) — Task 2 typecheck-fail → Task 3/4 fix sequence guarantees the compiler catches any miss.
- **Seam preserved:** fd I/O lives only in the production lambda; the fake spawn in `dispatch.test.ts` never opens a real fd, so existing dispatch tests keep passing. The `stdio: ['ignore','inherit','inherit']` placeholder set by `dispatchIssue` is overridden by the lambda's `['ignore', fd, fd]`.
- **ESM gotcha flagged:** Task 4 explicitly forbids `require('node:fs')` in this ESM module and routes the delimiter write through the imported `writeSync`.
- **Intermediate red typecheck:** Task 2 commits with a knowingly-red `yarn typecheck` (callers not yet updated); resolved by end of Task 4 Step 6. Acceptable per TDD; called out so the engineer does not paper over it.
- **Session logs are created `0o600` (owner-only):** the production lambda opens each log with `openSync(logPath, 'a', 0o600)` because session output may contain secrets (tokens in `gh`/git error output, env echoes, prompt material). The create-mode only applies on first creation; re-dispatches append to the existing file without chmod.
