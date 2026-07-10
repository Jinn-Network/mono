import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDistillMode, writeDistillMode } from '../src/distill-mode.js';

function tmpModePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-distill-mode-')), 'distill.json');
}

describe('distill mode store', () => {
  it('reads unset when the mode file is absent', () => {
    expect(readDistillMode(tmpModePath())).toBe('unset');
  });

  it('reads unset when the mode file is malformed JSON', () => {
    const path = tmpModePath();
    writeFileSync(path, '{ not valid');
    expect(readDistillMode(path)).toBe('unset');
  });

  it('reads unset when the where value is not one of the three modes', () => {
    const path = tmpModePath();
    writeFileSync(path, JSON.stringify({ where: 'sideways' }));
    expect(readDistillMode(path)).toBe('unset');
  });

  it.each(['local', 'defer', 'off'] as const)('round-trips the %s mode', (mode) => {
    const path = tmpModePath();
    writeDistillMode(mode, path);
    expect(readDistillMode(path)).toBe(mode);
    // Persisted as the design's { where } shape.
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ where: mode });
  });

  it('creates the parent directory when persisting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-distill-mode-nested-'));
    const path = join(dir, 'a', 'b', 'distill.json');
    writeDistillMode('local', path);
    expect(readDistillMode(path)).toBe('local');
  });

  // Rename migration (#1532): a mode recorded under the old single-l file name
  // is still honoured when the new file is absent — canary users keep their
  // recorded consent across the rename.
  it('falls back to the legacy distil.json when the new path is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-distill-mode-legacy-'));
    const path = join(dir, 'distill.json');
    const legacy = join(dir, 'distil.json');
    writeFileSync(legacy, JSON.stringify({ where: 'defer' }));
    expect(readDistillMode(path, legacy)).toBe('defer');
  });

  it('prefers the new path over the legacy file when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jinn-distill-mode-both-'));
    const path = join(dir, 'distill.json');
    const legacy = join(dir, 'distil.json');
    writeDistillMode('local', path);
    writeFileSync(legacy, JSON.stringify({ where: 'off' }));
    expect(readDistillMode(path, legacy)).toBe('local');
  });
});
