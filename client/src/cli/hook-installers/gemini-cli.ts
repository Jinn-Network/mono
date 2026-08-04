import {
  appendUniqueString,
  removeString,
  DEFAULT_STOP_HOOK_COMMAND,
  parseJsonObject,
  stableJson,
} from './common.js';

export function patchGeminiCliSettingsJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['SessionEnd'] = appendUniqueString(hooks['SessionEnd'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}

export function removeGeminiCliHookJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool gemini-cli`,
): string {
  const obj = parseJsonObject(raw);
  const hooks = typeof obj['hooks'] === 'object' && obj['hooks'] !== null && !Array.isArray(obj['hooks'])
    ? obj['hooks'] as Record<string, unknown>
    : {};
  hooks['SessionEnd'] = removeString(hooks['SessionEnd'], command);
  obj['hooks'] = hooks;
  return stableJson(obj);
}
