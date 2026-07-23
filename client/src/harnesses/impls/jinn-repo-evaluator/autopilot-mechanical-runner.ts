import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AutopilotEvaluationContext } from '@jinn-network/sdk/solvernets/jinn-repo';
import type {
  AutopilotMechanicalResult,
  AutopilotMechanicalRunner,
} from './autopilot-semantic.js';
import {
  KNOWN_LIVE_EVAL_PACKAGES,
  scopeTestsForChangedFiles,
  type PackageSpec,
} from './scope-tests.js';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;
const LOG_LIMIT = 4000;
const DEFAULT_MONO_REPO_URL = 'https://github.com/Jinn-Network/mono.git';

export interface RepositoryCommandRunner {
  (
    command: string,
    args: string[],
    options: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }>;
}

async function defaultCommand(
  command: string,
  args: string[],
  options: { cwd?: string },
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(command, args, {
    ...options,
    maxBuffer: MAX_BUFFER,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function defaultPathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function commandErrorDetail(error: unknown): string {
  const value = error as { stdout?: unknown; stderr?: unknown } | undefined;
  const output = `${String(value?.stdout ?? '')}\n${String(value?.stderr ?? '')}`.trim();
  const message = error instanceof Error ? error.message : String(error);
  return `${message}${output ? `\n${output}` : ''}`.slice(0, LOG_LIMIT);
}

function isDeterministicCommandFailure(error: unknown): boolean {
  return typeof (error as { code?: unknown } | undefined)?.code === 'number';
}

function prohibitedPath(path: string): boolean {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.includes('\0')
    || path.split('/').some((segment) => segment === '..' || segment === '.git')
  ) {
    return true;
  }
  return false;
}

export interface ExactHeadMechanicalRunnerOptions {
  monoRepoUrl?: string;
  packages?: readonly PackageSpec[];
  command?: RepositoryCommandRunner;
  makeTempDir?: () => Promise<string>;
  remove?: (path: string) => Promise<void>;
  pathExists?: (path: string) => Promise<boolean>;
}

/**
 * Creates a detached checkout at the adopted resultingHead and runs
 * deterministic gates over the complete baseOid...resultingHead PR diff.
 * The successful checkout stays alive for the semantic runner and is removed
 * through the returned cleanup callback.
 */
export class ExactHeadMechanicalRunner implements AutopilotMechanicalRunner {
  private readonly monoRepoUrl: string;
  private readonly packages: readonly PackageSpec[];
  private readonly command: RepositoryCommandRunner;
  private readonly makeTempDir: () => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;
  private readonly pathExists: (path: string) => Promise<boolean>;

  constructor(options: ExactHeadMechanicalRunnerOptions = {}) {
    this.monoRepoUrl = options.monoRepoUrl ?? DEFAULT_MONO_REPO_URL;
    this.packages = options.packages ?? KNOWN_LIVE_EVAL_PACKAGES;
    this.command = options.command ?? defaultCommand;
    this.makeTempDir = options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-autopilot-evaluator-')));
    this.remove = options.remove
      ?? ((path) => rm(path, { recursive: true, force: true }));
    this.pathExists = options.pathExists ?? defaultPathExists;
  }

  async run(context: AutopilotEvaluationContext): Promise<AutopilotMechanicalResult> {
    const root = await this.makeTempDir();
    const repoDir = join(root, 'repo');
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      await this.remove(root);
    };
    const unscorable = async (detail: string): Promise<AutopilotMechanicalResult> => {
      await cleanup();
      return { kind: 'unscorable', detail: detail.slice(0, LOG_LIMIT) };
    };

    try {
      await this.command('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        this.monoRepoUrl,
        repoDir,
      ], {});
      await this.command('git', [
        '-C',
        repoDir,
        'fetch',
        '--no-tags',
        'origin',
        context.reviewTarget.baseOid,
        context.reviewTarget.resultingHead,
      ], {});
      await this.command('git', [
        '-C',
        repoDir,
        'checkout',
        '--detach',
        context.reviewTarget.resultingHead,
      ], {});

      const exact = await this.command('git', [
        '-C',
        repoDir,
        'rev-parse',
        'HEAD',
      ], {});
      const actualHead = exact.stdout.trim().toLowerCase();
      const expectedHead = context.reviewTarget.resultingHead.toLowerCase();
      if (actualHead !== expectedHead) {
        return await unscorable(
          `exact-head-mismatch: expected ${expectedHead}, got ${actualHead || '<empty>'}`,
        );
      }

      try {
        await this.command('git', [
          '-C',
          repoDir,
          'merge-base',
          '--is-ancestor',
          context.reviewTarget.baseOid,
          context.reviewTarget.resultingHead,
        ], {});
      } catch (error) {
        return await unscorable(
          `base-head-mismatch: ${commandErrorDetail(error)}`,
        );
      }

      const diff = await this.command('git', [
        '-C',
        repoDir,
        'diff',
        '--name-only',
        `${context.reviewTarget.baseOid}...${context.reviewTarget.resultingHead}`,
      ], {});
      const changedFiles = diff.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const badPath = changedFiles.find(prohibitedPath);
      if (badPath) {
        return await unscorable(`prohibited-path in exact PR diff: ${badPath}`);
      }

      const scopes = scopeTestsForChangedFiles(changedFiles, this.packages);
      for (const scope of scopes) {
        const pkgDir = join(repoDir, scope.pkg.root);
        try {
          await this.command('corepack', ['enable'], { cwd: pkgDir });
        } catch {
          // Non-fatal; the pinned `yarn install` command is authoritative.
        }
        try {
          await this.command('yarn', ['install', '--immutable'], { cwd: pkgDir });
        } catch (error) {
          return await unscorable(
            `install-failed[${scope.pkg.root}]: ${commandErrorDetail(error)}`,
          );
        }
        try {
          await this.command('yarn', [scope.pkg.typecheckScript], { cwd: pkgDir });
        } catch (error) {
          if (!isDeterministicCommandFailure(error)) {
            return await unscorable(
              `typecheck-spawn-failed[${scope.pkg.root}]: ${commandErrorDetail(error)}`,
            );
          }
          return {
            kind: 'failed',
            checkoutDir: repoDir,
            changedFiles,
            check: 'typecheck',
            detail: `typecheck-failed[${scope.pkg.root}]: ${commandErrorDetail(error)}`,
            cleanup,
          };
        }
      }

      for (const scope of scopes) {
        const pkgDir = join(repoDir, scope.pkg.root);
        const existingTests: string[] = [];
        for (const candidate of scope.candidateTestFiles) {
          if (await this.pathExists(join(repoDir, candidate))) {
            existingTests.push(candidate);
          }
        }
        const testArgs = existingTests.length > 0
          ? [
              'vitest',
              'run',
              ...existingTests.map((path) => path.slice(scope.pkg.root.length + 1)),
            ]
          : [scope.pkg.testScript];
        try {
          await this.command('yarn', testArgs, { cwd: pkgDir });
        } catch (error) {
          if (!isDeterministicCommandFailure(error)) {
            return await unscorable(
              `test-spawn-failed[${scope.pkg.root}]: ${commandErrorDetail(error)}`,
            );
          }
          return {
            kind: 'failed',
            checkoutDir: repoDir,
            changedFiles,
            check: 'tests',
            detail: `tests-failed[${scope.pkg.root}]: ${commandErrorDetail(error)}`,
            cleanup,
          };
        }
      }

      return {
        kind: 'passed',
        checkoutDir: repoDir,
        changedFiles,
        checks: ['repository', 'exact-head', 'policy', 'typecheck', 'tests'],
        cleanup,
      };
    } catch (error) {
      return await unscorable(`repository-precheck-failed: ${commandErrorDetail(error)}`);
    }
  }
}
