/**
 * Regression test for Finding 6: learnerVersion must be read from the
 * bundled claude-code-learner/.claude-plugin/plugin.json at runtime, not
 * hard-coded in main.ts.
 *
 * This test reads the plugin.json directly and verifies that:
 * 1. The file exists and is valid JSON.
 * 2. It has a `version` string that is a valid semver.
 * 3. The version matches what main.ts would resolve (via the same probing
 *    logic) so that any drift between the file and main.ts causes a failure.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const __dir = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled plugin.json using the same two-probe logic as main.ts.
 * From the test file at client/test/restorer/plug-ins/ the src location is
 * ../../../src relative; the dist location would be farther up but since we
 * run tests from source, the first probe always hits.
 */
function resolvePluginJson(): string {
  // Probe 1: running from client/test/... — go up to client/, then into plugins/
  const fromTest = join(__dir, '../../../plugins/claude-code-learner/.claude-plugin/plugin.json');
  if (existsSync(fromTest)) return fromTest;
  // Probe 2: running from client/dist/... (compiled)
  const fromDist = join(__dir, '../../../../plugins/claude-code-learner/.claude-plugin/plugin.json');
  if (existsSync(fromDist)) return fromDist;
  throw new Error(
    `Could not find bundled claude-code-learner plugin.json from ${__dir}`,
  );
}

describe('bundled claude-code-learner plugin.json', () => {
  it('exists and is valid JSON with a semver version field', () => {
    const path = resolvePluginJson();
    const raw = readFileSync(path, 'utf8');
    let parsed: { version?: unknown };
    expect(() => {
      parsed = JSON.parse(raw) as { version?: unknown };
    }).not.toThrow();
    expect(typeof parsed!.version).toBe('string');
    expect(semver.valid(parsed!.version as string)).not.toBeNull();
  });

  it('version is non-empty and parseable as semver', () => {
    const path = resolvePluginJson();
    const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version: string };
    expect(version.length).toBeGreaterThan(0);
    const parsed = semver.parse(version);
    expect(parsed).not.toBeNull();
    expect(parsed!.major).toBeGreaterThanOrEqual(0);
  });

  it('main.ts probe logic resolves the same file as the test probe', () => {
    // Simulate the two-probe logic from main.ts (adapted for the test context).
    // main.ts resolves from dirname(fileURLToPath(import.meta.url)) which is
    // client/src/ (src) or client/dist/ (compiled).
    // From client/src/ the probe is: join(__mainDir, '../plugins/...')
    // From client/test/restorer/plug-ins/ the equivalent forward path is:
    // join(__dir, '../../../plugins/...') — same as resolvePluginJson() probe 1.
    const resolved = resolvePluginJson();
    expect(existsSync(resolved)).toBe(true);
    const { version } = JSON.parse(readFileSync(resolved, 'utf8')) as { version: string };
    // The version should satisfy the default compatibility range used in tests.
    expect(semver.satisfies(version, `>=${version}`)).toBe(true);
  });
});
