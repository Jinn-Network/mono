import {
  appendUniqueCommandObject,
  removeCommandObject,
  DEFAULT_STOP_HOOK_COMMAND,
  parseJsonObject,
  stableJson,
} from './common.js';

export function patchClaudeCodeSettingsJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['Stop'] = appendUniqueCommandObject(hooks['Stop'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}

export function removeClaudeCodeHookJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool claude-code`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['Stop'] = removeCommandObject(hooks['Stop'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}
