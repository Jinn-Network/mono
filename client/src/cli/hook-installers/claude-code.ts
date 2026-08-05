import { DEFAULT_STOP_HOOK_COMMAND, parseJsonObject, stableJson } from './common.js';

/**
 * Claude Code's real hook schema (confirmed against
 * `apps/jinn-agent/skills/autonomous-ai-agents/claude-code/SKILL.md` — this
 * repo's own documented example — and the operator's live
 * `~/.claude/settings.json`):
 *
 *   { "hooks": { "Stop": [ { "matcher"?: string, "hooks": [ { "type": "command", "command": string } ] } ] } }
 *
 * `Stop` is an array of **hook groups**, each with an optional `matcher`
 * and a `hooks` array of command entries — NOT a flat array of
 * `{command}` objects. A flat `{command}` entry is silently ignored by
 * Claude Code (never fires), which was this file's bug before the fix.
 */

function stopGroups(hooksSection: Record<string, unknown>): unknown[] {
  return Array.isArray(hooksSection['Stop']) ? (hooksSection['Stop'] as unknown[]) : [];
}

function groupContainsCommand(group: unknown, command: string): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as Record<string, unknown>)['hooks'];
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) => typeof h === 'object' && h !== null && (h as Record<string, unknown>)['command'] === command,
  );
}

export function patchClaudeCodeSettingsJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`,
): string {
  const obj = parseJsonObject(raw);
  const hooksSection = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  const groups = stopGroups(hooksSection);
  if (!groups.some((g) => groupContainsCommand(g, command))) {
    groups.push({ hooks: [{ type: 'command', command }] });
  }
  hooksSection['Stop'] = groups;
  obj['hooks'] = hooksSection;
  return stableJson(obj);
}

export function removeClaudeCodeHookJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`,
): string {
  const obj = parseJsonObject(raw);
  const hooksSection = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  const groups = stopGroups(hooksSection)
    .map((group) => {
      if (typeof group !== 'object' || group === null) return group;
      const rec = group as Record<string, unknown>;
      const hooks = Array.isArray(rec['hooks']) ? rec['hooks'] as unknown[] : [];
      const filteredHooks = hooks.filter(
        (h) => !(typeof h === 'object' && h !== null && (h as Record<string, unknown>)['command'] === command),
      );
      return { ...rec, hooks: filteredHooks };
    })
    // Drop groups our removal emptied out — but leave alone any group that
    // was never ours (e.g. one with no `hooks` array at all) untouched.
    .filter((group) => {
      if (typeof group !== 'object' || group === null) return true;
      const hooks = (group as Record<string, unknown>)['hooks'];
      return !Array.isArray(hooks) || hooks.length > 0;
    });
  hooksSection['Stop'] = groups;
  obj['hooks'] = hooksSection;
  return stableJson(obj);
}
