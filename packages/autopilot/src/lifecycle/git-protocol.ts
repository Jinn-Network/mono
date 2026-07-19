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
    candidateParent: GitOid;
    expectedRemoteHead: GitOid | null;
    claimOid: GitOid;
  }): Promise<ClaimOutcome>;
  publishReviewClaim(input: {
    prNumber: number;
    recordParent: GitOid | null;
    expectedRemoteRecordOid: GitOid | null;
    recordOid: GitOid;
  }): Promise<PublicationOutcome>;
  publishReviewFix(input: {
    branch: GitRefName;
    newHeadParent: GitOid;
    expectedRemoteHead: GitOid;
    newHead: GitOid;
    prNumber: number;
    recordParent: GitOid | null;
    expectedRemoteRecordOid: GitOid | null;
    recordOid: GitOid;
  }): Promise<PublicationOutcome>;
  publishMergePrep(input: {
    branch: GitRefName;
    expectedRemoteHead: GitOid;
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

function exactLease(ref: string, expected: GitOid | null): string {
  return `--force-with-lease=${ref}:${expected ?? ''}`;
}

async function assertCandidateParent(
  runner: GitCommandRunner,
  candidate: GitOid,
  expected: GitOid | null,
): Promise<void> {
  const output = await runner('git', ['rev-list', '--parents', '-n', '1', candidate]);
  const fields = output.trim().split(/\s+/);
  const [observedCandidate, ...parents] = fields;
  if (
    observedCandidate !== candidate
    || (expected === null && parents.length !== 0)
    || (expected !== null && (parents.length !== 1 || parents[0] !== expected))
  ) {
    throw new Error(`Candidate ${candidate} does not have expected parent ${expected ?? '<none>'}`);
  }
}

async function publishLeasedScalar(
  runner: GitCommandRunner,
  remote: string,
  ref: string,
  expectedRemoteOid: GitOid | null,
  published: GitOid,
): Promise<ClaimOutcome> {
  const before = await readRef(runner, remote, ref);
  if (!before.succeeded) {
    return { status: 'ambiguous', expected: expectedRemoteOid, published, observed: null };
  }
  if (before.oid === published) {
    return {
      status: 'already-applied',
      expected: expectedRemoteOid,
      published,
      observed: published,
    };
  }
  if (before.oid !== expectedRemoteOid) {
    return { status: 'lost', expected: expectedRemoteOid, published, observed: before.oid };
  }
  try {
    await runner('git', [
      'push',
      exactLease(ref, expectedRemoteOid),
      remote,
      `${published}:${ref}`,
    ]);
    return { status: 'won', expected: expectedRemoteOid, published, observed: published };
  } catch {
    const readback = await readRef(runner, remote, ref);
    if (!readback.succeeded) {
      return { status: 'ambiguous', expected: expectedRemoteOid, published, observed: null };
    }
    if (readback.oid === published) {
      return {
        status: 'already-applied',
        expected: expectedRemoteOid,
        published,
        observed: published,
      };
    }
    return { status: 'lost', expected: expectedRemoteOid, published, observed: readback.oid };
  }
}

async function publishScalarWithParent(
  runner: GitCommandRunner,
  remote: string,
  ref: string,
  candidateParent: GitOid | null,
  expectedRemoteOid: GitOid | null,
  published: GitOid,
): Promise<ClaimOutcome> {
  await assertCandidateParent(runner, published, candidateParent);
  return publishLeasedScalar(runner, remote, ref, expectedRemoteOid, published);
}

function assertRemote(remote: string): void {
  if (remote.length === 0 || /[\u0000-\u0020\u007f]/.test(remote)) {
    throw new Error('Invalid Git remote');
  }
}

function assertBranchClaimRelation(
  candidateParent: GitOid,
  expectedRemoteHead: GitOid | null,
): void {
  if (expectedRemoteHead !== null && candidateParent !== expectedRemoteHead) {
    throw new Error('Branch claim candidate parent must equal expected remote head');
  }
}

function assertReviewRecordRelation(
  recordParent: GitOid | null,
  expectedRemoteRecordOid: GitOid | null,
): void {
  if (recordParent !== expectedRemoteRecordOid) {
    throw new Error('Review record parent must equal expected remote record OID');
  }
}

function assertReviewFixRelation(input: {
  readonly newHeadParent: GitOid;
  readonly expectedRemoteHead: GitOid;
  readonly recordParent: GitOid | null;
  readonly expectedRemoteRecordOid: GitOid | null;
}): void {
  if (input.newHeadParent !== input.expectedRemoteHead) {
    throw new Error('Review fix new head parent must equal expected remote head');
  }
  assertReviewRecordRelation(input.recordParent, input.expectedRemoteRecordOid);
}

export function makeGitProtocolPort(
  runner: GitCommandRunner,
  options: { readonly remote?: string } = {},
): GitProtocolPort {
  const remote = options.remote ?? 'origin';
  assertRemote(remote);
  return {
    async claimBranch(input) {
      assertBranchClaimRelation(input.candidateParent, input.expectedRemoteHead);
      const ref = branchRef(input.branch);
      return publishScalarWithParent(
        runner,
        remote,
        ref,
        input.candidateParent,
        input.expectedRemoteHead,
        input.claimOid,
      );
    },

    async publishReviewClaim(input) {
      assertReviewRecordRelation(input.recordParent, input.expectedRemoteRecordOid);
      const ref = reviewClaimRef(input.prNumber);
      return publishScalarWithParent(
        runner,
        remote,
        ref,
        input.recordParent,
        input.expectedRemoteRecordOid,
        input.recordOid,
      );
    },

    async publishReviewFix(input) {
      assertReviewFixRelation(input);
      const branch = branchRef(input.branch);
      const review = reviewClaimRef(input.prNumber);
      const expected = {
        branch: input.expectedRemoteHead,
        review: input.expectedRemoteRecordOid,
      };
      const published = {
        branch: input.newHead,
        review: input.recordOid,
      };
      await assertCandidateParent(runner, input.newHead, input.newHeadParent);
      await assertCandidateParent(runner, input.recordOid, input.recordParent);
      const [branchBefore, reviewBefore] = await Promise.all([
        readRef(runner, remote, branch),
        readRef(runner, remote, review),
      ]);
      const before = {
        branch: branchBefore.oid,
        review: reviewBefore.oid,
      };
      if (!branchBefore.succeeded || !reviewBefore.succeeded) {
        return { status: 'ambiguous', expected, published, observed: before };
      }
      if (before.branch === published.branch && before.review === published.review) {
        return { status: 'already-applied', expected, published, observed: before };
      }
      if (before.branch !== expected.branch || before.review !== expected.review) {
        return { status: 'lost', expected, published, observed: before };
      }
      try {
        await runner('git', [
          'push',
          '--atomic',
          exactLease(branch, input.expectedRemoteHead),
          exactLease(review, input.expectedRemoteRecordOid),
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
      return publishLeasedScalar(
        runner,
        remote,
        ref,
        input.expectedRemoteHead,
        input.newHead,
      );
    },
  };
}
