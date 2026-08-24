/**
 * Preflight: detect Claude auth context and probe authentication status.
 *
 * Three contexts are recognised:
 *   - 'container'      — running inside a Docker container (/.dockerenv exists)
 *   - 'docker-compose' — explicitly opted-in via env / config
 *   - 'bare'           — plain host environment (default)
 *
 * Priority:
 *   1. JINN_RUNTIME_MODE env var (authoritative; CI / scripted operators)
 *   2. `runtimeMode` field in the resolved config (persisted by jinn-auth split)
 *   3. /.dockerenv presence -> 'container' (the only filesystem-guessable mode)
 *   4. Default 'bare'
 *
 * We deliberately do NOT guess `docker-compose` from a docker-compose.yml in
 * cwd. That heuristic misfired for anyone running from the operator/ checkout
 * (the package ships its own compose file naming jinn-daemon) and nothing in
 * the runtime can verify the host is actually orchestrating us via compose.
 * Operators in real docker-compose set the env var or persist the mode.
 */

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { ReadyStatus } from '../harnesses/types.js';

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
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type AuthProbeValidity = 'valid' | 'invalid' | 'malformed' | 'error';

export interface AuthProbeResult {
  authenticated: boolean;
  context: AuthContext;
  detail: string;
  email?: string;
  /** Presence of a login is `authenticated`; this classifies *why* a probe failed. */
  validity?: AuthProbeValidity;
}

export interface ProbeOptions {
  context: AuthContext;
  cwd: string;
  /** CLI path to use in bare/container modes. Docker-compose runs inside the service image. */
  claudePath?: string;
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
 * When `dockerenvExists` is omitted the function inspects the filesystem directly.
 */
export function detectAuthContext(opts: DetectContextOptions): AuthContext {
  const env = opts.env ?? process.env;

  // 1. JINN_RUNTIME_MODE env var (CI / scripted operators).
  const envMode = env['JINN_RUNTIME_MODE'];
  if (envMode === 'bare' || envMode === 'docker-compose' || envMode === 'container') {
    return envMode;
  }

  // 2. Explicit config (persisted by jinn-auth split).
  if (opts.configuredMode) {
    return opts.configuredMode;
  }

  // 3. /.dockerenv -> 'container'. This is the only filesystem signal we trust:
  // it means the runtime IS a Docker container, no ambiguity.
  const inContainer =
    opts.dockerenvExists !== undefined
      ? opts.dockerenvExists
      : existsSync('/.dockerenv');

  if (inContainer) return 'container';

  // 4. Default 'bare'. We deliberately do NOT guess 'docker-compose' from a
  // local docker-compose.yml — that heuristic misfired for anyone running
  // from the operator/ checkout dir.
  return 'bare';
}

// ---------------------------------------------------------------------------
// probeClaudeAuth
// ---------------------------------------------------------------------------

/**
 * Probe whether `claude` is authenticated in the given context.
 * When `spawnResult` is provided (testing) no subprocess is created.
 */
export function classifyClaudeAuthValidity(
  result: Pick<AuthProbeResult, 'authenticated' | 'detail' | 'validity'>,
): AuthProbeValidity {
  if (result.validity) return result.validity;
  if (result.authenticated) return 'valid';
  const detail = result.detail ?? '';
  if (/not valid JSON/i.test(detail)) return 'malformed';
  if (/not found on PATH|timed out|ETIMEDOUT/i.test(detail)) return 'error';
  if (detail === 'not logged in') return 'invalid';
  return 'error';
}

export function probeClaudeAuth(opts: ProbeOptions): AuthProbeResult {
  const { context, cwd } = opts;

  const sr: SpawnResult = opts.spawnResult ?? _spawnAuthStatus(context, cwd, opts.claudePath);

  if (sr.status !== 0) {
    const timedOut =
      sr.status === null || /timed out/i.test(sr.stderr);
    return {
      authenticated: false,
      context,
      detail:
        sr.stderr ||
        (timedOut ? 'claude auth status timed out' : 'claude auth status exited with non-zero status'),
      validity: 'error',
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
      validity: 'malformed',
    };
  }

  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('loggedIn' in parsed) ||
    (parsed as Record<string, unknown>).loggedIn !== true
  ) {
    return { authenticated: false, context, detail: 'not logged in', validity: 'invalid' };
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
    validity: 'valid',
  };
}

function _spawnAuthStatus(context: AuthContext, cwd: string, claudePath = 'claude'): SpawnResult {
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
    command = claudePath;
    args = ['auth', 'status'];
  }

  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10_000 });
  const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errCode === 'ENOENT') {
    return {
      status: -1,
      stdout: '',
      stderr: `claude binary ${claudePath} not found on PATH`,
    };
  }
  if (errCode === 'ETIMEDOUT' || (result.status === null && result.signal != null)) {
    return {
      status: null,
      stdout: '',
      stderr: 'claude auth status timed out',
    };
  }
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ---------------------------------------------------------------------------
// buildClaudeIsReady — factory to dedupe per-harness isReady() impls
// ---------------------------------------------------------------------------

export const CLAUDE_INSTALL_URL = '/v1/setup/claude/install';
export const CLAUDE_AUTH_LOGIN_CLI = 'claude auth login';

export interface BuildClaudeIsReadyOpts {
  getClaudePath: () => string;
  getContext: () => AuthContext;
}

/**
 * Build a `isReady()` implementation that probes claude auth status and
 * returns the appropriate ReadyStatus with nextStep URLs.
 *
 * Callers that need a stub short-circuit (e.g. stub mode) should check
 * their stub flag BEFORE calling the returned function and return early.
 */
export function buildClaudeIsReady(
  opts: BuildClaudeIsReadyOpts,
): (_ctx?: { solverType: string; role?: 'restoration' | 'evaluation' }) => Promise<ReadyStatus> {
  return async (
    _ctx?: { solverType: string; role?: 'restoration' | 'evaluation' },
  ): Promise<ReadyStatus> => {
    const result = probeClaudeAuth({
      context: opts.getContext(),
      cwd: process.cwd(),
      claudePath: opts.getClaudePath(),
    });
    if (result.authenticated) return { ready: true, reason: result.detail };
    const binaryMissing = result.detail.includes('not found on PATH');
    return {
      ready: false,
      reason: result.detail,
      nextStep: binaryMissing
        ? { description: 'Install Claude Code from the operator app', url: CLAUDE_INSTALL_URL }
        : { description: 'Sign in with the Claude Code CLI', cli: CLAUDE_AUTH_LOGIN_CLI },
    };
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
  claudePath = 'claude',
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

  return { command: claudePath, args: ['auth', 'login'] };
}
