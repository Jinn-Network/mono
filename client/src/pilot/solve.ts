export interface Arm { name: 'A' | 'B'; skills: string[]; }
export interface SolveTokens { inputTokens: number; outputTokens: number; cacheReadTokens: number; }

/** The jinn-agent argv for one solve. Arm A = empty loadout enforced via
 *  --ignore-rules (no memory/AGENTS.md/preloaded-skill leakage, spike §3.1);
 *  arm B = arm A + `-s <skill>` for each loadout skill. */
export function buildSolveArgs(arm: Arm, prompt: string, opts: { maxTurns: number }): string[] {
  const base = ['chat', '-q', prompt, '-Q', '--yolo', '--ignore-rules'];
  const skills = arm.skills.flatMap((s) => ['-s', s]);
  return [...base, ...skills, '--pass-session-id', '--max-turns', String(opts.maxTurns)];
}

export function parseSessionTokens(exportLine: string): SolveTokens {
  const o = JSON.parse(exportLine) as Record<string, unknown>;
  const num = (k: string): number => {
    const v = o[k];
    if (typeof v !== 'number') throw new Error(`session export missing numeric token field '${k}'`);
    return v;
  };
  return {
    inputTokens: num('input_tokens'),
    outputTokens: num('output_tokens'),
    cacheReadTokens: typeof o['cache_read_tokens'] === 'number' ? (o['cache_read_tokens'] as number) : 0,
  };
}

export function extractSessionId(stderr: string): string | null {
  const m = stderr.match(/session_id:\s*(\S+)/);
  return m ? m[1]! : null;
}
