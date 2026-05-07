import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readModeState, writeModeState } from '../../src/harnesses/mode-state.js';

let TMP: string;
let PATH_: string;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'mode-state-'));
  PATH_ = join(TMP, 'sub', 'mode-state.json');
});

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
});

describe('mode-state persistence', () => {
  it('returns null when the file does not exist', () => {
    expect(readModeState(PATH_)).toBeNull();
  });

  it('round-trips a write→read', () => {
    writeModeState({ mode: 'frozen', switchedAt: 1_746_547_200_000 }, PATH_);
    expect(existsSync(PATH_)).toBe(true);
    expect(readModeState(PATH_)).toEqual({ mode: 'frozen', switchedAt: 1_746_547_200_000 });
  });

  it('returns null on schema mismatch (not "train" / "frozen")', () => {
    writeFileSync(PATH_.replace('/sub/', '/'), JSON.stringify({ mode: 'gibberish', switchedAt: 1 }));
    const broken = PATH_.replace('/sub/', '/');
    expect(readModeState(broken)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    const broken = join(TMP, 'broken.json');
    writeFileSync(broken, '{not json');
    expect(readModeState(broken)).toBeNull();
  });
});
