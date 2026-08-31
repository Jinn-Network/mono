import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gcOrphanedBundledLocalVendorCopies,
  remoteVendorNamesFromEntries,
} from '../../src/plugins/vendor-gc.js';
import { safeVendorName } from '../../src/plugins/resolvers.js';
import { loadSolverNets } from '../../src/solver-nets/registry.js';
import * as vendorGc from '../../src/plugins/vendor-gc.js';

describe('solver plugin vendor GC', () => {
  it('removes orphaned bundled/local copies but keeps remote materializations', () => {
    const vendorRoot = mkdtempSync(join(tmpdir(), 'solver-plugin-gc-'));
    const remoteSource = 'npm:@scope/pkg';
    const remoteName = safeVendorName(remoteSource);
    try {
      mkdirSync(join(vendorRoot, 'network-tools'), { recursive: true });
      writeFileSync(join(vendorRoot, 'network-tools.source.sha256'), 'deadbeef\n');
      mkdirSync(join(vendorRoot, 'network-tools.lock'));
      mkdirSync(join(vendorRoot, remoteName), { recursive: true });
      writeFileSync(join(vendorRoot, `${remoteName}.source.sha256`), 'remote\n');

      gcOrphanedBundledLocalVendorCopies(
        vendorRoot,
        remoteVendorNamesFromEntries([remoteSource]),
      );

      expect(existsSync(join(vendorRoot, 'network-tools'))).toBe(false);
      expect(existsSync(join(vendorRoot, 'network-tools.source.sha256'))).toBe(false);
      expect(existsSync(join(vendorRoot, 'network-tools.lock'))).toBe(false);
      expect(existsSync(join(vendorRoot, remoteName))).toBe(true);
      expect(existsSync(join(vendorRoot, `${remoteName}.source.sha256`))).toBe(true);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });

  // AC5 (#1242): "Garbage collection does not delete remote materializations."
  // The criterion is unconditional — a remote tree the current executionWiring
  // cannot see (evaluator-only net, empty wiring, net temporarily unjoined,
  // plugin vendored ahead of joining) must still survive. Remote copies are
  // operator-placed by hand and unrecoverable from inside this tree.
  it('keeps remote materializations that are absent from the protected set', () => {
    const vendorRoot = mkdtempSync(join(tmpdir(), 'solver-plugin-gc-unconfigured-'));
    const unconfigured = [
      safeVendorName('npm:@scope/unconfigured'),
      safeVendorName('git:https://example.invalid/repo.git'),
      safeVendorName('github:owner/repo'),
      safeVendorName('claude:some-skill'),
    ];
    try {
      for (const name of unconfigured) {
        mkdirSync(join(vendorRoot, name), { recursive: true });
        writeFileSync(join(vendorRoot, `${name}.source.sha256`), 'remote\n');
      }
      mkdirSync(join(vendorRoot, 'network-tools'), { recursive: true });

      // Empty protected set — exactly the `executionWiring: []` boot shape.
      gcOrphanedBundledLocalVendorCopies(vendorRoot, new Set());

      for (const name of unconfigured) {
        expect(existsSync(join(vendorRoot, name))).toBe(true);
        expect(existsSync(join(vendorRoot, `${name}.source.sha256`))).toBe(true);
      }
      expect(existsSync(join(vendorRoot, 'network-tools'))).toBe(false);
    } finally {
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });

  it('never throws when vendorRoot is absent', () => {
    const vendorRoot = join(tmpdir(), `solver-plugin-gc-missing-${Date.now()}`);
    expect(() => {
      gcOrphanedBundledLocalVendorCopies(vendorRoot, new Set());
    }).not.toThrow();
  });

  it('loadSolverNets skips vendor GC unless the boot path opts in', async () => {
    // The GC body is stubbed and the root is a temp directory: this case must
    // never resolve or touch defaultSolverPluginVendorRoot(), which on a real
    // operator host is the live ~/.jinn-operator/solver-plugins tree.
    const gcSpy = vi
      .spyOn(vendorGc, 'gcOrphanedBundledLocalVendorCopies')
      .mockImplementation(() => {});
    const vendorRoot = mkdtempSync(join(tmpdir(), 'solver-plugin-gc-boot-'));

    try {
      await loadSolverNets({ executionWiring: [] }, { vendorRoot });
      expect(gcSpy).not.toHaveBeenCalled();

      await loadSolverNets(
        { executionWiring: [] },
        { gcOrphanedVendorCopies: true, vendorRoot },
      );
      expect(gcSpy).toHaveBeenCalledOnce();
      // Pins the target: a refactor that re-points the GC at $HOME fails here.
      expect(gcSpy.mock.calls[0]?.[0]).toBe(vendorRoot);
    } finally {
      gcSpy.mockRestore();
      rmSync(vendorRoot, { recursive: true, force: true });
    }
  });
});
