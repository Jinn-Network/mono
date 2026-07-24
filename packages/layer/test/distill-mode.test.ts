import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDistillDefaults,
  readDistillMode,
  writeDistillDefaults,
  writeDistillMode,
} from '../src/distill-mode.js';

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

describe('distill defaults store (distiller + distillerModel)', () => {
  it('reads empty defaults when the file is absent', () => {
    expect(readDistillDefaults(tmpModePath())).toEqual({});
  });

  it('reads empty defaults when the file is malformed JSON', () => {
    const path = tmpModePath();
    writeFileSync(path, '{ not valid');
    expect(readDistillDefaults(path)).toEqual({});
  });

  it('drops an unrecognised distiller provider (fail-safe → absent)', () => {
    const path = tmpModePath();
    writeFileSync(path, JSON.stringify({ distiller: 'gpt', distillerModel: 'x' }));
    expect(readDistillDefaults(path)).toEqual({ distillerModel: 'x' });
  });

  it('drops a non-string distillerModel (fail-safe → absent)', () => {
    const path = tmpModePath();
    writeFileSync(path, JSON.stringify({ distiller: 'claude', distillerModel: 42 }));
    expect(readDistillDefaults(path)).toEqual({ distiller: 'claude' });
  });

  it('round-trips distiller and distillerModel', () => {
    const path = tmpModePath();
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-5.5' }, path);
    expect(readDistillDefaults(path)).toEqual({ distiller: 'codex', distillerModel: 'gpt-5.5' });
  });

  it('merges defaults without clobbering an existing where mode', () => {
    const path = tmpModePath();
    writeDistillMode('local', path);
    writeDistillDefaults({ distiller: 'codex' }, path);
    expect(readDistillMode(path)).toBe('local');
    expect(readDistillDefaults(path)).toEqual({ distiller: 'codex' });
  });

  it('writeDistillMode preserves already-set distiller defaults', () => {
    const path = tmpModePath();
    writeDistillDefaults({ distiller: 'codex', distillerModel: 'gpt-5.5' }, path);
    writeDistillMode('off', path);
    expect(readDistillMode(path)).toBe('off');
    expect(readDistillDefaults(path)).toEqual({ distiller: 'codex', distillerModel: 'gpt-5.5' });
  });

  it('merges a partial patch without dropping the other default', () => {
    const path = tmpModePath();
    writeDistillDefaults({ distiller: 'claude', distillerModel: 'claude-opus-4-8' }, path);
    writeDistillDefaults({ distillerModel: 'claude-opus-4-9' }, path);
    expect(readDistillDefaults(path)).toEqual({ distiller: 'claude', distillerModel: 'claude-opus-4-9' });
  });
});
