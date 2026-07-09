import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDistilMode, writeDistilMode } from '../src/distil-mode.js';

function tmpModePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-distil-mode-')), 'distil.json');
}

describe('distil mode store', () => {
  it('reads unset when the mode file is absent', () => {
    expect(readDistilMode(tmpModePath())).toBe('unset');
  });

  it('reads unset when the mode file is malformed JSON', () => {
    const path = tmpModePath();
    writeFileSync(path, '{ not valid');
    expect(readDistilMode(path)).toBe('unset');
  });

  it('reads unset when the where value is not one of the three modes', () => {
    const path = tmpModePath();
    writeFileSync(path, JSON.stringify({ where: 'sideways' }));
    expect(readDistilMode(path)).toBe('unset');
  });

  it.each(['local', 'defer', 'off'] as const)('round-trips the %s mode', (mode) => {
    const path = tmpModePath();
    writeDistilMode(mode, path);
    expect(readDistilMode(path)).toBe(mode);
    // Persisted as the design's { where } shape.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ where: mode });
  });

  it('creates the parent directory when persisting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-distil-mode-nested-'));
    const path = join(dir, 'a', 'b', 'distil.json');
    writeDistilMode('local', path);
    expect(readDistilMode(path)).toBe('local');
  });
});
