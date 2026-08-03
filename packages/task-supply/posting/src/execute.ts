// SPDX-License-Identifier: MIT

// Explicit post is the default (design §8): the plan -- terms and the computed escrow total -- is
// surfaced before a wei is spent, and an approval decision is required. Auto-post is an opt-in
// standing policy flag that pre-approves with THE SAME fields in a log line, so a standing policy
// is never quieter than a hand-approved one (visible-money-actions).
//
// Everything that touches the chain is injected. The requester backend is the sole posting and
// recovery authority; this package retains only selection, terms, approval, batching and logging.
import {
  BroadcastUncertainError,
  postingEscrowValueWei,
  type MarketplaceRequesterBackend,
  type PostingOutcome,
} from "@jinn-network/marketplace-binding";
import { buildDispatchSubmission } from "./dispatch-submission.js";
import type { PostingPlan, PostingPlanEntry, PostingPoolEntry } from "./types.js";

/** Shows the operator what is about to be spent. Rendering is the host's job, not this package's. */
export interface PostingRenderPort {
  renderPlan(plan: PostingPlan): void | Promise<void>;
}

export type PostingApproval =
  | { readonly approved: true }
  | { readonly approved: false; readonly reason: string };

export interface PostingApprovalPort {
  approvePlan(plan: PostingPlan): Promise<PostingApproval>;
}

export interface PostingLogLine {
  readonly event:
    | "posting.plan-surfaced"
    | "posting.auto-approved"
    | "posting.approved"
    | "posting.refused"
    | "posting.posted"
    | "posting.uncertain";
  readonly fields: Readonly<Record<string, string>>;
}

/** Structured sink; this package never writes to an ambient console. */
export interface PostingLogPort {
  record(line: PostingLogLine): void;
}

export interface PostingDeps {
  /** Task digest -> pool entry. The plan carries digests; the bytes are read here. */
  readonly entries: ReadonlyMap<string, PostingPoolEntry>;
  /**
   * Sole authority for requester scope, posting WAL and recovered outcome reconciliation.
   * The host composes it with the same creator and terms used to construct the plan.
   */
  readonly backend: MarketplaceRequesterBackend;
  readonly render: PostingRenderPort;
  readonly approval: PostingApprovalPort;
  readonly log: PostingLogPort;
}

export interface PostingRunSummary {
  readonly posted: readonly {
    readonly taskDigest: `sha256:${string}`;
    readonly taskId: bigint;
    readonly txHash: `0x${string}`;
  }[];
  readonly uncertain: readonly { readonly taskDigest: `sha256:${string}`; readonly detail: string }[];
  /** Set only when approval was withheld; the batch then spent nothing. */
  readonly refused?: string;
  readonly spentEscrowValueWei: bigint;
}

export class PostingRefusedError extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = "PostingRefusedError";
  }
}

/** The money fields, identical for the explicit and the auto path. */
function planFields(plan: PostingPlan): Record<string, string> {
  return {
    createdAt: plan.createdAt,
    creatorSafe: plan.creatorSafe,
    requester: plan.requester,
    entries: String(plan.entries.length),
    totalEscrowValueWei: String(plan.totalEscrowValueWei),
    solutionMaxDeliveryRateWei: String(plan.terms.solutionMaxDeliveryRateWei),
    verdictMaxDeliveryRateWei: String(plan.terms.verdictMaxDeliveryRateWei),
    responseTimeoutSeconds: String(plan.terms.responseTimeoutSeconds),
    maxClaims: String(plan.terms.maxClaims),
    allowSolverSelfEvaluation: String(plan.terms.allowSolverSelfEvaluation),
  };
}

interface PreparedEntry {
  readonly planEntry: PostingPlanEntry;
  readonly entry: PostingPoolEntry;
  readonly submissionBytes: Uint8Array;
}

/**
 * Everything checkable about the batch, checked before the first wei leaves: the bytes for every
 * planned digest are in hand, every entry's escrow is the escrow the plan's own terms imply, and
 * every dispatch Submission seals. All three are pure, so a refusal raised from inside the post
 * loop would only mean earlier entries were already posted and escrowed when it fired.
 *
 * The escrow re-derivation is the same class of check as the `maxClaims` gate one layer down:
 * the requester backend computes the real `msg.value` from its configured terms and the sealed
 * `attempts.maxTotal`. A plan carrying an understated `escrowValueWei` would render, log, and
 * total a number that is not what the chain is sent.
 */
function prepareBatch(deps: PostingDeps, plan: PostingPlan): readonly PreparedEntry[] {
  const expectedEscrowValueWei = postingEscrowValueWei(plan.terms);
  return plan.entries.map((planEntry) => {
    const entry = deps.entries.get(planEntry.taskDigest);
    if (entry === undefined) {
      throw new PostingRefusedError(
        "pool-entry-missing",
        `planned entry ${planEntry.taskDigest} is not in the supplied pool -- refusing to post a `
          + "batch whose bytes cannot be read",
      );
    }
    if (planEntry.escrowValueWei !== expectedEscrowValueWei) {
      throw new PostingRefusedError(
        "escrow-disagrees-with-terms",
        `planned entry ${planEntry.taskDigest} carries escrow ${planEntry.escrowValueWei} wei, but `
          + `this plan's terms imply ${expectedEscrowValueWei} wei -- the surfaced total would not `
          + "be what is sent",
      );
    }
    return { planEntry, entry, submissionBytes: buildDispatchSubmission(entry, planEntry, plan) };
  });
}

function uncertainOperationDetail(error: unknown): string | undefined {
  if (error instanceof BroadcastUncertainError) return error.message;
  // MarketplaceRequesterBackend exposes operational failures through TaskExecutionBackend's
  // error contract. Avoid a second runtime package edge just to recognize the generic shape.
  if (
    error instanceof Error
    && error.name === "TaskExecutionError"
    && "category" in error
    && error.category === "backend-unavailable"
    && "retryable" in error
    && error.retryable === true
  ) {
    const detail = "detail" in error ? error.detail : undefined;
    return typeof detail === "string" ? detail : error.message;
  }
  return undefined;
}

export async function executePosting(
  deps: PostingDeps,
  plan: PostingPlan,
): Promise<PostingRunSummary> {
  await deps.render.renderPlan(plan);
  deps.log.record({ event: "posting.plan-surfaced", fields: planFields(plan) });

  if (plan.approval === "auto") {
    deps.log.record({ event: "posting.auto-approved", fields: planFields(plan) });
  } else {
    const decision = await deps.approval.approvePlan(plan);
    if (!decision.approved) {
      deps.log.record({
        event: "posting.refused",
        fields: { ...planFields(plan), reason: decision.reason },
      });
      return { posted: [], uncertain: [], refused: decision.reason, spentEscrowValueWei: 0n };
    }
    deps.log.record({ event: "posting.approved", fields: planFields(plan) });
  }

  // After the approval gate (a withheld plan is never inspected further) and before the first
  // post: the whole batch is resolved and sealed, so a refusal cannot land mid-spend.
  const prepared = prepareBatch(deps, plan);

  const posted: { taskDigest: `sha256:${string}`; taskId: bigint; txHash: `0x${string}` }[] = [];
  const uncertain: { taskDigest: `sha256:${string}`; detail: string }[] = [];
  let spentEscrowValueWei = 0n;

  for (const { planEntry, entry, submissionBytes } of prepared) {
    let outcome: PostingOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop -- posts are sequential: one requester, one
      // nonce sequence, and one escrow balance draining as the batch proceeds.
      outcome = await deps.backend.post(entry.taskBytes, submissionBytes);
    } catch (error) {
      const detail = uncertainOperationDetail(error);
      if (detail !== undefined) {
        // Never retried here: the requester backend resolves uncertain work through
        // `recoverPosting()` and canonical evidence, not by posting again.
        uncertain.push({ taskDigest: planEntry.taskDigest, detail });
        deps.log.record({
          event: "posting.uncertain",
          fields: { taskDigest: planEntry.taskDigest, detail },
        });
        continue;
      }
      throw error;
    }

    posted.push({ taskDigest: planEntry.taskDigest, taskId: outcome.taskId, txHash: outcome.txHash });
    spentEscrowValueWei += planEntry.escrowValueWei;
    deps.log.record({
      event: "posting.posted",
      fields: {
        taskDigest: planEntry.taskDigest,
        taskId: String(outcome.taskId),
        txHash: outcome.txHash,
        escrowValueWei: String(planEntry.escrowValueWei),
      },
    });
  }

  return { posted, uncertain, spentEscrowValueWei };
}
