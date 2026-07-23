import { z } from 'zod';
import {
  AutopilotSessionCapsuleSchema,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/solvernets/jinn-repo';

import type {
  AutopilotMarketplaceDeliveryObservation,
  AutopilotMarketplaceDeliveryObserver,
} from './marketplace-delivery-observer.js';

const Hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const NonNegativeIntegerSchema = z.number().int().nonnegative().safe();

const ExpectedCorrelationSchema = z.object({
  resultingHead: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  reviewedHead: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  reviewGeneration: z.string().uuid().optional(),
  reviewRefOid: z.string().regex(/^[0-9a-f]{40}$/).optional(),
}).strict();

export const AutopilotDeliveryObservationRequestSchema = z.object({
  schemaVersion:
    z.literal('jinn-autopilot-delivery-observation-request.v1'),
  role: z.enum(['solution', 'verdict']),
  taskId: z.string().regex(/^(0|[1-9][0-9]*)$/),
  taskCid: z.string().min(1),
  creationBlockNumber: NonNegativeIntegerSchema,
  // The SDK currently owns a different Zod major than the client, so parse
  // this boundary with the SDK codec after the client-owned envelope.
  session: z.unknown(),
  attemptIndex: NonNegativeIntegerSchema.optional(),
  requestId: Hex32Schema.optional(),
  deliveryEnvelopeCid: z.string().min(1).optional(),
  deliveryTransactionHash: Hex32Schema.optional(),
  deliveryBlockNumber: NonNegativeIntegerSchema.optional(),
  solutionOperator: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  expectedCorrelation: ExpectedCorrelationSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.attemptIndex === undefined) !== (value.requestId === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'attemptIndex and requestId must appear together',
    });
  }
  if (value.role === 'verdict' && value.solutionOperator === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'verdict observation requires solutionOperator',
    });
  }
});

export type AutopilotDeliveryObservationRequest = Omit<
  z.infer<typeof AutopilotDeliveryObservationRequestSchema>,
  'session'
> & {
  readonly session: AutopilotSessionCapsule;
};

export interface AutopilotDeliveryObservationCommandDeps {
  readonly chainId: number;
  readonly observer: AutopilotMarketplaceDeliveryObserver;
  latestBlockNumber(): Promise<bigint>;
}

export type JsonAutopilotMarketplaceDeliveryObservation =
  | Exclude<AutopilotMarketplaceDeliveryObservation, { status: 'verified' }>
  | (
      Omit<
        Extract<
          AutopilotMarketplaceDeliveryObservation,
          { status: 'verified' }
        >,
        'delivery'
      >
      & {
        readonly delivery: Omit<
          Extract<
            AutopilotMarketplaceDeliveryObservation,
            { status: 'verified' }
          >['delivery'],
          'blockNumber'
        > & {
          readonly blockNumber: number;
        };
      }
    );

function jsonObservation(
  observation: AutopilotMarketplaceDeliveryObservation,
): JsonAutopilotMarketplaceDeliveryObservation {
  if (observation.status !== 'verified') return observation;
  const blockNumber = Number(observation.delivery.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('Verified delivery block cannot be represented as JSON');
  }
  return {
    ...observation,
    delivery: {
      ...observation.delivery,
      blockNumber,
    },
  };
}

export async function observeAutopilotMarketplaceDelivery(
  input: unknown,
  deps: AutopilotDeliveryObservationCommandDeps,
): Promise<JsonAutopilotMarketplaceDeliveryObservation> {
  const envelope = AutopilotDeliveryObservationRequestSchema.parse(input);
  const request: AutopilotDeliveryObservationRequest = {
    ...envelope,
    session: AutopilotSessionCapsuleSchema.parse(envelope.session),
  };
  if (!Number.isSafeInteger(deps.chainId) || deps.chainId <= 0) {
    throw new Error('Autopilot delivery observer chain ID is invalid');
  }
  const toBlock = await deps.latestBlockNumber();
  const fromBlock = BigInt(request.creationBlockNumber);
  if (toBlock < fromBlock) {
    throw new Error('Latest chain block predates the marketplace Task');
  }
  const observation = await deps.observer.observe({
    chainId: deps.chainId,
    role: request.role,
    taskId: request.taskId,
    taskCid: request.taskCid,
    session: request.session,
    fromBlock,
    toBlock,
    ...(request.attemptIndex === undefined
      ? {}
      : {
          attemptIndex: request.attemptIndex,
          requestId: request.requestId!,
        }),
    ...(request.deliveryEnvelopeCid === undefined
      ? {}
      : { deliveryEnvelopeCid: request.deliveryEnvelopeCid }),
    ...(request.deliveryTransactionHash === undefined
      ? {}
      : { deliveryTransactionHash: request.deliveryTransactionHash }),
    ...(request.deliveryBlockNumber === undefined
      ? {}
      : { deliveryBlockNumber: BigInt(request.deliveryBlockNumber) }),
    ...(request.solutionOperator === undefined
      ? {}
      : { solutionOperator: request.solutionOperator }),
    ...(request.expectedCorrelation === undefined
      ? {}
      : { expectedCorrelation: request.expectedCorrelation }),
  });
  return jsonObservation(observation);
}
