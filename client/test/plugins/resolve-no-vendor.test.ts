/**
 * Regression test for issue #1052 (AC2): `resolveSolverPlugin(..., { noVendor })`
 * must NOT write to the vendor root (default `~/.jinn-client/solver-plugins/`).
 *
 * `jinn solver-plugins validate` / `show` are read-only inspection verbs — they
 * should never silently materialise a copy of the plug-in into the operator's
 * global dir. The `noVendor` flag makes the resolver use the source path
 * directly as `root`. Without it, the default vendoring path is unchanged.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSolverPlugin } from '../../src/plugins/resolvers.js';
import {
  createSolverPluginsCommand,
} from '../../src/cli/commands/solver-plugins.js';
import {
  withTempPlugin,
  withTempConfig,
  makeCtx,
  parsedLine,
} from '../cli/commands/solver-plugins-test-helpers.js';

describe('resolveSolverPlugin noVendor', () => {
  it('Test A: resolves a local plugin in place and writes nothing to vendorRoot', async () => {
    const localDir = withTempPlugin();
    const vendorRoot = mkdtempSync(join(tmpdir(), 'no-vendor-'));
    try {
      const plugin = await resolveSolverPlugin(localDir, { vendorRoot, noVendor: true });

      // (a) resolves fully
      expect(plugin.name).toBeTruthy();
      expect(plugin.sha256).toBeTruthy();
      expect(plugin.manifestPath).toBeTruthy();

      // (b) root is the source dir, NOT under vendorRoot
      expect(plugin.root).toBe(localDir);
      expect(plugin.root.startsWith(vendorRoot)).toBe(false);

      // (c) nothing written to vendorRoot
      expect(readdirSync(vendorRoot)).toEqual([]);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });

  it('Test B: without noVendor, still materialises into vendorRoot (default path unbroken)', async () => {
    const localDir = withTempPlugin();
    const vendorRoot = mkdtempSync(join(tmpdir(), 'yes-vendor-'));
    try {
      const plugin = await resolveSolverPlugin(localDir, { vendorRoot });

      expect(plugin.root.startsWith(vendorRoot)).toBe(true);
      expect(readdirSync(vendorRoot).length).toBeGreaterThan(0);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });

  it('Test C: `validate <local-dir>` succeeds via the CLI', async () => {
    const localDir = withTempPlugin();
    const configPath = withTempConfig();
    const command = createSolverPluginsCommand({});
    const { ctx, writes, exits } = makeCtx(
      ['validate', localDir, '--config', configPath],
      {},
    );
    await command.run(ctx);
    const out = parsedLine(writes);
    expect(out.ok).toBe(true);
    expect(exits).toEqual([]);
  });
});
