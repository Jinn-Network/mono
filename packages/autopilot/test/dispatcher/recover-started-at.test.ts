import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverStartedAt } from '../../src/dispatcher/state.js';

// Unit tests for the exported `recoverStartedAt(worktreePath, markerPath)`
// (jinn-mono#1296/#1393 fix). Uses real temp directories — birthtime cannot
// be forged, so ages are simulated with `utimesSync` on the marker file
// instead. Tolerant assertions throughout: never assert exact equality
// against Date.now() (see note on macOS mtimeMs sub-millisecond precision
// below), only relative ordering / small tolerances.

describe('recoverStartedAt', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('regression for the false wall-clock pause: marker evidence (future mtime) wins over the worktree signal — max() semantics', () => {
    dir = mkdtempSync(join(tmpdir(), 'recover-started-at-'));
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath);
    const markerPath = join(dir, 'marker');
    writeFileSync(markerPath, 'x');

    // We can't backdate birthtime, so this test pins max() semantics by
    // pushing the marker mtime FAR IN THE FUTURE of the worktree's times —
    // the reused-worktree shape inverted. In production the marker is always
    // >= the worktree birthtime (it's written at every dispatch, including
    // re-dispatch onto a reused worktree), so "marker wins" is the same
    // relationship either way.
    const future = new Date(Date.now() + 1_000_000);
    utimesSync(markerPath, future, future);

    const result = recoverStartedAt(worktreePath, markerPath);

    // Tolerant: macOS mtimeMs can carry sub-millisecond rounding.
    expect(Math.abs(result - future.getTime())).toBeLessThan(10);
  });

  it('marker exists but is old and the worktree is fresh → returns the worktree-derived value (>= marker)', () => {
    dir = mkdtempSync(join(tmpdir(), 'recover-started-at-'));
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath);
    const markerPath = join(dir, 'marker');
    writeFileSync(markerPath, 'x');

    const old = new Date(1_000_000);
    utimesSync(markerPath, old, old);

    const result = recoverStartedAt(worktreePath, markerPath);

    expect(result).toBeGreaterThan(old.getTime());
  });

  it('no marker file → returns the worktree-derived value (today\'s fallback preserved)', () => {
    dir = mkdtempSync(join(tmpdir(), 'recover-started-at-'));
    const worktreePath = join(dir, 'worktree');
    mkdirSync(worktreePath);
    const markerPath = join(dir, 'does-not-exist');

    const result = recoverStartedAt(worktreePath, markerPath);

    expect(result).toBeGreaterThan(0);
  });

  it('neither path exists → returns 0 (unknown-age sentinel)', () => {
    dir = mkdtempSync(join(tmpdir(), 'recover-started-at-'));
    const worktreePath = join(dir, 'no-worktree-here');
    const markerPath = join(dir, 'no-marker-here');

    const result = recoverStartedAt(worktreePath, markerPath);

    expect(result).toBe(0);
  });
});
