/**
 * AC#4 gate for the `create-plugin` skill (issue #1048).
 *
 * The skill's "did it actually load" check resolves a freshly-scaffolded
 * plug-in through the real daemon loader: `loadSolverPlugins` →
 * `forSolverType`. This test exercises that exact mechanism end-to-end —
 * scaffold via `runCreate`, then load the on-disk package and assert the
 * registry resolves it for its target SolverType (and only that type).
 *
 * Hermetic: both the scaffold outDir AND the loader's vendorRoot are temp
 * dirs, so the loader's materialization never writes to ~/.jinn-client/.
 *
 * No new operator/src substrate is introduced — the test asserts the real
 * loader path directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCreate } from '../../../src/cli/commands/create.js';
import { loadSolverPlugins } from '../../../src/plugins/registry.js';

let OUT: string;
let VENDOR: string;

beforeEach(() => {
  OUT = mkdtempSync(join(tmpdir(), 'jinn-create-plugin-out-'));
  VENDOR = mkdtempSync(join(tmpdir(), 'jinn-create-plugin-vendor-'));
});

afterEach(() => {
  if (OUT) rmSync(OUT, { recursive: true, force: true });
  if (VENDOR) rmSync(VENDOR, { recursive: true, force: true });
});

// Both patterns drive the identical mechanism — scaffold, load via a bare
// `file:` source (the same entry shape references/load-probe.mjs uses, so the
// loader takes the name from the manifest), then assert the registry resolves
// the plug-in for its target key and nothing else. Only the pattern and the
// target/non-target keys differ.
const cases = [
  {
    pattern: 'solver-type-plugin' as const,
    packageName: '@jinn-test/probe-st',
    target: 'demo.v1', // the declared SolverType
    nonTarget: 'not-a-real.v9',
  },
  {
    pattern: 'runtime-plugin' as const,
    packageName: '@jinn-test/probe-rt',
    target: 'jinn.runtime', // runtime plug-ins resolve under this key only
    nonTarget: 'demo.v1',
  },
];

describe('create-plugin load probe', () => {
  for (const { pattern, packageName, target, nonTarget } of cases) {
    it(`scaffolds and resolves via forSolverType for ${pattern}`, async () => {
      const targetRoot = await runCreate({
        target: 'plugin',
        pattern,
        packageName,
        solverTypeString: target,
        outDir: OUT,
      });

      const reg = await loadSolverPlugins(
        [{ source: 'file:' + targetRoot }],
        { vendorRoot: VENDOR },
      );

      // Positive: the scaffolded plug-in resolves for its target key.
      expect(reg.forSolverType(target).map((p) => p.name)).toEqual([
        packageName,
      ]);

      // Negative control: an unrelated key resolves nothing.
      expect(reg.forSolverType(nonTarget)).toEqual([]);
    });
  }
});
