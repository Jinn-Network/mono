/**
 * Default operator state directory (F1 identity).
 *
 * Fresh installs use `~/.jinn-operator`. Existing installs that still have a
 * populated `~/.jinn-client` and an empty `~/.jinn-operator` keep reading the
 * legacy directory; one log line names the future copy-forward. `JINN_STATE_DIR`
 * always wins. `JINN_EARNING_DIR` remains a per-key override at its call sites.
 * When `env` is passed without `home`, `HOME` / `USERPROFILE` on that bag win
 * over `homedir()`, so MCP and stop-hook callers that inject HOME resolve the
 * same tree the daemon would.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const LEGACY_STATE_DIR_NAME = '.jinn-client';
export const STATE_DIR_NAME = '.jinn-operator';

export const STATE_DIR_FALLBACK_LOG =
  'using ~/.jinn-client; a future run will copy this state to ~/.jinn-operator';

export function dirIsNonEmpty(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    if (!statSync(path).isDirectory()) return false;
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

let cachedHome: string | undefined;
let cachedValue: string | undefined;
let didLogFallback = false;

export function resolveDefaultStateDir(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): string {
  const env = options?.env ?? process.env;
  const home = options?.home ?? env['HOME'] ?? env['USERPROFILE'] ?? homedir();
  const override = env['JINN_STATE_DIR'];
  if (typeof override === 'string' && override.trim() !== '') return override;

  const useCache = options?.log === undefined;
  if (useCache && cachedHome === home && cachedValue !== undefined) {
    return cachedValue;
  }

  const next = join(home, STATE_DIR_NAME);
  const legacy = join(home, LEGACY_STATE_DIR_NAME);
  let value = next;
  if (dirIsNonEmpty(next)) {
    value = next;
  } else if (dirIsNonEmpty(legacy)) {
    const log = options?.log ?? ((message: string) => {
      console.warn(message);
    });
    if (!useCache || !didLogFallback) {
      log(STATE_DIR_FALLBACK_LOG);
      if (useCache) didLogFallback = true;
    }
    value = legacy;
  }

  if (useCache) {
    cachedHome = home;
    cachedValue = value;
  }
  return value;
}

export function joinDefaultStateDir(...segments: string[]): string {
  return join(resolveDefaultStateDir(), ...segments);
}

export function defaultConfigPath(options?: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  log?: (message: string) => void;
}): string {
  return join(resolveDefaultStateDir(options), 'config.json');
}
