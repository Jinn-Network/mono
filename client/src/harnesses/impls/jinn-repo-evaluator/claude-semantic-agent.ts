import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerInput,
} from './autopilot-semantic.js';
import {
  runSupervisedProcess,
  SupervisedProcessUnreapedError,
} from './supervised-process.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_ALLOWLIST = [
  'PATH',
  'LANG',
  'TMPDIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

export interface ClaudeSemanticAgentRunnerOptions {
  claudePath?: string;
  spawn?: typeof spawn;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  terminationGraceMs?: number;
  reapTimeoutMs?: number;
  makeTempDir?: () => Promise<string>;
  remove?: (path: string) => Promise<void>;
}

function agentEnv(isolatedHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
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

  constructor(options: ClaudeSemanticAgentRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? 'claude';
    this.spawnFn = options.spawn ?? spawn;
    this.killProcessGroup =
      options.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
    this.terminationGraceMs = options.terminationGraceMs;
    this.reapTimeoutMs = options.reapTimeoutMs;
    this.makeTempDir =
      options.makeTempDir
      ?? (() => mkdtemp(join(tmpdir(), 'jinn-semantic-home-')));
    this.remove =
      options.remove
      ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async run(input: SemanticAgentRunnerInput): Promise<string> {
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
      '--allowedTools',
      'Read',
      'Glob',
      'Grep',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(git show:*)',
      'Bash(git status:*)',
      'Bash(git rev-parse:*)',
      'Bash(git blame:*)',
      '--disallowedTools',
      'Edit',
      'Write',
      'NotebookEdit',
      'WebFetch',
      'WebSearch',
      'Bash(gh:*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
      'Bash(git config:*)',
      'Bash(git remote:*)',
      '-p',
      input.prompt,
    ];
    if (input.model) args.push('--model', input.model);

    let cleanupSafe = true;
    try {
      const result = await runSupervisedProcess(this.claudePath, args, {
        cwd: input.cwd,
        env: agentEnv(isolatedHome),
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
