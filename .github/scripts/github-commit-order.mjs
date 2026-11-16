// How another commit relates to the commit a job publishes, asked of GitHub because the
// publishing jobs check out with `fetch-depth: 1` and their clones cannot answer ancestry.
// On `next` every push tip descends from the earlier ones, so ancestry is the order of
// pushes. One rule for the two jobs that must never move a public surface back to an older
// commit: the stack canary publisher's `canary` tag (`publish-verified-platform.mjs`, #5230)
// and the profile host refresh (`refresh-profile-host.mjs`, #5242).

/**
 * Asks GitHub's compare of `source...other` how `other` relates to `source`: `behind` when
 * `other` is an ancestor of `source` (earlier), `ahead` when it descends from `source`
 * (later). Every other outcome, a failed call, `diverged`, or any other answer, is an order
 * that cannot be told and comes back with its reason. Callers handle `other === source`.
 * @param {{
 *   exec: (command: string, args: string[], cwd: string) => { status: number | null, stdout: string, stderr: string },
 *   cwd: string,
 *   repository: string,
 *   source: string,
 *   other: string,
 * }} args
 * @returns {{ order: 'behind' | 'ahead' } | { order: null, reason: string }}
 */
export function githubCommitOrder({ exec, cwd, repository, source, other }) {
  const result = exec('gh', ['api', `repos/${repository}/compare/${source}...${other}`, '--jq', '.status'], cwd);
  const order = result.status === 0 ? result.stdout.trim() : null;
  if (order === 'behind' || order === 'ahead') return { order };
  const reason = order === null
    ? `GitHub compare failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`
    : order === 'diverged'
      ? 'neither commit descends from the other (GitHub compare: diverged)'
      : `GitHub compare returned ${JSON.stringify(order)}`;
  return { order: null, reason };
}
