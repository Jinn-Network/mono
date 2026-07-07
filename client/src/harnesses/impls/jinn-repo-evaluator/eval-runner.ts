/**
 * Repo-native eval runner for the jinn-repo SolverType.
 *
 * Grades a candidate patch against a real merged-PR fixture, SWE-bench
 * FAIL_TO_PASS style:
 *   1. prepare a throwaway repro (clone @ base_commit, apply patch, overwrite
 *      gold tests) — see ./repro.ts
 *   2. install deps in the `client/` workspace
 *   3. run the PR's own (gold) test scoped by `task.test_cmd`
 *   4. classify: test passed => PASS, test failed => FAIL, infra failure
 *      (clone / install / spawn) => unscorable
 *
 * Infra failure is NEVER coerced to FAIL: a candidate patch must not be
 * penalised because the grader's environment broke. `unscorable` is the
 * honest signal for "we could not grade this".
 *
 * cwd note: `client/` is a standalone yarn project (no root workspace), so
 * both `yarn install` and the test command run from `<repro>/client`. The
 * task's `test_cmd` / `test_files` paths are repo-root-relative (they start
 * with `client/`); we strip a single leading `client/` from the test-command
 * args so they resolve correctly from inside `client/`.
 */

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRepro, PatchDoesNotApplyError } from './repro.js';
import type { JinnRepoTask } from '../../../solver-types/jinn-repo.js';

const sh = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;
const LOG_LIMIT = 4000;

export interface JinnRepoEvalResult {
  passed: boolean | null; // null only when unscorable
  unscorable: boolean;
  logExcerpt: string;
}

/** Strip a single leading `client/` so a repo-root-relative arg resolves
 *  from inside the `client/` workspace. Non-path args pass through. */
function stripClientPrefix(arg: string): string {
  return arg.startsWith('client/') ? arg.slice('client/'.length) : arg;
}

export async function runJinnRepoEval(args: {
  task: JinnRepoTask;
  patch: string;
  monoRepoUrl: string;
  goldTests: Record<string, string>;
}): Promise<JinnRepoEvalResult> {
  let repro;
  try {
    repro = await prepareRepro({
      monoRepoUrl: args.monoRepoUrl,
      baseCommit: args.task.base_commit,
      patch: args.patch,
      goldTestFiles: args.goldTests,
    });
  } catch (e) {
    // A candidate patch that does not apply is a graded FAIL — the candidate
    // produced a broken/conflicting diff (SWE-bench convention). Only true
    // grader-infra failure (clone / fetch / checkout) is unscorable.
    if (e instanceof PatchDoesNotApplyError) {
      return {
        passed: false,
        unscorable: false,
        logExcerpt: String(e).slice(0, LOG_LIMIT),
      };
    }
    return {
      passed: null,
      unscorable: true,
      logExcerpt: `repro-prep-failed: ${String(e).slice(0, LOG_LIMIT)}`,
    };
  }

  const clientDir = join(repro.dir, 'client');

  try {
    // corepack is usually already enabled at the user / container level.
    // A failure here (e.g. read-only global shim dir) must NOT block the
    // eval — yarn install is the real gate. Swallow any corepack error.
    try {
      await sh('corepack', ['enable'], { cwd: clientDir });
    } catch {
      // non-fatal: proceed to yarn install regardless
    }
    await sh('yarn', ['install', '--immutable'], { cwd: clientDir, maxBuffer: MAX_BUFFER });
  } catch (e) {
    await repro.cleanup();
    return {
      passed: null,
      unscorable: true,
      logExcerpt: `install-failed: ${String(e).slice(0, LOG_LIMIT)}`,
    };
  }

  try {
    const [bin, ...rest] = args.task.test_cmd.split(' ').map(stripClientPrefix);
    if (!bin) {
      await repro.cleanup();
      return { passed: null, unscorable: true, logExcerpt: 'empty-test-cmd' };
    }
    await sh(bin, rest, { cwd: clientDir, maxBuffer: MAX_BUFFER });
    return { passed: true, unscorable: false, logExcerpt: '' };
  } catch (e: any) {
    // A *numeric* exit code means the test command ran and exited non-zero —
    // a real FAIL (the gold test did not pass under this patch). A non-numeric
    // `code` (e.g. ENOENT when the runner binary is missing) is a spawn-level
    // infra failure and must be unscorable, not coerced to FAIL.
    const out = `${e?.stdout ?? ''}\n${e?.stderr ?? ''}`.slice(0, LOG_LIMIT);
    if (typeof e?.code === 'number') {
      return { passed: false, unscorable: false, logExcerpt: out };
    }
    return {
      passed: null,
      unscorable: true,
      logExcerpt: `test-spawn-failed: ${String(e?.code ?? e).slice(0, LOG_LIMIT)}\n${out}`,
    };
  } finally {
    await repro.cleanup();
  }
}
