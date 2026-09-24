import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, pruneMigrationBackups } from '../../src/config.js';

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

describe('loadConfig prune notice', () => {
  it('writes the prune notice to stderr, never to stdout', () => {
    // stdout carries the --json payload (src/errors/envelope.ts: "stderr is
    // reserved for logs"). Every --json verb loads config before it emits, so
    // one console.log here breaks `jinn <verb> --json | jq` on the single run
    // that performs the prune.
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-prune-notice-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ network: 'testnet', configShapeVersion: 2 }));
    writeFileSync(join(dir, 'config.json.backup-20260730T142233Z'), '{}\n');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      loadConfig(configPath);
      expect(log).not.toHaveBeenCalled();
      expect(error.mock.calls.map((call) => String(call[0]))).toContain(
        '[config] Pruned 1 pre-v2 migration backup.',
      );
    } finally {
      log.mockRestore();
      error.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
