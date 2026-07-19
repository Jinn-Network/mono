import { reviewClaimRef } from './codecs.js';
import {
  gitOid,
  type ClaimOutcome,
  type GitOid,
  type GitRefName,
  type PublicationOutcome,
} from './types.js';

export type GitCommandRunner = (
  command: 'git',
  args: readonly string[],
) => Promise<string>;

export interface GitProtocolPort {
  claimBranch(input: {
    branch: GitRefName;
    expectedHead: GitOid;
    claimOid: GitOid;
  }): Promise<ClaimOutcome>;
  publishReviewClaim(input: {
    prNumber: number;
    expectedRecordOid: GitOid | null;
    recordOid: GitOid;
  }): Promise<PublicationOutcome>;
  publishReviewFix(input: {
    branch: GitRefName;
    expectedHead: GitOid;
    newHead: GitOid;
    prNumber: number;
    expectedRecordOid: GitOid | null;
    recordOid: GitOid;
  }): Promise<PublicationOutcome>;
  publishMergePrep(input: {
    branch: GitRefName;
    expectedHead: GitOid;
    newHead: GitOid;
  }): Promise<PublicationOutcome>;
}

interface ReadRefResult {
  readonly succeeded: boolean;
  readonly oid: GitOid | null;
}

function branchRef(branch: GitRefName): string {
  if (branch.startsWith('refs/')) throw new Error('Expected a branch name, not a full ref');
  return `refs/heads/${branch}`;
}

function parseLsRemote(output: string, expectedRef: string): GitOid | null {
  if (output.length === 0) return null;
  for (const line of output.trimEnd().split('\n')) {
    const [oid, ref, extra] = line.split('\t');
    if (extra !== undefined || oid === undefined || ref === undefined) {
      throw new Error('Malformed git ls-remote output');
    }
    if (ref === expectedRef) return gitOid(oid);
  }
  return null;
}

async function readRef(
  runner: GitCommandRunner,
  remote: string,
  ref: string,
): Promise<ReadRefResult> {
  try {
    return {
      succeeded: true,
      oid: parseLsRemote(await runner('git', ['ls-remote', remote, ref]), ref),
    };
  } catch {
    return { succeeded: false, oid: null };
  }
}

async function pushScalar(
  runner: GitCommandRunner,
  remote: string,
  args: readonly string[],
  ref: string,
  expected: GitOid | null,
  published: GitOid,
): Promise<ClaimOutcome> {
  try {
    await runner('git', args);
    return { status: 'won', expected, published, observed: published };
  } catch {
    const readback = await readRef(runner, remote, ref);
    if (!readback.succeeded) {
      return { status: 'ambiguous', expected, published, observed: null };
    }
    if (readback.oid === published) {
      return { status: 'already-applied', expected, published, observed: published };
    }
    return { status: 'lost', expected, published, observed: readback.oid };
  }
}

function assertRemote(remote: string): void {
  if (remote.length === 0 || /[\u0000-\u0020\u007f]/.test(remote)) {
    throw new Error('Invalid Git remote');
  }
}

export function makeGitProtocolPort(
  runner: GitCommandRunner,
  options: { readonly remote?: string } = {},
): GitProtocolPort {
  const remote = options.remote ?? 'origin';
  assertRemote(remote);
  return {
    async claimBranch(input) {
      const ref = branchRef(input.branch);
      return pushScalar(
        runner,
        remote,
        ['push', remote, `${input.claimOid}:${ref}`],
        ref,
        input.expectedHead,
        input.claimOid,
      );
    },

    async publishReviewClaim(input) {
      const ref = reviewClaimRef(input.prNumber);
      return pushScalar(
        runner,
        remote,
        ['push', remote, `${input.recordOid}:${ref}`],
        ref,
        input.expectedRecordOid,
        input.recordOid,
      );
    },

    async publishReviewFix(input) {
      const branch = branchRef(input.branch);
      const review = reviewClaimRef(input.prNumber);
      const expected = {
        branch: input.expectedHead,
        review: input.expectedRecordOid,
      };
      const published = {
        branch: input.newHead,
        review: input.recordOid,
      };
      try {
        await runner('git', [
          'push',
          '--atomic',
          remote,
          `${input.newHead}:${branch}`,
          `${input.recordOid}:${review}`,
        ]);
        return {
          status: 'won',
          expected,
          published,
          observed: published,
        };
      } catch {
        const [branchReadback, reviewReadback] = await Promise.all([
          readRef(runner, remote, branch),
          readRef(runner, remote, review),
        ]);
        const observed = {
          branch: branchReadback.oid,
          review: reviewReadback.oid,
        };
        if (!branchReadback.succeeded || !reviewReadback.succeeded) {
          return { status: 'ambiguous', expected, published, observed };
        }
        if (observed.branch === published.branch && observed.review === published.review) {
          return { status: 'already-applied', expected, published, observed };
        }
        return { status: 'lost', expected, published, observed };
      }
    },

    async publishMergePrep(input) {
      const ref = branchRef(input.branch);
      return pushScalar(
        runner,
        remote,
        [
          'push',
          remote,
          `--force-with-lease=${input.branch}:${input.expectedHead}`,
          `${input.newHead}:${ref}`,
        ],
        ref,
        input.expectedHead,
        input.newHead,
      );
    },
  };
}
