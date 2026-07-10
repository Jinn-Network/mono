export interface Arm { name: string; skills: string[]; jinnAgentHome?: string; }
export interface SolveTokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; }

/** The jinn-agent argv for one solve. Arm A = empty loadout enforced via
 *  --ignore-rules (no memory/AGENTS.md/preloaded-skill leakage, spike §3.1);
 *  arm B = arm A + `-s <skill>` for each loadout skill. When `provider`/`model`
 *  are supplied they pin the inference endpoint for this invocation (e.g.
 *  `openai-codex` + `gpt-5.4-mini`) without touching the global config default. */
export function buildSolveArgs(
  arm: Arm,
  prompt: string,
  opts: { maxTurns: number; provider?: string; model?: string },
): string[] {
  const base = ['chat', '-q', prompt, '-Q', '--yolo', '--ignore-rules'];
  const endpoint = [
    ...(opts.provider ? ['--provider', opts.provider] : []),
    ...(opts.model ? ['-m', opts.model] : []),
  ];
  const skills = arm.skills.flatMap((s) => ['-s', s]);
  return [...base, ...endpoint, ...skills, '--pass-session-id', '--max-turns', String(opts.maxTurns)];
}

export function parseSessionTokens(exportLine: string): SolveTokens {
  const o = JSON.parse(exportLine) as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number') throw new Error(`session export missing numeric token field '${k}'`);
    return v;
  };
  const optNum = (k: string): number => (typeof o[k] === 'number' ? (o[k] as number) : 0);
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: optNum('cache_read_tokens'),
    // Reasoning models (e.g. gpt-5.4-mini) report reasoning tokens separately;
    // they are billed at the output rate. Absent for non-reasoning models → 0.
    reasoningTokens: optNum('reasoning_tokens'),
  };
}

export function extractSessionId(stderr: string): string | null {
  const m = stderr.match(/session_id:\s*(\S+)/);
  return m ? m[1]! : null;
}
