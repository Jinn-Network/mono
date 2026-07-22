import type { AttemptManifest } from './attempt-workspace.js';
import { formatHumanCommentMarker } from './codecs.js';
import type {
  BranchClaim,
  GitOid,
  HumanReason,
  PublicationOutcome,
  ReviewVerdictState,
} from './types.js';

export interface ImplementationAuthority {
  readonly remoteHead: GitOid;
  readonly latestClaimOid: GitOid;
  readonly latestClaim: BranchClaim;
}

export interface ImplementationSessionPullRequest {
  readonly number: number;
  readonly head: GitOid;
  readonly headRefName: string;
  readonly baseRefName: string;
  readonly draft: boolean;
  readonly labels: readonly string[];
  readonly body: string;
}

export interface ImplementationSessionPort {
  readManifest(path: string): AttemptManifest;
  readAuthority(manifest: AttemptManifest): Promise<ImplementationAuthority>;
  readLocalHead(manifest: AttemptManifest): Promise<GitOid>;
  readBranchClaim(
    manifest: AttemptManifest,
    oid: GitOid,
  ): Promise<BranchClaim | null>;
  readCompletionSummary(
    manifest: AttemptManifest,
    oid: GitOid,
  ): Promise<string | null>;
  isAncestor(
    manifest: AttemptManifest,
    ancestor: GitOid,
    descendant: GitOid,
  ): Promise<boolean>;
  treesDiffer(
    manifest: AttemptManifest,
    left: GitOid,
    right: GitOid,
  ): Promise<boolean>;
  publishBranch(input: {
    readonly manifest: AttemptManifest;
    readonly expectedRemoteHead: GitOid;
    readonly newHead: GitOid;
  }): Promise<PublicationOutcome>;
  advanceManifestHead(
    manifestPath: string,
    expectedHead: GitOid,
    nextHead: GitOid,
  ): AttemptManifest;
  createCompletionCommit(input: {
    readonly manifest: AttemptManifest;
    readonly parent: GitOid;
    readonly completionClaim: BranchClaim & { readonly phaseComplete: true };
    readonly summary: string;
  }): Promise<GitOid>;
  readPullRequest(
    prNumber: number,
    expectedHead: GitOid,
  ): Promise<ImplementationSessionPullRequest>;
  /**
   * Reads only the pull request's current head OID, without validating it
   * against any expectation -- unlike {@link readPullRequest}, which throws
   * when the observed head disagrees with `expectedHead`. Used exclusively
   * by {@link awaitPullRequestHead} to poll GitHub's PR *record* (which
   * lags a just-pushed branch ref by up to a few seconds, see #1883) until
   * it catches up with a head this session just published, without
   * mistaking that lag for the PR having genuinely changed under us.
   */
  readPullRequestHead(prNumber: number): Promise<GitOid>;
  /**
   * Injectable delay, used only to pace {@link awaitPullRequestHead}'s
   * bounded retry against GitHub PR-record replication lag. Production
   * wires a real `setTimeout`-based sleep; tests fake it so retries resolve
   * instantly and can assert on the delay values requested.
   */
  sleep(ms: number): Promise<void>;
  ensureCompletionSummary(
    prNumber: number,
    expectedHead: GitOid,
    summary: string,
  ): Promise<void>;
  setPullRequestLabel(
    prNumber: number,
    expectedHead: GitOid,
    label: string,
    present: boolean,
  ): Promise<void>;
  /**
   * Interim board paint for Human escalation only. Finalize no longer writes
   * Project Status (Stage 1 — decisions off the board); the painter owns the
   * rest of the Status view from Stage 3.
   */
  setPullRequestDraft(
    prNumber: number,
    expectedHead: GitOid,
    draft: boolean,
  ): Promise<void>;
  hasHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
  ): Promise<boolean>;
  ensureHumanComment(
    prNumber: number,
    expectedHead: GitOid,
    marker: string,
    body: string,
  ): Promise<void>;
  /** Stage 2: true when parent head ancestry includes a child-issue trailer. */
  parentHeadReferencesChild?(
    manifest: AttemptManifest,
    head: GitOid,
    childIssueNumber: number,
  ): Promise<boolean>;
  closeChildIssue?(
    issueNumber: number,
    comment: string,
  ): Promise<void>;
}

export type CheckpointResult =
  | { readonly status: 'published' | 'already-applied'; readonly head: GitOid }
  | { readonly status: 'stale' | 'ambiguous'; readonly head: GitOid };

export type ImplementationCompleteResult =
  | { readonly status: 'complete'; readonly head: GitOid }
  | {
      readonly status: 'partial';
      readonly head: GitOid;
      readonly pending:
        | 'checkpoint'
        | 'marker'
        | 'summary'
        | 'label'
        | 'ready'
        | 'hold';
      /**
       * The swallowed failure reason, when available, so `autopilot session
       * implementation-complete` can surface *why* a retry is pending
       * instead of only that one is. Optional: some partial outcomes (e.g.
       * a Human hold, or an authority mismatch caught upstream) are
       * self-explanatory from `pending` alone and never had an underlying
       * thrown error to report.
       */
      readonly detail?: string;
    };

export type HumanHoldResult = {
  readonly status: 'human';
  readonly head: GitOid;
};

export const IMPLEMENTATION_SUMMARY_START =
  '<!-- jinn-autopilot:v2 implementation-summary:start -->';
export const IMPLEMENTATION_SUMMARY_END =
  '<!-- jinn-autopilot:v2 implementation-summary:end -->';

export function hasImplementationSummary(body: string, summary: string): boolean {
  return body.includes(
    `${IMPLEMENTATION_SUMMARY_START}\n${summary.trim()}\n${IMPLEMENTATION_SUMMARY_END}`,
  );
}

export interface ImplementationSessionProtocol {
  checkpoint(manifest: AttemptManifest): Promise<CheckpointResult>;
  implementationComplete(
    manifest: AttemptManifest,
    summary: string,
  ): Promise<ImplementationCompleteResult>;
  childComplete?(
    manifest: AttemptManifest,
  ): Promise<{ readonly status: 'closed' | 'rejected'; readonly detail?: string }>;
  reviewVerdict(
    manifest: AttemptManifest,
    state: ReviewVerdictState,
    body: string,
  ): Promise<never>;
  human(manifest: AttemptManifest, reason: string): Promise<HumanHoldResult>;
}

function notWired(operation: string): never {
  throw new Error(`session ${operation}: operation not wired`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireImplementationManifest(
  supplied: AttemptManifest,
  port: ImplementationSessionPort,
): AttemptManifest {
  const fresh = port.readManifest(supplied.paths.manifest);
  if (
    fresh.phase !== 'implement'
    || fresh.attemptId !== supplied.attemptId
    || fresh.paths.manifest !== supplied.paths.manifest
    || fresh.paths.worktree !== supplied.paths.worktree
    || fresh.prNumber === undefined
  ) {
    throw new Error('Implementation session manifest authority changed or is invalid');
  }
  return fresh;
}

async function requireAuthority(
  manifest: AttemptManifest,
  port: ImplementationSessionPort,
): Promise<ImplementationAuthority> {
  const authority = await port.readAuthority(manifest);
  const latest = authority.latestClaim;
  if (
    latest.phase !== 'implement'
    || latest.attempt !== manifest.attemptId
    || latest.issueNumber !== manifest.issueNumber
    || (
      latest.prNumber === undefined
        ? authority.latestClaimOid !== manifest.claimOid
        : latest.prNumber !== manifest.prNumber
    )
    || latest.runner !== manifest.runnerId
    || latest.login.toLowerCase() !== manifest.selectedLogin.toLowerCase()
    || latest.targetBase !== manifest.targetBase
    || !await port.isAncestor(manifest, manifest.claimOid as GitOid, authority.remoteHead)
    || !await port.isAncestor(manifest, authority.latestClaimOid, authority.remoteHead)
  ) {
    throw new Error('Implementation attempt no longer owns the latest claim');
  }
  return authority;
}

function validImplementationPullRequest(
  manifest: AttemptManifest,
  pullRequest: ImplementationSessionPullRequest,
  expectedHead: GitOid,
  requireDraft: boolean,
): boolean {
  const marker =
    `<!-- jinn-autopilot:v2 issue=${manifest.issueNumber} branch=${manifest.branch} -->`;
  return pullRequest.number === manifest.prNumber
    && pullRequest.head === expectedHead
    && pullRequest.headRefName === manifest.branch
    && pullRequest.baseRefName === manifest.targetBase
    && (!requireDraft || pullRequest.draft)
    && pullRequest.body.includes(marker);
}

async function requireImplementationPullRequestAuthority(
  manifest: AttemptManifest,
  authority: ImplementationAuthority,
  port: ImplementationSessionPort,
  requireDraft: boolean,
): Promise<ImplementationSessionPullRequest> {
  const pullRequest = await port.readPullRequest(manifest.prNumber!, authority.remoteHead);
  if (!validImplementationPullRequest(
    manifest,
    pullRequest,
    authority.remoteHead,
    requireDraft,
  )) {
    throw new Error('Implementation pull request authority changed or is invalid');
  }
  return pullRequest;
}

async function requireActiveImplementationPullRequest(
  manifest: AttemptManifest,
  authority: ImplementationAuthority,
  port: ImplementationSessionPort,
): Promise<ImplementationSessionPullRequest> {
  return requireImplementationPullRequestAuthority(manifest, authority, port, true);
}

function hasHumanHold(
  pullRequest: ImplementationSessionPullRequest,
): boolean {
  return pullRequest.labels.includes('review:needs-human');
}

function branchOutcome(
  outcome: PublicationOutcome,
): 'published' | 'already-applied' | 'stale' | 'ambiguous' {
  if (outcome.status === 'won') return 'published';
  if (outcome.status === 'already-applied') return 'already-applied';
  if (outcome.status === 'lost') return 'stale';
  return 'ambiguous';
}

async function checkpoint(
  supplied: AttemptManifest,
  port: ImplementationSessionPort,
): Promise<CheckpointResult> {
  let manifest = requireImplementationManifest(supplied, port);
  const authority = await requireAuthority(manifest, port);
  if (authority.latestClaim.phaseComplete === true) {
    throw new Error('Implementation is already phase-complete');
  }
  await requireActiveImplementationPullRequest(manifest, authority, port);
  const localHead = await port.readLocalHead(manifest);

  if (authority.remoteHead !== manifest.expectedHead) {
    if (authority.remoteHead === localHead) {
      if (!await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)) {
        return { status: 'stale', head: authority.remoteHead };
      }
      if (!await port.treesDiffer(manifest, manifest.expectedHead as GitOid, localHead)) {
        throw new Error('Checkpoint must contain a real tree/content change');
      }
      manifest = port.advanceManifestHead(
        manifest.paths.manifest,
        manifest.expectedHead as GitOid,
        localHead,
      );
      return { status: 'already-applied', head: manifest.expectedHead as GitOid };
    }
    return { status: 'stale', head: authority.remoteHead };
  }
  if (localHead === manifest.expectedHead) {
    return { status: 'already-applied', head: localHead };
  }
  if (!await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)) {
    throw new Error('Local checkpoint HEAD is not a descendant of the manifest expected head');
  }
  if (!await port.treesDiffer(manifest, manifest.expectedHead as GitOid, localHead)) {
    throw new Error('Checkpoint must contain a real tree/content change');
  }

  const outcome = await port.publishBranch({
    manifest,
    expectedRemoteHead: manifest.expectedHead as GitOid,
    newHead: localHead,
  });
  const status = branchOutcome(outcome);
  if (status === 'ambiguous') return { status, head: localHead };
  if (status === 'stale') {
    const observed = 'observed' in outcome && typeof outcome.observed === 'string'
      ? outcome.observed as GitOid
      : authority.remoteHead;
    return { status, head: observed };
  }
  port.advanceManifestHead(
    manifest.paths.manifest,
    manifest.expectedHead as GitOid,
    localHead,
  );
  return { status, head: localHead };
}

function completionClaim(
  manifest: AttemptManifest,
  parent: GitOid,
): BranchClaim & { readonly phaseComplete: true } {
  return {
    kind: 'branch-claim',
    protocolVersion: 2,
    phase: 'implement',
    issueNumber: manifest.issueNumber,
    prNumber: manifest.prNumber!,
    attempt: manifest.attemptId,
    runner: manifest.runnerId,
    login: manifest.selectedLogin,
    expectedHead: parent,
    targetBase: manifest.targetBase as BranchClaim['targetBase'],
    claimedAt: new Date().toISOString(),
    phaseComplete: true,
  };
}

function isOwnedCompletionClaim(
  manifest: AttemptManifest,
  candidate: BranchClaim | null,
  expectedParent: GitOid,
): candidate is BranchClaim & { readonly phaseComplete: true } {
  return candidate?.phase === 'implement'
    && candidate.phaseComplete === true
    && candidate.issueNumber === manifest.issueNumber
    && candidate.prNumber === manifest.prNumber
    && candidate.attempt === manifest.attemptId
    && candidate.runner === manifest.runnerId
    && candidate.login.toLowerCase() === manifest.selectedLogin.toLowerCase()
    && candidate.targetBase === manifest.targetBase
    && candidate.expectedHead === expectedParent;
}

async function ensureCompletionProjection(
  manifest: AttemptManifest,
  head: GitOid,
  summary: string,
  port: ImplementationSessionPort,
): Promise<ImplementationCompleteResult> {
  // Three-op finalize (Stage 1): summary → engine:review → undraft → complete.
  // Project Status is paint-only and is never read or written here.
  const prNumber = manifest.prNumber!;
  let pullRequest: ImplementationSessionPullRequest;
  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    if (
      !validImplementationPullRequest(manifest, pullRequest, head, false)
    ) {
      return { status: 'partial', head, pending: 'ready' };
    }
    if (hasHumanHold(pullRequest)) {
      return { status: 'partial', head, pending: 'hold' };
    }
    if (
      !pullRequest.draft
      && hasImplementationSummary(pullRequest.body, summary)
      && pullRequest.labels.includes('engine:review')
    ) {
      return { status: 'complete', head };
    }
    // Re-draft only when the durable work (summary + label) is genuinely
    // missing. A non-draft PR that already has both is already complete
    // (early return above); re-drafting a ready PR that only lacked paint
    // would thrash the ready state.
    if (
      !pullRequest.draft
      && (!hasImplementationSummary(pullRequest.body, summary)
        || !pullRequest.labels.includes('engine:review'))
    ) {
      await port.setPullRequestDraft(prNumber, head, true);
    }
  } catch (error) {
    return { status: 'partial', head, pending: 'ready', detail: message(error) };
  }

  try {
    await port.ensureCompletionSummary(prNumber, head, summary);
  } catch (error) {
    return { status: 'partial', head, pending: 'summary', detail: message(error) };
  }

  // Label: attach engine:review before undrafting, so the PR is reviewable
  // the instant it goes ready. requireDraft is false so this block stays
  // re-entrant when a prior attempt already undrafted the PR.
  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    if (!validImplementationPullRequest(manifest, pullRequest, head, false)) {
      return { status: 'partial', head, pending: 'ready' };
    }
    if (hasHumanHold(pullRequest)) {
      return { status: 'partial', head, pending: 'hold' };
    }
    if (!pullRequest.labels.includes('engine:review')) {
      await port.setPullRequestLabel(prNumber, head, 'engine:review', true);
    }
  } catch (error) {
    return { status: 'partial', head, pending: 'label', detail: message(error) };
  }

  try {
    pullRequest = await port.readPullRequest(prNumber, head);
    if (!validImplementationPullRequest(manifest, pullRequest, head, false)) {
      return { status: 'partial', head, pending: 'ready' };
    }
    if (hasHumanHold(pullRequest)) {
      return { status: 'partial', head, pending: 'hold' };
    }
    if (pullRequest.draft) {
      await port.setPullRequestDraft(prNumber, head, false);
    }
  } catch (error) {
    return { status: 'partial', head, pending: 'ready', detail: message(error) };
  }

  return { status: 'complete', head };
}

/**
 * Bounded retry count for {@link awaitPullRequestHead}'s post-publish
 * convergence poll. `implementationComplete` publishes its completion
 * marker (or resumes/republishes one) via the git transport, whose
 * `ls-remote` readback is immediately current -- but GitHub's PR *record*
 * (`gh pr view` / the GraphQL API `ensureCompletionProjection` reads next)
 * lags a just-pushed ref by up to a few seconds. A single-shot read after
 * publish therefore still shows the pre-publish head, and every downstream
 * authority check in `ensureCompletionProjection` throws on that stale
 * head -- the very next line, `catch`, maps EVERY throw to a
 * recoverable partial, leaving the PR draft with the marker commit
 * already on the branch (the live bug this fixes). Three attempts with a
 * short delay between them gives replication time to catch up.
 */
const PULL_REQUEST_HEAD_CONVERGENCE_MAX_ATTEMPTS = 3;

/** Delay between {@link awaitPullRequestHead} retry attempts. */
const PULL_REQUEST_HEAD_CONVERGENCE_RETRY_DELAY_MS = 1000;

type PullRequestHeadConvergence =
  | { readonly outcome: 'converged' }
  | { readonly outcome: 'foreign'; readonly observed: GitOid }
  | { readonly outcome: 'lagging'; readonly observed: GitOid };

/**
 * Polls the PR record's head via {@link ImplementationSessionPort.readPullRequestHead}
 * until it reflects `expectedHead` (the head we just published), tolerating
 * GitHub PR-record replication lag without weakening fencing.
 *
 * On each attempt, the observed head is one of three things:
 *   - `expectedHead` -> converged, proceed to project onto it.
 *   - `previousHead` (the exact pre-publish head) -> replication lag; retry.
 *   - anything else -> a foreign write genuinely changed the PR's branch
 *     out from under us. Fail closed immediately with no further retries --
 *     the PR really did change; a later retry/reap resumes safely via the
 *     existing partial-result contract.
 *
 * Exhausting the retry budget while still observing `previousHead` also
 * returns closed (`lagging`), never forcing the projection through on an
 * unconfirmed head.
 */
async function awaitPullRequestHead(
  prNumber: number,
  previousHead: GitOid,
  expectedHead: GitOid,
  port: ImplementationSessionPort,
): Promise<PullRequestHeadConvergence> {
  for (
    let attempt = 1;
    attempt <= PULL_REQUEST_HEAD_CONVERGENCE_MAX_ATTEMPTS;
    attempt += 1
  ) {
    const observed = await port.readPullRequestHead(prNumber);
    if (observed === expectedHead) return { outcome: 'converged' };
    if (observed !== previousHead) return { outcome: 'foreign', observed };
    if (attempt === PULL_REQUEST_HEAD_CONVERGENCE_MAX_ATTEMPTS) {
      return { outcome: 'lagging', observed };
    }
    await port.sleep(PULL_REQUEST_HEAD_CONVERGENCE_RETRY_DELAY_MS);
  }
  /* istanbul ignore next -- unreachable: the loop always returns */
  return { outcome: 'lagging', observed: previousHead };
}

function pullRequestHeadConvergenceDetail(
  convergence: Extract<PullRequestHeadConvergence, { outcome: 'foreign' | 'lagging' }>,
  expectedHead: GitOid,
): string {
  return convergence.outcome === 'foreign'
    ? `Pull request head is ${convergence.observed}, not the published ${expectedHead}: `
      + 'a foreign write changed the pull request'
    : `Pull request record has not caught up with the published head ${expectedHead} `
      + `after ${PULL_REQUEST_HEAD_CONVERGENCE_MAX_ATTEMPTS} attempts`;
}

/**
 * Waits for the PR record to converge on `publishedHead` before the caller
 * projects durable state (summary, labels, draft) onto it.
 * Returns `null` once converged; otherwise a partial result -- with a
 * surfaced `detail` -- fit to return directly without ever calling
 * {@link ensureCompletionProjection} against a head the PR record hasn't
 * confirmed yet.
 */
async function convergeOnPublishedHead(
  manifest: AttemptManifest,
  previousHead: GitOid,
  publishedHead: GitOid,
  port: ImplementationSessionPort,
): Promise<ImplementationCompleteResult | null> {
  const convergence = await awaitPullRequestHead(
    manifest.prNumber!,
    previousHead,
    publishedHead,
    port,
  );
  if (convergence.outcome === 'converged') return null;
  return {
    status: 'partial',
    head: publishedHead,
    pending: 'ready',
    detail: pullRequestHeadConvergenceDetail(convergence, publishedHead),
  };
}

async function implementationComplete(
  supplied: AttemptManifest,
  summary: string,
  port: ImplementationSessionPort,
): Promise<ImplementationCompleteResult> {
  let manifest = requireImplementationManifest(supplied, port);
  let authority = await requireAuthority(manifest, port);
  let pullRequest = await requireImplementationPullRequestAuthority(
    manifest,
    authority,
    port,
    false,
  );
  if (hasHumanHold(pullRequest)) {
    return { status: 'partial', head: authority.remoteHead, pending: 'hold' };
  }
  let localHead = await port.readLocalHead(manifest);

  if (authority.latestClaim.phaseComplete === true) {
    if (
      authority.latestClaimOid !== authority.remoteHead
      || localHead !== authority.remoteHead
      || !await port.isAncestor(manifest, manifest.expectedHead as GitOid, localHead)
    ) {
      throw new Error('Phase-complete authority does not match the exact local/remote head');
    }
    if (manifest.expectedHead !== authority.remoteHead) {
      manifest = port.advanceManifestHead(
        manifest.paths.manifest,
        manifest.expectedHead as GitOid,
        authority.remoteHead,
      );
    }
    const durableSummary = await port.readCompletionSummary(
      manifest,
      authority.latestClaimOid,
    );
    if (durableSummary === null || durableSummary.trim() !== summary.trim()) {
      throw new Error('Retry summary does not match the durable summary');
    }
    // A resumed session: the marker was already published (possibly by a
    // prior invocation of this very call), so the PR record has usually
    // long since caught up -- this is a fast no-op in the common case. But
    // if this is the immediate retry right after that publish, the same
    // replication lag applies, and `authority.latestClaim.expectedHead` is
    // exactly the pre-marker head (the completion claim's own recorded
    // parent), giving the exact `previousHead` to distinguish lag from a
    // foreign change.
    const staleProjection = await convergeOnPublishedHead(
      manifest,
      authority.latestClaim.expectedHead as GitOid,
      authority.remoteHead,
      port,
    );
    if (staleProjection !== null) return staleProjection;
    return ensureCompletionProjection(
      manifest,
      authority.remoteHead,
      durableSummary,
      port,
    );
  }

  if (localHead !== manifest.expectedHead) {
    const localClaim = await port.readBranchClaim(manifest, localHead);
    if (
      isOwnedCompletionClaim(
        manifest,
        localClaim,
        manifest.expectedHead as GitOid,
      )
    ) {
      const durableSummary = await port.readCompletionSummary(manifest, localHead);
      if (durableSummary === null || durableSummary.trim() !== summary.trim()) {
        throw new Error('Retry summary does not match the durable summary');
      }
      await requireActiveImplementationPullRequest(manifest, authority, port);
      const prePublishHead = manifest.expectedHead as GitOid;
      const retry = await port.publishBranch({
        manifest,
        expectedRemoteHead: prePublishHead,
        newHead: localHead,
      });
      if (retry.status === 'won' || retry.status === 'already-applied') {
        manifest = port.advanceManifestHead(
          manifest.paths.manifest,
          prePublishHead,
          localHead,
        );
        const staleProjection = await convergeOnPublishedHead(
          manifest,
          prePublishHead,
          localHead,
          port,
        );
        if (staleProjection !== null) return staleProjection;
        return ensureCompletionProjection(manifest, localHead, durableSummary, port);
      }
      return { status: 'partial', head: localHead, pending: 'marker' };
    }
    const checkpointResult = await checkpoint(manifest, port);
    if (
      checkpointResult.status !== 'published'
      && checkpointResult.status !== 'already-applied'
    ) {
      return {
        status: 'partial',
        head: checkpointResult.head,
        pending: 'checkpoint',
      };
    }
    manifest = requireImplementationManifest(manifest, port);
    authority = await requireAuthority(manifest, port);
    localHead = await port.readLocalHead(manifest);
  }
  if (
    authority.remoteHead !== manifest.expectedHead
    || localHead !== manifest.expectedHead
  ) {
    return { status: 'partial', head: authority.remoteHead, pending: 'checkpoint' };
  }
  pullRequest = await requireActiveImplementationPullRequest(manifest, authority, port);
  if (hasHumanHold(pullRequest)) {
    return { status: 'partial', head: authority.remoteHead, pending: 'hold' };
  }

  const markerClaim = completionClaim(manifest, authority.remoteHead);
  const marker = await port.createCompletionCommit({
    manifest,
    parent: authority.remoteHead,
    completionClaim: markerClaim,
    summary,
  });
  const outcome = await port.publishBranch({
    manifest,
    expectedRemoteHead: authority.remoteHead,
    newHead: marker,
  });
  if (outcome.status === 'ambiguous' || outcome.status === 'lost') {
    return { status: 'partial', head: marker, pending: 'marker' };
  }
  manifest = port.advanceManifestHead(
    manifest.paths.manifest,
    manifest.expectedHead as GitOid,
    marker,
  );
  // `authority.remoteHead` still holds the pre-marker head here -- publish
  // succeeded but this local variable was never reassigned -- giving the
  // exact `previousHead` this convergence wait needs to tell replication
  // lag apart from a genuinely foreign change.
  const staleProjection = await convergeOnPublishedHead(
    manifest,
    authority.remoteHead,
    marker,
    port,
  );
  if (staleProjection !== null) return staleProjection;
  return ensureCompletionProjection(manifest, marker, summary, port);
}

function humanReason(detail: string): HumanReason {
  return {
    phase: 'implementing',
    code: 'implementation-escalation',
    detail,
  };
}

async function human(
  supplied: AttemptManifest,
  detail: string,
  port: ImplementationSessionPort,
): Promise<HumanHoldResult> {
  const manifest = requireImplementationManifest(supplied, port);
  const authority = await requireAuthority(manifest, port);
  if (authority.latestClaim.phaseComplete === true) {
    throw new Error('A phase-complete implementation cannot enter a Human hold');
  }
  const prNumber = manifest.prNumber!;
  const reason = humanReason(detail);
  const marker = formatHumanCommentMarker({
    issueNumber: manifest.issueNumber,
    prNumber,
    reason,
  });
  const body = `${marker}\n\nAutopilot parked this item for Human review.\n\n${detail}`;
  let pullRequest = await requireImplementationPullRequestAuthority(
    manifest,
    authority,
    port,
    false,
  );
  if (!pullRequest.draft) {
    await port.setPullRequestDraft(prNumber, authority.remoteHead, true);
    pullRequest = await requireImplementationPullRequestAuthority(
      manifest,
      authority,
      port,
      false,
    );
  }
  if (!pullRequest.labels.includes('engine:review')) {
    await port.setPullRequestLabel(
      prNumber,
      authority.remoteHead,
      'engine:review',
      true,
    );
    pullRequest = await requireImplementationPullRequestAuthority(
      manifest,
      authority,
      port,
      false,
    );
  }
  if (!pullRequest.labels.includes('review:needs-human')) {
    await port.setPullRequestLabel(
      prNumber,
      authority.remoteHead,
      'review:needs-human',
      true,
    );
    pullRequest = await requireImplementationPullRequestAuthority(
      manifest,
      authority,
      port,
      false,
    );
  }
  if (!await port.hasHumanComment(prNumber, authority.remoteHead, marker)) {
    await requireImplementationPullRequestAuthority(
      manifest,
      authority,
      port,
      false,
    );
    await port.ensureHumanComment(prNumber, authority.remoteHead, marker, body);
  }
  await requireImplementationPullRequestAuthority(
    manifest,
    authority,
    port,
    false,
  );
  // Stage 3: Human Status paint is painter-owned; label+marker are authority.
  pullRequest = await port.readPullRequest(prNumber, authority.remoteHead);
  if (pullRequest.head !== authority.remoteHead || !pullRequest.draft) {
    throw new Error('Human hold projection did not converge on a draft PR');
  }
  return { status: 'human', head: authority.remoteHead };
}

async function childComplete(
  supplied: AttemptManifest,
  port: ImplementationSessionPort,
): Promise<{ readonly status: 'closed' | 'rejected'; readonly detail?: string }> {
  const manifest = port.readManifest(supplied.paths.manifest);
  if (
    manifest.phase !== 'implement'
    || manifest.attemptId !== supplied.attemptId
    || manifest.issueNumber !== supplied.issueNumber
  ) {
    throw new Error('Child-complete manifest authority changed or is invalid');
  }
  const authority = await port.readAuthority(manifest);
  const claim = authority.latestClaim;
  if (claim.phase !== 'fix' && claim.phase !== 'reconcile') {
    return { status: 'rejected', detail: 'claim is not a child fix/reconcile phase' };
  }
  if (claim.issueNumber !== manifest.issueNumber) {
    return { status: 'rejected', detail: 'claim issue does not match child attempt' };
  }
  if (
    port.parentHeadReferencesChild === undefined
    || port.closeChildIssue === undefined
  ) {
    return { status: 'rejected', detail: 'child-complete port methods unavailable' };
  }
  const references = await port.parentHeadReferencesChild(
    manifest,
    authority.remoteHead,
    manifest.issueNumber,
  );
  if (!references) {
    return {
      status: 'rejected',
      detail: 'parent head is missing checkpoint trailers for this child',
    };
  }
  await port.closeChildIssue(
    manifest.issueNumber,
    `Closed by child-complete after landing on parent PR #${claim.prNumber}.`,
  );
  return { status: 'closed' };
}

export function makeImplementationSessionProtocol(
  port: ImplementationSessionPort,
): ImplementationSessionProtocol {
  return {
    checkpoint: (manifest) => checkpoint(manifest, port),
    implementationComplete: (manifest, summary) =>
      implementationComplete(manifest, summary, port),
    childComplete: (manifest) => childComplete(manifest, port),
    reviewVerdict: async () => notWired('review-verdict'),
    human: (manifest, reason) => human(manifest, reason, port),
  };
}

export function implementationSessionErrorDetail(error: unknown): string {
  return message(error);
}
