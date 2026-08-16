import {
  appendUniqueString,
  removeString,
  DEFAULT_STOP_HOOK_COMMAND,
  parseJsonObject,
  stableJson,
} from './common.js';

export function patchCodexConfigJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['stop'] = appendUniqueString(hooks['stop'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}

export function removeCodexHookJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool codex`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['stop'] = removeString(hooks['stop'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}
