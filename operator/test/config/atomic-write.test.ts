import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupConfigFile, writeConfigFileAtomic } from '../../src/config/atomic-write.js';

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, `${JSON.stringify({ rpcUrl: 'http://x' }, null, 2)}\n`, { mode: 0o600 });
  return path;
}

describe('atomic config write', () => {
  it('writes the value and leaves no temp file behind', () => {
    const path = fixture();
    writeConfigFileAtomic(path, { rpcUrl: 'http://y', configShapeVersion: 2 });
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({
      rpcUrl: 'http://y',
      configShapeVersion: 2,
    });
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('preserves the existing file mode', () => {
    const path = fixture();
    writeConfigFileAtomic(path, { rpcUrl: 'http://y' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('never leaves a truncated file when serialization throws mid-write', () => {
    const path = fixture();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => writeConfigFileAtomic(path, cyclic)).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ rpcUrl: 'http://x' });
    const leftovers = readdirSync(join(path, '..')).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('backs up with a timestamped name and the source mode', () => {
    const path = fixture();
    const backup = backupConfigFile(path, () => new Date('2026-07-30T09:15:00.000Z'));
    expect(backup).toBe(`${path}.backup-20260730T091500Z`);
    expect(statSync(backup!).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(backup!, 'utf-8'))).toEqual({ rpcUrl: 'http://x' });
  });

  it('returns undefined when there is nothing to back up', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-config-'));
    expect(backupConfigFile(join(dir, 'absent.json'))).toBeUndefined();
  });
});
