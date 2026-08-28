/**
 * Regression: bundled/local SolverPlugins resolve in place (#1242) and never
 * write to the vendor root. The legacy `noVendor` flag is a no-op retained for
 * CLI callers on read-only inspection verbs.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
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

describe('resolveSolverPlugin in-place resolution (#1242)', () => {
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

  it('Test B: resolves bundled plugins in place without writing to vendorRoot', async () => {
    const vendorRoot = mkdtempSync(join(tmpdir(), 'yes-vendor-'));
    try {
      const plugin = await resolveSolverPlugin('bundled:network-tools', { vendorRoot });

      expect(plugin.root).not.toMatch(new RegExp(`^${vendorRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(existsSync(join(plugin.root, 'jinn.plugin.json'))).toBe(true);
      expect(readdirSync(vendorRoot)).toEqual([]);
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
