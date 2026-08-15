import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneMigrationBackups } from '../../src/config.js';

describe('pruneMigrationBackups', () => {
  it('removes stage-1 atomic-write backups and leaves everything else alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-prune-'));
    writeFileSync(join(dir, 'config.json'), '{"configShapeVersion":2}\n');
    writeFileSync(join(dir, 'config.json.backup-20260730T142233Z'), '{}\n');
    writeFileSync(join(dir, 'config.json.backup-20260731T090000Z'), '{}\n');
    writeFileSync(join(dir, 'keystore-password'), 'secret\n');
    writeFileSync(join(dir, 'config.json.bak.20260730T142233'), '{}\n');

    const result = pruneMigrationBackups(dir);

    expect(result.removed.sort()).toEqual([
      'config.json.backup-20260730T142233Z',
      'config.json.backup-20260731T090000Z',
    ]);
    expect(readdirSync(dir).sort()).toEqual([
      'config.json',
      'config.json.bak.20260730T142233',
      'keystore-password',
    ]);
  });

  it('is a no-op on a directory with no backups', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-prune-empty-'));
    writeFileSync(join(dir, 'config.json'), '{"configShapeVersion":2}\n');
    expect(pruneMigrationBackups(dir).removed).toEqual([]);
    expect(readdirSync(dir)).toEqual(['config.json']);
  });
});
