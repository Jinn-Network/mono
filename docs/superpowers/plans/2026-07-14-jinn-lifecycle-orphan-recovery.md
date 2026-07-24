---

# jinn Daemon Lifecycle: Orphan Recovery (#805) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three daemon-lifecycle holes in issue #805 — `jinn run` refusing on a recycled (non-jinn) pid instead of reclaiming it, `jinn stop` giving up when its pidfile is stale/missing, and no `jinn kill [--all]` verb to force-terminate orphaned jinn daemons by cmdline enumeration.

**Architecture:** One new shared pure module (`client/src/lifecycle/process-discovery.ts`, lifted near-verbatim from abandoned commit `cb7129437`) provides `enumerateJinnProcesses()`, `processAlive()`, and `pidMatchesJinn()`. `pidfile-liveness.ts` (the `jinn run` precheck) grows one new decision branch that reclaims a live-but-non-jinn pid instead of refusing. `stop.ts` grows an enumeration fallback for the missing/stale-pidfile cases (SIGTERM only, matching its existing "graceful" contract). A new `kill.ts` command (DI-factory pattern, matching `doctor.ts`) enumerates and force-terminates jinn processes with a SIGTERM→10s→SIGKILL escalation, gated by `--all` when more than one match is found.

**Tech Stack:** TypeScript, vitest, Node `child_process.execSync`/`process.kill`, existing `CommandModule`/`emitResult`/`emitEnvelope` CLI plumbing.

## Global Constraints

- Fix shape: regression-test-first. Every behavior change below gets a failing test before implementation.
- Simplicity First / Surgical Changes (CLAUDE.md Rules 2–3): no `--dry-run` mode, no config surface for the 10s SIGTERM→SIGKILL timeout, no restructuring of `stop.ts` into a DI factory (only `kill.ts`, which is new, uses the DI factory pattern).
- American English throughout (Rule 5).
- `jinn stop` remains SIGTERM-only (graceful); only `jinn kill` escalates to SIGKILL.
- `StopResult`'s new `discoveredPids?: number[]` field is additive — omit it (don't emit `[]`) when the enumeration fallback wasn't triggered or found nothing, so existing JSON consumers see an unchanged shape in the common case.
- `jinn kill` without `--all`: kills a single match outright; refuses (exit 11, `invalid_invocation`) and lists what it found when more than one match exists, requiring `--all` to proceed. This is the "least surprise" reading of the issue text per the coordinator's scope decision.
- Verification commands (run after every task, mandatory before the final task closes): `cd client && yarn typecheck` and `cd client && yarn test`. Targeted runs use `yarn vitest run <path>`.

---

### Task 1: Lift the shared `process-discovery` module

**Files:**
- Create: `client/src/lifecycle/process-discovery.ts`
- Create: `client/test/lifecycle/process-discovery.test.ts`

**Interfaces:**
- Produces: `processAlive(pid: number): boolean`, `readPidfile(path: string): PidfileStatus`, `enumerateJinnProcesses(): JinnProcess[]`, `pidMatchesJinn(pid: number): boolean` (newly exported — the only change from the abandoned commit besides the doc-comment link), `__setExecSyncForTesting(fn)`, `__resetExecSyncForTesting()`. Types `PidfileStatus { pid: number | null; alive: boolean; isJinn: boolean }`, `JinnProcess { pid: number; command: string }`.
- Consumed by: Task 2 (`pidMatchesJinn`), Task 3 (`enumerateJinnProcesses`), Task 4 (`enumerateJinnProcesses`, `processAlive`).

- [ ] **Step 1: Write the test file (copied from `cb7129437`, plus one new case for the newly-exported `pidMatchesJinn`)**

Create `client/test/lifecycle/process-discovery.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  processAlive,
  readPidfile,
  enumerateJinnProcesses,
  pidMatchesJinn,
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

describe('processAlive', () => {
  it('returns true for the current process', () => {
    expect(processAlive(process.pid)).toBe(true);
  });
  it('returns false for an obviously-dead pid', () => {
    expect(processAlive(2 ** 22)).toBe(false);
  });
});

describe('readPidfile', () => {
  it('returns alive=false when the file does not exist', () => {
    const result = readPidfile(join(tmpdir(), 'jinn-does-not-exist-' + Date.now() + '.pid'));
    expect(result).toEqual({ pid: null, alive: false, isJinn: false });
  });

  it('parses a bare-pid pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pidfile-'));
    const path = join(dir, 'daemon.pid');
    writeFileSync(path, String(process.pid) + '\n');
    const result = readPidfile(path);
    expect(result.pid).toBe(process.pid);
    expect(result.alive).toBe(true);
    expect(typeof result.isJinn).toBe('boolean');
  });

  it('returns pid=null for a malformed pidfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-pidfile-'));
    const path = join(dir, 'daemon.pid');
    writeFileSync(path, 'not-a-number\n');
    const result = readPidfile(path);
    expect(result.pid).toBeNull();
    expect(result.alive).toBe(false);
    expect(result.isJinn).toBe(false);
  });
});

describe('pidMatchesJinn (with injected execSync)', () => {
  beforeEach(() => {
    __resetExecSyncForTesting();
  });
  afterEach(() => {
    __resetExecSyncForTesting();
  });

  it('returns true when ps reports a jinn daemon cmdline', () => {
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    expect(pidMatchesJinn(123456)).toBe(true);
  });

  it('returns false when ps reports an unrelated cmdline', () => {
    __setExecSyncForTesting(() => 'python train.py\n');
    expect(pidMatchesJinn(123456)).toBe(false);
  });

  it('returns false when ps throws (pid gone between checks)', () => {
    __setExecSyncForTesting(() => {
      throw new Error('ps: no such process');
    });
    expect(pidMatchesJinn(123456)).toBe(false);
  });
});

describe('enumerateJinnProcesses (with injected execSync)', () => {
  beforeEach(() => {
    __resetExecSyncForTesting();
  });
  afterEach(() => {
    __resetExecSyncForTesting();
  });

  it('matches the production `node dist/bin/jinn.js run` invocation', () => {
    __setExecSyncForTesting(() =>
      [
        ' 1111 node /opt/jinn/dist/bin/jinn.js run',
        ' 2222 /usr/local/bin/node /home/op/.nvm/versions/node/v22/bin/jinn run',
        ' 3333 grep jinn',
        ' 4444 zsh',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid).sort()).toEqual([1111, 2222]);
  });

  it('excludes the current process pid', () => {
    __setExecSyncForTesting(() =>
      [
        ` ${process.pid} node dist/bin/jinn.js run`,
        ' 9999 node dist/bin/jinn.js run',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid)).toEqual([9999]);
  });

  it('returns [] when ps emits nothing useful', () => {
    __setExecSyncForTesting(() => '\n');
    expect(enumerateJinnProcesses()).toEqual([]);
  });

  it('returns [] when ps throws', () => {
    __setExecSyncForTesting(() => {
      throw new Error('ps not found');
    });
    expect(enumerateJinnProcesses()).toEqual([]);
  });

  it('does not match unrelated processes with "jinn" in their path', () => {
    __setExecSyncForTesting(() =>
      [
        ' 5555 vim /home/op/jinn-notes.md',
        ' 6666 cat /var/log/jinn.log',
        ' 7777 node /opt/jinn/dist/bin/jinn.js run --config=x',
      ].join('\n'),
    );
    const result = enumerateJinnProcesses();
    expect(result.map((p) => p.pid)).toEqual([7777]);
  });
});
```

- [ ] **Step 2: Run the test file and confirm it fails on the missing module**

Run: `cd client && yarn vitest run test/lifecycle/process-discovery.test.ts`
Expected: FAIL — `Cannot find module '../../src/lifecycle/process-discovery.js'`

- [ ] **Step 3: Create the implementation**

Create `client/src/lifecycle/process-discovery.ts` (lifted from `cb7129437`, with `pidMatchesJinn` exported and the doc-comment plan link repointed at this plan's saved path):

```ts
/**
 * Shared process-discovery helpers for daemon lifecycle controls.
 *
 * Used by `jinn run` (precheck), `jinn stop` (fallback), and `jinn kill`
 * (enumeration). All helpers are sync — they shell out to `ps` or read
 * /proc — and never block on network or daemon-side I/O.
 *
 * The cmdline-match regex MUST exclude `process.pid` to keep the precheck
 * safe for the running CLI process itself.
 *
 * Design: docs/superpowers/plans/2026-07-14-jinn-lifecycle-orphan-recovery.md
 * Issue: #805
 */
import { execSync as nodeExecSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface PidfileStatus {
  /** Parsed pid, or null if file missing / malformed. */
  pid: number | null;
  /** `process.kill(pid, 0)` succeeded. */
  alive: boolean;
  /** `alive` AND cmdline matches the jinn daemon regex. */
  isJinn: boolean;
}

export interface JinnProcess {
  pid: number;
  command: string;
}

// Matches:
//   `node /path/to/dist/bin/jinn.js run [...]`
//   `/usr/bin/node .../dist/bin/jinn.js run`
//   `jinn run [...]`  (when invoked via the published `jinn` shim)
// Does NOT match:
//   `grep jinn`
//   `vim jinn-notes.md`
//   `cat /var/log/jinn.log`
const JINN_CMDLINE_RE = /(?:\bnode\b[^\s]*\s+\S*dist\/bin\/jinn\.js|\bjinn\b)\s+run\b/;

// Injectable for tests. Production uses node:child_process.execSync directly.
type ExecSyncFn = (cmd: string) => string | Buffer;
let execSyncImpl: ExecSyncFn = (cmd) => nodeExecSync(cmd, { encoding: 'utf-8' });

/** @internal — tests only */
export function __setExecSyncForTesting(fn: ExecSyncFn): void {
  execSyncImpl = fn;
}
/** @internal — tests only */
export function __resetExecSyncForTesting(): void {
  execSyncImpl = (cmd) => nodeExecSync(cmd, { encoding: 'utf-8' });
}

/** True iff `process.kill(pid, 0)` succeeds. Pure check, no signal sent. */
export function processAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read `pid` from a bare-integer pidfile, then probe liveness and cmdline.
 * Never throws; missing/malformed/dead all return structured negatives.
 */
export function readPidfile(path: string): PidfileStatus {
  if (!existsSync(path)) {
    return { pid: null, alive: false, isJinn: false };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return { pid: null, alive: false, isJinn: false };
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { pid: null, alive: false, isJinn: false };
  }
  const alive = processAlive(parsed);
  if (!alive) {
    return { pid: parsed, alive: false, isJinn: false };
  }
  const isJinn = pidMatchesJinn(parsed);
  return { pid: parsed, alive: true, isJinn };
}

/**
 * Read the cmdline for a single pid; true iff it matches the jinn regex.
 * Exported (#805) so `pidfile-liveness.ts`'s `jinn run` precheck can reclaim
 * a live-but-not-jinn pid instead of refusing.
 */
export function pidMatchesJinn(pid: number): boolean {
  try {
    const out = String(execSyncImpl(`ps -p ${pid} -o command=`)).trim();
    if (!out) return false;
    return JINN_CMDLINE_RE.test(out);
  } catch {
    return false;
  }
}

/**
 * Enumerate all jinn-daemon processes on the host. Excludes `process.pid`
 * so the calling CLI never lists itself. Returns [] on any ps error or
 * empty output — callers must treat "found nothing" as authoritative.
 */
export function enumerateJinnProcesses(): JinnProcess[] {
  let out: string;
  try {
    out = String(execSyncImpl('ps -eo pid=,command=')).trim();
  } catch {
    return [];
  }
  if (!out) return [];
  const results: JinnProcess[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number.parseInt(m[1]!, 10);
    const cmd = m[2]!.trim();
    if (!Number.isFinite(pid) || pid === process.pid) continue;
    if (!JINN_CMDLINE_RE.test(cmd)) continue;
    results.push({ pid, command: cmd });
  }
  return results;
}
```

- [ ] **Step 4: Run the test file and confirm it passes**

Run: `cd client && yarn vitest run test/lifecycle/process-discovery.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd client
git add src/lifecycle/process-discovery.ts test/lifecycle/process-discovery.test.ts
git commit -m "$(cat <<'EOF'
test(805): add shared process-discovery helpers

Pure module backing the run/stop/kill lifecycle work: enumerateJinnProcesses(),
processAlive(), pidMatchesJinn(), readPidfile(). Lifted from abandoned branch
fix/805-jinn-lifecycle-controls (cb7129437), with pidMatchesJinn exported for
the jinn-run precheck (Task 2).

Refs: #805
EOF
)"
```

---

### Task 2: `jinn run` precheck reclaims a live-but-not-jinn pid (recycled-pid bug)

**Files:**
- Modify: `client/src/preflight/pidfile-liveness.ts`
- Modify: `client/test/preflight/pidfile-liveness.test.ts`
- Modify: `client/test/main/concurrent-jinn-run-refused.test.ts`

**Interfaces:**
- Consumes: `pidMatchesJinn` from `client/src/lifecycle/process-discovery.ts` (Task 1).
- Produces: `PidfileLivenessDecision`'s `unlink-stale` variant gains reason `'not-jinn'`. `checkPidfileLiveness` and `applyPidfileLivenessGate` signatures are unchanged.

**Why two existing test files need edits, not just new tests:** `pidMatchesJinn` shells out to real `ps` in production. Once wired in, any existing test that mocks `process.kill` to report a pid "alive" (but doesn't mock `ps` too) will now hit real `ps -p <pid> -o command=`, which fails for a pid that was never really spawned — flipping the decision from `refuse/alive` to `unlink-stale/not-jinn` and breaking the test. Both `pidfile-liveness.test.ts`'s "returns refuse when the recorded PID is alive" test and `concurrent-jinn-run-refused.test.ts`'s two sibling-pid tests fall into this trap.

- [ ] **Step 1: Update `pidfile-liveness.test.ts` — fix the now-broken "alive" test and add two new cases**

In `client/test/preflight/pidfile-liveness.test.ts`, add the import and reset hooks:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPidfileLiveness } from '../../src/preflight/pidfile-liveness.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';

describe('pidfile-liveness preflight', () => {
  let tmp: string;
  let pidPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-pidfile-liveness-'));
    pidPath = join(tmp, 'daemon.pid');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    __resetExecSyncForTesting();
  });
```

Replace the existing "returns refuse when the recorded PID is alive" test (it must now also stub the cmdline check to report a jinn-matching process, otherwise the real `ps -p 987654` lookup fails and the decision flips):

```ts
  it('returns refuse when the recorded PID is alive and is a jinn daemon', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'alive' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reclaims a pidfile recording a live pid whose cmdline is not a jinn daemon (recycled pid / #805)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    __setExecSyncForTesting(() => 'python train.py\n');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({
        decision: 'unlink-stale',
        pid: 987654,
        reason: 'not-jinn',
        pidfilePath: pidPath,
      });
    } finally {
      killSpy.mockRestore();
    }
  });
```

Leave every other existing test in this file unchanged (self/PID-1, malformed, ESRCH, EPERM, and unknown-errno all short-circuit before the cmdline check runs).

- [ ] **Step 2: Update `concurrent-jinn-run-refused.test.ts` — pin the sibling-pid mock's cmdline and add one new integration case**

In the `beforeEach`, add the cmdline stub right after the existing `killSpy` assignment, and import the reset hooks:

```ts
import {
  applyPidfileLivenessGate,
  checkPidfileLiveness,
} from '../../src/preflight/pidfile-liveness.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../src/lifecycle/process-discovery.js';
```

```ts
  beforeEach(async () => {
    // ...unchanged setup...
    writeFileSync(pidPath, `${siblingPid}\n`, 'utf-8');
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === siblingPid && sig === 0) {
        return true as never;
      }
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    // #805: the sibling is a genuine jinn daemon — pin the cmdline probe so
    // the refuse-path tests below aren't at the mercy of real `ps` output.
    __setExecSyncForTesting(() => 'node /opt/jinn/dist/bin/jinn.js run\n');
  });

  afterEach(async () => {
    killSpy?.mockRestore();
    killSpy = undefined;
    __resetExecSyncForTesting();
    await daemon.stop().catch(() => undefined);
    rmSync(tmp, { recursive: true, force: true });
  });
```

Add a new test after the ESRCH case at the end of the `describe` block:

```ts
  it('reclaims (does not refuse) when the sibling pid is alive but not a jinn daemon — #805 recycled-pid case', () => {
    __setExecSyncForTesting(() => 'python train.py\n');
    const decision = checkPidfileLiveness({ pidPath });
    expect(decision.decision).toBe('unlink-stale');
    if (decision.decision === 'unlink-stale') {
      expect(decision.pid).toBe(siblingPid);
      expect(decision.reason).toBe('not-jinn');
    }
  });
```

- [ ] **Step 3: Run both test files and confirm they fail**

Run: `cd client && yarn vitest run test/preflight/pidfile-liveness.test.ts test/main/concurrent-jinn-run-refused.test.ts`
Expected: FAIL — the two new tests fail because `checkPidfileLiveness` doesn't yet call `pidMatchesJinn`; the `'not-jinn'` reason and the corresponding TS union member don't exist yet, so this may also be a type error at this point (that's fine — it demonstrates the gap).

- [ ] **Step 4: Implement the reclaim branch in `pidfile-liveness.ts`**

Edit `client/src/preflight/pidfile-liveness.ts`:

Add the import:

```ts
import { existsSync, readFileSync, unlinkSync } from 'node:fs';

import { emitEnvelope, type EnvelopeSinks } from '../errors/envelope.js';
import { emitStructured } from '../events/emitter.js';
import { pidMatchesJinn } from '../lifecycle/process-discovery.js';
```

Update the doc comment's branch list (top of file) to add the new branch, and update the discriminated union:

```ts
/**
 * Pidfile liveness preflight (issue #649). Classifies the recorded PID and
 * returns a discriminated decision; side-effect-free so the caller owns the
 * unlink (mirrors the idiom at `client/src/mcp/operator-server.ts:209-213`).
 *
 * Branches (load-bearing — see #649 acceptance criteria):
 *   - File missing               → { decision: 'proceed' }
 *   - File malformed (NaN/empty) → { decision: 'unlink-stale', reason: 'malformed' }
 *   - PID 1 or our own pid       → { decision: 'unlink-stale', reason: 'self-or-pid1-container' }
 *   - process.kill(pid, 0) ESRCH → { decision: 'unlink-stale', reason: 'esrch' }
 *   - alive but not a jinn cmdline (#805, recycled pid) → { decision: 'unlink-stale', reason: 'not-jinn' }
 *   - process.kill(pid, 0) ok AND cmdline is a jinn daemon → { decision: 'refuse', reason: 'alive' }
 *   - process.kill(pid, 0) EPERM → { decision: 'refuse', reason: 'eperm' }
 *   - any other errno            → { decision: 'refuse', reason: 'unknown' }
 * ...
 */

export type PidfileLivenessDecision =
  | { decision: 'proceed' }
  | {
      decision: 'unlink-stale';
      pid: number | null;
      pidfilePath: string;
      reason: 'malformed' | 'esrch' | 'self-or-pid1-container' | 'not-jinn';
    }
  | {
      decision: 'refuse';
      pid: number;
      pidfilePath: string;
      reason: 'alive' | 'eperm' | 'unknown';
    };
```

Update the liveness probe:

```ts
  try {
    process.kill(parsed, 0);
    // #805: the OS can recycle a pid after the jinn daemon that owned it
    // exits — process.kill(pid, 0) succeeds against whatever new process now
    // holds that pid, which is not a jinn daemon. Refusing here would block
    // `jinn run` forever on a stale pidfile that happens to alias a live,
    // unrelated process. Confirm the cmdline before refusing.
    if (!pidMatchesJinn(parsed)) {
      return { decision: 'unlink-stale', pid: parsed, pidfilePath: pidPath, reason: 'not-jinn' };
    }
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'alive' };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') {
      return { decision: 'unlink-stale', pid: parsed, pidfilePath: pidPath, reason: 'esrch' };
    }
    if (errno === 'EPERM') {
      return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'eperm' };
    }
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'unknown' };
  }
```

Update the refuse-branch envelope hint in `applyPidfileLivenessGate` to mention `jinn kill` (closes the issue's "hinting `jinn stop` / `jinn kill`" ask):

```ts
    emitEnvelope(
      {
        code: 'invalid_invocation',
        message: `Another jinn daemon is already running (PID ${liveness.pid}).`,
        hint: 'Run `jinn stop` to terminate it gracefully, or `jinn kill` if it does not respond, or set JINN_EARNING_DIR to a different earning directory.',
        exampleCli: 'jinn stop',
        details: {
          field: 'daemon_pidfile',
          pid: liveness.pid,
          pidfilePath: pidPath,
          reason: liveness.reason,
        },
      },
      sinks,
    );
```

- [ ] **Step 5: Run both test files and confirm they pass**

Run: `cd client && yarn vitest run test/preflight/pidfile-liveness.test.ts test/main/concurrent-jinn-run-refused.test.ts`
Expected: PASS — all cases, old and new.

- [ ] **Step 6: Full test run to catch any other consumer of the hint string or the union type**

Run: `cd client && yarn test`
Expected: PASS. (Confirmed in exploration: no other test file references `checkPidfileLiveness`/`applyPidfileLivenessGate` or the exact hint string, so no further edits are expected — but this step is the actual verification, not an assumption.)

- [ ] **Step 7: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 8: Commit**

```bash
cd client
git add src/preflight/pidfile-liveness.ts test/preflight/pidfile-liveness.test.ts test/main/concurrent-jinn-run-refused.test.ts
git commit -m "$(cat <<'EOF'
fix(805): jinn run reclaims a live pid whose cmdline is not a jinn daemon

The pidfile-liveness precheck refused jinn run whenever process.kill(pid, 0)
succeeded, even if the OS had recycled that pid to an unrelated process after
the daemon that owned it exited. Confirm the cmdline via the new
pidMatchesJinn() helper before refusing; reclaim (unlink-stale, reason
'not-jinn') otherwise. Also hints `jinn kill` alongside `jinn stop` in the
refuse envelope.

Refs: #805
EOF
)"
```

---

### Task 3: `jinn stop` falls through to enumeration when the pidfile is stale or missing

**Files:**
- Modify: `client/src/cli/commands/stop.ts`
- Modify: `client/test/cli/commands/stop.test.ts`

**Interfaces:**
- Consumes: `enumerateJinnProcesses` from `client/src/lifecycle/process-discovery.ts` (Task 1).
- Produces: `StopResult` gains `discoveredPids?: number[]` (additive).

- [ ] **Step 1: Rewrite `stop.test.ts` — pin enumeration to empty by default, add three new fallback cases**

Replace `client/test/cli/commands/stop.test.ts` in full:

```ts
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import stop from '../../../src/cli/commands/stop.js';
import { makeCommandCtx } from '@test/cli.js';
import { Store } from '../../../src/store/store.js';
import {
  __setExecSyncForTesting,
  __resetExecSyncForTesting,
} from '../../../src/lifecycle/process-discovery.js';

describe('stop command', () => {
  // Deterministic by default: no orphaned processes discovered, regardless
  // of what's actually running on the host machine (#805 — operators
  // routinely have real stray jinn daemons around, which must not leak into
  // these unit tests). Individual tests override this to exercise the
  // enumeration fallback.
  beforeEach(() => {
    __setExecSyncForTesting(() => '');
  });
  afterEach(() => {
    __resetExecSyncForTesting();
    vi.restoreAllMocks();
  });

  it('is success-shaped when no pidfile exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const { ctx, writes, exits } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.state).toBe('stopped');
    expect(parsed.pid).toBeNull();
    expect(parsed.killed).toBe(false);
    expect(parsed.discoveredPids).toBeUndefined();
    expect(exits).toEqual([]);
  });

  it('reads the pidfile and reports the pid on success', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    // PID 99999 almost certainly doesn't exist — stop should still emit a
    // success-shaped response with killed=false rather than an envelope.
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.pid).toBe(99999);
    expect(typeof parsed.killed).toBe('boolean');
  });

  it('removes stale pidfiles and clears persisted running state', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    const dbPath = join(dir, 'jinn.db');
    const store = new Store(dbPath);
    try {
      store.setShutdownState('running');
    } finally {
      store.close();
    }
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ dbPath, earningDir: dir }), 'utf8');
    writeFileSync(join(dir, 'daemon.pid'), '99999\n');

    const { ctx, writes } = makeCommandCtx({ argv: ['--config', join(dir, 'config.json')] });
    await stop.run(ctx);

    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      state: 'stopped',
      pid: 99999,
      killed: false,
      pidfileRemoved: true,
      stalePidfileCleaned: true,
    });
    expect(parsed.discoveredPids).toBeUndefined();
    expect(existsSync(join(dir, 'daemon.pid'))).toBe(false);
    const verifyStore = new Store(dbPath);
    try {
      expect(verifyStore.getShutdownState()).toBe('clean');
    } finally {
      verifyStore.close();
    }
  });

  it('emits invalid_invocation for bad flags', async () => {
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--humna'] });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });

  it('#805: falls through to cmdline enumeration and signals discovered processes when the pidfile is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    __setExecSyncForTesting(() =>
      [' 55555 node /opt/jinn/dist/bin/jinn.js run', ' 66666 zsh'].join('\n'),
    );
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.state).toBe('stopping');
    expect(parsed.pid).toBeNull();
    expect(parsed.killed).toBe(true);
    expect(parsed.discoveredPids).toEqual([55555]);
    expect(killSpy).toHaveBeenCalledWith(55555, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('#805: falls through to cmdline enumeration when the recorded pidfile pid is stale (ESRCH)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    writeFileSync(join(dir, 'daemon.pid'), '77777\n');
    __setExecSyncForTesting(() => ' 88888 node /opt/jinn/dist/bin/jinn.js run');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === 77777) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as never;
    });
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.pid).toBe(77777);
    expect(parsed.stalePidfileCleaned).toBe(true);
    expect(parsed.pidfileRemoved).toBe(true);
    expect(parsed.killed).toBe(true);
    expect(parsed.discoveredPids).toEqual([88888]);
    expect(killSpy).toHaveBeenCalledWith(88888, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('#805: missing pidfile + no discovered processes reports plain stopped (no regression)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-stop-test-'));
    // beforeEach already pins execSync to return '' — nothing discovered.
    const { ctx, writes } = makeCommandCtx({ env: { JINN_EARNING_DIR: dir } });
    await stop.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.state).toBe('stopped');
    expect(parsed.killed).toBe(false);
    expect(parsed.discoveredPids).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run and confirm the three new `#805` tests fail**

Run: `cd client && yarn vitest run test/cli/commands/stop.test.ts`
Expected: the three new `#805`-prefixed tests FAIL (missing `discoveredPids` field / enumeration never called); the four pre-existing tests still PASS unmodified in behavior.

- [ ] **Step 3: Implement the enumeration fallback in `stop.ts`**

Edit `client/src/cli/commands/stop.ts`. Add the import:

```ts
import { parseArgs } from 'node:util';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandModule } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import { loadConfig } from '../../config.js';
import { Store } from '../../store/store.js';
import { enumerateJinnProcesses } from '../../lifecycle/process-discovery.js';
```

Add `discoveredPids` to `StopResult`:

```ts
interface StopResult {
  schemaVersion: 1;
  generatedAt: string;
  state: 'stopped' | 'stopping';
  pid: number | null;
  killed: boolean;
  pidfilePath: string;
  pidfileRemoved: boolean;
  stalePidfileCleaned: boolean;
  /** #805 — pids found and SIGTERM'd via cmdline enumeration when the
   * recorded pidfile pid could not identify a live daemon. Present only
   * when the fallback ran and found something. */
  discoveredPids?: number[];
}
```

Add the helper after `removePidfile`:

```ts
/**
 * #805: cmdline-enumeration fallback for `jinn stop`. Called only when the
 * pidfile-recorded pid could not identify a live daemon (missing pidfile,
 * malformed pidfile, or the recorded pid is already dead) — an orphaned
 * jinn daemon may still be running under a pid the stale pidfile never
 * recorded. SIGTERM only, matching stop's "graceful signal" contract;
 * `jinn kill` owns the SIGKILL escalation.
 */
function killDiscoveredJinnProcesses(): number[] {
  const found = enumerateJinnProcesses();
  const killedPids: number[] = [];
  for (const proc of found) {
    try {
      process.kill(proc.pid, 'SIGTERM');
      killedPids.push(proc.pid);
    } catch {
      // Process exited between enumeration and signal — not an error.
    }
  }
  return killedPids;
}
```

Replace the no-pidfile branch:

```ts
  if (!existsSync(pidPath)) {
    markShutdownClean(dbPath);
    // #805: no pidfile to read — fall through to cmdline enumeration so an
    // orphaned daemon (pidfile lost or never written) still gets signalled
    // instead of `jinn stop` silently no-oping.
    const discoveredPids = killDiscoveredJinnProcesses();
    emitResult(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        state: discoveredPids.length > 0 ? 'stopping' : 'stopped',
        pid: null,
        killed: discoveredPids.length > 0,
        pidfilePath: pidPath,
        pidfileRemoved: false,
        stalePidfileCleaned: false,
        ...(discoveredPids.length > 0 ? { discoveredPids } : {}),
      } satisfies StopResult,
      (v) => {
        const value = v as StopResult;
        return value.discoveredPids && value.discoveredPids.length > 0
          ? `No pidfile found; discovered and signalled ${value.discoveredPids.length} orphaned jinn process(es): ${value.discoveredPids.join(', ')}.`
          : 'Daemon is already stopped.';
      },
      {
        json: Boolean(parsed.values.json),
        human: Boolean(parsed.values.human),
        writer: ctx.writer,
        stdoutIsTty: ctx.stdoutIsTty,
        noColor: Boolean(ctx.env['NO_COLOR']),
      },
    );
    return;
  }
```

Replace the main path's try/catch and final `emitResult`:

```ts
  const parsedPid = parseInt(readFileSync(pidPath, 'utf-8').trim(), 10);
  const pid = Number.isFinite(parsedPid) ? parsedPid : null;
  let killed = false;
  let stalePidfileCleaned = false;
  let pidfileRemoved = false;
  let discoveredPids: number[] = [];
  try {
    if (pid === null) throw new Error('invalid pidfile');
    process.kill(pid, 'SIGTERM');
    killed = true;
  } catch {
    // Recorded pid is gone or the pidfile was malformed; clean stale state
    // and fall through to cmdline enumeration (#805) — an orphaned daemon
    // may still be running under a pid the stale file doesn't record.
    stalePidfileCleaned = true;
    pidfileRemoved = removePidfile(pidPath);
    markShutdownClean(dbPath);
    discoveredPids = killDiscoveredJinnProcesses();
  }

  emitResult(
    {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      state:
        killed || discoveredPids.length > 0 || (pid !== null && processAlive(pid))
          ? 'stopping'
          : 'stopped',
      pid,
      killed: killed || discoveredPids.length > 0,
      pidfilePath: pidPath,
      pidfileRemoved,
      stalePidfileCleaned,
      ...(discoveredPids.length > 0 ? { discoveredPids } : {}),
    },
    (v) => {
      const value = v as StopResult;
      if (value.killed && value.discoveredPids && value.discoveredPids.length > 0) {
        return `Daemon pid ${value.pid} was already gone; signalled ${value.discoveredPids.length} discovered jinn process(es): ${value.discoveredPids.join(', ')}.`;
      }
      return value.killed
        ? `Sent SIGTERM to daemon pid ${value.pid}.`
        : `Daemon pid ${value.pid} was already gone; cleaned stale state.`;
    },
    {
      json: Boolean(parsed.values.json),
      human: Boolean(parsed.values.human),
      writer: ctx.writer,
      stdoutIsTty: ctx.stdoutIsTty,
      noColor: Boolean(ctx.env['NO_COLOR']),
    },
  );
}
```

Update `helpText`:

```ts
  helpText: `Usage: jinn stop [--human]

Reads the daemon pid from <earningDir>/daemon.pid and sends SIGTERM.
Idempotent: if the daemon is already stopped, returns state=stopped and
killed=false with exit 0. Stale pidfiles are removed.

If the pidfile is missing, malformed, or records a pid that is already
dead, falls through to cmdline enumeration (#805) and sends SIGTERM to
any jinn daemon process found, reporting the pids in discoveredPids. Use
\`jinn kill\` if a process needs a harder SIGKILL escalation.

Examples:
  jinn stop
  jinn stop --human
`,
```

- [ ] **Step 4: Run and confirm all tests pass**

Run: `cd client && yarn vitest run test/cli/commands/stop.test.ts`
Expected: PASS — all seven tests.

- [ ] **Step 5: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
cd client
git add src/cli/commands/stop.ts test/cli/commands/stop.test.ts
git commit -m "$(cat <<'EOF'
fix(805): jinn stop falls through to cmdline enumeration on a stale pidfile

jinn stop only ever looked at <earningDir>/daemon.pid; a missing, malformed,
or stale pidfile made it a no-op even when an orphaned jinn daemon was still
running. Now falls through to enumerateJinnProcesses() and SIGTERMs any
survivors, reporting them in the new additive StopResult.discoveredPids
field. Stop remains SIGTERM-only — jinn kill (next commit) owns the SIGKILL
escalation.

Refs: #805
EOF
)"
```

---

### Task 4: New `jinn kill [--all]` command

**Files:**
- Create: `client/src/cli/commands/kill.ts`
- Create: `client/test/cli/commands/kill.test.ts`
- Modify: `client/src/cli/index.ts`
- Modify: `client/skills/jinn-operator/SKILL.md` (regenerated, not hand-edited)
- Modify: `spec/2026-04-14-client-surface.md`
- Modify: `client/README.md`

**Interfaces:**
- Consumes: `enumerateJinnProcesses`, `processAlive`, `JinnProcess` from `client/src/lifecycle/process-discovery.ts` (Task 1).
- Produces: `createKillCommand(deps?: KillDeps): CommandModule`, default-exports a `CommandModule` named `'kill'`. `KillDeps { enumerateJinnProcesses(): JinnProcess[]; killSignal(pid: number, signal: NodeJS.Signals): void; processAlive(pid: number): boolean; sleep(ms: number): Promise<void> }`.

- [ ] **Step 1: Write the failing test file**

Create `client/test/cli/commands/kill.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createKillCommand, type KillDeps } from '../../../src/cli/commands/kill.js';
import { makeCommandCtx } from '@test/cli.js';
import type { JinnProcess } from '../../../src/lifecycle/process-discovery.js';

function makeDeps(overrides: Partial<KillDeps> = {}): KillDeps {
  return {
    enumerateJinnProcesses: () => [],
    killSignal: vi.fn(),
    processAlive: () => false,
    sleep: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('kill command', () => {
  it('reports no processes found when enumeration is empty', async () => {
    const deps = makeDeps();
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.found).toEqual([]);
    expect(parsed.killed).toEqual([]);
    expect(parsed.forceKilled).toEqual([]);
    expect(exits).toEqual([]);
    expect(deps.killSignal).not.toHaveBeenCalled();
  });

  it('kills a single discovered process without --all', async () => {
    const found: JinnProcess[] = [{ pid: 1234, command: 'node dist/bin/jinn.js run' }];
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      processAlive: () => false, // dead immediately after SIGTERM
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.found).toEqual([{ pid: 1234, command: 'node dist/bin/jinn.js run' }]);
    expect(parsed.killed).toEqual([1234]);
    expect(parsed.forceKilled).toEqual([]);
    expect(deps.killSignal).toHaveBeenCalledTimes(1);
    expect(deps.killSignal).toHaveBeenCalledWith(1234, 'SIGTERM');
  });

  it('refuses more than one match without --all', async () => {
    const found: JinnProcess[] = [
      { pid: 1234, command: 'node dist/bin/jinn.js run' },
      { pid: 5678, command: 'node dist/bin/jinn.js run' },
    ];
    const deps = makeDeps({ enumerateJinnProcesses: () => found });
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
    expect(deps.killSignal).not.toHaveBeenCalled();
  });

  it('kills all discovered processes with --all', async () => {
    const found: JinnProcess[] = [
      { pid: 1234, command: 'node dist/bin/jinn.js run' },
      { pid: 5678, command: 'node dist/bin/jinn.js run' },
    ];
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      processAlive: () => false,
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx({ argv: ['--all'] });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed.sort()).toEqual([1234, 5678]);
    expect(deps.killSignal).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(deps.killSignal).toHaveBeenCalledWith(5678, 'SIGTERM');
  });

  it('escalates to SIGKILL after the SIGTERM timeout when the process never exits', async () => {
    const found: JinnProcess[] = [{ pid: 9999, command: 'node dist/bin/jinn.js run' }];
    const killSignal = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      enumerateJinnProcesses: () => found,
      killSignal,
      processAlive: () => true, // never exits on its own
      sleep,
    });
    const cmd = createKillCommand(deps);
    const { ctx, writes } = makeCommandCtx();
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.killed).toEqual([9999]);
    expect(parsed.forceKilled).toEqual([9999]);
    expect(killSignal).toHaveBeenCalledWith(9999, 'SIGTERM');
    expect(killSignal).toHaveBeenCalledWith(9999, 'SIGKILL');
    expect(killSignal.mock.calls[0]).toEqual([9999, 'SIGTERM']);
    expect(killSignal.mock.calls[killSignal.mock.calls.length - 1]).toEqual([9999, 'SIGKILL']);
    expect(sleep).toHaveBeenCalled();
  });

  it('emits invalid_invocation for bad flags', async () => {
    const deps = makeDeps();
    const cmd = createKillCommand(deps);
    const { ctx, writes, exits } = makeCommandCtx({ argv: ['--bogus'] });
    await cmd.run(ctx);
    const parsed = JSON.parse(writes[writes.length - 1]);
    expect(parsed.code).toBe('invalid_invocation');
    expect(exits).toEqual([11]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails on the missing module**

Run: `cd client && yarn vitest run test/cli/commands/kill.test.ts`
Expected: FAIL — `Cannot find module '../../../src/cli/commands/kill.js'`

- [ ] **Step 3: Implement `kill.ts`**

Create `client/src/cli/commands/kill.ts`:

```ts
import { parseArgs } from 'node:util';
import type { CommandContext, CommandModule } from '../command.js';
import { COMMON_FLAGS } from '../command.js';
import { emitResult } from '../output.js';
import { emitEnvelope } from '../../errors/envelope.js';
import {
  enumerateJinnProcesses as defaultEnumerateJinnProcesses,
  processAlive as defaultProcessAlive,
  type JinnProcess,
} from '../../lifecycle/process-discovery.js';

const POLL_INTERVAL_MS = 200;
const SIGTERM_TIMEOUT_MS = 10_000;

export interface KillDeps {
  enumerateJinnProcesses: () => JinnProcess[];
  killSignal: (pid: number, signal: NodeJS.Signals) => void;
  processAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

function defaultKillSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone.
  }
}

const PRODUCTION_DEPS: KillDeps = {
  enumerateJinnProcesses: defaultEnumerateJinnProcesses,
  killSignal: defaultKillSignal,
  processAlive: defaultProcessAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

interface KillResult {
  schemaVersion: 1;
  generatedAt: string;
  found: Array<{ pid: number; command: string }>;
  killed: number[];
  forceKilled: number[];
}

/**
 * SIGTERM one pid, poll `processAlive` up to SIGTERM_TIMEOUT_MS, and SIGKILL
 * if it's still alive after that. Returns whether SIGKILL was needed.
 */
async function terminateOne(pid: number, deps: KillDeps): Promise<{ pid: number; forced: boolean }> {
  deps.killSignal(pid, 'SIGTERM');
  let elapsed = 0;
  while (elapsed < SIGTERM_TIMEOUT_MS) {
    if (!deps.processAlive(pid)) {
      return { pid, forced: false };
    }
    await deps.sleep(POLL_INTERVAL_MS);
    elapsed += POLL_INTERVAL_MS;
  }
  if (deps.processAlive(pid)) {
    deps.killSignal(pid, 'SIGKILL');
    return { pid, forced: true };
  }
  return { pid, forced: false };
}

export function createKillCommand(deps: KillDeps = PRODUCTION_DEPS): CommandModule {
  return {
    name: 'kill',
    summary: 'Force-terminate jinn daemon processes discovered by cmdline enumeration',
    helpText: `Usage: jinn kill [--all] [--human]

Enumerates host processes whose command line matches a jinn daemon
invocation (\`node .../dist/bin/jinn.js run\` or \`jinn run\`), sends
SIGTERM, waits up to 10s, then sends SIGKILL to any survivor. Excludes
the current process.

Unlike \`jinn stop\`, this does not read a pidfile — it is the recovery
path when the pidfile is stale, missing, or ownerless.

If more than one matching process is found, jinn kill refuses and
requires --all to avoid silently killing an unrelated jinn daemon (e.g.
a second worktree or operator on the same host). A single match is
always killed without --all.

Examples:
  jinn kill
  jinn kill --all
  jinn kill --human
`,
    async run(ctx: CommandContext): Promise<void> {
      let parsed;
      try {
        parsed = parseArgs({
          args: ctx.argv,
          options: { ...COMMON_FLAGS, all: { type: 'boolean' as const, default: false } },
          allowPositionals: false,
        });
      } catch (err) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: err instanceof Error ? err.message : String(err),
            exampleCli: 'jinn kill',
            details: { field: 'flags' },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const found = deps.enumerateJinnProcesses();
      const all = Boolean(parsed.values['all']);

      if (found.length > 1 && !all) {
        emitEnvelope(
          {
            code: 'invalid_invocation',
            message: `Found ${found.length} jinn daemon processes; refusing to kill more than one without --all.`,
            hint: 'Re-run with `jinn kill --all` to terminate all of them.',
            exampleCli: 'jinn kill --all',
            details: {
              field: 'all',
              found: found.map((p) => ({ pid: p.pid, command: p.command })),
            },
          },
          { writer: ctx.writer, exit: ctx.exit },
        );
        return;
      }

      const killed: number[] = [];
      const forceKilled: number[] = [];
      for (const proc of found) {
        const result = await terminateOne(proc.pid, deps);
        killed.push(result.pid);
        if (result.forced) forceKilled.push(result.pid);
      }

      const payload: KillResult = {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        found: found.map((p) => ({ pid: p.pid, command: p.command })),
        killed,
        forceKilled,
      };

      emitResult(
        payload,
        (v) => {
          const value = v as KillResult;
          if (value.found.length === 0) return 'No jinn daemon processes found.';
          const forced =
            value.forceKilled.length > 0 ? ` (${value.forceKilled.length} required SIGKILL)` : '';
          return `Terminated ${value.killed.length} jinn daemon process(es): ${value.killed.join(', ')}${forced}.`;
        },
        {
          json: Boolean(parsed.values['json']),
          human: Boolean(parsed.values['human']),
          writer: ctx.writer,
          stdoutIsTty: ctx.stdoutIsTty,
          noColor: Boolean(ctx.env['NO_COLOR']),
        },
      );
    },
  };
}

const command: CommandModule = createKillCommand();
export default command;
```

- [ ] **Step 4: Run and confirm the test file passes**

Run: `cd client && yarn vitest run test/cli/commands/kill.test.ts`
Expected: PASS — all six tests.

- [ ] **Step 5: Register the verb in the CLI dispatcher**

Edit `client/src/cli/index.ts`. Add the import next to `stopCommand`:

```ts
import runCommand from './commands/run.js';
import stopCommand from './commands/stop.js';
import killCommand from './commands/kill.js';
import statusCommand from './commands/status.js';
```

Add it to `COMMANDS`, right after `stopCommand` (keeps the lifecycle-verb grouping intact):

```ts
const COMMANDS: CommandModule[] = [
  versionCommand,
  doctorCommand,
  initCommand,
  quickstartCommand,
  authCommand,
  bootstrapCommand,
  fundRequirementsCommand,
  runCommand,
  stopCommand,
  killCommand,
  statusCommand,
  // ...unchanged remainder...
```

- [ ] **Step 6: Run the full test suite (catches conformance/help-rendering tests that snapshot the command list)**

Run: `cd client && yarn test`
Expected: PASS. If any snapshot test enumerates `CLI_COMMANDS` names or renders top-level `--help`, update its expected fixture to include `kill` in this step — do not skip the failure.

- [ ] **Step 7: Regenerate `SKILL.md`'s CLI table and verify it's the only diff**

Run: `cd client && yarn skill:generate`

Then run: `cd client && yarn skill:check`
Expected: exits 0 (generated output matches committed file after Step 5's registration).

Confirm the diff is confined to the `<!-- skill:cli-table:start -->...<!-- skill:cli-table:end -->` region in `client/skills/jinn-operator/SKILL.md`:

Run: `cd client && git diff skills/jinn-operator/SKILL.md`

- [ ] **Step 8: Update the canonical verb table in `spec/2026-04-14-client-surface.md`**

In `spec/2026-04-14-client-surface.md` §2.1, add a row after `jinn stop`:

```diff
 | `jinn run` | Foreground daemon; exits on SIGINT/SIGTERM | N/A (long-running) |
 | `jinn stop` | Signal a running `jinn run` to shut down | Yes |
+| `jinn kill` | Force-terminate jinn daemon processes found by cmdline enumeration (SIGTERM→10s→SIGKILL); `--all` required for more than one match | Yes |
 | `jinn version` | Client version, protocol phase, deployment digest, token map | Yes |
```

- [ ] **Step 9: Update `client/README.md`'s Lifecycle command table**

In `client/README.md`, add a row after `jinn stop` (around line 266):

```diff
 | `jinn stop` | Signal a running daemon to stop | Yes |
+| `jinn kill` | Force-terminate jinn daemon processes by cmdline enumeration (`--all` for multiple) | Yes |
 | `jinn version` | Version, phase, deployment digest | Yes |
```

- [ ] **Step 10: Typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 11: Commit**

```bash
cd client
git add src/cli/commands/kill.ts test/cli/commands/kill.test.ts src/cli/index.ts skills/jinn-operator/SKILL.md README.md
git -C .. add spec/2026-04-14-client-surface.md
git commit -m "$(cat <<'EOF'
feat(805): add jinn kill [--all] to force-terminate orphaned jinn daemons

New lifecycle verb: enumerates host processes matching the jinn daemon
cmdline pattern, SIGTERMs them, polls up to 10s, then SIGKILLs survivors.
Refuses (exit 11) when more than one match is found unless --all is passed,
to avoid silently killing an unrelated jinn daemon on a shared host. DI
factory (createKillCommand) mirrors doctor.ts so signal-sending and
enumeration are mockable without spawning real processes.

Registered in the CLI dispatcher, documented in spec/2026-04-14-client-
surface.md §2.1 and client/README.md, SKILL.md regenerated via
yarn skill:generate.

Refs: #805
EOF
)"
```

---

### Task 5: Final verification pass

**Files:** none (verification only).

- [ ] **Step 1: Full typecheck**

Run: `cd client && yarn typecheck`
Expected: zero errors.

- [ ] **Step 2: Full test suite**

Run: `cd client && yarn test`
Expected: all suites PASS, including every file touched in Tasks 1–4:
`test/lifecycle/process-discovery.test.ts`, `test/preflight/pidfile-liveness.test.ts`,
`test/main/concurrent-jinn-run-refused.test.ts`, `test/cli/commands/stop.test.ts`,
`test/cli/commands/kill.test.ts`.

- [ ] **Step 3: SKILL.md drift check (CI parity)**

Run: `cd client && yarn skill:check`
Expected: exits 0.

- [ ] **Step 4: Map each acceptance criterion to its closing task**

| # | Issue acceptance criterion | Closed by |
|---|---|---|
| 1 | `jinn run` refuses on alive-but-jinn pid; reclaims on alive-but-not-jinn (recycled) pid | Task 2 |
| 2 | `jinn stop` falls through to cmdline enumeration when the pidfile is stale or missing | Task 3 |
| 3 | `jinn kill [--all]` enumerates and force-terminates jinn processes (SIGTERM→10s→SIGKILL) | Task 4 |

- [ ] **Step 5: Manual smoke check (optional but recommended before opening the PR)**

```bash
cd client
yarn build
node dist/bin/jinn.js kill --help
node dist/bin/jinn.js stop --help
```

Expected: both print the updated help text without error; `jinn kill --help` documents `--all`.

---

## Self-Review Notes (for the plan author, already applied above)

- **Spec coverage:** all three issue items map to Task 2 / Task 3 / Task 4 respectively (table in Task 5, Step 4).
- **Placeholder scan:** no TBD/TODO; every step shows complete code, not "similar to Task N".
- **Type consistency:** `PidfileLivenessDecision`'s `unlink-stale.reason` union, `StopResult.discoveredPids`, `KillDeps`, and `JinnProcess` are defined once (Tasks 1–4) and referenced identically by every later task and test.
- **Blast-radius check already performed during exploration:** `checkPidfileLiveness` / `applyPidfileLivenessGate` are referenced from exactly two test files (`test/preflight/pidfile-liveness.test.ts`, `test/main/concurrent-jinn-run-refused.test.ts`) and one production call site (`client/src/main.ts:2245`); both test files are updated in Task 2, the call site's signature is unchanged so `main.ts` needs no edit.

---

**Intended save path for this plan:** `docs/superpowers/plans/2026-07-14-jinn-lifecycle-orphan-recovery.md`

**Execution options once saved:**
1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution with checkpoints via `superpowers:executing-plans`.

---
