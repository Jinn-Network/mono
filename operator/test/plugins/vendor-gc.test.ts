import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  gcOrphanedBundledLocalVendorCopies,
  remoteVendorNamesFromEntries,
} from '../../src/plugins/vendor-gc.js';
import { safeVendorName } from '../../src/plugins/resolvers.js';

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

  it('never throws when vendorRoot is absent', () => {
    const vendorRoot = join(tmpdir(), `solver-plugin-gc-missing-${Date.now()}`);
    expect(() => {
      gcOrphanedBundledLocalVendorCopies(vendorRoot, new Set());
    }).not.toThrow();
  });
});
