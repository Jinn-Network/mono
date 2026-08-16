/**
 * Regression test for issue #778 — the Hermes/learner harness was calling
 * `git diff --binary` via `execFileSync` from inside `harvestOutput`. When the
 * spawnSync call hung (pathological diff, repo lock contention, etc.) the entire
 * Node.js main event loop blocked: no other daemon loops ticked, no claims, no
 * deliveries, no jinn-claim emissions. macOS `sample` of a wedged daemon showed
 * 2086/2086 main-thread samples in `node::SyncProcessRunner::Spawn → uv_run →
 * kevent`.
 *
 * Acceptance check: while `harvestOutput`'s underlying `git diff` is in flight
 * (here mocked to never resolve), a concurrent `setTimeout` callback MUST still
 * fire. The sync version of the code would starve the timer; the async version
 * leaves the event loop free.
 *
 * Companion regression: the matching `git apply --numstat` call in
 * `restoration-patch.ts` (`gitApplyParseCheck`) was the second wedge site and
 * is exercised in the same shape below.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// MOCK_JUSTIFICATION: child_process is a leaf syscall; we cannot DI it
// without owning a shim. We need to inject a never-resolving git diff to
// reproduce the wedge condition deterministically. Per #778 the production
// code now goes through promisify(execFile), so we mock the async execFile.
const slowExecFileCalls: { command: string; args: readonly string[] }[] = [];
let pendingResolvers: Array<() => void> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (
      command: string,
      args: readonly string[],
      ..._rest: unknown[]
    ) => {
      // Only intercept the harvest/restoration-patch git invocations. Anything
      // else (e.g. repo setup) passes through to the real execFile.
      const isHarvestDiff =
        command === 'git' && args.includes('diff') && args.includes('--binary');
      const isApplyNumstat =
        command === 'git' && args.includes('apply') && args.includes('--numstat');
      if (!isHarvestDiff && !isApplyNumstat) {
        return (actual.execFile as unknown as (
          ...a: unknown[]
        ) => unknown)(command, args, ..._rest);
      }
      slowExecFileCalls.push({ command, args });
      // Capture the callback so the test can drain it on teardown — the
      // production code passes the callback via `execFile(..., callback)`
      // (restoration-patch) OR via `promisify(execFile)` (harvest). Find it
      // among the trailing args.
      const callback = _rest.find((arg) => typeof arg === 'function') as
        | ((err: Error | null, stdout: string, stderr: string) => void)
        | undefined;
      if (callback) {
        // Resolve with a benign stdout so the production code treats the
        // teardown "completion" as success rather than a parse failure.
        pendingResolvers.push(() => callback(null, '', ''));
      }
      // Return a stub ChildProcess-shaped object exposing `stdin` so the
      // restoration-patch caller (which writes the patch to stdin) does not
      // throw when poking the handle.
      const fakeStdin = {
        write: () => true,
        end: () => undefined,
      };
      return { stdin: fakeStdin, kill: () => {} } as never;
    },
  };
});

// Import AFTER mock is registered so the production code picks up the mocked
// execFile.
import { harvestOutput } from '../../../../src/harnesses/impls/learner/harvest.js';
import { gitApplyParseCheck } from '../../../../src/harnesses/impls/learner/restoration-patch.js';

function makeSweRebenchWorkingDir(): string {
  const workingDir = mkdtempSync(join(tmpdir(), 'jinn-778-harvest-'));
  // Create a minimal `repo/.git` dir to trip the swe-rebench branch in
  // maybeMaterializeSweRebenchPatchPayload — it only checks for the .git
  // directory's existence, not its contents (our mocked execFile takes over
  // before any real git commands run).
  const repoGitDir = join(workingDir, 'repo', '.git');
  mkdirSync(repoGitDir, { recursive: true });
  return workingDir;
}

describe('harvestOutput — async wedge regression (#778)', () => {
  let workingDir: string;

  beforeEach(() => {
    slowExecFileCalls.length = 0;
    pendingResolvers = [];
    workingDir = makeSweRebenchWorkingDir();
  });

  afterEach(() => {
    // Drain any captured callbacks so the test process can exit cleanly.
    for (const resolve of pendingResolvers.splice(0)) resolve();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('does not block the event loop while git diff is in flight', async () => {
    const swePayloadPath = join(workingDir, '.execute', 'solution-payload.json');
    mkdirSync(join(workingDir, '.execute'), { recursive: true });
    // Pre-write a stub typed payload so that *if* the git-diff materialiser is
    // skipped (e.g. by the implementation deciding the repo is in a weird
    // state) the harvest still has a fallback path. The wedge under test is
    // specifically the git-diff call path though, which is gated only by the
    // existence of `repo/.git` — so the materializer WILL be entered.
    writeFileSync(
      swePayloadPath,
      JSON.stringify({
        schemaVersion: 'swe-rebench-v2-solution.v1',
        patch: 'diff --git a/foo b/foo\n@@ -1 +1 @@\n-x\n+y\n',
      }),
    );

    const harvestPromise = harvestOutput(workingDir, undefined, {
      id: 'task-1',
      description: 'd',
      solverType: 'swe-rebench-v2.v1',
      role: 'restoration',
    } as never);

    // Race the harvest against a 100ms tick. With the OLD sync code the entire
    // main thread is blocked in `spawnSync` until `git diff` returns; the
    // setTimeout cannot fire. With the async fix the timer drains while git is
    // still in flight, so this Promise resolves first.
    const eventLoopTicked = await Promise.race([
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 100)),
      harvestPromise.then(() => 'harvest-done' as const).catch(() => 'harvest-done' as const),
    ]);

    expect(eventLoopTicked).toBe('tick');
    expect(slowExecFileCalls.length).toBeGreaterThan(0);
    expect(slowExecFileCalls[0]?.args).toEqual(
      expect.arrayContaining(['diff', '--binary']),
    );

    // Drain the harvest before the test finishes so vitest doesn't see a
    // dangling Promise.
    for (const resolve of pendingResolvers.splice(0)) resolve();
    await harvestPromise.catch(() => undefined);
  });
});

describe('gitApplyParseCheck — async wedge regression (#778)', () => {
  let repoDir: string;

  beforeEach(() => {
    slowExecFileCalls.length = 0;
    pendingResolvers = [];
    repoDir = mkdtempSync(join(tmpdir(), 'jinn-778-apply-'));
  });

  afterEach(() => {
    for (const resolve of pendingResolvers.splice(0)) resolve();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('does not block the event loop while git apply --numstat is in flight', async () => {
    const patch =
      'diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-old\n+new\n';

    const checkPromise = gitApplyParseCheck(repoDir, patch);

    const eventLoopTicked = await Promise.race([
      new Promise<'tick'>((resolve) => setTimeout(() => resolve('tick'), 100)),
      Promise.resolve(checkPromise).then(() => 'check-done' as const).catch(() => 'check-done' as const),
    ]);

    expect(eventLoopTicked).toBe('tick');
    expect(slowExecFileCalls.length).toBeGreaterThan(0);
    expect(slowExecFileCalls[0]?.args).toEqual(
      expect.arrayContaining(['apply', '--numstat']),
    );

    for (const resolve of pendingResolvers.splice(0)) resolve();
    await Promise.resolve(checkPromise).catch(() => undefined);
  });
});
