/**
 * Helpers for sanitising a SWE-rebench v2 restoration patch before it is
 * submitted as the solution payload.
 *
 * Two problems this guards against (see jinn-mono-uy6v.8):
 *  1. Coding agents naturally write a regression test alongside their fix.
 *     The upstream eval applies the model patch and then the *gold* `test_patch`
 *     with `git apply --3way` and `set -e` — if the model patch already touched
 *     the same test file the gold patch will conflict, abort the eval, and the
 *     verdict is `passed_match:false` for a reason that has nothing to do with
 *     the fix. Standard SWE-bench evaluation resets test files before applying
 *     the gold test patch; since our restorer never sees the gold `test_patch`,
 *     we approximate that by stripping test-path hunks on the producer side.
 *  2. Hand-authored diffs (the `submit_typed_payload` / `.execute` fallback
 *     path) sometimes drop the leading space on a context line, which makes
 *     `git apply` reject the whole patch ("corrupt patch at line N"). A cheap
 *     `git apply --numstat` parse catches that before the patch ships.
 */

import { execFile } from 'node:child_process';

// Async execFile — see #778. The sibling `git diff` wedge in harvest.ts
// could starve the entire daemon main thread; the same risk applies to
// this `git apply --numstat` call (any git invocation can hang on a repo
// lock, FS issue, etc.). 60s timeout matches harvest.ts.
const GIT_APPLY_TIMEOUT_MS = 60_000;

/**
 * Whether `path` (a forward-slash repo-relative path) looks like a test file
 * by common cross-language convention. Conservative on purpose: over-stripping
 * a model's own test is harmless (the eval discards model test edits anyway),
 * under-stripping risks the gold-test-patch conflict.
 */
export function isTestPath(path: string): boolean {
  const p = path.replace(/^[ab]\//, '');
  const segments = p.split('/');
  const base = segments[segments.length - 1] ?? '';
  // A directory segment that is exactly a conventional test directory.
  for (const seg of segments.slice(0, -1)) {
    if (seg === 'test' || seg === 'tests' || seg === '__tests__' || seg === 'testsuite' || seg === 'testsuites') {
      return true;
    }
  }
  // Filename conventions.
  if (base === 'conftest.py') return true;
  if (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base)) return true;
  if (/_test\.go$/.test(base)) return true;
  if (/_test\.rs$/.test(base)) return true;
  if (/\.(test|spec)\.(m?[jt]sx?|cjs)$/.test(base)) return true;
  if (/(Test|Tests|IT)\.java$/.test(base)) return true;
  if (/_(test|spec)\.rb$/.test(base) || /^test_.*\.rb$/.test(base)) return true;
  return false;
}

/** Extract the a/ and b/ paths from a `diff --git` header line, if present. */
function pathsFromDiffHeader(line: string): string[] {
  // `diff --git a/foo/bar b/foo/bar` — paths may contain spaces but in practice
  // for our repos they don't; take the two whitespace-delimited tokens after
  // `diff --git`.
  const m = /^diff --git (\S.*?) (\S.*)$/.exec(line);
  if (!m) return [];
  return [m[1]!.replace(/^a\//, ''), m[2]!.replace(/^b\//, '')];
}

/** Fallback: pull a path out of a `--- a/x` / `+++ b/x` line. */
function pathFromMarkerLine(line: string): string | null {
  const m = /^[-+]{3} ([ab]\/.+)$/.exec(line);
  if (!m) return null;
  return m[1]!.replace(/^[ab]\//, '');
}

/**
 * Split a unified diff into per-file sections and drop the ones whose path
 * (a/ or b/ side) is a test path. Returns the rejoined diff, or `''` if no
 * non-test hunks remain.
 *
 * Splits only on `diff --git ` boundaries, so binary patches and rename
 * headers are kept intact within a section.
 */
export function stripTestPathHunks(unifiedDiff: string): string {
  if (!unifiedDiff.includes('diff --git ')) {
    // Not a git-format multi-file diff — leave it alone (could be a single
    // `--- a/x`/`+++ b/x` patch; not our concern to dissect here).
    return unifiedDiff;
  }
  const lines = unifiedDiff.split('\n');
  type Section = { paths: string[]; lines: string[] };
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      current = { paths: pathsFromDiffHeader(line), lines: [line] };
      sections.push(current);
      continue;
    }
    if (!current) {
      // Preamble before the first `diff --git ` (rare; e.g. a leading blank
      // line). Keep it as a pseudo-section with no paths so it's preserved.
      current = { paths: [], lines: [line] };
      sections.push(current);
      continue;
    }
    current.lines.push(line);
    if (current.paths.length === 0) {
      const p = pathFromMarkerLine(line);
      if (p) current.paths.push(p);
    }
  }
  const kept = sections.filter((s) => !s.paths.some(isTestPath));
  if (kept.length === 0) return '';
  // If every kept section is empty-path preamble only, treat as empty too.
  if (!kept.some((s) => s.lines.some((l) => l.startsWith('diff --git ')))) return '';
  const out = kept.flatMap((s) => s.lines).join('\n');
  // jinn-mono-c52e: `git apply` rejects diffs that end mid-line with
  // "corrupt patch at line N" — enforce trailing newline on the envelope.
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * Cheap structural validation: have `git apply --numstat` parse the patch (no
 * worktree changes, no base-blob lookups). Catches malformed unified diffs —
 * "corrupt patch at line N", "unexpected line", etc. — before the patch is
 * submitted as a verdict-bound solution payload.
 */
export async function gitApplyParseCheck(
  repoDir: string,
  patch: string,
): Promise<{ ok: true } | { ok: false; stderr: string }> {
  if (!patch.trim()) return { ok: false, stderr: 'empty patch' };
  try {
    // Async + 60s timeout (#778) — see header note. Production callers
    // already await this; only the test suite called it synchronously.
    // We use the callback form of execFile (not promisify) so the returned
    // ChildProcess handle is available to write the patch via stdin.
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        'git',
        ['-C', repoDir, 'apply', '--numstat', '-'],
        {
          encoding: 'utf8',
          timeout: GIT_APPLY_TIMEOUT_MS,
        },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
      // `child` is undefined only if the spawn itself synchronously failed,
      // in which case the callback above will already be queued to reject.
      child?.stdin?.write(patch);
      child?.stdin?.end();
    });
    return { ok: true };
  } catch (err) {
    const stderr =
      typeof err === 'object' && err !== null && 'stderr' in err
        ? String((err as { stderr: unknown }).stderr ?? '')
        : err instanceof Error
          ? err.message
          : String(err);
    return { ok: false, stderr: stderr.slice(0, 800) };
  }
}
