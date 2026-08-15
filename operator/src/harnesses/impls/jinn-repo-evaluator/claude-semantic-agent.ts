import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerInput,
  SemanticRuntimeReadiness,
} from './autopilot-semantic.js';
import {
  runSupervisedProcess,
  SupervisedProcessUnreapedError,
} from './supervised-process.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MIN_SAFE_MODE_VERSION = [2, 1, 216] as const;
const MIN_SAFE_MODE_VERSION_TEXT = MIN_SAFE_MODE_VERSION.join('.');
const ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'TMPDIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

function parseClaudeVersion(output: string): readonly [number, number, number] | undefined {
  const match = output.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$)/u);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(
  actual: readonly [number, number, number],
  required: readonly [number, number, number],
): boolean {
  for (let index = 0; index < required.length; index += 1) {
    if (actual[index]! > required[index]!) return true;
    if (actual[index]! < required[index]!) return false;
  }
  return true;
}

export interface ClaudeSemanticAgentRunnerOptions {
  claudePath?: string;
  spawn?: typeof spawn;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  terminationGraceMs?: number;
  reapTimeoutMs?: number;
  readinessTimeoutMs?: number;
  readinessCacheMs?: number;
  makeTempDir?: () => Promise<string>;
  remove?: (path: string) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

function agentEnv(
  isolatedHome: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (environment[key]) env[key] = environment[key];
  }
  return {
    ...env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, 'xdg-config'),
    XDG_DATA_HOME: join(isolatedHome, 'xdg-data'),
    XDG_CACHE_HOME: join(isolatedHome, 'xdg-cache'),
    GH_CONFIG_DIR: join(isolatedHome, 'gh'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}

/** Generic configured Claude runtime behind the typed semantic-runner port. */
export class ClaudeSemanticAgentRunner implements SemanticAgentRunner {
  private readonly claudePath: string;
  private readonly spawnFn: typeof spawn;
  private readonly killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  private readonly makeTempDir: () => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;
  private readonly terminationGraceMs: number | undefined;
  private readonly reapTimeoutMs: number | undefined;
  private readonly readinessTimeoutMs: number;
  private readonly readinessCacheMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readiness:
    | { checkedAt: number; status: SemanticRuntimeReadiness }
    | undefined;
  private readinessInFlight: Promise<SemanticRuntimeReadiness> | undefined;

  constructor(options: ClaudeSemanticAgentRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? 'claude';
    this.spawnFn = options.spawn ?? spawn;
    this.killProcessGroup =
      options.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
    this.terminationGraceMs = options.terminationGraceMs;
    this.reapTimeoutMs = options.reapTimeoutMs;
    this.readinessTimeoutMs = options.readinessTimeoutMs ?? 5_000;
    this.readinessCacheMs = options.readinessCacheMs ?? 30_000;
    this.environment = options.environment ?? process.env;
    this.makeTempDir =
      options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-semantic-home-')));
    this.remove =
      options.remove
      ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async isReady(): Promise<SemanticRuntimeReadiness> {
    if (
      this.readiness
      && Date.now() - this.readiness.checkedAt < this.readinessCacheMs
    ) {
      return this.readiness.status;
    }
    if (this.readinessInFlight) return await this.readinessInFlight;

    const probe = this.probeReadiness();
    this.readinessInFlight = probe;
    try {
      const status = await probe;
      this.readiness = { checkedAt: Date.now(), status };
      return status;
    } finally {
      if (this.readinessInFlight === probe) this.readinessInFlight = undefined;
    }
  }

  private async probeReadiness(): Promise<SemanticRuntimeReadiness> {
    if (
      !this.environment['CLAUDE_CODE_OAUTH_TOKEN']
      && !this.environment['ANTHROPIC_API_KEY']
    ) {
      return {
        ready: false,
        reason:
          'Claude semantic evaluator requires CLAUDE_CODE_OAUTH_TOKEN '
          + 'or ANTHROPIC_API_KEY because it runs in an isolated HOME',
      };
    }
    let isolatedHome: string;
    try {
      isolatedHome = await this.makeTempDir();
    } catch (error) {
      return {
        ready: false,
        reason:
          'Claude semantic evaluator unavailable: '
          + (error instanceof Error ? error.message : String(error)),
      };
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.readinessTimeoutMs,
    );
    timeout.unref?.();
    let cleanupSafe = true;
    try {
      const processOptions = {
        cwd: isolatedHome,
        env: agentEnv(isolatedHome, this.environment),
        abort: controller.signal,
        maxOutputBytes: 64 * 1024,
        spawn: this.spawnFn,
        killProcessGroup: this.killProcessGroup,
        ...(this.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: this.terminationGraceMs }),
        ...(this.reapTimeoutMs === undefined
          ? {}
          : { reapTimeoutMs: this.reapTimeoutMs }),
      };
      const versionResult = await runSupervisedProcess(
        this.claudePath,
        ['--version'],
        processOptions,
      );
      const version = parseClaudeVersion(versionResult.stdout);
      if (!version || !versionAtLeast(version, MIN_SAFE_MODE_VERSION)) {
        return {
          ready: false,
          reason:
            `Claude semantic evaluator requires Claude Code >= ${MIN_SAFE_MODE_VERSION_TEXT}; `
            + `installed version output was ${JSON.stringify(versionResult.stdout.trim())}`,
        };
      }
      const helpResult = await runSupervisedProcess(
        this.claudePath,
        ['--help'],
        processOptions,
      );
      if (!helpResult.stdout.includes('--safe-mode')) {
        return {
          ready: false,
          reason:
            'Claude semantic evaluator CLI does not advertise required --safe-mode',
        };
      }
      const authResult = await runSupervisedProcess(
        this.claudePath,
        ['auth', 'status', '--json'],
        processOptions,
      );
      const parsed = JSON.parse(authResult.stdout) as {
        loggedIn?: unknown;
        authenticated?: unknown;
      };
      if (parsed.loggedIn === true || parsed.authenticated === true) {
        return { ready: true };
      }
      return {
        ready: false,
        reason: 'Claude semantic evaluator is not authenticated',
      };
    } catch (error) {
      if (error instanceof SupervisedProcessUnreapedError) cleanupSafe = false;
      return {
        ready: false,
        reason:
          'Claude semantic evaluator unavailable: '
          + (error instanceof Error ? error.message : String(error)),
      };
    } finally {
      clearTimeout(timeout);
      if (cleanupSafe) {
        try {
          await this.remove(isolatedHome);
        } catch {
          // A failed readiness cleanup remains a negative probe only when the
          // runtime itself was unavailable; do not conceal valid auth state.
        }
      }
    }
  }

  async run(input: SemanticAgentRunnerInput): Promise<string> {
    if (
      !this.environment['CLAUDE_CODE_OAUTH_TOKEN']
      && !this.environment['ANTHROPIC_API_KEY']
    ) {
      throw new Error(
        'Claude semantic evaluator requires CLAUDE_CODE_OAUTH_TOKEN '
        + 'or ANTHROPIC_API_KEY',
      );
    }
    const isolatedHome = await this.makeTempDir();
    const args = [
      '--safe-mode',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--no-session-persistence',
      '--permission-mode',
      'dontAsk',
      '--output-format',
      'text',
      '--tools',
      '',
      '--disallowedTools',
      '*',
      '-p',
    ];
    if (input.model) args.push('--model', input.model);

    let cleanupSafe = true;
    try {
      const result = await runSupervisedProcess(this.claudePath, args, {
        cwd: isolatedHome,
        env: agentEnv(isolatedHome, this.environment),
        input: input.prompt,
        abort: input.abort,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        spawn: this.spawnFn,
        killProcessGroup: this.killProcessGroup,
        ...(this.terminationGraceMs === undefined
          ? {}
          : { terminationGraceMs: this.terminationGraceMs }),
        ...(this.reapTimeoutMs === undefined
          ? {}
          : { reapTimeoutMs: this.reapTimeoutMs }),
      });
      return result.stdout.trim();
    } catch (error) {
      if (error instanceof SupervisedProcessUnreapedError) cleanupSafe = false;
      throw error;
    } finally {
      if (cleanupSafe) {
        try {
          await this.remove(isolatedHome);
        } catch {
          // Isolated-home disposal cannot replace a semantic result.
        }
      }
    }
  }
}
