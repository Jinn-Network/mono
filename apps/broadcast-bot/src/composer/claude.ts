import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import type { BroadcastEvent } from '../types.js';
import { SYSTEM_PROMPT, buildUserPrompt, tightenInstruction } from './prompt.js';
import { lint } from './lint.js';

const execFile = promisify(execFileCb);

export interface ClaudeComposerOptions {
  claudePath: string;
  model: string;
  maxChars: number;
  timeoutMs: number;
}

export class ClaudeCliMissingError extends Error {
  constructor(claudePath: string) {
    super(
      `claude CLI not found at "${claudePath}". Install Claude Code from ` +
        `https://claude.com/code and run \`claude login\`, then re-run the bot. ` +
        `The broadcast bot has no fallback composer — it requires the local ` +
        `\`claude\` subprocess for OAuth.`,
    );
    this.name = 'ClaudeCliMissingError';
  }
}

export class ClaudeNotLoggedInError extends Error {
  constructor() {
    super(
      `claude CLI is on PATH but not authenticated. Run \`claude login\` (or ` +
        `set CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the bot's environment) ` +
        `and re-run the bot.`,
    );
    this.name = 'ClaudeNotLoggedInError';
  }
}

/**
 * Preflight — must be called once before any compose calls. Confirms the
 * binary exists and is runnable, so we fail with a clear message at startup
 * rather than per-event mid-loop.
 */
export async function assertClaudeAvailable(claudePath: string): Promise<void> {
  try {
    await execFile(claudePath, ['--version'], { timeout: 10_000 });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ClaudeCliMissingError(claudePath);
    // Some installs print to stderr but exit 0; only re-throw if exec actually failed.
    if ((err as { stderr?: string }).stderr?.includes('login')) {
      throw new ClaudeNotLoggedInError();
    }
    throw err;
  }
}

export interface ComposerResult {
  text: string;
  /** Lint reason if every attempt failed, otherwise null. */
  lintError: string | null;
}

export class ClaudeComposer {
  constructor(private readonly opts: ClaudeComposerOptions) {}

  async compose(event: BroadcastEvent): Promise<ComposerResult> {
    const firstPrompt = buildUserPrompt(event);
    const first = await this.callClaude(firstPrompt);
    const firstLint = lint({ text: first, link: event.link, maxChars: this.opts.maxChars });
    if (!firstLint) return { text: first, lintError: null };

    const retryPrompt = `${firstPrompt}\n\n${tightenInstruction(firstLint)}`;
    const second = await this.callClaude(retryPrompt);
    const secondLint = lint({ text: second, link: event.link, maxChars: this.opts.maxChars });
    if (!secondLint) return { text: second, lintError: null };

    return { text: second, lintError: secondLint };
  }

  private callClaude(userPrompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p',
        userPrompt,
        '--append-system-prompt',
        SYSTEM_PROMPT,
        '--model',
        this.opts.model,
      ];
      const child = spawn(this.opts.claudePath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildClaudeEnv(),
        timeout: this.opts.timeoutMs,
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new ClaudeCliMissingError(this.opts.claudePath));
        else reject(err);
      });
      child.on('exit', (code) => {
        if (code === 0) resolve(stdout.trim());
        else if (stderr.toLowerCase().includes('login') || stderr.toLowerCase().includes('not logged in')) {
          reject(new ClaudeNotLoggedInError());
        } else {
          reject(new Error(`claude -p exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });
    });
  }
}

/**
 * Pass through the auth-related env vars Claude Code looks for. Block
 * everything else — the composer subprocess has no business seeing
 * X_API_KEY, GITHUB_TOKEN, RPC URLs, etc.
 */
function buildClaudeEnv(): Record<string, string> {
  const allowlist = [
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
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ];
  const env: Record<string, string> = {};
  for (const k of allowlist) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}
