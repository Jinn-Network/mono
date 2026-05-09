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

export function appendUniqueCommandObject(list: unknown, command: string): Array<Record<string, unknown>> {
  const arr = Array.isArray(list)
    ? list.filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v))
    : [];
  return arr.some((entry) => entry['command'] === command) ? arr : [...arr, { command }];
}
