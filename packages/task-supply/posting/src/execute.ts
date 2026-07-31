// SPDX-License-Identifier: MIT

// Explicit post is the default (design §8): the plan -- terms and the computed escrow total -- is
// surfaced before a wei is spent, and an approval decision is required. Auto-post is an opt-in
// standing policy flag that pre-approves with THE SAME fields in a log line, so a standing policy
// is never quieter than a hand-approved one (visible-money-actions).
//
// Everything that touches the chain is injected. `postTask` is a parameter, not an import edge in
// disguise: it is the marketplace binding's today, the work client's at its mint (README, F7).
import {
  BroadcastUncertainError,
  type MarketplaceChainConfig,
  type PostingOutcome,
  type PostingPorts,
  type PostingTerms,
} from "@jinn-network/marketplace-binding";
import { buildDispatchSubmission } from "./dispatch-submission.js";
import type { PostingPlan, PostingPoolEntry } from "./types.js";

/** The posting core's shape. Swapped, not wrapped, when the work client mints (F7). */
export type PostTaskFn = (
  taskBytes: Uint8Array,
  submissionBytes: Uint8Array,
  terms: PostingTerms,
  config: MarketplaceChainConfig,
  creatorSafe: `0x${string}`,
  ports: PostingPorts,
) => Promise<PostingOutcome>;

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
  readonly chain: MarketplaceChainConfig;
  readonly ports: PostingPorts;
  readonly postTask: PostTaskFn;
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

  const posted: { taskDigest: `sha256:${string}`; taskId: bigint; txHash: `0x${string}` }[] = [];
  const uncertain: { taskDigest: `sha256:${string}`; detail: string }[] = [];
  let spentEscrowValueWei = 0n;

  for (const planEntry of plan.entries) {
    const entry = deps.entries.get(planEntry.taskDigest);
    if (entry === undefined) {
      throw new PostingRefusedError(
        "pool-entry-missing",
        `planned entry ${planEntry.taskDigest} is not in the supplied pool -- refusing to post a `
          + "batch whose bytes cannot be read",
      );
    }
    const submissionBytes = buildDispatchSubmission(entry, planEntry, plan);

    let outcome: PostingOutcome;
    try {
      // eslint-disable-next-line no-await-in-loop -- posts are sequential: one requester, one
      // nonce sequence, and one escrow balance draining as the batch proceeds.
      outcome = await deps.postTask(
        entry.taskBytes,
        submissionBytes,
        plan.terms,
        deps.chain,
        plan.creatorSafe,
        deps.ports,
      );
    } catch (error) {
      if (error instanceof BroadcastUncertainError) {
        // Never retried here: an uncertain broadcast is resolved by `recoverPostingIntents`
        // against the chain, not by posting again.
        uncertain.push({ taskDigest: planEntry.taskDigest, detail: error.message });
        deps.log.record({
          event: "posting.uncertain",
          fields: { taskDigest: planEntry.taskDigest, detail: error.message },
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
