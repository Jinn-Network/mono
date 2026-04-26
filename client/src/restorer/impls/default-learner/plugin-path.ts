import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the default-learner plugin root from the impl directory's
 * runtime location.
 *
 * Layout assumption: this file lives at
 *   <package>/<src-or-dist>/restorer/impls/default-learner/plugin-path.{ts,js}
 * and the plugin lives at
 *   <package>/plugins/default-learner/
 *
 * Walks up four directories from this file (impls → restorer → src/dist →
 * package root) then descends into plugins/default-learner/. Verifies the
 * expected layout exists and throws with a clear message if not.
 */
export function resolvePluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..', '..', '..', '..');
  const pluginRoot = join(packageRoot, 'plugins', 'default-learner');

  if (!existsSync(pluginRoot)) {
    throw new Error(
      `default-learner plugin not found at expected path: ${pluginRoot}. ` +
        `Resolved from impl dir: ${here}.`,
    );
  }
  if (!existsSync(join(pluginRoot, 'skills', 'coordinator', 'SKILL.md'))) {
    throw new Error(
      `default-learner plugin at ${pluginRoot} is missing skills/coordinator/SKILL.md`,
    );
  }
  return pluginRoot;
}
