/** Git helpers for the pilot orchestrator, factored out so their fail-loud
 *  behaviour is unit-testable with an injected runner (the orchestrator's own
 *  I/O is validated by dry-run + smoke, per the pilot plan). */

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTestPathHunks } from '../harnesses/impls/learner/restoration-patch.js';

export type CmdRunner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** A git base-checkout step (clone/checkout) exited non-zero. The base repo is
 *  unusable, so the INSTANCE is ungradeable — it MUST NOT silently proceed into
 *  an empty repo where both arms score `passed:false` (that mis-attributes an
 *  environment failure to the agent and understates the resolve rate). Caught at
 *  run-pilot's per-instance boundary, which skips the instance and continues. */
export class GitStepError extends Error {
  constructor(
    readonly step: 'clone' | 'checkout',
    readonly exitCode: number,
    readonly detail: string,
  ) {
    super(`git ${step} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`);
    this.name = 'GitStepError';
  }
}

/** Clone `repo` into `baseDir` and check out `baseCommit`, FAIL-LOUD on a
 *  non-zero exit from either step. A 404'd/renamed repo or an unfetchable commit
 *  must throw here rather than leave an empty/wrong checkout that both arms then
 *  "solve" into empty patches. */
export async function prepareBaseCheckout(
  run: CmdRunner,
  repo: string,
  baseCommit: string,
  baseDir: string,
): Promise<void> {
  const clone = await run('git', ['clone', `https://github.com/${repo}.git`, baseDir]);
  if (clone.exitCode !== 0) throw new GitStepError('clone', clone.exitCode, clone.stderr.trim().slice(0, 300));
  let checkout = await run('git', ['checkout', baseCommit], { cwd: baseDir });
  if (checkout.exitCode !== 0) {
    // Upstream history rewrites leave dataset base commits unreachable from
    // any ref — absent from a plain clone ("unable to read tree") yet still
    // served by GitHub to an explicit fetch-by-sha. Fetch, then retry once.
    const fetch = await run('git', ['fetch', 'origin', baseCommit], { cwd: baseDir });
    if (fetch.exitCode === 0) {
      checkout = await run('git', ['checkout', baseCommit], { cwd: baseDir });
    }
    if (checkout.exitCode !== 0) throw new GitStepError('checkout', checkout.exitCode, checkout.stderr.trim().slice(0, 300));
  }
}

/** Recover the working-tree patch, INCLUDING new (untracked) files: `git add -A`
 *  stages everything, then `git diff --cached` emits the full diff. A plain
 *  `git diff` misses untracked files, so a fix that ADDS a file would look like
 *  an empty patch (a spurious not-resolved). */
export async function recoverPatch(run: CmdRunner, cwd: string): Promise<string> {
  await run('git', ['add', '-A'], { cwd });
  const diff = await run('git', ['diff', '--cached'], { cwd });
  return stripTestPathHunks(diff.stdout);
}

/**
 * Create an isolated checkout directory. Durable runs keep live work beneath
 * `<out>/work` so agent path protections see an operator-owned location;
 * legacy runs without `--out` retain the OS-temp fallback.
 */
export async function createPilotWorkDir(outDir: string | undefined, prefix: string): Promise<string> {
  const root = outDir ? join(outDir, 'work') : tmpdir();
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
