/**
 * ERC-8004 ReputationRegistry surface.
 *
 * See `registry.ts` for the typed client and `feedback-hook.ts` for the
 * evaluator-delivery hook + score-mapping policy. Spec: DR §4.3 in
 * `docs/superpowers/specs/2026-04-27-erc-8004-entity-model-design.md`.
 */

export {
  ReputationRegistryClient,
  REPUTATION_REGISTRY_ADDRESSES,
  REPUTATION_REGISTRY_ABI,
  getReputationRegistryAddress,
  ZERO_HASH,
  type ReputationRegistryConfig,
  type FeedbackRecord,
  type FeedbackId,
  type FeedbackSummary,
  type GiveFeedbackArgs,
  type RespondToFeedbackArgs,
  type RevokeFeedbackArgs,
} from './registry.js';

export {
  submitEvaluatorFeedback,
  mapVerdictToScore,
  type EvaluatorVerdict,
  type RestorerExecutionRef,
  type ScoreMapping,
  type FeedbackHookOutcome,
} from './feedback-hook.js';
