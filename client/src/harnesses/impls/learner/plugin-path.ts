import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the learner plugin root from the impl directory's
 * runtime location.
 *
 * Layout assumption: this file lives at
 *   <package>/<src-or-dist>/harnesses/impls/learner/plugin-path.{ts,js}
 * and the plugin lives at
 *   <package>/plugins/learner/
 *
 * Walks up four directories from this file (impls → harness → src/dist →
 * package root) then descends into plugins/learner/. Verifies the
 * expected layout exists and throws with a clear message if not.
 */
function requireAsset(pluginRoot: string, relative: string, hint?: string): void {
  if (!existsSync(join(pluginRoot, relative))) {
    const suffix = hint ? ` — ${hint}` : '';
    throw new Error(`learner plugin at ${pluginRoot} is missing ${relative}${suffix}`);
  }
}

export function resolvePluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..', '..', '..');
  const pluginRoot = join(packageRoot, 'plugins', 'learner');

  if (!existsSync(pluginRoot)) {
    throw new Error(
      `learner plugin not found at expected path: ${pluginRoot}. ` +
        `Resolved from impl dir: ${here}.`,
    );
  }
  requireAsset(pluginRoot, 'skills/learn/SKILL.md');
  requireAsset(pluginRoot, 'hooks/session-start', 'plugin assets may be stale or incomplete; rebuild the plugin');
  requireAsset(pluginRoot, 'hooks/hooks.json', 'plugin assets may be stale or incomplete; rebuild the plugin');
  return pluginRoot;
}
