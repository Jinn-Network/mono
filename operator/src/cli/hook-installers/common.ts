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

/**
 * Cheap, format-agnostic presence check used by `jinn integrations
 * install/remove` to decide `alreadyConfigured` / `not configured` without
 * re-parsing each tool's hook JSON shape (mirrors the existing
 * `hasTomlMcpServer`-style substring checks in `cli/commands/integrations.ts`).
 */
export function fileContainsHookCommand(raw: string, command: string): boolean {
  return raw.includes(command);
}
