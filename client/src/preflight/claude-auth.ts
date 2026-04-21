/**
 * Preflight: detect Claude auth context and probe authentication status.
 *
 * Three contexts are recognised:
 *   - 'container'      — running inside a Docker container (/.dockerenv exists)
 *   - 'docker-compose' — a docker-compose.yml with a jinn-daemon service lives in cwd
 *   - 'bare'           — plain host environment (default)
 *
 * Priority:
 *   1. JINN_RUNTIME_MODE env var (authoritative; CI/scripted operators)
 *   2. `runtimeMode` field in the resolved config (persisted by `jinn auth`)
 *   3. Filesystem heuristic (container → docker-compose → bare) as a last resort
 *
 * The filesystem path is a LAST RESORT because running from the `client/`
 * checkout dir misdetects as docker-compose (the package's own compose file
 * names `jinn-daemon`). Operators should set `runtimeMode` at `jinn auth`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthContext = 'container' | 'docker-compose' | 'bare';

export interface DetectContextOptions {
  cwd: string;
  /** Optional explicit mode, typically from `config.runtimeMode`. Highest priority. */
  configuredMode?: AuthContext;
  /** Optional env (default: process.env). Tests can inject a stub. */
  env?: NodeJS.ProcessEnv;
  /** Override the /.dockerenv existence check (for testing). */
  dockerenvExists?: boolean;
  /** Override the docker-compose.yml jinn-daemon check (for testing). */
  composeServiceExists?: boolean;
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface AuthProbeResult {
  authenticated: boolean;
  context: AuthContext;
  detail: string;
  email?: string;
}

export interface ProbeOptions {
  context: AuthContext;
  cwd: string;
  /** Inject a pre-computed spawn result (for testing). */
  spawnResult?: SpawnResult;
}

export interface LoginResult {
  success: boolean;
  detail: string;
}

// ---------------------------------------------------------------------------
// detectAuthContext
// ---------------------------------------------------------------------------

/**
 * Determine which environment Claude is running in.
 * When `dockerenvExists` / `composeServiceExists` are omitted the function
 * inspects the filesystem directly.
 */
export function detectAuthContext(opts: DetectContextOptions): AuthContext {
  const { cwd } = opts;
  const env = opts.env ?? process.env;

  // 1. JINN_RUNTIME_MODE env var (CI / scripted operators).
  const envMode = env['JINN_RUNTIME_MODE'];
  if (envMode === 'bare' || envMode === 'docker-compose' || envMode === 'container') {
    return envMode;
  }

  // 2. Explicit config (persisted by `jinn auth`).
  if (opts.configuredMode) {
    return opts.configuredMode;
  }

  // 3. Filesystem heuristic — last resort. Flawed inside the client/ checkout dir
  // because the package's own docker-compose.yml names jinn-daemon. Prefer
  // setting runtimeMode explicitly.
  const inContainer =
    opts.dockerenvExists !== undefined
      ? opts.dockerenvExists
      : existsSync('/.dockerenv');

  if (inContainer) return 'container';

  const hasComposeService =
    opts.composeServiceExists !== undefined
      ? opts.composeServiceExists
      : _composeHasJinnDaemon(cwd);

  if (hasComposeService) return 'docker-compose';

  return 'bare';
}

function _composeHasJinnDaemon(cwd: string): boolean {
  const composePath = join(cwd, 'docker-compose.yml');
  if (!existsSync(composePath)) return false;
  try {
    const content = readFileSync(composePath, 'utf8');
    return content.includes('jinn-daemon');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// probeClaudeAuth
// ---------------------------------------------------------------------------

/**
 * Probe whether `claude` is authenticated in the given context.
 * When `spawnResult` is provided (testing) no subprocess is created.
 */
export function probeClaudeAuth(opts: ProbeOptions): AuthProbeResult {
  const { context, cwd } = opts;

  const sr: SpawnResult = opts.spawnResult ?? _spawnAuthStatus(context, cwd);

  if (sr.status !== 0) {
    return {
      authenticated: false,
      context,
      detail: sr.stderr || 'claude auth status exited with non-zero status',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(sr.stdout);
  } catch {
    return {
      authenticated: false,
      context,
      detail: 'claude auth status output is not valid JSON',
    };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('loggedIn' in parsed) ||
    (parsed as Record<string, unknown>).loggedIn !== true
  ) {
    return { authenticated: false, context, detail: 'not logged in' };
  }

  const email =
    typeof (parsed as Record<string, unknown>).email === 'string'
      ? ((parsed as Record<string, unknown>).email as string)
      : undefined;

  return {
    authenticated: true,
    context,
    detail: email ? `logged in as ${email}` : 'logged in',
    email,
  };
}

function _spawnAuthStatus(context: AuthContext, cwd: string): SpawnResult {
  let command: string;
  let args: string[];

  if (context === 'docker-compose') {
    command = 'docker';
    args = [
      'compose',
      '-f',
      join(cwd, 'docker-compose.yml'),
      'run',
      '--rm',
      '-T',
      '--no-deps',
      '--entrypoint',
      'claude',
      'jinn-daemon',
      'auth',
      'status',
    ];
  } else {
    command = 'claude';
    args = ['auth', 'status'];
  }

  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// buildLoginCommand
// ---------------------------------------------------------------------------

/**
 * Return the command + args needed to interactively log in to Claude.
 */
export function buildLoginCommand(
  context: AuthContext,
  cwd: string,
): { command: string; args: string[] } {
  if (context === 'docker-compose') {
    return {
      command: 'docker',
      args: [
        'compose',
        '-f',
        join(cwd, 'docker-compose.yml'),
        'run',
        '--rm',
        '-it',
        '--no-deps',
        '--entrypoint',
        'claude',
        'jinn-daemon',
        'auth',
        'login',
      ],
    };
  }

  return { command: 'claude', args: ['auth', 'login'] };
}
