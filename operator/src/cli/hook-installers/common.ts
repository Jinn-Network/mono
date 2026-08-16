export const DEFAULT_STOP_HOOK_COMMAND = 'jinn-stop-hook';

export function parseJsonObject(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('settings file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function stableJson(obj: unknown): string {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

export function appendUniqueString(list: unknown, value: string): string[] {
  const arr = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  return arr.includes(value) ? arr : [...arr, value];
}

export function removeString(list: unknown, value: string): string[] {
  const arr = Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : [];
  return arr.filter((v) => v !== value);
}

export function appendUniqueCommandObject(list: unknown, command: string): Array<Record<string, unknown>> {
  const arr = Array.isArray(list)
    ? list.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
    : [];
  return arr.some((entry) => entry['command'] === command) ? arr : [...arr, { command }];
}

export function removeCommandObject(list: unknown, command: string): Array<Record<string, unknown>> {
  const arr = Array.isArray(list)
    ? list.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
    : [];
  return arr.filter((entry) => entry['command'] !== command);
}

/**
 * Cheap, format-agnostic presence check used by `jinn integrations
 * install/remove` to decide `alreadyConfigured` / `not configured` without
 * re-parsing each tool's hook JSON shape (mirrors the existing
 * `hasTomlMcpServer`-style substring checks in `cli/commands/integrations.ts`).
 */
export function fileContainsHookCommand(raw: string, command: string): boolean {
  return raw.includes(command);
}
