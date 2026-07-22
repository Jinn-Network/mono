import type { GitHubLifecycleSnapshot } from '../../src/lifecycle/snapshot.js';
import type { TargetedActionReader } from '../../src/lifecycle/targeted-action-reader.js';

export function targetedFrom(
  readSnapshot: () => GitHubLifecycleSnapshot | Promise<GitHubLifecycleSnapshot>,
  ledger: Array<{ readonly kind: string; readonly points: number }> = [],
): TargetedActionReader {
  return {
    async readPullRequest(_cycle, prNumber) {
      ledger.push({ kind: 'target-pr', points: 10 });
      const snapshot = await readSnapshot();
      return snapshot.pullRequests.some((pr) => pr.number === prNumber) ? snapshot : null;
    },
    async readIssue(_cycle, issueNumber) {
      ledger.push({ kind: 'target-issue', points: 10 });
      const snapshot = await readSnapshot();
      const source = snapshot.issues.find((issue) => issue.number === issueNumber);
      const item = snapshot.project.items.find((entry) => (
        entry.contentType === 'Issue' && entry.number === issueNumber
      ));
      if (source === undefined || item === undefined) return null;
      return {
        native: {
          number: issueNumber,
          title: source.title,
          open: true,
          author: source.author,
          labels: source.labels ?? [],
        },
        source,
        projectItem: { id: item.id, status: item.status, blockedOn: item.blockedOn },
        snapshot,
      };
    },
    async readProjectItem(issueNumber) {
      ledger.push({ kind: 'target-project', points: 1 });
      const snapshot = await readSnapshot();
      const item = snapshot.project.items.find((entry) => (
        entry.contentType === 'Issue' && entry.number === issueNumber
      ));
      return item === undefined
        ? null
        : { id: item.id, status: item.status, blockedOn: item.blockedOn };
    },
    async readOpenPullRequests(issueNumber) {
      ledger.push({ kind: 'target-relation', points: 2 });
      const snapshot = await readSnapshot();
      return snapshot.pullRequests
        .filter((pr) => pr.state === 'OPEN' && pr.closingIssueNumbers.includes(issueNumber))
        .map((pr) => ({
          number: pr.number,
          headRefName: pr.headRefName,
          headOid: pr.headOid,
          baseRefName: pr.baseRefName,
          draft: pr.isDraft,
          labels: pr.labels,
          body: pr.body,
        }));
    },
  };
}
