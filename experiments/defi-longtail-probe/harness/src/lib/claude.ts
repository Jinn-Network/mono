import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';

export interface ClaudeRunResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** From the CLI's terminal result event (stream-json). Null if the run died before emitting it. */
  tokenCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  numTurns: number | null;
  webSearchCount: number;
  webFetchCount: number;
  /** Set when the CLI terminated on an API-side error (rate limit, 5xx, auth).
   * The agent never got a fair attempt, so the trial is an INFRA ERROR and must
   * never be scored — see trial.ts. */
  apiError: string | null;
}

/**
 * Unlike crux-test, this probe wants a realistic full-tooling agent: web tools
 * allowed, normal env (the agent needs internet for search + its own CLI auth).
 * Only obviously irrelevant vars are dropped; nothing DeFi-relevant is injected.
 */
export async function runClaude(opts: {
  workspaceDir: string;
  prompt: string;
  model: string;
  stdoutPath: string;
  timeoutMs: number;
}): Promise<ClaudeRunResult> {
  const args = [
    '-p', opts.prompt,
    '--model', opts.model,
    '--setting-sources', 'project',
    '--permission-mode', 'bypassPermissions',
    '--output-format', 'stream-json',
    '--verbose',
  ];

  const started = Date.now();
  const proc = spawn('claude', args, {
    cwd: opts.workspaceDir,
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: undefined as unknown as string },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const out = createWriteStream(opts.stdoutPath);
  proc.stdout.pipe(out);
  proc.stderr.pipe(out);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { process.kill(-proc.pid!, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => { try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ } }, 10_000);
  }, opts.timeoutMs);

  const exitCode: number | null = await new Promise((resolve) => {
    proc.on('exit', (code) => resolve(code));
    proc.on('error', () => resolve(null));
  });
  clearTimeout(timer);
  // Make sure no orphaned children survive the trial.
  try { process.kill(-proc.pid!, 'SIGKILL'); } catch { /* gone */ }
  await new Promise((r) => out.end(r));

  return { exitCode, timedOut, durationMs: Date.now() - started, ...analyzeTranscript(opts.stdoutPath) };
}

export function analyzeTranscript(stdoutPath: string): Pick<ClaudeRunResult, 'tokenCostUsd' | 'inputTokens' | 'outputTokens' | 'numTurns' | 'webSearchCount' | 'webFetchCount' | 'apiError'> {
  let raw = '';
  try { raw = readFileSync(stdoutPath, 'utf8'); } catch { /* no transcript */ }
  let tokenCostUsd: number | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let numTurns: number | null = null;
  let webSearchCount = 0;
  let webFetchCount = 0;
  let apiError: string | null = null;

  for (const line of raw.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let evt: any;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt?.type === 'result') {
      if (typeof evt.total_cost_usd === 'number') tokenCostUsd = evt.total_cost_usd;
      if (typeof evt.num_turns === 'number') numTurns = evt.num_turns;
      if (evt.terminal_reason === 'api_error' || evt.is_error === true) {
        const status = evt.api_error_status ? ` (HTTP ${evt.api_error_status})` : '';
        apiError = `${String(evt.result ?? 'api error').slice(0, 200)}${status}`;
      }
      const u = evt.usage;
      if (u) {
        inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
        outputTokens = u.output_tokens ?? 0;
      }
    }
    const s = JSON.stringify(evt);
    if (s.includes('"name":"WebSearch"')) webSearchCount += 1;
    if (s.includes('"name":"WebFetch"')) webFetchCount += 1;
  }
  return { tokenCostUsd, inputTokens, outputTokens, numTurns, webSearchCount, webFetchCount, apiError };
}
