import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reapWorkDirs } from '../../../src/harnesses/engine/work-dir-reaper.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a fake per-task working directory with some scratch content. */
function makeWorkDir(root: string, requestId: string, ageMs = 0): string {
  const dir = join(root, requestId);
  mkdirSync(join(dir, 'repo'), { recursive: true });
  mkdirSync(join(dir, 'env'), { recursive: true });
  writeFileSync(join(dir, 'task.json'), '{}', 'utf-8');
  writeFileSync(join(dir, 'system_snapshot.tar.gz'), 'x'.repeat(64), 'utf-8');
  if (ageMs > 0) {
    const when = (Date.now() - ageMs) / 1000;
    // Backdate the directory mtime so the reaper sees it as old.
    utimesSync(dir, when, when);
  }
  return dir;
}

describe('reapWorkDirs', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'jinn-reaper-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a work dir whose request is in the terminal set', () => {
    const dir = makeWorkDir(root, '0xterminal');
    makeWorkDir(root, '0xinflight');

    const report = reapWorkDirs({
      workingDirRoot: root,
      terminalRequestIds: new Set(['0xterminal']),
      inFlightRequestIds: new Set(['0xinflight']),
    });

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(root, '0xinflight'))).toBe(true);
    expect(report.removed).toContain('0xterminal');
    expect(report.removed).toHaveLength(1);
  });

  it('never removes a work dir for an in-flight request', () => {
    const dir = makeWorkDir(root, '0xinflight', 30 * 24 * 60 * 60 * 1000); // 30 days old

    const report = reapWorkDirs({
      workingDirRoot: root,
      terminalRequestIds: new Set(),
      inFlightRequestIds: new Set(['0xinflight']),
    });

    expect(existsSync(dir)).toBe(true);
    expect(report.removed).toHaveLength(0);
    expect(report.protected).toContain('0xinflight');
  });

  it('removes an orphaned work dir older than the max age', () => {
    const old = makeWorkDir(root, '0xorphan-old', 2 * 24 * 60 * 60 * 1000); // 2 days old
    const fresh = makeWorkDir(root, '0xorphan-fresh', 60 * 1000); // 1 minute old

    const report = reapWorkDirs({
      workingDirRoot: root,
      terminalRequestIds: new Set(),
      inFlightRequestIds: new Set(),
      orphanMaxAgeMs: 24 * 60 * 60 * 1000, // 24h
    });

    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(report.removed).toContain('0xorphan-old');
    expect(report.removed).not.toContain('0xorphan-fresh');
  });

  it('keeps a recent orphan that is not yet past the max age', () => {
    const dir = makeWorkDir(root, '0xorphan-fresh', 60 * 1000);

    const report = reapWorkDirs({
      workingDirRoot: root,
      terminalRequestIds: new Set(),
      inFlightRequestIds: new Set(),
      orphanMaxAgeMs: 24 * 60 * 60 * 1000,
    });

    expect(existsSync(dir)).toBe(true);
    expect(report.removed).toHaveLength(0);
  });

  it('is a no-op when the working dir root does not exist', () => {
    const report = reapWorkDirs({
      workingDirRoot: join(root, 'does-not-exist'),
      terminalRequestIds: new Set(['0xany']),
      inFlightRequestIds: new Set(),
    });
    expect(report.removed).toHaveLength(0);
  });

  it('reclaims disk: clears a backlog of terminal dirs in one pass', () => {
    const ids = Array.from({ length: 12 }, (_, i) => `0xbacklog-${i}`);
    for (const id of ids) makeWorkDir(root, id);

    const report = reapWorkDirs({
      workingDirRoot: root,
      terminalRequestIds: new Set(ids),
      inFlightRequestIds: new Set(),
    });

    expect(report.removed.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(existsSync(join(root, id))).toBe(false);
  });
});
