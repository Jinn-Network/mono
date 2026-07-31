import { join } from 'node:path';

/**
 * Trigger-rate extraction: did the mounted skill actually load during a
 * solve, measured from claude-code's own per-session JSONL transcript —
 * never from asking the model to self-report ("what skills did you use?"
 * produces confabulation; verified this session).
 *
 * Ground truth (verified read-only against real smoke-run session files
 * under bench/.claude-bench-config/projects/ before writing this parser):
 *
 * 1. claude-code persists one JSONL per session at
 *    `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<sessionId>.jsonl`, where
 *    `<cwd-slug>` is the solve cwd with every non-alphanumeric character
 *    ([^A-Za-z0-9]) replaced 1:1 with `-` (no collapsing of runs — an
 *    apostrophe next to a slash, e.g. `.../life's-work/.claude/...`,
 *    becomes `...-life-s-work--claude-...` with a real double dash).
 *
 * 2. The session start always carries a `skill_listing` attachment event
 *    enumerating every skill discoverable in that session (project-mounted
 *    + user-level). This appears IN BOTH ARMS and merely reflects what is
 *    *available* — a treatment-arm session's listing includes the mounted
 *    skill's name precisely because it was mounted, not because it was
 *    used. Substring-matching the skill name against this (or any other)
 *    whole event would false-positive on every treatment-arm attempt
 *    regardless of whether the model ever invoked it — confirmed by
 *    inspecting real tdd-arm vs baseline-arm smoke sessions side by side.
 *
 * 3. The only session-level fact that distinguishes "available" from
 *    "actually loaded" is the model choosing to call the `Skill` tool
 *    (the same top-level function claude-code exposes for skill
 *    invocation) with `input.skill` naming the mounted skill: an
 *    `assistant` event whose `message.content` contains
 *    `{ type: 'tool_use', name: 'Skill', input: { skill: <name> } }`.
 *    None of the 18 real smoke-run sessions inspected (both arms, two
 *    separate smoke runs) contain such a block — a genuine, verified null:
 *    the tdd skill was mounted but never actually invoked in those runs.
 *    That absence is exactly the case this module's motivating rule exists
 *    for (a low/zero trigger rate must read as "not exercised", not "no
 *    effect") — see `renderReceiptMd` in `receipt.ts`.
 *
 * detectSkillTrigger is deliberately conservative: it requires the
 * structural tool_use match above, and additionally downgrades a match to
 * not-triggered if the paired `tool_result` (matched by `tool_use_id`)
 * comes back `is_error: true` (the call was made but the skill did not
 * actually load, e.g. a bad name). It never substring-matches skill names
 * against whole event bodies.
 */

/** Pure cwd-slug logic — the solve cwd is replaced 1:1, character by
 *  character, everywhere it is not `[A-Za-z0-9]`. Caller must pass the same
 *  (already-resolved, non-symlinked) absolute path used as the `cwd` of the
 *  `claude` spawn — claude-code slugs the real path, and on macOS `/tmp` is
 *  itself a symlink to `/private/tmp`, so a symlinked cwd would slug to a
 *  directory that does not match what claude-code actually wrote. */
export function sessionJsonlPath(configDir: string, solveCwd: string, sessionId: string): string {
  const slug = solveCwd.replace(/[^A-Za-z0-9]/g, '-');
  return join(configDir, 'projects', slug, `${sessionId}.jsonl`);
}

export interface TriggerDetectionResult {
  triggered: boolean;
  /** Short descriptors only (event type + line index) — never full event
   *  bodies, per the rig's "session data, never full transcripts in
   *  receipts" posture. */
  evidence: string[];
}

interface ParsedLine {
  idx: number;
  obj: Record<string, unknown>;
}

function parseLines(jsonlText: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const lines = jsonlText.split('\n');
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!.trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj && typeof obj === 'object') out.push({ idx, obj });
    } catch {
      // Not valid JSON (partial/corrupt line) — skip, never treated as evidence.
    }
  }
  return out;
}

function contentBlocks(obj: Record<string, unknown>): Record<string, unknown>[] {
  const message = obj.message as Record<string, unknown> | undefined;
  const content = message?.content;
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

/** Detects whether `skillName` was actually loaded (the model invoked the
 *  `Skill` tool naming it), per the signature derived above. Never inspects
 *  self-report text; only structural tool_use/tool_result fields. */
export function detectSkillTrigger(jsonlText: string, skillName: string): TriggerDetectionResult {
  const target = skillName.trim().toLowerCase();
  const parsed = parseLines(jsonlText);
  const evidence: string[] = [];

  // Pass 1: assistant tool_use blocks invoking Skill(skill===target).
  // toolUseId -> line index, for pass 2's tool_result lookup.
  const matchedToolUseIds = new Map<string, number>();
  for (const { idx, obj } of parsed) {
    if (obj.type !== 'assistant') continue;
    for (const block of contentBlocks(obj)) {
      if (block.type !== 'tool_use' || block.name !== 'Skill') continue;
      const input = block.input as Record<string, unknown> | undefined;
      const skillInput = typeof input?.skill === 'string' ? input.skill.trim().toLowerCase() : '';
      if (skillInput !== target) continue;
      const id = typeof block.id === 'string' ? block.id : undefined;
      if (id) matchedToolUseIds.set(id, idx);
      evidence.push(`assistant#${idx}`);
    }
  }

  if (matchedToolUseIds.size === 0) {
    return { triggered: false, evidence: [] };
  }

  // Pass 2: paired tool_result for each matched tool_use — downgrade to
  // "not triggered" only for ids whose EVERY tool_result came back is_error.
  const idOutcome = new Map<string, 'success' | 'error' | 'unresolved'>(
    [...matchedToolUseIds.keys()].map((id) => [id, 'unresolved']),
  );
  for (const { idx, obj } of parsed) {
    if (obj.type !== 'user') continue;
    for (const block of contentBlocks(obj)) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      if (!toolUseId || !matchedToolUseIds.has(toolUseId)) continue;
      const isError = block.is_error === true;
      idOutcome.set(toolUseId, isError ? 'error' : 'success');
      evidence.push(`user#${idx}`);
    }
  }

  const triggered = [...idOutcome.values()].some((outcome) => outcome !== 'error');
  return { triggered, evidence: triggered ? evidence : [] };
}
