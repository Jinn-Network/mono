import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildHeadlessPrompt,
  buildHermesHeadlessPrompt,
} from '../headless.js';
import {
  prepareHermesHome,
  type HermesHomeOpts,
} from './hermes-home.js';
import { hermesChatArgs } from './hermes-runtime.js';
import type { DispatcherConfig, Effort } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

export interface SpawnResult {
  pid: number | undefined;
}

export type SpawnExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

export interface CoordinatorSpawnOptions {
  cwd: string;
  detached: boolean;
  stdio: 'ignore' | Array<string | number | null>;
  env?: NodeJS.ProcessEnv;
  logPath?: string;
  startedAtMarkerPath?: string;
  onExit?: SpawnExitHandler;
  [key: string]: unknown;
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: CoordinatorSpawnOptions,
) => SpawnResult;

export type CoordinatorSessionKind = 'implement' | 'review' | 'merge-prep';
export type CoordinatorSkill = 'implement-issue' | 'review-pr' | 'merge-prep';

export interface CoordinatorSessionSpec {
  kind: CoordinatorSessionKind;
  number: number;
  skill: CoordinatorSkill;
  scenario: string;
  worktreePath: string;
  /** Only implementation supplies board Effort; other sessions pass null. */
  effort: Effort | null;
  /** Identity and caller-specific child-stage environment. */
  env: NodeJS.ProcessEnv;
  spawnOptions: {
    detached: boolean;
    stdio: 'ignore' | Array<string | number | null>;
    logPath?: string;
    startedAtMarkerPath?: string;
    onExit?: SpawnExitHandler;
    [key: string]: unknown;
  };
}

export interface CoordinatorSessionDeps {
  spawn: SpawnFn;
  prepareHermesHome?: (
    opts: HermesHomeOpts,
  ) => { hermesHome: string };
  log?: (message: string) => void;
}

/** Canon is explicit because neither headless runtime auto-loads it reliably. */
export function loadCanon(): string {
  const claudeMd = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8').trim();
  const handbook = readFileSync(
    join(REPO_ROOT, 'docs', 'engineering', 'handbook.md'),
    'utf8',
  ).trim();
  return [
    '# CLAUDE.md (canonical)\n',
    claudeMd,
    '',
    '# Engineering handbook (canonical)\n',
    handbook,
  ].join('\n');
}

/** Map board Effort to Claude's CLI flag; null keeps the runtime default. */
export function effortFlag(effort: Effort | null): string[] {
  return effort == null ? [] : ['--effort', effort.toLowerCase()];
}

/**
 * Launch one AI coordinator through the process-wide runtime.
 *
 * Runtime selection lives only here: callers retain their lifecycle, cleanup,
 * logging paths, worktrees, and GitHub identities.
 */
export function spawnCoordinatorSession(
  spec: CoordinatorSessionSpec,
  cfg: DispatcherConfig,
  deps: CoordinatorSessionDeps,
): SpawnResult {
  const sessionId = `${spec.kind}-${spec.number}`;
  const runtimePrompt = cfg.runtime === 'hermes'
    ? buildHermesHeadlessPrompt(spec.skill, spec.scenario)
    : buildHeadlessPrompt(spec.skill, spec.scenario);
  const prompt = [loadCanon(), '', runtimePrompt].join('\n');
  const env: NodeJS.ProcessEnv = {
    ...spec.env,
    JINN_AUTOPILOT_RUNTIME: cfg.runtime,
    // Pin the session CLI to the package the DISPATCHER itself runs from.
    // The skill's fallback is <repo-root>/packages/autopilot resolved from
    // the session's cwd — the attempt worktree — whose checkout is the
    // claim's base commit and can carry an older `autopilot session`
    // implementation (proven live: a review verdict died on next's v1
    // identity assertion). v1's dispatch.ts always pinned this; v2 must too.
    JINN_AUTOPILOT_PACKAGE_DIR: join(REPO_ROOT, 'packages', 'autopilot'),
  };
  let result: SpawnResult;

  if (cfg.runtime === 'hermes') {
    const home = (deps.prepareHermesHome ?? prepareHermesHome)({
      sessionId,
      worktreePath: spec.worktreePath,
      effort: spec.effort,
      cfg,
    });
    result = deps.spawn(
      cfg.hermesPythonPath,
      hermesChatArgs(prompt, {
        model: cfg.hermesModel,
        provider: cfg.hermesProvider,
      }),
      {
        ...spec.spawnOptions,
        cwd: spec.worktreePath,
        env: {
          ...env,
          HERMES_HOME: home.hermesHome,
          JINN_DISPATCHER_HERMES_PYTHON: cfg.hermesPythonPath,
          JINN_DISPATCHER_HERMES_MODEL: cfg.hermesModel,
          JINN_DISPATCHER_HERMES_PROVIDER: cfg.hermesProvider,
        },
      },
    );
  } else {
    result = deps.spawn(
      'claude',
      ['-p', ...effortFlag(spec.effort), prompt],
      {
        ...spec.spawnOptions,
        cwd: spec.worktreePath,
        env,
      },
    );
  }

  (deps.log ?? console.log)(
    `[autopilot] coordinator dispatch session=${sessionId} ` +
      `runtime=${cfg.runtime} pid=${result.pid ?? 'unknown'}`,
  );
  return result;
}
