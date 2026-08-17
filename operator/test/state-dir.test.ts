import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  STATE_DIR_FALLBACK_LOG,
  resolveDefaultStateDir,
} from '../src/state-dir.js';

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDefaultStateDir', () => {
  it('honors JINN_STATE_DIR over both homedir layouts', () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-state-dir-'));
    mkdirSync(join(dir, '.jinn-operator'), { recursive: true });
    writeFileSync(join(dir, '.jinn-operator', 'config.json'), '{}\n');
    mkdirSync(join(dir, '.jinn-client'), { recursive: true });
    writeFileSync(join(dir, '.jinn-client', 'config.json'), '{}\n');
    expect(
      resolveDefaultStateDir({
        home: dir,
        env: { JINN_STATE_DIR: '/data' },
        log: () => {
          throw new Error('must not log when JINN_STATE_DIR is set');
        },
      }),
    ).toBe('/data');
  });

  it('uses ~/.jinn-operator for a fresh home', () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-state-dir-'));
    expect(resolveDefaultStateDir({ home: dir, env: {}, log: () => undefined })).toBe(
      join(dir, '.jinn-operator'),
    );
  });

  it('uses env.HOME when home is omitted (MCP/stop-hook env bags)', () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-state-dir-'));
    expect(
      resolveDefaultStateDir({
        env: { HOME: dir },
        log: () => undefined,
      }),
    ).toBe(join(dir, '.jinn-operator'));
  });

  it('reads ~/.jinn-client when ~/.jinn-operator is empty and logs the copy-forward', () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-state-dir-'));
    mkdirSync(join(dir, '.jinn-operator'), { recursive: true });
    mkdirSync(join(dir, '.jinn-client'), { recursive: true });
    writeFileSync(join(dir, '.jinn-client', 'config.json'), '{}\n');
    const logs: string[] = [];
    expect(
      resolveDefaultStateDir({
        home: dir,
        env: {},
        log: (message) => {
          logs.push(message);
        },
      }),
    ).toBe(join(dir, '.jinn-client'));
    expect(logs).toEqual([STATE_DIR_FALLBACK_LOG]);
  });

  it('prefers a populated ~/.jinn-operator over a populated ~/.jinn-client', () => {
    dir = mkdtempSync(join(tmpdir(), 'jinn-state-dir-'));
    mkdirSync(join(dir, '.jinn-operator'), { recursive: true });
    writeFileSync(join(dir, '.jinn-operator', 'config.json'), '{}\n');
    mkdirSync(join(dir, '.jinn-client'), { recursive: true });
    writeFileSync(join(dir, '.jinn-client', 'config.json'), '{}\n');
    expect(
      resolveDefaultStateDir({
        home: dir,
        env: {},
        log: () => {
          throw new Error('must not fall back when the new dir is populated');
        },
      }),
    ).toBe(join(dir, '.jinn-operator'));
  });
});
