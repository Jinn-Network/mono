import {
  AutopilotCorrelationSchema,
} from '@jinn-network/sdk/autopilot';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  readAttemptManifest,
} from './attempt-workspace.js';
import {
  publishAdoptionReceipt,
  readAdoptionReceiptState,
  type AdoptionReceiptPorts,
} from './marketplace-adoption-receipt.js';
import {
  makeProductionMarketplaceAdoptionReceiptPorts,
} from './marketplace-mutation-adoption-production.js';
import {
  adoptMarketplaceReview,
  type MarketplaceReviewAdoptionResult,
} from './marketplace-review-adoption.js';
import type {
  VerifiedMarketplaceVerdictDelivery,
} from './marketplace-delivery-client.js';
import {
  makeReviewSessionProtocol,
  type ReviewSessionPort,
} from './review-session.js';
import {
  makeProductionReviewSessionPort,
} from './review-session-production.js';

export interface ProductionMarketplaceReviewAdoptionOptions {
  readonly delivery: VerifiedMarketplaceVerdictDelivery;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  /** Test seams for the production recovery composition. */
  readonly readManifest?: (path: string) => ReturnType<typeof readAttemptManifest>;
  readonly sessionPort?: ReviewSessionPort;
  readonly receiptPorts?: AdoptionReceiptPorts;
}

export async function adoptProductionMarketplaceReview(
  options: ProductionMarketplaceReviewAdoptionOptions,
): Promise<MarketplaceReviewAdoptionResult> {
  const runner = options.runner ?? defaultRunner;
  const ambient = options.environment ?? process.env;
  const readManifest = options.readManifest ?? readAttemptManifest;
  let manifest = readManifest(
    options.delivery.review.manifestPath,
  );
  const reviewEnvironment = { ...ambient };
  delete reviewEnvironment.GH_TOKEN;
  delete reviewEnvironment.GITHUB_TOKEN;
  reviewEnvironment.JINN_AUTOPILOT_SESSION_MANIFEST =
    manifest.paths.manifest;
  const sessionPort =
    options.sessionPort
    ?? makeProductionReviewSessionPort({
      runner,
      environment: reviewEnvironment,
      now: options.now,
    });
  // A previous process may have won the append-only review-ref CAS and
  // crashed before advancing its local manifest. The production port repairs
  // only a direct, same-attempt descendant. Refresh before constructing the
  // adoption input so a valid recovered Verdict is never classified against
  // the stale in-memory pair.
  await sessionPort.readAuthority(manifest);
  manifest = readManifest(manifest.paths.manifest);
  const receiptPorts =
    options.receiptPorts
    ?? makeProductionMarketplaceAdoptionReceiptPorts({
      manifestPath: manifest.paths.manifest,
      runner,
      environment: ambient,
    });
  const expectedCorrelation = AutopilotCorrelationSchema.parse({
    taskId: options.delivery.task.id,
    attemptIndex: options.delivery.attempt.index,
    requestId: options.delivery.attempt.requestId,
    deliveryEnvelopeCid: options.delivery.envelope.cid,
    v2AttemptId: options.delivery.origin.v2AttemptId,
    claimOid: options.delivery.session.claimOid,
    prNumber: options.delivery.session.prNumber,
    expectedHead: options.delivery.session.expectedHead,
    resultingHead: options.delivery.review.head,
    reviewedHead: options.delivery.review.head,
    reviewGeneration: options.delivery.review.generation,
    reviewRefOid: options.delivery.review.refOid,
  });
  return adoptMarketplaceReview({
    manifest,
    expectedCorrelation,
    solverOperator: options.delivery.solutionOperator,
    evaluatorOperator: options.delivery.evaluator.address,
    result: options.delivery.result,
    receiptAuthors: options.delivery.session.receiptAuthors,
    publisherLogin: manifest.selectedLogin,
  }, {
    async readAuthority(current) {
      const authority = await sessionPort.readAuthority(current);
      return {
        claimOid: current.claimOid,
        head: authority.record.head,
        reviewGeneration: authority.record.generation,
        reviewRefOid: authority.reviewRefOid,
        reviewState: authority.record.state,
      };
    },
    protocol: makeReviewSessionProtocol(sessionPort),
    publishReceipt: (input) => publishAdoptionReceipt(input, receiptPorts),
    readReceiptState: (exactFacts, allowedAuthors) =>
      readAdoptionReceiptState(exactFacts, allowedAuthors, receiptPorts),
    now: options.now ?? (() => new Date()),
  });
}
