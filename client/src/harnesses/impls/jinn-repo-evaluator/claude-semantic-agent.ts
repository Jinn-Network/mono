import { spawn, type ChildProcess } from 'node:child_process';
import type {
  SemanticAgentRunner,
  SemanticAgentRunnerInput,
} from './autopilot-semantic.js';

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'TERM',
  'TMPDIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'NODE_PATH',
  'NODE_OPTIONS',
  'NPM_CONFIG_PREFIX',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
] as const;

export interface ClaudeSemanticAgentRunnerOptions {
  claudePath?: string;
  model?: string;
  spawn?: typeof spawn;
  killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
}

function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
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

  constructor(options: ClaudeSemanticAgentRunnerOptions = {}) {
    this.claudePath = options.claudePath ?? 'claude';
    this.model = options.model;
    this.spawnFn = options.spawn ?? spawn;
    this.killProcessGroup =
      options.killProcessGroup
      ?? ((pid, signal) => process.kill(-pid, signal));
  }

  async run(input: SemanticAgentRunnerInput): Promise<string> {
    const args = [
      '--setting-sources',
      'project',
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'text',
      '-p',
      input.prompt,
    ];
    const model = input.model ?? this.model;
    if (model) args.push('--model', model);

    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const child: ChildProcess = this.spawnFn(this.claudePath, args, {
        cwd: input.cwd,
        env: agentEnv(),
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
  }
}
