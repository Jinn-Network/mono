/**
 * Pins the learner plugin manifest version to 0.2.0 (the Lever-A graded-gate build).
 *
 * Run attribution: `executor.plugins[].version` flows from the manifest's
 * `"version"` field via `resolveSolverPlugin` → `manifest.version`. Bumping
 * the manifest is therefore the mechanism that makes Lever-A runs
 * distinguishable from baseline (0.1.0) runs in the queryable `pluginsJson`
 * column on `attemptEnvelopeMeta`.
 *
 * Assertion level (c): both host manifests are read directly and asserted
 * to carry the expected version. A higher-fidelity assertion (loading via
 * `loadSolverPluginManifest`) is not available here because the learner's
 * host manifests (.claude-plugin/plugin.json, .codex-plugin/plugin.json)
 * omit the `jinn.supports` field that `validateSolverPluginManifest`
 * requires — they are host-specific UI manifests, not Jinn plugin manifests.
 *
 * The cross-manifest check (both files must agree) prevents one manifest
 * from being bumped without the other, which would silently split
 * attribution across runner backends.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const EXPECTED_VERSION = '0.2.0';

/**
 * The learner plugin root — four directories up from this test file
 * (learner → impls → harnesses → test → client package root), then into plugins/learner.
 */
const learnerPluginRoot = join(
  fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, ''),
  'plugins',
  'learner',
);

function readManifestVersion(relPath: string): string {
  const manifest = JSON.parse(readFileSync(join(learnerPluginRoot, relPath), 'utf-8')) as {
    version?: unknown;
  };
  if (typeof manifest.version !== 'string') {
    throw new Error(`"version" field missing or not a string in ${relPath}`);
  }
  return manifest.version;
}

describe('claude-code-learner manifest version (Lever-A build attribution)', () => {
  it('.claude-plugin/plugin.json reports version 0.2.0', () => {
    expect(readManifestVersion('.claude-plugin/plugin.json')).toBe(EXPECTED_VERSION);
  });

  it('.codex-plugin/plugin.json reports version 0.2.0', () => {
    expect(readManifestVersion('.codex-plugin/plugin.json')).toBe(EXPECTED_VERSION);
  });

  it('both host manifests agree on the same version (no silent drift)', () => {
    const claude = readManifestVersion('.claude-plugin/plugin.json');
    const codex = readManifestVersion('.codex-plugin/plugin.json');
    expect(claude).toBe(codex);
  });
});
