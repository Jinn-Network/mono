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

/** Returned by `mountSkill`, consumed by `unmountSkill`. Records exactly
 *  which ancestor directories mounting had to create so unmounting can prune
 *  ONLY those — never a directory (or its contents, e.g. a tracked
 *  `.claude/settings.json`) that predates this bench attempt. `createdDirs`
 *  is in creation order (`.claude` before `.claude/skills`, when both were
 *  created); `unmountSkill` removes them in reverse. */
export interface SkillMountHandle {
  /** The mounted skill dir: `<checkoutDir>/.claude/skills/<name>`. */
  mounted: string;
  /** Ancestor dirs that did NOT exist before this mount and so are safe to
   *  prune entirely on unmount (empty when both `.claude` and
   *  `.claude/skills` already existed in the checkout). */
  createdDirs: string[];
}

/** Mount the pinned skill into the per-attempt checkout — the project-level
 *  location claude-code discovers skills from, so the treatment is exactly
 *  "this skill is installed in this workspace". pin.json is rig metadata, not
 *  part of the published skill, and must not ride along.
 *
 *  Records (before creating anything) whether `.claude` and `.claude/skills`
 *  already existed in the checkout, so `unmountSkill` can restore the
 *  checkout to its ORIGINAL state rather than deleting `.claude` wholesale —
 *  a checkout with a tracked `.claude/settings.json` (or other pre-existing
 *  content, or other mounted skills) must come back untouched, with only
 *  this skill's mount removed (final-review C2). */
export async function mountSkill(checkoutDir: string, skillDir: string, name: string): Promise<SkillMountHandle> {
  const claudeDir = join(checkoutDir, '.claude');
  const skillsDir = join(claudeDir, 'skills');
  const dest = join(skillsDir, name);
  const createdDirs: string[] = [];
  if (!existsSync(claudeDir)) createdDirs.push(claudeDir);
  if (!existsSync(skillsDir)) createdDirs.push(skillsDir);
  await mkdir(dest, { recursive: true });
  await cp(skillDir, dest, { recursive: true });
  await rm(join(dest, 'pin.json'), { force: true });
  return { mounted: dest, createdDirs };
}

/** Remove the mounted skill from the checkout, restoring the checkout's
 *  original state rather than deleting `.claude/` wholesale: removes ONLY
 *  `<checkout>/.claude/skills/<name>`, then prunes `.claude/skills` and
 *  `.claude` in turn, each ONLY if `mountSkill` had to create it (recorded on
 *  `handle.createdDirs`). MUST run after the claude spawn completes and
 *  BEFORE `recoverPatch` — `recoverPatch` runs `git add -A` / `git diff
 *  --cached`, which stages untracked files by design, so a still-mounted
 *  skill would ride along as an added file in every treatment arm's graded
 *  patch (never in baseline's), a systematic, one-directional asymmetry
 *  between the arms being compared. */
export async function unmountSkill(handle: SkillMountHandle): Promise<void> {
  await rm(handle.mounted, { recursive: true, force: true });
  for (const dir of [...handle.createdDirs].reverse()) {
    await rm(dir, { recursive: true, force: true });
  }
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

/** Message for a failed auth preflight probe (run-bench.ts, before any solve
 *  work). Pure/testable: names why the isolated config dir is required (not
 *  optional — dropping isolation lets ambient user-level skills leak into
 *  the "no skill installed" baseline and makes receipts unreproducible off
 *  this operator's machine) and both supported remediation routes. Never
 *  reads, copies, or extracts a credential — detection + message only. */
export function authPreflightFailureMessage(configDir: string): string {
  return [
    `[bench] auth preflight failed: the isolated CLAUDE_CONFIG_DIR (${configDir}) has no usable claude-code credentials.`,
    `Isolation is required for a truthful baseline — an unisolated config dir lets the operator's ambient user-level skills/plugins leak into every arm, including the "no skill installed" baseline, and makes receipts unreproducible off this operator's machine.`,
    `Fix with one of:`,
    `  1. export ANTHROPIC_API_KEY=... (metered API billing; works headless — the route for the Linux wave host)`,
    `  2. one-time interactive login into the bench config dir: CLAUDE_CONFIG_DIR=${configDir} claude` +
      ` then /login (keeps subscription billing)`,
  ].join('\n');
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
