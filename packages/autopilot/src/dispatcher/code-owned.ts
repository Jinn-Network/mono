export interface OwnedPaths {
  /** Literal anchored prefixes (exact file or directory) the matcher represents
   *  precisely — leading/trailing `/` stripped. */
  prefixes: string[];
  /** True if CODEOWNERS contains a rule the prefix matcher CANNOT represent
   *  precisely: a glob (`*`/`?`/`[`) or one that normalizes to empty (a bare
   *  `/` owning everything). When set, we cannot prove a file is *not* owned, so
   *  `touchesCodeOwnedPath` fails safe and treats every PR as human-surface. */
  hasUnsupportedPattern: boolean;
}

/**
 * Parse `.github/CODEOWNERS` into owned path prefixes. Only the path token of
 * each rule is kept; comments and blank lines are ignored.
 *
 * The repo's CODEOWNERS uses only anchored prefixes — exact files (`/SPEC.md`)
 * and directories (`/client/src/dashboard/spa/src/pages/`) — which the prefix
 * matcher covers exactly. Anything the matcher can't represent precisely (a
 * glob, or a bare `/`) sets `hasUnsupportedPattern`; under-matching such a rule
 * would be the UNSAFE direction (mark a human-surface PR approve-eligible), so
 * callers fail safe to advisory instead. Replace any such rule with anchored
 * paths to restore precise (per-PR) matching.
 */
export function parseOwnedPrefixes(codeownersText: string): OwnedPaths {
  const prefixes: string[] = [];
  let hasUnsupportedPattern = false;
  for (const raw of codeownersText.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const pattern = line.split(/\s+/)[0];
    if (!pattern) continue;
    if (/[*?[\]]/.test(pattern)) {
      console.warn(
        `[autopilot] CODEOWNERS pattern '${pattern}' uses glob metacharacters the ` +
          'human-surface matcher cannot represent — treating ALL PRs as human-surface ' +
          '(advisory) until it is replaced with anchored paths.',
      );
      hasUnsupportedPattern = true;
      continue;
    }
    const prefix = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (prefix === '') {
      // A bare '/' owns everything — can't express as a prefix; fail safe.
      hasUnsupportedPattern = true;
      continue;
    }
    prefixes.push(prefix);
  }
  return { prefixes, hasUnsupportedPattern };
}

/**
 * True iff the PR is a "human-surface" change — any changed file is at or under
 * a code-owned path — which requires a human code owner (DR-2026-06-03), so the
 * engine reviews it but must not approve it. Fails safe: if CODEOWNERS has a
 * rule the matcher can't represent precisely, returns true (cannot prove a file
 * is not owned).
 */
export function touchesCodeOwnedPath(changedFiles: string[], owned: OwnedPaths): boolean {
  if (owned.hasUnsupportedPattern) return true;
  return changedFiles.some((raw) => {
    const file = raw.trim();
    if (!file) return false;
    return owned.prefixes.some((p) => file === p || file.startsWith(`${p}/`));
  });
}
