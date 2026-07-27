import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the learner plugin root from the impl directory's runtime location.
 *
 * Canonical layout (compiled): this file lives at
 *   <package>/dist/harnesses/impls/learner/plugin-path.js
 * and the plugin tree is co-located inside dist/:
 *   <package>/dist/plugins/learner/
 *
 * The build step copies plugins/learner → dist/plugins/learner so the
 * compiled code and the plugin runtime assets are always version-locked
 * within the same dist/ tree — for published npm installs and source
 * checkouts alike (after `yarn build`).
 *
 * Source-checkout / tsx path (e.g. vitest): this file lives at
 *   <package>/src/harnesses/impls/learner/plugin-path.ts
 * Walking up four directories reaches the package root, and the plugin
 * lives at <package>/plugins/learner/.
 *
 * Detection: if the resolved path three levels up ends with `/dist` the
 * runtime is inside a compiled dist tree; otherwise fall back to the
 * package-root layout (four levels up).
 */
function requireAsset(pluginRoot: string, relative: string, hint?: string): void {
  if (!existsSync(join(pluginRoot, relative))) {
    const suffix = hint ? ` — ${hint}` : '';
    throw new Error(`learner plugin at ${pluginRoot} is missing ${relative}${suffix}`);
  }
}

export function resolvePluginRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const threeUp = resolve(here, '..', '..', '..');

  // Compiled dist layout: dist/harnesses/impls/learner → dist/ → dist/plugins/learner
  const isDistTree = threeUp.endsWith('/dist');
  const pluginRoot = isDistTree
    ? join(threeUp, 'plugins', 'learner')
    : join(resolve(here, '..', '..', '..', '..'), 'plugins', 'learner');

  if (!existsSync(pluginRoot)) {
    throw new Error(
      `learner plugin not found at expected path: ${pluginRoot}. ` +
        `Resolved from impl dir: ${here}. ` +
        `Run \`yarn build\` to copy plugins/learner into dist/plugins/learner.`,
    );
  }
  requireAsset(pluginRoot, 'skills/learn/SKILL.md');
  requireAsset(pluginRoot, 'hooks/session-start', 'plugin assets may be stale or incomplete; rebuild the plugin');
  requireAsset(pluginRoot, 'hooks/hooks.json', 'plugin assets may be stale or incomplete; rebuild the plugin');
  requireAsset(pluginRoot, 'hooks/post-tool-use', 'plugin assets may be stale or incomplete; rebuild the plugin');
  requireAsset(pluginRoot, '.claude-plugin/plugin.json', 'plugin manifest missing; learner attribution would be silently dropped — rebuild the plugin');
  return pluginRoot;
}
