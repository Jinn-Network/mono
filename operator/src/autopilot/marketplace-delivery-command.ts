import {
  AutopilotDeliveryExpectationSchema,
  AutopilotDeliveryObservationSchema,
  type AutopilotDeliveryExpectation,
  type AutopilotDeliveryObservation,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';

import type {
  AutopilotMarketplaceDeliveryObservation,
  AutopilotMarketplaceDeliveryObserver,
} from './marketplace-delivery-observer.js';

export const AutopilotDeliveryObservationRequestSchema =
  AutopilotDeliveryExpectationSchema;
export type AutopilotDeliveryObservationRequest =
  AutopilotDeliveryExpectation;

export interface AutopilotDeliveryObservationCommandDeps {
  readonly chainId: number;
  readonly observer: AutopilotMarketplaceDeliveryObserver;
  latestBlockNumber(): Promise<bigint>;
}

export type JsonAutopilotMarketplaceDeliveryObservation =
  AutopilotDeliveryObservation;

function jsonObservation(
  observation: AutopilotMarketplaceDeliveryObservation,
  session: AutopilotSessionCapsule,
): JsonAutopilotMarketplaceDeliveryObservation {
  if (observation.status !== 'verified') {
    return AutopilotDeliveryObservationSchema.parse(observation);
  }
  const blockNumber = Number(observation.delivery.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error('Verified delivery block cannot be represented as JSON');
  }
  return AutopilotDeliveryObservationSchema.parse({
    ...observation,
    delivery: {
      ...observation.delivery,
      blockNumber,
    },
    session,
    envelope: {
      cid: observation.delivery.envelopeCid,
      digest: observation.delivery.envelopeDigest,
      executionSchema: observation.envelope.schemaVersion,
      solverType: observation.envelope.solverType,
      role: observation.role,
      participant: {
        safeAddress: observation.envelope.participant.safeAddress,
        agentEoa: observation.envelope.participant.agentEoa,
      },
      signer: observation.envelope.signature.signer,
    },
  });
}

export async function observeAutopilotMarketplaceDelivery(
  input: unknown,
  deps: AutopilotDeliveryObservationCommandDeps,
): Promise<JsonAutopilotMarketplaceDeliveryObservation> {
  const request = AutopilotDeliveryExpectationSchema.parse(input);
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
  return jsonObservation(observation, request.session);
}
