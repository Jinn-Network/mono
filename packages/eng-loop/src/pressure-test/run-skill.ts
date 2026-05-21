import { spawn } from 'node:child_process';

export interface SkillRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Spawn a one-shot headless `claude -p` session with the given prompt. */
export function runSkillHeadless(
  prompt: string,
  opts: { cwd: string; timeoutMs: number },
): Promise<SkillRunResult> {
  return new Promise((resolve) => {
    const proc = spawn('claude', ['-p', prompt], { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGTERM'); }, opts.timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
