import { cp, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeRunResult {
  costUsd: number;
  numTurns: number | null;
  isError: boolean;
  sessionId: string | null;
  raw: string;
}

export function buildClaudeArgs(opts: { prompt: string; model: string; maxTurns: number }): string[] {
  return [
    '-p', opts.prompt,
    '--output-format', 'json',
    '--model', opts.model,
    '--max-turns', String(opts.maxTurns),
    '--setting-sources', 'project',
    '--permission-mode', 'bypassPermissions',
  ];
}

/** Mount the pinned skill into the per-attempt checkout — the project-level
 *  location claude-code discovers skills from, so the treatment is exactly
 *  "this skill is installed in this workspace". pin.json is rig metadata, not
 *  part of the published skill, and must not ride along. */
export async function mountSkill(checkoutDir: string, skillDir: string, name: string): Promise<string> {
  const dest = join(checkoutDir, '.claude', 'skills', name);
  await mkdir(dest, { recursive: true });
  await cp(skillDir, dest, { recursive: true });
  await rm(join(dest, 'pin.json'), { force: true });
  return dest;
}

/** Isolated CLAUDE_CONFIG_DIR: auth travels, nothing else does. User-level
 *  skills, plugins, memory, and settings must not leak into any arm — the
 *  baseline arm's claim is "no skill installed". */
export async function prepareBenchConfigDir(
  benchConfigDir: string,
  opts: { sourceConfigDir?: string },
): Promise<void> {
  await mkdir(benchConfigDir, { recursive: true });
  if (process.env.ANTHROPIC_API_KEY) return; // env auth: nothing to copy
  const src = opts.sourceConfigDir;
  if (src && existsSync(join(src, '.credentials.json'))) {
    await copyFile(join(src, '.credentials.json'), join(benchConfigDir, '.credentials.json'));
  }
}

function toResult(o: Record<string, unknown>, raw: string): ClaudeRunResult {
  return {
    costUsd: typeof o.total_cost_usd === 'number' ? o.total_cost_usd : 0,
    numTurns: typeof o.num_turns === 'number' ? o.num_turns : null,
    isError: o.is_error === true,
    sessionId: typeof o.session_id === 'string' ? o.session_id : null,
    raw,
  };
}

/** Tolerant of pretty-printed/multi-line JSON and a plain-text preamble
 *  before the JSON object: whole-stdout parse first, then from the first
 *  `{` to the end, then the original single-line scan. Only true garbage
 *  falls through to isError: true. */
export function parseClaudeJson(stdout: string): ClaudeRunResult {
  const trimmed = stdout.trim();
  try {
    return toResult(JSON.parse(trimmed) as Record<string, unknown>, stdout);
  } catch {
    // fall through
  }
  const braceIndex = trimmed.indexOf('{');
  if (braceIndex !== -1) {
    try {
      return toResult(JSON.parse(trimmed.slice(braceIndex)) as Record<string, unknown>, stdout);
    } catch {
      // fall through
    }
  }
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{')) ?? '';
  try {
    return toResult(JSON.parse(line) as Record<string, unknown>, stdout);
  } catch {
    return { costUsd: 0, numTurns: null, isError: true, sessionId: null, raw: stdout };
  }
}
