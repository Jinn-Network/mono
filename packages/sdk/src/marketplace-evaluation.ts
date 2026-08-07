import { z } from 'zod/v3';

export const MARKETPLACE_EVALUATION_PROVENANCE_CONTEXT_KEY =
  'jinn.marketplace.evaluation-provenance.v1' as const;

export const MarketplaceEvaluationProvenanceV1Schema = z.object({
  schemaVersion: z.literal('jinn-marketplace-evaluation-provenance.v1'),
  sourceTaskId: z.string().regex(/^(0|[1-9][0-9]*)$/),
  sourceTaskCid: z.string().min(1),
  attemptIndex: z.number().int().safe().nonnegative(),
  solutionRequestId: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  solutionEnvelopeCid: z.string().min(1),
  solutionOperatorSafe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  evaluatorOperatorSafe: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
}).strict();

export type MarketplaceEvaluationProvenanceV1 = z.infer<
  typeof MarketplaceEvaluationProvenanceV1Schema
>;
