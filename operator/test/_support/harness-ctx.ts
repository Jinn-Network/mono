import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@/types/task.js';
import type { HarnessContext } from '@/harnesses/types.js';
import { TrajectoryCollector } from '@/trajectory/collector.js';

export interface HarnessCtxOpts {
  task: Task;
  taskCid?: string;
  /** mkdtemp prefix; default 'jinn-harness-ctx-'. Ignored when workingDir is provided. */
  prefix?: string;
  /**
   * When true, allocates separate `workingDir` + `implStateDir` subdirs under
   * one temp root. Default false (both point to the same temp dir, matching
   * most legacy `makeCtx` shapes). Ignored when workingDir is provided.
   */
  separateDirs?: boolean;
  /**
   * Explicit working directory. When provided, skips mkdtemp and uses this
   * directory directly (and also uses it as implStateDir unless implStateDir
   * is also provided). Useful for tests that pre-allocate dirs for cleanup.
   */
  workingDir?: string;
  /**
   * Explicit impl-state directory. Only meaningful when workingDir is also
   * provided. Defaults to workingDir when omitted.
   */
  implStateDir?: string;
  msUntilEndTs?: () => number;
  abort?: AbortSignal;
  log?: HarnessContext['log'];
  /**
   * Extra fields attached to the returned context. Some impls read test-only
   * properties via `(ctx as any)._testDeps` — pass them here.
   */
  extra?: Record<string, unknown>;
}

function normaliseTaskForTests(input: Task): Task {
  const legacy = input as Task & {
    type?: 'restoration' | 'evaluation';
    kind?: string;
    spec?: ({ kind?: string } & Record<string, unknown>);
  };
  return {
    ...input,
    solverType: input.solverType ?? legacy.spec?.kind ?? legacy.kind,
    role: input.role ?? legacy.type ?? 'restoration',
  };
}

/**
 * Canonical `HarnessContext` builder for harness-impl tests. Replaces the
 * 6 ad-hoc `makeCtx` helpers across `test/harnesses/impls/`. Each call creates
 * a fresh tempdir (unless workingDir is supplied); tests that need cleanup may
 * track the returned dirs.
 */
export function makeHarnessCtx(opts: HarnessCtxOpts): HarnessContext {
  let workingDir: string;
  let implStateDir: string;
  if (opts.workingDir !== undefined) {
    workingDir = opts.workingDir;
    implStateDir = opts.implStateDir ?? opts.workingDir;
  } else {
    const root = mkdtempSync(join(tmpdir(), opts.prefix ?? 'jinn-harness-ctx-'));
    workingDir = root;
    implStateDir = root;
    if (opts.separateDirs) {
      workingDir = join(root, 'work');
      implStateDir = join(root, 'state');
      mkdirSync(workingDir);
      mkdirSync(implStateDir);
    }
  }
  const taskCid = opts.taskCid ?? '';
  const ctx: HarnessContext = {
    task: normaliseTaskForTests(opts.task),
    workingDir,
    implStateDir,
    log: opts.log ?? (() => {}),
    abort: opts.abort ?? new AbortController().signal,
    msUntilEndTs: opts.msUntilEndTs ?? (() => 0),
    trajectory: new TrajectoryCollector({ taskCid, runId: 'test' }),
  };
  if (opts.taskCid !== undefined) {
    ctx.taskCid = opts.taskCid;
  }
  if (opts.extra) {
    Object.assign(ctx as unknown as Record<string, unknown>, opts.extra);
  }
  return ctx;
}
