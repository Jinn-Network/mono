import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerInput,
} from './autopilot-semantic.js';

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
  model?: string;
  spawn?: typeof spawn;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
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
  private readonly model: string | undefined;
  private readonly spawnFn: typeof spawn;
  private readonly killProcessGroup: (
    pid: number,
    signal: NodeJS.Signals,
  ) => void;
  private readonly makeTempDir: () => Promise<string>;
  private readonly remove: (path: string) => Promise<void>;

  constructor(options: ClaudeSemanticAgentRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? 'claude';
    this.model = options.model;
    this.spawnFn = options.spawn ?? spawn;
    this.killProcessGroup =
      options.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
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
      '--setting-sources',
      'project',
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
      'Bash(gh:*)',
      'Bash(git push:*)',
      'Bash(git commit:*)',
      'Bash(git config:*)',
      'Bash(git remote:*)',
      '-p',
      input.prompt,
    ];
    if (this.model) args.push('--model', this.model);

    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        let stdout = '';
        let stderr = '';
        const child: ChildProcess = this.spawnFn(this.claudePath, args, {
          cwd: input.cwd,
          env: agentEnv(isolatedHome),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (error?: Error): void => {
          if (settled) return;
          settled = true;
          input.abort.removeEventListener('abort', onAbort);
          if (error) reject(error);
          else resolve(stdout.trim());
        };
        const onAbort = (): void => {
          if (child.pid !== undefined) {
            try {
              this.killProcessGroup(child.pid, 'SIGTERM');
            } catch {
              child.kill('SIGTERM');
            }
          }
          finish(new Error('Semantic review aborted'));
        };
        input.abort.addEventListener('abort', onAbort, { once: true });
        if (input.abort.aborted) {
          onAbort();
          return;
        }

        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString();
          if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
            onAbort();
          }
        });
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString();
          if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
            onAbort();
          }
        });
        child.once('error', (error) => finish(error));
        child.once('exit', (code, signal) => {
          if (code === 0) {
            finish();
          } else {
            finish(new Error(
              `Semantic agent exited with code ${String(code)}`
              + `${signal ? ` (${signal})` : ''}: ${stderr.slice(0, 4000)}`,
            ));
          }
        });
      });
    } finally {
      try {
        await this.remove(isolatedHome);
      } catch {
        // Isolated-home disposal cannot replace a semantic result.
      }
    }
  }
}
