import { describe, it, expect } from 'vitest';
import { computeDiffStats } from '../mcp/diff-stats.mjs';

const ONE_LINE_FIX = `--- a/src/foo.c
+++ b/src/foo.c
@@ -1 +1 @@
-broken
+fixed
`;

const MULTI_HUNK_TWO_FILES = `--- a/src/foo.c
+++ b/src/foo.c
@@ -1,3 +1,3 @@
 line1
-bad
+good
 line3
@@ -10 +10 @@
-also bad
+also good
--- a/test/test_foo.c
+++ b/test/test_foo.c
@@ -5 +5 @@
-old
+new
`;

const RENAME_PATCH = `diff --git a/src/old.c b/src/new.c
similarity index 90%
rename from src/old.c
rename to src/new.c
--- a/src/old.c
+++ b/src/new.c
@@ -1 +1 @@
-old
+new
`;

describe('computeDiffStats (r83r diff-stats library)', () => {
  it('returns 1 hunk / 1 file / 1 add / 1 remove for the one-line fix', () => {
    expect(computeDiffStats(ONE_LINE_FIX)).toEqual({
      hunks: 1, filesTouched: 1, addedLines: 1, removedLines: 1, hasRenames: false,
    });
  });

  it('returns 3 hunks / 2 files for the multi-hunk patch', () => {
    const s = computeDiffStats(MULTI_HUNK_TWO_FILES);
    expect(s.hunks).toBe(3);
    expect(s.filesTouched).toBe(2);
    expect(s.addedLines).toBe(3);
    expect(s.removedLines).toBe(3);
    expect(s.hasRenames).toBe(false);
  });

  it('flags hasRenames: true when a rename header is present', () => {
    expect(computeDiffStats(RENAME_PATCH).hasRenames).toBe(true);
  });

  it('rejects an empty patch with a sensible error', () => {
    expect(() => computeDiffStats('')).toThrow(/empty patch/i);
  });
});
