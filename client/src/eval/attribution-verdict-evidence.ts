/**
 * Offline attribution verdict grounding.
 *
 * Canonical signed envelopes are the outcome authority. The embedded
 * marketplace rows are retained only to constrain the exact
 * attempt/verdict tuple, evidence-hash join, and verdict-code agreement; a
 * row or ref alone never authenticates or determines `acceptedDiff`.
 */

import {
  SweRebenchV2SolutionPayloadSchema,
  SweRebenchV2VerdictPayloadSchema,
} from '@jinn-network/sdk/solvernets/swe-rebench-v2';
import { z } from 'zod';

import { VerdictCode } from '../adapters/mech/verdict-code.js';
import { authenticateExecutionEnvelope } from '../conformance/execution-envelope-authenticator.js';

const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const PositiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/);
const RequestIdSchema = Bytes32Schema;
const MarketplaceVerdictCodeSchema = z.union([
  z.literal(VerdictCode.Pass),
  z.literal(VerdictCode.Fail),
]);

const MarketplaceAttemptSchema = z.object({
  chainId: z.number().int().positive(),
  taskId: PositiveDecimalSchema,
  attemptIndex: z.number().int().nonnegative(),
  requestId: RequestIdSchema,
  operator: AddressSchema,
  evidenceHash: Bytes32Schema,
}).strict();

const MarketplaceVerdictSchema = z.object({
  chainId: z.number().int().positive(),
  taskId: PositiveDecimalSchema,
  attemptIndex: z.number().int().nonnegative(),
  verdictIndex: z.number().int().nonnegative(),
  requestId: RequestIdSchema,
  evaluator: AddressSchema,
  verdictCode: MarketplaceVerdictCodeSchema,
  evidenceHash: Bytes32Schema,
}).strict();

export const AttributionVerdictProofSchema = z.object({
  schema: z.literal('jinn.attribution-marketplace-verdict-proof.v1'),
  marketplace: z.object({
    attempt: MarketplaceAttemptSchema,
    verdict: MarketplaceVerdictSchema,
  }).strict(),
  solutionEnvelope: z.unknown(),
  verdictEnvelope: z.unknown(),
}).strict();

export type AttributionVerdictProof = z.infer<typeof AttributionVerdictProofSchema>;

export interface VerifiedAttributionVerdict {
  acceptedDiff: boolean;
  unscorable: false;
  verdictRef: string;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function requiredTaskField(
  task: unknown,
  field: 'requestId' | 'instanceId',
  sourceName: string,
): string {
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new Error(`${sourceName}.task is required`);
  }
  const value = (task as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${sourceName}.task.${field} is required`);
  }
  return value;
}

export async function verifyAttributionVerdictProof(
  input: unknown,
  expectedInstanceId: string,
): Promise<VerifiedAttributionVerdict> {
  const proof = AttributionVerdictProofSchema.parse(input);
  const [solution, verdict] = await Promise.all([
    authenticateExecutionEnvelope(proof.solutionEnvelope, 'attribution solution envelope'),
    authenticateExecutionEnvelope(proof.verdictEnvelope, 'attribution verdict envelope'),
  ]);

  if (solution.role !== 'solution' || solution.solverType !== 'swe-rebench-v2.v1') {
    throw new Error('attribution solution envelope must be a swe-rebench-v2 solution');
  }
  if (verdict.role !== 'verdict' || verdict.solverType !== 'swe-rebench-v2.v1') {
    throw new Error('attribution verdict envelope must be a swe-rebench-v2 verdict');
  }

  const attempt = proof.marketplace.attempt;
  const verdictRow = proof.marketplace.verdict;
  if (
    attempt.chainId !== verdictRow.chainId
    || attempt.taskId !== verdictRow.taskId
    || attempt.attemptIndex !== verdictRow.attemptIndex
  ) {
    throw new Error('marketplace attempt and verdict rows do not share one exact tuple');
  }

  const solutionRequestId = requiredTaskField(
    solution.task,
    'requestId',
    'attribution solution envelope',
  );
  const verdictRequestId = requiredTaskField(
    verdict.task,
    'requestId',
    'attribution verdict envelope',
  );
  if (!sameHex(solutionRequestId, attempt.requestId)) {
    throw new Error('attribution solution request does not match the marketplace attempt');
  }
  if (!sameHex(verdictRequestId, verdictRow.requestId)) {
    throw new Error('attribution verdict request does not match the marketplace verdict');
  }

  const solutionInstanceId = requiredTaskField(
    solution.task,
    'instanceId',
    'attribution solution envelope',
  );
  const verdictInstanceId = requiredTaskField(
    verdict.task,
    'instanceId',
    'attribution verdict envelope',
  );
  if (
    solutionInstanceId !== expectedInstanceId
    || verdictInstanceId !== expectedInstanceId
  ) {
    throw new Error('signed envelopes do not match the recorded instance');
  }
  if (!sameHex(solution.participant.safeAddress, attempt.operator)) {
    throw new Error('attribution solution participant Safe does not match the marketplace operator');
  }
  if (!sameHex(verdict.participant.safeAddress, verdictRow.evaluator)) {
    throw new Error('attribution verdict participant Safe does not match the marketplace evaluator');
  }
  if (!sameHex(solution.signature.hash, attempt.evidenceHash)) {
    throw new Error('attribution solution evidence hash does not match the signed envelope');
  }
  if (!sameHex(verdict.signature.hash, verdictRow.evidenceHash)) {
    throw new Error('attribution verdict evidence hash does not match the signed envelope');
  }

  SweRebenchV2SolutionPayloadSchema.parse(solution.payload);
  const signedVerdict = SweRebenchV2VerdictPayloadSchema.parse(verdict.payload);
  const expectedVerdictCode = signedVerdict.passed_match
    ? VerdictCode.Pass
    : VerdictCode.Fail;
  if (verdictRow.verdictCode !== expectedVerdictCode) {
    throw new Error('marketplace verdict code contradicts signed verdict passed_match');
  }
  if (signedVerdict.score !== (signedVerdict.passed_match ? 1 : 0)) {
    throw new Error('signed verdict score contradicts passed_match');
  }

  return {
    acceptedDiff: signedVerdict.passed_match,
    unscorable: false,
    verdictRef:
      `verdict:${verdictRow.chainId}:${verdictRow.taskId}:`
      + `${verdictRow.attemptIndex}:${verdictRow.verdictIndex}:${verdictRow.requestId}`,
  };
}
