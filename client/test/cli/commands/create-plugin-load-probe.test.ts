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
 * No new client/src substrate is introduced — the test asserts the real
 * loader path the `references/load-probe.mjs` script will drive at runtime.
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

describe('create-plugin load probe (solver-type-plugin)', () => {
  it('scaffolds and resolves via forSolverType for the target SolverType', async () => {
    const targetRoot = await runCreate({
      target: 'plugin',
      pattern: 'solver-type-plugin',
      packageName: '@jinn-test/probe-st',
      solverTypeString: 'demo.v1',
      outDir: OUT,
    });

    // Same entry shape the references/load-probe.mjs script uses: a bare
    // `file:` source, no `name` (so the loader takes the name from the
    // manifest, and the vendor dir name is a slash-free basename).
    const reg = await loadSolverPlugins(
      [{ source: 'file:' + targetRoot }],
      { vendorRoot: VENDOR },
    );

    // Positive: the scaffolded plug-in resolves for its declared SolverType.
    const matches = reg.forSolverType('demo.v1');
    expect(matches.map((p) => p.name)).toEqual(['@jinn-test/probe-st']);

    // Negative control: an unrelated SolverType resolves nothing.
    expect(reg.forSolverType('not-a-real.v9')).toEqual([]);
  });
});

describe('create-plugin load probe (runtime-plugin)', () => {
  it('scaffolds and resolves via forSolverType for jinn.runtime', async () => {
    const targetRoot = await runCreate({
      target: 'plugin',
      pattern: 'runtime-plugin',
      packageName: '@jinn-test/probe-rt',
      solverTypeString: 'jinn.runtime',
      outDir: OUT,
    });

    const reg = await loadSolverPlugins(
      [{ source: 'file:' + targetRoot }],
      { vendorRoot: VENDOR },
    );

    // Positive: a runtime plug-in resolves under the 'jinn.runtime' key.
    const matches = reg.forSolverType('jinn.runtime');
    expect(matches.map((p) => p.name)).toEqual(['@jinn-test/probe-rt']);

    // Negative control: a runtime plug-in does NOT resolve for a SolverType.
    expect(reg.forSolverType('demo.v1')).toEqual([]);
  });
});
