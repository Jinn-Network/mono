import { constants as fsConstants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LocalClaudeCodeInstallResult {
  ok: boolean;
  claudePath?: string;
  detail: string;
}

export type ExecFileAsync = (
  file: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

export interface LocalClaudeCodeInstallOptions {
  installRoot?: string;
  execFileAsync?: ExecFileAsync;
}

export function defaultClaudeCodeInstallRoot(): string {
  return join(homedir(), '.jinn-client', 'tools', 'claude-code');
}

export function claudeBinaryPathForInstallRoot(installRoot: string): string {
  return join(installRoot, 'node_modules', '.bin', 'claude');
}

function compactInstallFailure(err: unknown): string {
  const e = err as { stderr?: string; stdout?: string; message?: string };
  const raw = e.stderr || e.stdout || e.message || String(err);
  return raw.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, 4).join(' ');
}

export async function installClaudeCodeLocally(
  opts: LocalClaudeCodeInstallOptions = {},
): Promise<LocalClaudeCodeInstallResult> {
  const installRoot = opts.installRoot ?? defaultClaudeCodeInstallRoot();
  const run = opts.execFileAsync ?? execFileAsync;
  await fs.mkdir(installRoot, { recursive: true, mode: 0o700 });

  try {
    await run(
      'npm',
      [
        'install',
        '--prefix',
        installRoot,
        '@anthropic-ai/claude-code@latest',
        '--omit=dev',
        '--no-audit',
        '--no-fund',
      ],
      { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 },
    );
  } catch (err) {
    return {
      ok: false,
      detail: `Claude Code install failed: ${compactInstallFailure(err)}`,
    };
  }

  const claudePath = claudeBinaryPathForInstallRoot(installRoot);
  try {
    await fs.access(claudePath, fsConstants.X_OK);
    return { ok: true, claudePath, detail: 'Claude Code installed' };
  } catch {
    return {
      ok: false,
      detail: `Claude Code install completed, but no executable was found at ${claudePath}`,
    };
  }
}
