import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, pid } from 'node:process';
import {
  AUTOPILOT_RUNTIME_ENV,
  parseAutopilotRuntime,
} from '../src/autopilot-runtime.js';
import type { SpawnFn } from '../src/dispatcher/coordinator-session.js';
import {
  defaultRunner,
  type CommandRunner,
} from '../src/dispatcher/issue-source.js';
import { DEFAULT_CONFIG, type DispatcherConfig } from '../src/dispatcher/types.js';
import { shouldRouteToSession } from '../src/cli/routing.js';
import {
  buildGitHubLifecycleSnapshot,
  defaultRunnerId,
  explicitEnvironmentFlag,
  explainIssue,
  explainPullRequest,
  GhLifecycleReader,
  makeProductionActiveRuntime,
  makeProductionReconciliationWriter,
  parseLifecycleCli,
  renderLifecycleHuman,
  renderLifecycleJson,
  resolveCredentialPool,
  runLifecycleCycle,
  sanitizedGitHubCommandOverlay,
  selectCredential,
  sweepDeadAttempts,
  type SelectedCredential,
} from '../src/lifecycle/index.js';

const DEFAULT_INTERVAL_MS = 10 * 60_000;
const STALE_AFTER_MS = 2 * 60 * 60_000;
const DEFAULT_WORKTREE_BASE = join(
  homedir(),
  '.jinn-client',
  'autopilot',
  'attempts',
);

function authorAllowlist(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((login) => login.trim().toLowerCase())
      .filter((login) => login.length > 0),
  );
}

function positiveEnvironmentInteger(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} is too large`);
  return value;
}

function dispatcherConfig(allowlist: ReadonlySet<string>): DispatcherConfig {
  return {
    ...DEFAULT_CONFIG,
    runtime: parseAutopilotRuntime(env[AUTOPILOT_RUNTIME_ENV]),
    authorAllowlist: [...allowlist],
    reviewBotLogin: env.JINN_REVIEW_BOT_LOGIN ?? '',
    implGhToken: env.JINN_IMPL_GH_TOKEN ?? '',
    reviewGhToken: env.JINN_REVIEW_GH_TOKEN ?? '',
    mergePrepEnabled: true,
    ...(env.JINN_DISPATCHER_HERMES_MODEL === undefined
      ? {}
      : { hermesModel: env.JINN_DISPATCHER_HERMES_MODEL }),
    ...(env.JINN_DISPATCHER_HERMES_PROVIDER === undefined
      ? {}
      : { hermesProvider: env.JINN_DISPATCHER_HERMES_PROVIDER }),
    ...(env.JINN_DISPATCHER_HERMES_PYTHON === undefined
      ? {}
      : { hermesPythonPath: env.JINN_DISPATCHER_HERMES_PYTHON }),
  };
}

function selectedReadRunner(
  token: string,
  ambient: NodeJS.ProcessEnv,
): CommandRunner {
  const selected = {
    ...sanitizedGitHubCommandOverlay(ambient, { GH_TOKEN: token }),
  };
  return (command, args, options) => defaultRunner(command, args, {
    ...options,
    env: { ...selected, ...options?.env },
  });
}

function makeLoggingSpawn(): SpawnFn {
  return (command, args, options) => {
    const { onExit, logPath, ...spawnOptions } = options;
    let descriptor: number | undefined;
    let stdio = options.stdio;
    try {
      if (logPath !== undefined) {
        mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
        descriptor = openSync(logPath, 'a', 0o600);
        writeSync(
          descriptor,
          `\n===== active dispatch ${new Date().toISOString()} pid=pending =====\n`,
        );
        stdio = ['ignore', descriptor, descriptor];
      }
      const child = spawn(command, args, {
        ...spawnOptions,
        detached: true,
        stdio,
      } as SpawnOptions) as ChildProcess;
      if (onExit !== undefined) {
        let completed = false;
        const finish = (
          code: number | null,
          signal: NodeJS.Signals | null,
        ) => {
          if (completed) return;
          completed = true;
          onExit(code, signal);
        };
        child.once('error', () => finish(null, null));
        child.once('exit', finish);
      }
      child.unref();
      const result = {
        pid: child.pid,
        get exitCode() {
          return child.exitCode;
        },
        once(event: 'exit', listener: (...args: unknown[]) => void) {
          child.once(event, listener);
          return result;
        },
      };
      return result;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  };
}

function childIsAlive(childPid: number): boolean {
  try {
    process.kill(childPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function main(): Promise<void> {
  if (shouldRouteToSession(argv)) {
    const { runSessionCli } = await import('../src/cli/session.js');
    await runSessionCli(argv.slice(3));
    return;
  }

  const options = parseLifecycleCli(argv.slice(2));
  const allowlist = authorAllowlist(env.JINN_DISPATCHER_AUTHOR_ALLOWLIST);
  const config = dispatcherConfig(allowlist);
  const runnerId = defaultRunnerId({
    configured: env.JINN_AUTOPILOT_RUNNER_ID,
    environment: env,
    pid,
  });
  let runner: CommandRunner = defaultRunner;
  let credentials: Awaited<ReturnType<typeof resolveCredentialPool>> | undefined;
  let maintenanceCredential: SelectedCredential | undefined;
  if (options.mode !== 'observe') {
    credentials = await resolveCredentialPool({
      JINN_IMPL_GH_TOKEN: env.JINN_IMPL_GH_TOKEN,
      JINN_REVIEW_GH_TOKEN: env.JINN_REVIEW_GH_TOKEN,
      JINN_REVIEW_BOT_LOGIN: env.JINN_REVIEW_BOT_LOGIN,
    }, defaultRunner);
    const selected = selectCredential(credentials, { phase: 'implement' });
    if (selected.status !== 'selected') throw new Error(selected.detail);
    maintenanceCredential = selected.credential;
    runner = selectedReadRunner(selected.credential.secret(), env);
  }
  const reader = new GhLifecycleReader(runner);
  const repositoryPath = (await runner('git', [
    'rev-parse', '--path-format=absolute', '--show-toplevel',
  ])).trim();
  const readSnapshot = (rateLimitFloor?: number) => buildGitHubLifecycleSnapshot(reader, {
    authorAllowlist: allowlist,
    ...(rateLimitFloor === undefined ? {} : { rateLimitFloor }),
  });
  const worktreeBase = env.JINN_AUTOPILOT_WORKTREE_BASE ?? DEFAULT_WORKTREE_BASE;
  const cleanupEnabled = options.mode === 'active'
    && explicitEnvironmentFlag(
      env.JINN_AUTOPILOT_CLEANUP_ENABLED,
      'JINN_AUTOPILOT_CLEANUP_ENABLED',
    );

  const writer = credentials === undefined
    ? undefined
    : (() => {
        const selection = selectCredential(credentials!, { phase: 'implement' });
        if (selection.status !== 'selected') throw new Error(selection.detail);
        return makeProductionReconciliationWriter({
          repositoryPath,
          readSnapshot,
          credential: selection.credential,
          runner,
          environment: env,
        });
      })();
  const active = options.mode !== 'active'
    ? undefined
    : makeProductionActiveRuntime({
        repositoryPath,
        worktreeBase,
        runnerId,
        credentials: credentials!,
        authorAllowlist: allowlist,
        readSnapshot,
        config,
        spawn: makeLoggingSpawn(),
        caps: {
          implementation: positiveEnvironmentInteger(
            env.JINN_AUTOPILOT_IMPLEMENTATION_CAP,
            config.concurrencyCap,
            'JINN_AUTOPILOT_IMPLEMENTATION_CAP',
          ),
          review: positiveEnvironmentInteger(
            env.JINN_AUTOPILOT_REVIEW_CAP,
            config.reviewCap,
            'JINN_AUTOPILOT_REVIEW_CAP',
          ),
          mergePrep: positiveEnvironmentInteger(
            env.JINN_AUTOPILOT_MERGE_PREP_CAP,
            config.mergePrepCap,
            'JINN_AUTOPILOT_MERGE_PREP_CAP',
          ),
        },
        implementationBackpressureThreshold: positiveEnvironmentInteger(
          env.JINN_AUTOPILOT_BACKPRESSURE,
          config.openPrBackpressure,
          'JINN_AUTOPILOT_BACKPRESSURE',
        ),
        staleAfterMs: STALE_AFTER_MS,
        runner,
        environment: env,
      });

  const runOnce = async (): Promise<void> => {
    if (
      options.mode === 'active'
      && cleanupEnabled
      && maintenanceCredential !== undefined
    ) {
      const cleanup = await sweepDeadAttempts(runner, {
        v2Base: join(worktreeBase, 'v2'),
        isPidAlive: childIsAlive,
        env: { GH_TOKEN: maintenanceCredential.secret() },
      });
      for (const result of cleanup) {
        if (result.status === 'retained' && result.reason.code !== 'live') {
          console.warn(
            `[autopilot:v2] cleanup retained attempt=${
              result.attemptId ?? 'unknown'
            } reason=${result.reason.code}: ${result.reason.detail}`,
          );
        }
      }
    }
    const report = await runLifecycleCycle(options.mode, {
      readSnapshot,
      ...(writer === undefined ? {} : { writer }),
      ...(active === undefined ? {} : { active }),
      now: () => new Date(),
      staleAfterMs: STALE_AFTER_MS,
      runnerId,
      cycleId: randomUUID,
    });
    if (options.json) {
      process.stdout.write(`${renderLifecycleJson(report)}\n`);
    } else if (options.command.kind === 'explain-issue') {
      process.stdout.write(`${explainIssue(report, options.command.number)}\n`);
    } else if (options.command.kind === 'explain-pr') {
      process.stdout.write(`${explainPullRequest(report, options.command.number)}\n`);
    } else {
      process.stdout.write(`${renderLifecycleHuman(report)}\n`);
    }
    if (report.status === 'rejected') process.exitCode = 2;
  };

  await runOnce();
  while (!options.once && process.exitCode !== 2) {
    await new Promise<void>((resolve) => setTimeout(resolve, DEFAULT_INTERVAL_MS));
    await runOnce();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[autopilot:v2] ${message}`);
  process.exitCode = 1;
});
