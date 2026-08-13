import { z } from 'zod/v3';
import {
  AutopilotCorrelationSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  autopilotCorrelationMatches,
} from './autopilot-session.js';

const SafeIntegerSchema = z.number().int().safe();
const NonNegativeSafeIntegerSchema = SafeIntegerSchema.nonnegative();
const Hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const GitOidSchema = z.string().regex(/^[0-9a-f]{40}$/);
const TaskIdSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const PositiveDecimalSchema = z.string().regex(/^[1-9][0-9]*$/);
const DeliveryRoleSchema = z.enum(['solution', 'verdict']);

const ExpectedCorrelationExtensionSchema = z.object({
  resultingHead: GitOidSchema.optional(),
  reviewedHead: GitOidSchema.optional(),
  reviewGeneration: z.string().uuid().optional(),
  reviewRefOid: GitOidSchema.optional(),
}).strict();

export const AutopilotDeliveryExpectationSchema = z.object({
  schemaVersion:
    z.literal('jinn-autopilot-delivery-observation-request.v1'),
  role: DeliveryRoleSchema,
  taskId: TaskIdSchema,
  taskCid: z.string().min(1),
  creationBlockNumber: NonNegativeSafeIntegerSchema,
  session: AutopilotSessionCapsuleSchema,
  attemptIndex: NonNegativeSafeIntegerSchema.optional(),
  requestId: Hex32Schema.optional(),
  deliveryEnvelopeCid: z.string().min(1).optional(),
  deliveryTransactionHash: Hex32Schema.optional(),
  deliveryBlockNumber: NonNegativeSafeIntegerSchema.optional(),
  solutionOperator: AddressSchema.optional(),
  expectedCorrelation: ExpectedCorrelationExtensionSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.attemptIndex === undefined) !== (value.requestId === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['attemptIndex'],
      message: 'attemptIndex and requestId must appear together',
    });
  }
  if (value.role === 'verdict' && value.solutionOperator === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['solutionOperator'],
      message: 'verdict observation requires solutionOperator',
    });
  }
});

export type AutopilotDeliveryExpectation = z.infer<
  typeof AutopilotDeliveryExpectationSchema
>;

export const AutopilotDeliveryPendingReasonSchema = z.enum([
  'task-not-indexed',
  'attempt-not-indexed',
  'envelope-not-indexed',
  'exact-indexer-required',
  'discovery-unavailable',
  'delivery-not-found',
  'rpc-unavailable',
  'publisher-identity-unavailable',
  'envelope-unavailable',
]);

export type AutopilotDeliveryPendingReason = z.infer<
  typeof AutopilotDeliveryPendingReasonSchema
>;

export const AutopilotDeliveryContradictionReasonSchema = z.enum([
  'multiple-tasks',
  'multiple-attempts',
  'multiple-verdicts',
  'multiple-envelopes',
  'inconsistent-indexer-data',
  'invalid-expectation',
  'discovery-mismatch',
  'publisher-mismatch',
  'evaluator-is-solver',
  'stale-attempt',
  'stale-delivery',
  'task-mismatch',
  'invalid-envelope-cid',
  'delivery-mismatch',
  'invalid-envelope',
  'envelope-mismatch',
  'invalid-result',
  'correlation-mismatch',
]);

export type AutopilotDeliveryContradictionReason = z.infer<
  typeof AutopilotDeliveryContradictionReasonSchema
>;

const PendingObservationSchema = z.object({
  status: z.literal('pending'),
  reason: AutopilotDeliveryPendingReasonSchema,
  detail: z.string().min(1).optional(),
}).strict();

const ContradictionObservationSchema = z.object({
  status: z.literal('contradiction'),
  reason: AutopilotDeliveryContradictionReasonSchema,
  detail: z.string().min(1),
}).strict();

const VerifiedTaskSchema = z.object({
  taskId: TaskIdSchema,
  taskCid: z.string().min(1),
  taskCidDigest: Hex32Schema,
  createdAtBlock: NonNegativeSafeIntegerSchema,
  createdAtTx: Hex32Schema,
}).strict();

const VerifiedAttemptSchema = z.object({
  attemptIndex: NonNegativeSafeIntegerSchema,
  requestId: Hex32Schema,
  operator: AddressSchema,
  createdAtBlock: NonNegativeSafeIntegerSchema.nullable(),
}).strict();

const VerifiedDeliverySchema = z.object({
  envelopeCid: z.string().min(1),
  envelopeDigest: Hex32Schema,
  publisherAgentId: PositiveDecimalSchema,
  transactionHash: Hex32Schema,
  blockNumber: NonNegativeSafeIntegerSchema,
}).strict();

const AuthenticatedEnvelopeProvenanceSchema = z.object({
  cid: z.string().min(1),
  digest: Hex32Schema,
  executionSchema: z.literal('jinn.execution.v1'),
  solverType: z.literal('jinn-repo.v1'),
  role: DeliveryRoleSchema,
  participant: z.object({
    safeAddress: AddressSchema,
    agentEoa: AddressSchema,
  }).strict(),
  signer: AddressSchema,
}).strict();

const verifiedCommonFields = {
  status: z.literal('verified'),
  task: VerifiedTaskSchema,
  attempt: VerifiedAttemptSchema,
  delivery: VerifiedDeliverySchema,
  envelope: AuthenticatedEnvelopeProvenanceSchema,
  session: AutopilotSessionCapsuleSchema,
  correlation: AutopilotCorrelationSchema,
};

const VerifiedSolutionObservationSchema = z.object({
  ...verifiedCommonFields,
  role: z.literal('solution'),
  envelope: AuthenticatedEnvelopeProvenanceSchema.extend({
    role: z.literal('solution'),
  }).strict(),
  result: AutopilotMutationResultSchema,
}).strict();

const VerifiedVerdictObservationSchema = z.object({
  ...verifiedCommonFields,
  role: z.literal('verdict'),
  envelope: AuthenticatedEnvelopeProvenanceSchema.extend({
    role: z.literal('verdict'),
  }).strict(),
  result: AutopilotReviewResultSchema,
}).strict();

const VerifiedObservationSchema = z.union([
  VerifiedSolutionObservationSchema,
  VerifiedVerdictObservationSchema,
]).superRefine((value, ctx) => {
  const mismatch = (path: Array<string | number>, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
  };
  const sameAddress = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();
  const bindings: Array<[
    unknown,
    unknown,
    Array<string | number>,
    string,
  ]> = [
    [value.task.taskId, value.correlation.taskId, ['task', 'taskId'], 'Task ID'],
    [
      value.attempt.attemptIndex,
      value.correlation.attemptIndex,
      ['attempt', 'attemptIndex'],
      'attempt index',
    ],
    [
      value.attempt.requestId.toLowerCase(),
      value.correlation.requestId.toLowerCase(),
      ['attempt', 'requestId'],
      'request ID',
    ],
    [
      value.delivery.envelopeCid,
      value.correlation.deliveryEnvelopeCid,
      ['delivery', 'envelopeCid'],
      'delivery envelope CID',
    ],
    [
      value.envelope.cid,
      value.delivery.envelopeCid,
      ['envelope', 'cid'],
      'envelope CID',
    ],
    [
      value.envelope.digest.toLowerCase(),
      value.delivery.envelopeDigest.toLowerCase(),
      ['envelope', 'digest'],
      'envelope digest',
    ],
    [
      value.session.v2AttemptId,
      value.correlation.v2AttemptId,
      ['session', 'v2AttemptId'],
      'V2 attempt ID',
    ],
    [
      value.session.claimOid,
      value.correlation.claimOid,
      ['session', 'claimOid'],
      'claim OID',
    ],
    [
      value.session.prNumber,
      value.correlation.prNumber,
      ['session', 'prNumber'],
      'PR number',
    ],
    [
      value.session.expectedHead,
      value.correlation.expectedHead,
      ['session', 'expectedHead'],
      'expected head',
    ],
  ];
  for (const [actual, expected, path, label] of bindings) {
    if (actual !== expected) {
      mismatch(path, `Verified ${label} does not match correlation`);
    }
  }
  if (!sameAddress(
    value.envelope.participant.safeAddress,
    value.attempt.operator,
  )) {
    mismatch(
      ['envelope', 'participant', 'safeAddress'],
      'Authenticated participant Safe does not match attempt operator',
    );
  }
  if (!sameAddress(value.envelope.signer, value.envelope.participant.agentEoa)) {
    mismatch(
      ['envelope', 'signer'],
      'Authenticated envelope signer does not match participant agent EOA',
    );
  }
  if (!autopilotCorrelationMatches(
    value.correlation,
    value.result.correlation,
  )) {
    mismatch(
      ['result', 'correlation'],
      'Authenticated result correlation does not match delivery correlation',
    );
  }
});

export const AutopilotDeliveryObservationSchema = z.union([
  PendingObservationSchema,
  ContradictionObservationSchema,
  VerifiedObservationSchema,
]);

export type AutopilotDeliveryObservation = z.infer<
  typeof AutopilotDeliveryObservationSchema
>;

// `AutopilotDeliveryCommandResultV1Schema` — the machine-command envelope whose
// `verb` literal was `'tasks observe-autopilot-delivery'` — was removed by
// one-swap R3b (issue #2494) together with that CLI verb. Both of its producers
// (the verb itself and the Autopilot lifecycle client that shelled out to it)
// are gone, and the published `Jinn-Network/autopilot` engine never referenced
// it. The delivery expectation and observation schemas above are unchanged:
// they describe the delivery, not the retired command that carried it.
