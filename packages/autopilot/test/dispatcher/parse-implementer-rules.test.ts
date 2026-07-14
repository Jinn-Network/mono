import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseImplementerRules } from '../../scripts/run-autopilot.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseImplementerRules', () => {
  it('unset → []', () => {
    expect(parseImplementerRules(undefined)).toEqual([]);
  });

  it('empty / blank string → []', () => {
    expect(parseImplementerRules('')).toEqual([]);
    expect(parseImplementerRules('   ')).toEqual([]);
  });

  it('malformed JSON → [] and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseImplementerRules('{not json')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('non-array JSON → [] and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseImplementerRules('{"implementer":"codex"}')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('valid array round-trips (only recognised keys kept)', () => {
    const raw = JSON.stringify([
      { effort: 'High', implementer: 'codex' },
      { shape: 'docs', implementer: 'cursor' },
      { effort: 'Low', shape: 'fix', implementer: 'claude' },
      { implementer: 'claude' },
    ]);
    expect(parseImplementerRules(raw)).toEqual([
      { effort: 'High', implementer: 'codex' },
      { shape: 'docs', implementer: 'cursor' },
      { effort: 'Low', shape: 'fix', implementer: 'claude' },
      { implementer: 'claude' },
    ]);
  });

  it('strips extra keys from an otherwise-valid entry', () => {
    const raw = JSON.stringify([
      { effort: 'High', implementer: 'codex', priority: 'P0', junk: 1 },
    ]);
    expect(parseImplementerRules(raw)).toEqual([{ effort: 'High', implementer: 'codex' }]);
  });

  it('drops an entry with an unknown implementer (keeps the rest) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([
      { effort: 'High', implementer: 'gpt' },
      { shape: 'docs', implementer: 'cursor' },
    ]);
    expect(parseImplementerRules(raw)).toEqual([{ shape: 'docs', implementer: 'cursor' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops an entry with an invalid effort and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([
      { effort: 'Massive', implementer: 'codex' },
      { implementer: 'claude' },
    ]);
    expect(parseImplementerRules(raw)).toEqual([{ implementer: 'claude' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops an entry with an invalid shape and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([
      { shape: 'epic', implementer: 'codex' },
      { implementer: 'claude' },
    ]);
    expect(parseImplementerRules(raw)).toEqual([{ implementer: 'claude' }]);
    expect(warn).toHaveBeenCalled();
  });

  it('drops an entry missing implementer and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([{ effort: 'High' }, { implementer: 'codex' }]);
    expect(parseImplementerRules(raw)).toEqual([{ implementer: 'codex' }]);
    expect(warn).toHaveBeenCalled();
  });
});
