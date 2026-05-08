import {
  appendUniqueCommandObject,
  DEFAULT_STOP_HOOK_COMMAND,
  parseJsonObject,
  stableJson,
} from './common.js';

export function patchCursorHooksJson(
  raw: string,
  command = `${DEFAULT_STOP_HOOK_COMMAND} --tool cursor`,
): string {
  const obj = parseJsonObject(raw);
  obj['sessionEnd'] = appendUniqueCommandObject(obj['sessionEnd'], command);
  return stableJson(obj);
}
