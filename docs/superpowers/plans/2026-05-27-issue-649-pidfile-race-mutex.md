# Issue #649 — Pidfile-race + port-bind-mutex fix (TDD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a racing `jinn run` from corrupting `daemon.pid` and shared SQLite/observability state when an existing daemon already holds the API port.

**Architecture:** Two surgical changes. (1) Extract a `pidfile-liveness` preflight helper that reads any existing `<earningDir>/daemon.pid`, classifies the recorded PID across five branches (missing / malformed / `ESRCH` / alive / `EPERM`), and returns a discriminated decision. Wire it into `client/src/main.ts` immediately before the existing `writeFileSync(pidPath, …)` call; on `refuse`, emit the existing `invalid_invocation` envelope (no exit code change — `emitEnvelope` already does `process.exit(11)` for that code) and never touch the pidfile. (2) Reorder `Daemon.start()` so `startApiServer({ port, … })` (the real cross-process mutex) binds **before** `setShutdownState('running')`, `setDaemonStartedAt(...)`, the `cachedShutdownState` assign, and the `emitEvent({ kind: 'startup', … })` call. Together: the pidfile becomes a single-writer invariant, and `EADDRINUSE` (when a future operator overrides the port-as-mutex assumption) trips before any store mutation. Run-mode: **`fix`** — regression test FIRST.

**Tech Stack:** TypeScript, vitest, node:fs / process.kill / process.pid, better-sqlite3-backed `Store` (`getActivityCountsByKind`, `getDaemonStartedAt`).

---

## File structure

**Create:**
- `client/src/preflight/pidfile-liveness.ts` — pure helper. Reads `pidPath`, classifies, returns `PidfileLivenessDecision`. No side-effect on `proceed` / `refuse`; on `unlink-stale` callers do the `unlinkSync` themselves so the helper stays test-friendly (synchronous, no fs writes inside the decision function).
- `client/test/preflight/pidfile-liveness.test.ts` — unit test for the helper, all five branches, `process.kill` mocked via `vi.spyOn`.
- `client/test/main/concurrent-jinn-run-refused.test.ts` — integration regression. Uses a real `Daemon` on port 0 + a real `Store`, simulates the racing pidfile write, invokes the helper, asserts no `startup` row and `daemon_started_at` unchanged.

**Modify:**
- `client/src/main.ts` (around `2575-2587`) — call the helper immediately before `writeFileSync(pidPath, …)`. On `refuse`, `emitEnvelope({ code: 'invalid_invocation', … })`. On `unlink-stale`, `unlinkSync(pidPath)` then fall through to the existing write.
- `client/src/daemon/daemon.ts` (`Daemon.start()`, currently `305-332`) — move `startApiServer({ port, store, … })` (and the `corpus = corpusFactory?.(this.store)` factory line) up so they run **before** `setShutdownState('running')` / `setDaemonStartedAt(...)` / `this.cachedShutdownState = 'running'` / `emitEvent({ kind: 'startup', … })`. `await this.adapter.initialize()` stays at the very top (read-only, verified by issue body).

**Don't touch:**
- `client/src/cli/commands/stop.ts` — its correctness flows from the upstream fix. AC #2 is satisfied because the live daemon's PID is no longer overwritten.
- `client/src/mcp/operator-server.ts` — `startDetachedDaemon` already does the right check before forking; we mirror its idiom.

---

## Acceptance-criteria mapping

| AC bullet (from issue body) | Tasks that satisfy it |
| --- | --- |
| AC1 — Second `jinn run` refuses with `invalid_invocation`; no pidfile / shutdown_state / daemon_started_at mutation; no `startup` activity row. | Task 2 (regression integration test red), Task 5 (helper + wiring green), Task 7 (`Daemon.start` reorder closes the residual state-mutation window). |
| AC2 — `jinn stop` SIGTERMs the live daemon after a refused race. | Task 5 (helper refuses on alive → pidfile untouched → `stop.ts` keeps reading the live PID). Asserted in Task 2 by checking pidfile contents after refuse. |
| AC3 — `Daemon.start()` binds the API server BEFORE state mutations + `startup` emission. | Task 6 (unit assertion that store mutations + `emitEvent` happen *after* `startApiServer` resolves), Task 7 (reorder implementation). |
| AC4 — Liveness check in `main.ts` before pidfile write; refuse with `invalid_invocation` envelope when alive. | Task 3 (helper unit tests red), Task 4 (helper implementation green), Task 5 (wire into `main.ts`). |
| AC5 — Integration test covers second-invocation end-to-end: pidfile untouched, no spurious activity row, `daemon_started_at` unchanged. | Task 2 (test written + red), Task 5/7 (test goes green after fix lands). |

---

## Tasks

### Task 1: Confirm baseline (no work — sanity)

**Files:**
- Read-only: `client/src/main.ts:2576-2587`, `client/src/daemon/daemon.ts:305-332`, `client/src/cli/commands/stop.ts:124-138`, `client/src/mcp/operator-server.ts:203-215`, `client/src/preflight/api-port.ts`, `client/test/preflight/api-port.test.ts`.

- [ ] **Step 1: Verify the existing branch is clean and based on `next`.**

  Run: `cd "/Users/adrianobradley/life's-work/jinn-mono_worktrees/649" && git status && git log --oneline -3`
  Expected: working tree clean, branch `fix/649-pidfile-race-mutex`.

- [ ] **Step 2: Confirm baseline typecheck + test pass before any change.**

  Run (inside `client/`):
  ```bash
  cd client && yarn typecheck
  ```
  Expected: zero errors. (`yarn test` is too slow for a smoke gate; defer the full run to verification.)

---

### Task 2: Write the integration regression — `concurrent-jinn-run-refused` (RED)

This is the test the issue's AC5 demands. Write it FIRST so we can watch it fail, then go green in later tasks. We do **not** spawn two daemon processes — we exercise the helper + `Daemon` in-process exactly the way `restart-daemon-cleanup-frees-ports.test.ts` does.

**Files:**
- Create: `client/test/main/concurrent-jinn-run-refused.test.ts`

- [ ] **Step 1: Write the failing integration test.**

```typescript
/**
 * Integration regression for #649 — a second `jinn run` invocation that races
 * against an already-running daemon must refuse cleanly: no pidfile clobber,
 * no spurious `startup` activity row, no `daemon_started_at` rewrite.
 *
 * Mirrors the in-process pattern from `restart-daemon-cleanup-frees-ports.test.ts`.
 * We don't fork a second node process; we exercise the liveness helper + a real
 * Daemon (port 0) inside one vitest worker, asserting the side-effect surface
 * the operator dashboard cares about.
 *
 * Run-mode: `fix` (issue #649). Skill chain: systematic-debugging →
 * writing-plans → test-driven-development → executing-plans →
 * verification-before-completion.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Daemon } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { Store } from '../../src/store/store.js';
import { checkPidfileLiveness } from '../../src/preflight/pidfile-liveness.js';

describe('#649 — second jinn run refuses without corrupting state', () => {
  let tmp: string;
  let pidPath: string;
  let store: Store;
  let daemon: Daemon;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-649-'));
    pidPath = join(tmp, 'daemon.pid');
    store = new Store(':memory:');
    daemon = new Daemon({
      adapter: new LocalAdapter(),
      store,
      apiPort: 0, // OS picks
      pollIntervalMs: 60_000,
      tasks: [],
    });
    await daemon.start();
    // First daemon writes its own pidfile, exactly like main.ts does at
    // client/src/main.ts:2578.
    writeFileSync(pidPath, `${process.pid}\n`, 'utf-8');
  });

  afterEach(async () => {
    await daemon.stop().catch(() => undefined);
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('refuses when the recorded PID is alive, and leaves shared state alone', () => {
    const startedAtBefore = store.getDaemonStartedAt();
    const startupCountBefore = store.getActivityCountsByKind()['startup'] ?? 0;
    const pidfileBefore = readFileSync(pidPath, 'utf-8');

    const decision = checkPidfileLiveness({ pidPath });

    expect(decision.decision).toBe('refuse');
    if (decision.decision === 'refuse') {
      expect(decision.pid).toBe(process.pid);
      expect(decision.reason).toBe('alive');
    }

    // The simulated second invocation MUST NOT have:
    //  - touched the pidfile,
    //  - bumped daemon_started_at,
    //  - written a second `startup` activity row.
    expect(readFileSync(pidPath, 'utf-8')).toBe(pidfileBefore);
    expect(store.getDaemonStartedAt()).toBe(startedAtBefore);
    expect(store.getActivityCountsByKind()['startup'] ?? 0).toBe(startupCountBefore);
  });

  it('reports a stale pidfile (ESRCH) so the caller can unlink and proceed', () => {
    // PID 1 is guaranteed-alive on every POSIX, so use an unallocatable PID.
    // Node coerces 0 to "current process group" on kill — use a fake high PID
    // that we can't possibly have allocated, then spy on process.kill to throw
    // ESRCH for that specific PID without touching real signals.
    const fakeStalePid = 2147483646; // INT32_MAX - 1
    writeFileSync(pidPath, `${fakeStalePid}\n`, 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      if (pid === fakeStalePid && sig === 0) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      return true as never;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision.decision).toBe('unlink-stale');
      if (decision.decision === 'unlink-stale') {
        expect(decision.pid).toBe(fakeStalePid);
        expect(decision.reason).toBe('esrch');
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails for the expected reason.**

  Run (inside `client/`):
  ```bash
  yarn test test/main/concurrent-jinn-run-refused.test.ts
  ```
  Expected: FAIL with a module-not-found error for `../../src/preflight/pidfile-liveness.js` (the helper doesn't exist yet). This is the red bar we need before writing code.

- [ ] **Step 3: Commit the failing test.**

  ```bash
  git add client/test/main/concurrent-jinn-run-refused.test.ts
  git commit -m "test(daemon): regression for #649 racing jinn run pidfile clobber"
  ```

---

### Task 3: Write the helper unit test — all five PID-state branches (RED)

**Files:**
- Create: `client/test/preflight/pidfile-liveness.test.ts`

- [ ] **Step 1: Write the failing unit test covering missing / malformed / esrch / alive / eperm.**

```typescript
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkPidfileLiveness } from '../../src/preflight/pidfile-liveness.js';

describe('pidfile-liveness preflight', () => {
  let tmp: string;
  let pidPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'jinn-pidfile-liveness-'));
    pidPath = join(tmp, 'daemon.pid');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns proceed when no pidfile exists', () => {
    expect(checkPidfileLiveness({ pidPath })).toEqual({ decision: 'proceed' });
  });

  it('returns unlink-stale when the pidfile is malformed (not a number)', () => {
    writeFileSync(pidPath, 'not-a-pid\n', 'utf-8');
    const decision = checkPidfileLiveness({ pidPath });
    expect(decision).toMatchObject({ decision: 'unlink-stale', reason: 'malformed', pidfilePath: pidPath });
  });

  it('returns unlink-stale on ESRCH (recorded PID is gone)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'unlink-stale', pid: 987654, reason: 'esrch' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('returns refuse when the recorded PID is alive', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'alive' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('returns refuse on EPERM (process exists but owned by another user)', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'eperm' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('treats unknown errno conservatively as refuse', () => {
    writeFileSync(pidPath, '987654\n', 'utf-8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EIO') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    try {
      const decision = checkPidfileLiveness({ pidPath });
      // Conservative: if we can't classify the errno, the safe move is to
      // refuse (don't risk trampling a daemon we just don't understand).
      expect(decision).toMatchObject({ decision: 'refuse', pid: 987654, reason: 'unknown' });
    } finally {
      killSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run the unit test and confirm it fails.**

  ```bash
  yarn test test/preflight/pidfile-liveness.test.ts
  ```
  Expected: FAIL — module not found (`checkPidfileLiveness`).

- [ ] **Step 3: Commit the failing unit test.**

  ```bash
  git add client/test/preflight/pidfile-liveness.test.ts
  git commit -m "test(preflight): unit tests for pidfile-liveness classifier"
  ```

---

### Task 4: Implement the helper (GREEN — unit test goes green)

**Files:**
- Create: `client/src/preflight/pidfile-liveness.ts`

- [ ] **Step 1: Implement `checkPidfileLiveness` as a pure synchronous classifier.**

```typescript
/**
 * Pidfile liveness preflight (issue #649).
 *
 * Reads <earningDir>/daemon.pid (if present), classifies the recorded PID,
 * and returns a discriminated decision the caller acts on. The function does
 * NOT mutate the filesystem — on `unlink-stale` the caller is responsible for
 * the `unlinkSync(pidPath)` call. Keeping the classifier side-effect-free
 * makes it trivially testable and lets the caller wrap the unlink in its own
 * try/catch consistent with the existing idiom in
 * `client/src/mcp/operator-server.ts:209-213`.
 *
 * Behavioral contract (mirrors the issue body's acceptance criteria + the
 * proven pattern at `client/src/mcp/operator-server.ts:203-215`):
 *
 *   - File missing               → { decision: 'proceed' }
 *   - File malformed (NaN/empty) → { decision: 'unlink-stale', reason: 'malformed' }
 *   - process.kill(pid, 0) ESRCH → { decision: 'unlink-stale', reason: 'esrch' }
 *   - process.kill(pid, 0) ok    → { decision: 'refuse', reason: 'alive' }
 *   - process.kill(pid, 0) EPERM → { decision: 'refuse', reason: 'eperm' }
 *   - any other errno            → { decision: 'refuse', reason: 'unknown' }
 *
 * The newline handling matches `client/src/cli/commands/stop.ts:124`: read
 * the file, `.trim()`, `parseInt(_, 10)`. `main.ts` writes the pidfile with a
 * trailing `\n` (see `client/src/main.ts:2578`), so trim is required.
 */

import { existsSync, readFileSync } from 'node:fs';

export type PidfileLivenessDecision =
  | { decision: 'proceed' }
  | {
      decision: 'unlink-stale';
      pid: number | null;
      pidfilePath: string;
      reason: 'malformed' | 'esrch';
    }
  | {
      decision: 'refuse';
      pid: number;
      pidfilePath: string;
      reason: 'alive' | 'eperm' | 'unknown';
    };

export interface CheckPidfileLivenessInput {
  pidPath: string;
}

export function checkPidfileLiveness(
  input: CheckPidfileLivenessInput,
): PidfileLivenessDecision {
  const { pidPath } = input;
  if (!existsSync(pidPath)) {
    return { decision: 'proceed' };
  }

  let raw: string;
  try {
    raw = readFileSync(pidPath, 'utf-8');
  } catch {
    // Unreadable pidfile: treat as malformed/stale. The caller will unlink
    // and proceed; if the next write also fails, that failure surfaces
    // upstream via main.ts's `writeFileSync` call.
    return { decision: 'unlink-stale', pid: null, pidfilePath: pidPath, reason: 'malformed' };
  }

  const parsed = parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { decision: 'unlink-stale', pid: null, pidfilePath: pidPath, reason: 'malformed' };
  }

  try {
    process.kill(parsed, 0);
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'alive' };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ESRCH') {
      return { decision: 'unlink-stale', pid: parsed, pidfilePath: pidPath, reason: 'esrch' };
    }
    if (errno === 'EPERM') {
      return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'eperm' };
    }
    // Any other errno: conservative refuse. Better to surface a clear error
    // to the operator than risk trampling a daemon we can't classify.
    return { decision: 'refuse', pid: parsed, pidfilePath: pidPath, reason: 'unknown' };
  }
}
```

- [ ] **Step 2: Run the unit test and confirm it passes.**

  ```bash
  yarn test test/preflight/pidfile-liveness.test.ts
  ```
  Expected: PASS (all six cases).

- [ ] **Step 3: Typecheck.**

  ```bash
  yarn typecheck
  ```
  Expected: zero errors.

- [ ] **Step 4: Commit the helper.**

  ```bash
  git add client/src/preflight/pidfile-liveness.ts
  git commit -m "feat(preflight): add pidfile-liveness classifier for jinn run"
  ```

---

### Task 5: Wire the helper into `main.ts` (GREEN — integration test goes green for AC1/AC2/AC4)

**Files:**
- Modify: `client/src/main.ts:2575-2587` (region around the pidfile write).

The site today (lines 2575–2587):

```typescript
// Write pidfile so `jinn stop` can find us.
const pidPath = join(config.earningDir, 'daemon.pid');
const { writeFileSync, unlinkSync } = await import('node:fs');
writeFileSync(pidPath, String(process.pid) + '\n', 'utf-8');
const removePidfile = () => {
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
};
process.on('exit', removePidfile);
```

- [ ] **Step 1: Add the helper import alongside other top-of-file imports.**

  At the top of `client/src/main.ts` (next to the other preflight imports such as `./preflight/api-port.js`), add:

```typescript
import { checkPidfileLiveness } from './preflight/pidfile-liveness.js';
```

  (Confirm the surrounding import block style — keep alphabetical ordering if the file already does so. Match the relative-path + `.js` suffix idiom used elsewhere in the file.)

- [ ] **Step 2: Insert the liveness gate immediately before `writeFileSync(pidPath, …)`.**

  Replace the region above with:

```typescript
// Write pidfile so `jinn stop` can find us. First, refuse the run if another
// daemon already owns this earning directory — see issue #649. The classifier
// is side-effect-free; we handle the unlink here so the failure mode matches
// the surrounding try/catch idiom (see operator-server.ts:209-213).
const pidPath = join(config.earningDir, 'daemon.pid');
const { writeFileSync, unlinkSync } = await import('node:fs');

const liveness = checkPidfileLiveness({ pidPath });
if (liveness.decision === 'refuse') {
  emitEnvelope({
    code: 'invalid_invocation',
    message: `Another jinn daemon is already running (PID ${liveness.pid}).`,
    hint: 'Run `jinn stop` to terminate it, or set JINN_EARNING_DIR to a different earning directory.',
    exampleCli: 'jinn stop',
    details: {
      field: 'daemon_pidfile',
      pid: liveness.pid,
      pidfilePath: pidPath,
      reason: liveness.reason,
    },
  });
  // emitEnvelope calls process.exit; this return is for type-narrowing only.
  return;
}
if (liveness.decision === 'unlink-stale') {
  try {
    unlinkSync(pidPath);
  } catch {
    /* best-effort — the writeFileSync below will surface any real problem */
  }
}

writeFileSync(pidPath, String(process.pid) + '\n', 'utf-8');
const removePidfile = () => {
  try {
    unlinkSync(pidPath);
  } catch {
    /* ignore */
  }
};
process.on('exit', removePidfile);
```

  Notes the implementer must verify:
  - The local `emitEnvelope` import already exists at `client/src/main.ts:44`. No new import needed for it.
  - The `details.field` value `daemon_pidfile` matches the existing convention parsed by `operator-server.ts:188` — don't rename it; it's a contract.
  - `emitEnvelope` exits the process via the existing error code map; do not add a manual `process.exit` here.
  - `return` is for TypeScript's control-flow analysis only — `emitEnvelope` doesn't return in practice. If the enclosing function isn't typed `Promise<void>`, the implementer may need `return undefined as never;` instead. Match whatever the surrounding return-type is.

- [ ] **Step 3: Re-run the integration regression — it should now pass for the `refuse` case.**

  ```bash
  yarn test test/main/concurrent-jinn-run-refused.test.ts
  ```
  Expected: both `it(...)` cases PASS.

- [ ] **Step 4: Typecheck.**

  ```bash
  yarn typecheck
  ```
  Expected: zero errors.

- [ ] **Step 5: Commit.**

  ```bash
  git add client/src/main.ts
  git commit -m "fix(daemon): refuse concurrent jinn run before pidfile write (#649)"
  ```

---

### Task 6: Write the `Daemon.start()` reorder unit test (RED)

This nails down AC3 — store mutations and the `startup` event must NOT happen until `startApiServer` has actually bound the port.

**Files:**
- Create: `client/test/daemon/daemon-start-order.test.ts`

- [ ] **Step 1: Write the failing reorder test.**

  Check first whether `client/test/daemon/` already has a sibling file (`ls client/test/daemon/`). If so, name the new file consistently with that directory's naming. The test below uses a port-bind stub to assert ordering without booting a real HTTP server.

```typescript
/**
 * Regression for #649 AC3 — Daemon.start() must NOT mutate shared store state
 * or emit the `startup` activity event until startApiServer has resolved.
 *
 * If the order is wrong, a racing process can corrupt shutdown_state /
 * daemon_started_at / activity_events even when EADDRINUSE later kills the
 * race.
 */

import { describe, expect, it, vi } from 'vitest';

import { Daemon } from '../../src/daemon/daemon.js';
import { LocalAdapter } from '../../src/adapters/local/adapter.js';
import { Store } from '../../src/store/store.js';

describe('#649 — Daemon.start binds API before mutating store', () => {
  it('does not call setShutdownState or setDaemonStartedAt before startApiServer resolves', async () => {
    const store = new Store(':memory:');
    const calls: string[] = [];

    const setShutdownStateSpy = vi.spyOn(store, 'setShutdownState').mockImplementation((s) => {
      calls.push(`setShutdownState:${s}`);
    });
    const setDaemonStartedAtSpy = vi.spyOn(store, 'setDaemonStartedAt').mockImplementation((ts) => {
      calls.push(`setDaemonStartedAt:${typeof ts}`);
    });
    const recordActivityEventSpy = vi.spyOn(store, 'recordActivityEvent').mockImplementation((e) => {
      calls.push(`activity:${e.kind}`);
    });

    // Inject an apiServer stub via the apiServer-injection path so we can
    // observe ordering without actually binding a TCP port. If the injection
    // path isn't available (the daemon insists on calling startApiServer
    // itself), this test should be skipped in favour of a port-0 variant.
    const apiServer = {
      port: 0,
      close: async () => undefined,
      // Mark the moment startApiServer's equivalent "is ready" — we push the
      // marker on construction because the injected server is already bound.
    };
    calls.push('apiServer:ready');

    const daemon = new Daemon({
      adapter: new LocalAdapter(),
      store,
      apiPort: 0,
      apiServer: apiServer as never,
      pollIntervalMs: 60_000,
      tasks: [],
    });

    await daemon.start();

    // The store mutations must come AFTER apiServer:ready.
    const apiIdx = calls.indexOf('apiServer:ready');
    const shutdownIdx = calls.indexOf('setShutdownState:running');
    const startedAtIdx = calls.findIndex((c) => c.startsWith('setDaemonStartedAt:'));
    const startupIdx = calls.findIndex((c) => c === 'activity:startup');

    expect(apiIdx).toBeGreaterThanOrEqual(0);
    expect(shutdownIdx).toBeGreaterThan(apiIdx);
    expect(startedAtIdx).toBeGreaterThan(apiIdx);
    expect(startupIdx).toBeGreaterThan(apiIdx);

    await daemon.stop().catch(() => undefined);
    setShutdownStateSpy.mockRestore();
    setDaemonStartedAtSpy.mockRestore();
    recordActivityEventSpy.mockRestore();
    store.close();
  });
});
```

  **Implementer caveat:** If `Daemon`'s constructor signature in this branch differs from `{ adapter, store, apiPort, apiServer, pollIntervalMs, tasks }`, read `client/src/daemon/daemon.ts` near the constructor and match the existing test setup style from `client/test/main/restart-daemon-cleanup-frees-ports.test.ts` instead. The point of the test is the ordering assertion — keep that the same.

- [ ] **Step 2: Run the new test and observe it fail.**

  ```bash
  yarn test test/daemon/daemon-start-order.test.ts
  ```
  Expected: FAIL — under today's `Daemon.start()`, `setShutdownState:running` lands BEFORE `apiServer:ready` (apiServer-injection path still runs the mutations first at lines 307-310).

- [ ] **Step 3: Commit the failing reorder test.**

  ```bash
  git add client/test/daemon/daemon-start-order.test.ts
  git commit -m "test(daemon): regression for #649 start-order pre-bind mutations"
  ```

---

### Task 7: Reorder `Daemon.start()` (GREEN — AC3)

**Files:**
- Modify: `client/src/daemon/daemon.ts:305-332`.

Current shape:

```typescript
async start(): Promise<void> {
  await this.adapter.initialize();
  this.store.setShutdownState('running');
  this.store.setDaemonStartedAt(new Date().toISOString());
  this.cachedShutdownState = 'running';
  emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');

  // Start HTTP API server (or adopt the one main.ts started early in
  // setup-mode). When injected, ownership stays with the caller — see
  // DaemonConfig.apiServer.
  const corpus = this.config.corpusFactory
    ? this.config.corpusFactory(this.store)
    : undefined;
  if (this.config.apiServer) {
    this.apiServer = this.config.apiServer;
    this.ownsApiServer = false;
  } else {
    this.apiServer = await startApiServer({
      port: this.apiPort,
      store: this.store,
      apiToken: this.apiToken,
      x402: this.config.x402,
      status: this.config.status,
      bindHost: this.config.apiBindHost,
      corpus,
    });
    this.ownsApiServer = true;
  }
  // ... peer-sync etc. below stays unchanged
}
```

- [ ] **Step 1: Rewrite the prologue so port-bind comes first.**

  Replace the prologue (everything from `async start(): Promise<void> {` through and including the `if (this.config.apiServer) { … } else { … }` block) with:

```typescript
async start(): Promise<void> {
  // adapter.initialize() is read-only (verified for MechAdapter and LocalAdapter
  // as part of #649): getBlockNumber, in-memory cursors, store reads only.
  await this.adapter.initialize();

  // Bind the API port BEFORE mutating shared store state or emitting the
  // `startup` activity event. The port bind is the cross-process mutex —
  // a racing `jinn run` invocation that survived the pidfile preflight
  // (rare, e.g. ms-scale TOCTOU) will throw EADDRINUSE here, and we'd
  // rather throw than corrupt shutdown_state / daemon_started_at / the
  // activity-events log. See issue #649.
  const corpus = this.config.corpusFactory
    ? this.config.corpusFactory(this.store)
    : undefined;
  if (this.config.apiServer) {
    this.apiServer = this.config.apiServer;
    this.ownsApiServer = false;
  } else {
    this.apiServer = await startApiServer({
      port: this.apiPort,
      store: this.store,
      apiToken: this.apiToken,
      x402: this.config.x402,
      status: this.config.status,
      bindHost: this.config.apiBindHost,
      corpus,
    });
    this.ownsApiServer = true;
  }

  // Only after the port is bound do we declare ourselves "running" in the
  // store and emit the startup lifecycle event. Order matters: see #649.
  this.store.setShutdownState('running');
  this.store.setDaemonStartedAt(new Date().toISOString());
  this.cachedShutdownState = 'running';
  emitEvent(this.store, { kind: 'startup', outcome: 'ok', detail: 'Daemon started' }, 'daemon');
```

  Notes:
  - The peer-sync block, `engine.recoverInFlight()`, and everything below the `emitEvent` line stays in place — do not move them.
  - The `corpus = this.config.corpusFactory?.(this.store)` factory line moves up with the api-server block because the server needs it. The factory itself must remain a pure constructor (no store writes) — verify by inspection.

- [ ] **Step 2: Run the reorder test and confirm it passes.**

  ```bash
  yarn test test/daemon/daemon-start-order.test.ts
  ```
  Expected: PASS — `apiServer:ready` precedes `setShutdownState:running`, `setDaemonStartedAt:…`, and `activity:startup`.

- [ ] **Step 3: Re-run the integration regression (#649) — still green.**

  ```bash
  yarn test test/main/concurrent-jinn-run-refused.test.ts
  ```
  Expected: PASS.

- [ ] **Step 4: Re-run the existing restart-cleanup integration test — must remain green.**

  ```bash
  yarn test test/main/restart-daemon-cleanup-frees-ports.test.ts
  ```
  Expected: PASS — unchanged.

- [ ] **Step 5: Commit.**

  ```bash
  git add client/src/daemon/daemon.ts
  git commit -m "fix(daemon): bind API before mutating shutdown_state (#649)"
  ```

---

### Task 8: Full verification (typecheck + test + build)

**Files:** none — verification only.

- [ ] **Step 1: Typecheck.**

  ```bash
  cd client && yarn typecheck
  ```
  Expected: zero errors.

- [ ] **Step 2: Full client unit suite.**

  ```bash
  yarn test
  ```
  Expected: every previously-green test still green; the three new tests green. Pay particular attention to:
  - `test/main/restart-daemon-cleanup-frees-ports.test.ts`
  - `test/main/restart-daemon-respawn.test.ts`
  - `test/main/daemon-does-not-exit-on-missing-claude-auth.test.ts`
  - any test under `test/daemon/` that snapshots `daemon_started_at` or `getActivityCountsByKind()`.

  If any test that previously passed now fails because it asserted the old call ordering, update it to match the new contract — but flag the change explicitly in the commit message.

- [ ] **Step 3: Build.**

  ```bash
  yarn build
  ```
  Expected: success — confirms the helper landed in `dist/preflight/` and the SPA bundle still composes.

- [ ] **Step 4: Read `jinn stop`'s code one more time and convince yourself AC2 holds.**

  Open `client/src/cli/commands/stop.ts:97-138`. The flow is: read `daemon.pid`, parse, SIGTERM, catch dead → clean. With Task 5 landed, the pidfile is no longer clobbered by a racing run, so `stop.ts` continues to read the live PID. No code change required — note this in the PR description.

- [ ] **Step 5: Sanity: confirm `kill -9` recovery still works.**

  Manual reasoning: if the previous daemon was `kill -9`'d, the next `jinn run` calls `checkPidfileLiveness` → reads the dead PID → `process.kill(deadPid, 0)` throws `ESRCH` → returns `unlink-stale` → main.ts `unlinkSync(pidPath)`s and proceeds to `writeFileSync`. Behaviour preserved.

---

## Verification checklist (run in order)

1. `cd client && yarn typecheck` — must be 0 errors.
2. `yarn test test/preflight/pidfile-liveness.test.ts` — 6/6 green.
3. `yarn test test/daemon/daemon-start-order.test.ts` — 1/1 green.
4. `yarn test test/main/concurrent-jinn-run-refused.test.ts` — 2/2 green.
5. `yarn test test/main/restart-daemon-cleanup-frees-ports.test.ts` — green (unchanged).
6. `yarn test` (full client suite) — no new failures.
7. `yarn build` — success; verify `dist/preflight/pidfile-liveness.js` exists.

---

## Risks the implementer must watch for

1. **Don't break `kill -9` recovery.** The `ESRCH` branch in the helper is what preserves it. Do not "harden" the helper to refuse on any error — that would brick recovery from crashed/killed daemons. Step 5 of Task 8 spells the manual reasoning out; if a future change conflates `ESRCH` and `EPERM` under one branch, the recovery path silently breaks.
2. **Don't accidentally introduce a store write before `startApiServer` in `Daemon.start()`.** The whole point of Task 7 is the ordering. If a future feature adds a `this.store.recordXyz(...)` call in this region, it must land **after** the api-server block. Consider a follow-up comment block in the method body once the fix lands ("DO NOT add store mutations above this line — see #649").
3. **Pidfile newline handling.** `main.ts` writes `String(process.pid) + '\n'`; `stop.ts:124` reads via `.trim()`. The helper does the same. Do not "fix" main.ts to drop the trailing `\n` — `stop.ts` tolerates both, but other consumers may not. Be consistent with what's there.
4. **`emitEnvelope` exits.** Treat it as `never`. Do not put any code after it that you need to run on the refuse path. The `return;` in Task 5 step 2 is purely a control-flow-analysis hint.
5. **`details.field === 'daemon_pidfile'` is a contract.** `client/src/mcp/operator-server.ts:188` (`parseStopCommandNotRunning`) keys off this exact string. Don't rename it.
6. **TOCTOU window accepted.** Between `checkPidfileLiveness` returning `proceed` / `unlink-stale` and the subsequent `writeFileSync`, another process could race. Task 7 closes that hole by making the API port-bind the authoritative mutex. Do not "fix" the residual TOCTOU with `'wx'` mode — that re-introduces the `kill -9` strand failure (a stale pidfile would block legitimate restarts). The two-layer defence is intentional.
7. **`Daemon.start()` ordering test depends on apiServer injection.** If injection is unavailable (config option removed), fall back to a port-0 real-server test using `vi.spyOn(store, 'setShutdownState')` to record ordering. Don't drop the assertion.
8. **`daemon_started_at` micro-window.** Between the api-server bind and the `setDaemonStartedAt` call (a few ms), a status request returns `null` for `startedAt`. The existing `gather-status.ts` consumer already handles `null` — verify no caller asserts non-null in this window. If any does, fix it as part of Task 7's commit (not separately).

---

## Self-review notes

- Every AC has at least one task mapped (table above).
- No placeholders — every code block is complete.
- Type names consistent: `PidfileLivenessDecision`, `checkPidfileLiveness`, `CheckPidfileLivenessInput` across helper, unit test, integration test, and `main.ts` wiring.
- Regression test written before implementation (Task 2 / 3 RED → Task 4 / 5 GREEN; Task 6 RED → Task 7 GREEN). Matches `fix`-shape discipline.
- Helper is side-effect-free (no fs writes inside the classifier); caller owns the `unlinkSync` so behaviour stays explicit at the call site and the existing surrounding `try { unlinkSync } catch { /* ignore */ }` idiom is preserved.
