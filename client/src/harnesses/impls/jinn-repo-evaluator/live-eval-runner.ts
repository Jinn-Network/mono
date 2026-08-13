/**
 * Repo-native mechanical eval runner for jinn-repo LIVE-ISSUE tasks
 * (issue #1891, spec/2026-07-20-autopilot-marketplace-execution.md
 * §"No new SolverType").
 *
 * A live-issue task snapshots an OPEN GitHub issue — posted before a fix
 * exists, so there is no gold FAIL_TO_PASS test to grade against (contrast
 * `./eval-runner.ts`, which grades merged-pr tasks against the PR's own gold
 * tests). Stage 1's evaluator for this branch is deliberately thin and
 * mechanical: three AND-gated checks, in order:
 *
 *   1. applies    — does the candidate patch apply to a clean base_commit
 *                    checkout? (via `./repro.ts`, same convention as the
 *                    merged-pr path: a patch that does not apply is a graded
 *                    FAIL, not an unscorable infra failure.)
 *   2. typecheck  — does each TOUCHED package's FULL typecheck script pass?
 *                    Always full (never scoped) — typechecking a subset of
 *                    files is not meaningful. For `client`, `yarn typecheck`
 *                    also builds `packages/sdk` (+ plugin/core) as a side
 *                    effect (see `client/package.json`'s `build:sdk` chain),
 *                    which is why this gate MUST run before the tests gate:
 *                    a scoped `vitest run` on a fresh clone would otherwise
 *                    fail to resolve `@jinn-network/sdk` (its `dist/` is
 *                    gitignored and only exists after that build step).
 *   3. tests      — for each touched package: if `scope-tests.ts` mirrors any
 *                    changed file to an test path that actually exists in the
 *                    repro, run those scoped (`vitest run <files>`); if none
 *                    exist, fall back to the package's full test script.
 *                    Multi-package patches AND-gate every touched package —
 *                    each package's scoped-or-fallback tests must pass.
 *
 * Infra failure (clone / install / spawn) is NEVER coerced into a gate
 * result — it is `unscorable`, mirroring `./eval-runner.ts` and the
 * swe-rebench-v2 evaluator's `EvalCouldNotGradeError` convention. The engine
 * records a skip (no verdict) rather than a bogus FAIL.
 *
 * A patch that changes files but touches NO gated package (e.g. only
 * `contracts/`, `docs/`, or root config — anything outside `client/` and
 * `packages/sdk/`) is likewise never coerced into a vacuous PASS: this
 * evaluator has no applicable gate for it, which is a capability limit of the
 * grader, not a verified solution — so it is `unscorable` too (see the
 * `scopes.length === 0` check below). Contrast the true empty-patch case
 * documented on `getChangedFiles`, where the empty changed-file list itself
 * is the (by-design) vacuous case.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRepro, PatchDoesNotApplyError } from './repro.js';
import {
  scopeTestsForChangedFiles,
  KNOWN_LIVE_EVAL_PACKAGES,
  type PackageSpec,
} from './scope-tests.js';
import type { JinnRepoLiveIssueTask } from '@jinn-network/sdk/solvernets/jinn-repo';

const sh = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;
const LOG_LIMIT = 4000;

export interface JinnRepoLiveEvalResult {
  applies: boolean;
  typecheck: boolean;
  tests: boolean;
  /** AND of the three gates above. */
  passed: boolean;
  /**
   * True for grader-infra failure (clone/install/spawn) OR a patch that
   * touches no gated package (no applicable gate exists) — see module doc.
   * Never true alongside `passed: true`.
   */
  unscorable: boolean;
  logExcerpt: string;
}

function unscorable(logExcerpt: string): JinnRepoLiveEvalResult {
  return { applies: false, typecheck: false, tests: false, passed: false, unscorable: true, logExcerpt };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `prepareRepro` applies the candidate patch via `git apply --3way`, which
 * stages cleanly-applied hunks — so a plain (unstaged) `git diff` sees
 * nothing. `git diff --name-only HEAD` (working tree + index vs HEAD) is the
 * form that reliably lists every changed file post-apply; verified against a
 * scratch repo before relying on it here. An empty candidate patch (a valid
 * no-op — `prepareRepro` skips `git apply` entirely for it) yields an empty
 * changed-file list, so every gate below is vacuously satisfied for it — a
 * known, documented limit of a mechanical (non-goal-aware) grader.
 *
 * Distinct from that: a NON-empty changed-file list that maps to zero gated
 * packages (every changed file falls outside `client/` and `packages/sdk/`)
 * must NOT also be vacuously satisfied — the caller checks
 * `scopes.length === 0` against a non-empty `changedFiles` and treats it as
 * `unscorable` (no applicable gate exists for this patch), never `passed`.
 */
async function getChangedFiles(repoDir: string): Promise<string[]> {
  const { stdout } = await sh('git', ['-C', repoDir, 'diff', '--name-only', 'HEAD']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

async function installDeps(pkgDir: string): Promise<void> {
  // corepack is usually already enabled at the user / container level. A
  // failure here (e.g. read-only global shim dir) must NOT block the eval —
  // yarn install is the real gate. Swallow any corepack error (mirrors
  // eval-runner.ts).
  try {
    await sh('corepack', ['enable'], { cwd: pkgDir });
  } catch {
    // non-fatal
  }
  await sh('yarn', ['install', '--immutable'], { cwd: pkgDir, maxBuffer: MAX_BUFFER });
}

/**
 * A *numeric* `code` on a spawn error means the command ran and exited
 * non-zero — a real gate FAIL. A non-numeric `code` (e.g. ENOENT) is a
 * spawn-level infra failure. Mirrors `eval-runner.ts`'s classification.
 */
function isRealFailure(e: unknown): boolean {
  return typeof (e as { code?: unknown } | undefined)?.code === 'number';
}

function logOf(e: unknown): string {
  const out = e as { stdout?: string; stderr?: string } | undefined;
  return `${out?.stdout ?? ''}\n${out?.stderr ?? ''}`.slice(0, LOG_LIMIT);
}

export function liveIssueWorkspaceRepository(spec: JinnRepoLiveIssueTask): string {
  return spec.relay?.workspaceRepository ?? spec.repo;
}

export async function runJinnRepoLiveEval(args: {
  spec: JinnRepoLiveIssueTask;
  patch: string;
  workspaceRepoUrl?: string;
  packages?: readonly PackageSpec[];
}): Promise<JinnRepoLiveEvalResult> {
  let repro;
  try {
    repro = await prepareRepro({
      monoRepoUrl:
        args.workspaceRepoUrl
        ?? `https://github.com/${liveIssueWorkspaceRepository(args.spec)}.git`,
      baseCommit: args.spec.base_commit,
      patch: args.patch,
      goldTestFiles: {}, // no gold for a live-issue task — no-ops in prepareRepro
    });
  } catch (e) {
    if (e instanceof PatchDoesNotApplyError) {
      return {
        applies: false,
        typecheck: false,
        tests: false,
        passed: false,
        unscorable: false,
        logExcerpt: String(e).slice(0, LOG_LIMIT),
      };
    }
    return unscorable(`repro-prep-failed: ${String(e).slice(0, LOG_LIMIT)}`);
  }

  try {
    const changedFiles = await getChangedFiles(repro.dir);
    const scopes = scopeTestsForChangedFiles(changedFiles, args.packages ?? KNOWN_LIVE_EVAL_PACKAGES);

    // A non-empty patch whose changed files all fall outside every gated
    // package (e.g. only `contracts/`, `docs/`, or root config) has no
    // applicable gate here — that is a capability limit of this mechanical
    // grader, not a verified solution. NEVER return a vacuous PASS for it;
    // mirror the infra-failure convention (unscorable, no verdict emitted).
    // Contrast the true empty-patch case (changedFiles.length === 0), which
    // stays vacuously satisfied by design — see getChangedFiles' doc above.
    if (scopes.length === 0 && changedFiles.length > 0) {
      return unscorable(
        `no-gated-package-touched: changed files outside every gated package (${(args.packages ?? KNOWN_LIVE_EVAL_PACKAGES).map((p) => p.root).join(', ')}): ${changedFiles.join(', ')}`.slice(
          0,
          LOG_LIMIT,
        ),
      );
    }

    // ── Gate 2: typecheck — full, per touched package, AND-gated ───────────
    let typecheckFailLog = '';
    for (const scope of scopes) {
      const pkgDir = join(repro.dir, scope.pkg.root);
      try {
        await installDeps(pkgDir);
      } catch (e) {
        return unscorable(`install-failed[${scope.pkg.root}]: ${String(e).slice(0, LOG_LIMIT)}`);
      }
      try {
        await sh('yarn', [scope.pkg.typecheckScript], { cwd: pkgDir, maxBuffer: MAX_BUFFER });
      } catch (e) {
        if (!isRealFailure(e)) {
          return unscorable(`typecheck-spawn-failed[${scope.pkg.root}]: ${String(e).slice(0, LOG_LIMIT)}`);
        }
        typecheckFailLog += `typecheck-failed[${scope.pkg.root}]:\n${logOf(e)}\n`;
      }
    }
    if (typecheckFailLog.length > 0) {
      return {
        applies: true,
        typecheck: false,
        tests: false,
        passed: false,
        unscorable: false,
        logExcerpt: typecheckFailLog.slice(0, LOG_LIMIT),
      };
    }

    // ── Gate 3: tests — scoped-if-any-exist, else full fallback, per
    //    touched package, AND-gated ─────────────────────────────────────
    let testsFailLog = '';
    for (const scope of scopes) {
      const pkgDir = join(repro.dir, scope.pkg.root);
      const existingScoped: string[] = [];
      for (const f of scope.candidateTestFiles) {
        if (await pathExists(join(repro.dir, f))) existingScoped.push(f);
      }
      try {
        if (existingScoped.length > 0) {
          // Candidate paths are repo-root-relative; strip the package prefix
          // so vitest resolves them from cwd=pkgDir.
          const relArgs = existingScoped.map((f) => f.slice(scope.pkg.root.length + 1));
          await sh('yarn', ['vitest', 'run', ...relArgs], { cwd: pkgDir, maxBuffer: MAX_BUFFER });
        } else {
          await sh('yarn', [scope.pkg.testScript], { cwd: pkgDir, maxBuffer: MAX_BUFFER });
        }
      } catch (e) {
        if (!isRealFailure(e)) {
          return unscorable(`test-spawn-failed[${scope.pkg.root}]: ${String(e).slice(0, LOG_LIMIT)}`);
        }
        testsFailLog += `tests-failed[${scope.pkg.root}]:\n${logOf(e)}\n`;
      }
    }

    const testsOk = testsFailLog.length === 0;
    return {
      applies: true,
      typecheck: true,
      tests: testsOk,
      passed: testsOk,
      unscorable: false,
      logExcerpt: testsOk ? '' : testsFailLog.slice(0, LOG_LIMIT),
    };
  } finally {
    await repro.cleanup();
  }
}
