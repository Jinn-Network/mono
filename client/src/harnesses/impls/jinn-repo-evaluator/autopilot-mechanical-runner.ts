import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AutopilotEvaluationContext } from '@jinn-network/sdk/solvernets/jinn-repo';
import type {
  AutopilotMechanicalResult,
  AutopilotMechanicalRunner,
} from './autopilot-semantic.js';
import {
  KNOWN_LIVE_EVAL_PACKAGES,
  type PackageSpec,
} from './scope-tests.js';
import {
  runSupervisedProcess,
  SupervisedProcessUnreapedError,
} from './supervised-process.js';

const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_REVIEW_DIFF_BYTES = 8 * 1024 * 1024;
const LOG_LIMIT = 4000;
const DEFAULT_MONO_REPO_URL = 'https://github.com/Jinn-Network/mono.git';

export interface RepositoryCommandRunner {
  (
    command: string,
    args: string[],
    options: {
      cwd?: string;
      signal?: AbortSignal;
      env: NodeJS.ProcessEnv;
    },
  ): Promise<{ stdout: string; stderr: string }>;
}

async function defaultCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    env: NodeJS.ProcessEnv;
  },
): Promise<{ stdout: string; stderr: string }> {
  return await runSupervisedProcess(command, args, {
    ...options,
    maxOutputBytes: MAX_BUFFER,
  });
}

function commandErrorDetail(error: unknown): string {
  const value = error as { stdout?: unknown; stderr?: unknown } | undefined;
  const output = `${String(value?.stdout ?? '')}\n${String(value?.stderr ?? '')}`.trim();
  const message = error instanceof Error ? error.message : String(error);
  return `${message}${output ? `\n${output}` : ''}`.slice(0, LOG_LIMIT);
}

function prohibitedPath(path: string): boolean {
  if (
    path.length === 0
    || path.startsWith('/')
    || path.trim() !== path
    || path.includes('\0')
    || path.includes('\ufffd')
    || /[\x00-\x1f\x7f]/u.test(path)
    || path.split('/').some((segment) => segment === '..' || segment === '.git')
  ) {
    return true;
  }
  const components = path.split('/');
  const basename = components.at(-1)!.toLowerCase();
  if (
    [
      'package.json',
      'yarn.lock',
      'package-lock.json',
      'pnpm-lock.yaml',
      '.yarnrc.yml',
      '.pnp.cjs',
      '.pnp.loader.mjs',
    ].includes(basename)
    || components.some((component) =>
      ['.yarn', 'node_modules', 'test', 'tests', '__tests__', '__snapshots__']
        .includes(component.toLowerCase()))
    || /^tsconfig(?:\.[a-z0-9_-]+)*\.json$/u.test(basename)
    || /^(?:vitest|vite|jest|hardhat|playwright|eslint|babel|rollup|webpack)(?:\.[a-z0-9_-]+)*\.config\.[a-z0-9]+$/u
      .test(basename)
    || /^\.eslintrc(?:\.[a-z0-9]+)?$/u.test(basename)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(basename)
    || basename.endsWith('.snap')
  ) {
    return true;
  }
  return false;
}

function repositoryCommandEnv(isolatedHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: isolatedHome,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] as const) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function supportedPackageFor(
  path: string,
  packages: readonly PackageSpec[],
): boolean {
  return packages.some((pkg) =>
    path === pkg.root || path.startsWith(`${pkg.root}/`)
  );
}

export type ImmutableMechanicalVerification =
  | { kind: 'passed'; checks: string[] }
  | { kind: 'failed'; check: string; detail: string }
  | { kind: 'unscorable'; detail: string };

export interface ImmutableMechanicalVerifier {
  isReady?(): Promise<{ ready: boolean; reason?: string }>;
  verify(input: {
    context: AutopilotEvaluationContext;
    checkoutDir: string;
    changedFiles: string[];
    abort?: AbortSignal;
  }): Promise<ImmutableMechanicalVerification>;
}

export interface ExactHeadMechanicalRunnerOptions {
  monoRepoUrl?: string;
  packages?: readonly PackageSpec[];
  command?: RepositoryCommandRunner;
  immutableVerifier?: ImmutableMechanicalVerifier;
  makeTempDir?: () => Promise<string>;
  remove?: (path: string) => Promise<void>;
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
  private readonly immutableVerifier: ImmutableMechanicalVerifier | undefined;
  private readonly makeTempDir: () => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;

  constructor(options: ExactHeadMechanicalRunnerOptions = {}) {
    this.monoRepoUrl = options.monoRepoUrl ?? DEFAULT_MONO_REPO_URL;
    this.packages = options.packages ?? KNOWN_LIVE_EVAL_PACKAGES;
    this.command = options.command ?? defaultCommand;
    this.immutableVerifier = options.immutableVerifier;
    this.makeTempDir = options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-autopilot-evaluator-')));
    this.remove = options.remove
      ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async run(
    context: AutopilotEvaluationContext,
    abort?: AbortSignal,
  ): Promise<AutopilotMechanicalResult> {
    if (abort?.aborted) {
      return { kind: 'unscorable', detail: 'evaluation-cancelled' };
    }
    const root = await this.makeTempDir();
    const repoDir = join(root, 'repo');
    let cleaned = false;
    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      await this.remove(root);
      cleaned = true;
    };
    const unscorable = async (
      detail: string,
      cleanupSafe = true,
    ): Promise<AutopilotMechanicalResult> => {
      if (cleanupSafe) await cleanup();
      return { kind: 'unscorable', detail: detail.slice(0, LOG_LIMIT) };
    };
    const cancelled = (error?: unknown): boolean => (
      abort?.aborted === true
      || (error as { name?: unknown } | undefined)?.name === 'AbortError'
    );
    const env = repositoryCommandEnv(root);
    const runCommand = (
      command: string,
      args: string[],
      cwd?: string,
    ): Promise<{ stdout: string; stderr: string }> => this.command(
      command,
      args,
      {
        ...(cwd ? { cwd } : {}),
        ...(abort ? { signal: abort } : {}),
        env,
      },
    );

    try {
      await runCommand('git', [
        'clone',
        '--filter=blob:none',
        '--no-checkout',
        this.monoRepoUrl,
        repoDir,
      ]);
      await runCommand('git', [
        '-C',
        repoDir,
        'fetch',
        '--no-tags',
        'origin',
        context.reviewTarget.baseOid,
        context.reviewTarget.resultingHead,
      ]);
      await runCommand('git', [
        '-C',
        repoDir,
        'checkout',
        '--detach',
        context.reviewTarget.resultingHead,
      ]);

      const exact = await runCommand('git', [
        '-C',
        repoDir,
        'rev-parse',
        'HEAD',
      ]);
      const actualHead = exact.stdout.trim().toLowerCase();
      const expectedHead = context.reviewTarget.resultingHead.toLowerCase();
      if (actualHead !== expectedHead) {
        return await unscorable(
          `exact-head-mismatch: expected ${expectedHead}, got ${actualHead || '<empty>'}`,
        );
      }

      try {
        const mergeBase = await runCommand('git', [
          '-C',
          repoDir,
          'merge-base',
          context.reviewTarget.baseOid,
          context.reviewTarget.resultingHead,
        ]);
        if (!/^[0-9a-f]{40,64}$/i.test(mergeBase.stdout.trim())) {
          return await unscorable(
            'base-head-mismatch: Git returned no valid common ancestor',
          );
        }
      } catch (error) {
        if (cancelled(error)) return await unscorable('evaluation-cancelled');
        return await unscorable(
          `base-head-mismatch: ${commandErrorDetail(error)}`,
        );
      }

      const diff = await runCommand('git', [
        '-C',
        repoDir,
        'diff',
        '--name-only',
        '-z',
        '--no-renames',
        `${context.reviewTarget.baseOid}...${context.reviewTarget.resultingHead}`,
      ]);
      if (diff.stdout.length > 0 && !diff.stdout.endsWith('\0')) {
        return await unscorable('malformed-path-list: expected NUL-delimited Git output');
      }
      const changedFiles = diff.stdout.length === 0
        ? []
        : diff.stdout.slice(0, -1).split('\0');
      const badPath = changedFiles.find(prohibitedPath);
      if (badPath) {
        return await unscorable(`prohibited-path in exact PR diff: ${badPath}`);
      }

      const unsupported = changedFiles.filter(
        (path) => !supportedPackageFor(path, this.packages),
      );
      if (unsupported.length > 0) {
        return await unscorable(
          `unsupported-diff-scope: no deterministic checks cover ${unsupported.join(', ')}`,
        );
      }

      const immutableVerifier = this.immutableVerifier;
      if (!immutableVerifier) {
        return await unscorable('immutable-verifier-unavailable');
      }

      let verification: ImmutableMechanicalVerification;
      try {
        verification = await immutableVerifier.verify({
          context,
          checkoutDir: repoDir,
          changedFiles,
          ...(abort ? { abort } : {}),
        });
      } catch (error) {
        if (cancelled(error)) return await unscorable('evaluation-cancelled');
        if (error instanceof SupervisedProcessUnreapedError) {
          return await unscorable(error.message, false);
        }
        return await unscorable(
          `immutable-verifier-failed: ${commandErrorDetail(error)}`,
        );
      }
      if (verification.kind === 'unscorable') {
        return await unscorable(verification.detail);
      }
      if (verification.kind === 'failed') {
        return {
          kind: 'failed',
          checkoutDir: repoDir,
          changedFiles,
          check: verification.check,
          detail: verification.detail,
          cleanup,
        };
      }

      const trustedDiff = await runCommand('git', [
        '-C',
        repoDir,
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--binary',
        '--full-index',
        `${context.reviewTarget.baseOid}...${context.reviewTarget.resultingHead}`,
        '--',
      ]);
      const reviewDiffBytes = Buffer.byteLength(trustedDiff.stdout);
      if (reviewDiffBytes > MAX_REVIEW_DIFF_BYTES) {
        return await unscorable(
          `review-diff-too-large: ${reviewDiffBytes} bytes exceeds ${MAX_REVIEW_DIFF_BYTES}`,
        );
      }

      return {
        kind: 'passed',
        checkoutDir: repoDir,
        changedFiles,
        reviewDiff: trustedDiff.stdout,
        checks: [
          'repository',
          'exact-head',
          'policy',
          ...verification.checks,
        ],
        cleanup,
      };
    } catch (error) {
      if (cancelled(error)) return await unscorable('evaluation-cancelled');
      if (error instanceof SupervisedProcessUnreapedError) {
        return await unscorable(error.message, false);
      }
      return await unscorable(`repository-precheck-failed: ${commandErrorDetail(error)}`);
    }
  }
}
