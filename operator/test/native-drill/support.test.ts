import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ExternalJournal } from '../../src/native-drill/scenarios/support.js';

function journalPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'jinn-drill-journal-')), name);
}

function expectUnreadable(path: string, run: () => unknown): void {
  expect(run).toThrow(/unreadable at/u);
  expect(run).toThrow(path);
}

describe('ExternalJournal.entries', () => {
  it('returns an empty list when the journal file does not exist yet', () => {
    const journal = new ExternalJournal<{ key: string }>(journalPath('missing.json'));
    expect(journal.entries()).toEqual([]);
  });

  it('returns the written entries after append', () => {
    const journal = new ExternalJournal<{ key: string }>(journalPath('ok.json'));
    journal.append({ key: 'a' });
    journal.append({ key: 'b' });
    expect(journal.entries()).toEqual([{ key: 'a' }, { key: 'b' }]);
  });

  it('throws, naming the path, when the journal is truncated JSON', () => {
    const path = journalPath('corrupt.json');
    writeFileSync(path, '{"key":', 'utf8');
    const journal = new ExternalJournal<{ key: string }>(path);
    expectUnreadable(path, () => journal.entries());
  });

  it('throws, naming the path, when the journal path is unreadable for a reason other than absence', () => {
    const path = journalPath('isdir.json');
    mkdirSync(path);
    const journal = new ExternalJournal<{ key: string }>(path);
    expectUnreadable(path, () => journal.entries());
  });
});
