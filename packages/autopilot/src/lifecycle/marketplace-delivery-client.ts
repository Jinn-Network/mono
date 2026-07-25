import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AutopilotDeliveryCommandResultV1Schema,
  AutopilotDeliveryExpectationSchema,
  AutopilotMutationResultSchema,
  AutopilotReviewResultSchema,
  AutopilotSessionCapsuleSchema,
  TaskSubmitRequestV1Schema,
  type AutopilotDeliveryObservation,
  type AutopilotReviewResult,
  type AutopilotSessionCapsule,
} from '@jinn-network/sdk/autopilot';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  recordMarketplaceSolutionDelivery,
  recordMarketplaceVerdictDelivery,
} from './marketplace-mutation-manifest.js';
import {
  marketplaceCommandEnvironment,
} from './marketplace-session-backend.js';
import type {
  MarketplaceMutationDeliveryReference,
  VerifiedMarketplaceSolutionDelivery,
} from './marketplace-mutation-adoption.js';

const OBSERVATION_SCHEMA =
  'jinn-autopilot-delivery-observation-request.v1' as const;
const TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export type MarketplaceSolutionObservation =
  | {
      readonly status: 'pending';
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: 'contradiction';
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly status: 'verified';
      readonly reference: MarketplaceMutationDeliveryReference;
      readonly delivery: VerifiedMarketplaceSolutionDelivery;
    };

export interface VerifiedMarketplaceVerdictDelivery {
  readonly schemaVersion: 'jinn-autopilot-verified-verdict-delivery.v1';
  readonly task: {
    readonly id: string;
    readonly creationTransactionHash: string;
    readonly creationBlockNumber: number;
    readonly solverNetManifestCid?: string;
  };
  readonly origin: {
    readonly v2AttemptId: string;
    readonly manifestPath: string;
  };
  readonly review: {
    readonly attemptId: string;
    readonly manifestPath: string;
    readonly head: string;
    readonly generation: string;
    readonly refOid: string;
    readonly reviewer: string;
  };
  readonly attempt: {
    readonly index: number;
    readonly requestId: string;
  };
  readonly solutionOperator: string;
  readonly evaluator: {
    readonly publisherAgentId: string;
    readonly address: string;
  };
  readonly envelope: {
    readonly cid: string;
    readonly author: string;
  };
  readonly transaction: {
    readonly hash: string;
    readonly blockNumber: number;
  };
  readonly result: AutopilotReviewResult;
  readonly session: AutopilotSessionCapsule;
}

export type MarketplaceVerdictObservation =
  | {
      readonly status: 'pending';
      readonly reason: string;
      readonly detail?: string;
    }
  | {
      readonly status: 'contradiction';
      readonly reason: string;
      readonly detail: string;
    }
  | {
      readonly status: 'verified';
      readonly delivery: VerifiedMarketplaceVerdictDelivery;
    };

export interface MarketplaceDeliveryClientOptions {
  readonly cliBin?: string;
  readonly runner?: CommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Malformed ${name}`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Malformed ${name}`);
  }
  return value;
}

function integerField(value: unknown, name: string): number {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    throw new Error(`Malformed ${name}`);
  }
  return value;
}

function sessionFromRequest(manifest: AttemptManifest): AutopilotSessionCapsule {
  if (
    manifest.execution.backend !== 'marketplace'
    || manifest.execution.requestFile === undefined
  ) {
    throw new Error('Marketplace attempt has no immutable request file');
  }
  const request = TaskSubmitRequestV1Schema.parse(
    JSON.parse(readFileSync(manifest.execution.requestFile, 'utf8')),
  );
  return AutopilotSessionCapsuleSchema.parse(request.spec.session);
}

function observationRequest(
  manifest: AttemptManifest,
  session: AutopilotSessionCapsule,
): Record<string, unknown> {
  const execution = manifest.execution;
  if (
    execution.backend !== 'marketplace'
    || execution.taskId === undefined
    || execution.taskCid === undefined
    || execution.creationTransactionHash === undefined
    || execution.creationBlockNumber === undefined
  ) {
    throw new Error(
      'Marketplace attempt is missing its Task identity or creation provenance',
    );
  }
  return AutopilotDeliveryExpectationSchema.parse({
    schemaVersion: OBSERVATION_SCHEMA,
    role: 'solution',
    taskId: execution.taskId,
    taskCid: execution.taskCid,
    creationBlockNumber: execution.creationBlockNumber,
    session,
    ...(execution.attemptIndex === undefined
      ? {}
      : {
          attemptIndex: execution.attemptIndex,
          requestId: execution.requestId,
        }),
    ...(execution.deliveryEnvelopeCid === undefined
      ? {}
      : { deliveryEnvelopeCid: execution.deliveryEnvelopeCid }),
    ...(execution.deliveryTx === undefined
      ? {}
      : {
          deliveryTransactionHash: execution.deliveryTx,
          deliveryBlockNumber: execution.deliveryBlockNumber,
        }),
  });
}

function writeObservationRequest(
  manifest: AttemptManifest,
  value: Record<string, unknown>,
  fileName = 'marketplace-solution-observation.json',
): string {
  const target = join(
    dirname(manifest.paths.manifest),
    fileName,
  );
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
    flag: 'w',
  });
  chmodSync(temporary, 0o600);
  renameSync(temporary, target);
  return target;
}

function parseMachineObservation(raw: string): AutopilotDeliveryObservation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Autopilot delivery observation returned malformed JSON');
  }
  const decoded = AutopilotDeliveryCommandResultV1Schema.safeParse(parsed);
  if (!decoded.success) {
    throw new Error(
      'Autopilot delivery observation response is outside the SDK contract',
      { cause: decoded.error },
    );
  }
  return decoded.data.observation;
}

function verifiedDelivery(
  manifest: AttemptManifest,
  session: AutopilotSessionCapsule,
  observation: Extract<AutopilotDeliveryObservation, { status: 'verified' }>,
): VerifiedMarketplaceSolutionDelivery {
  const execution = manifest.execution;
  if (
    execution.backend !== 'marketplace'
    || execution.taskId === undefined
    || execution.taskCid === undefined
    || execution.creationTransactionHash === undefined
    || execution.creationBlockNumber === undefined
  ) {
    throw new Error('Marketplace attempt lost Task provenance');
  }
  const task = record(observation.task, 'verified Task');
  const attempt = record(observation.attempt, 'verified attempt');
  const delivery = record(observation.delivery, 'verified delivery');
  const result = AutopilotMutationResultSchema.parse(observation.result);
  const taskId = stringField(task.taskId, 'verified Task ID');
  const taskCid = stringField(task.taskCid, 'verified Task CID');
  const createdAtBlock = integerField(
    task.createdAtBlock,
    'verified Task creation block',
  );
  const createdAtTx = stringField(
    task.createdAtTx,
    'verified Task creation transaction',
  );
  const attemptIndex = integerField(
    attempt.attemptIndex,
    'verified attempt index',
  );
  const requestId = stringField(attempt.requestId, 'verified request ID');
  const operator = stringField(attempt.operator, 'verified operator');
  const envelopeCid = stringField(
    delivery.envelopeCid,
    'verified delivery envelope CID',
  );
  const publisherAgentId = stringField(
    delivery.publisherAgentId,
    'verified publisher agent ID',
  );
  const transactionHash = stringField(
    delivery.transactionHash,
    'verified delivery transaction',
  );
  const blockNumber = integerField(
    delivery.blockNumber,
    'verified delivery block',
  );
  if (
    observation.role !== 'solution'
    || taskId !== execution.taskId
    || taskCid !== execution.taskCid
    || createdAtBlock !== execution.creationBlockNumber
    || createdAtTx.toLowerCase()
      !== execution.creationTransactionHash.toLowerCase()
    || !TRANSACTION_PATTERN.test(createdAtTx)
    || !TRANSACTION_PATTERN.test(transactionHash)
    || !ADDRESS_PATTERN.test(operator)
    || !/^[1-9][0-9]*$/.test(publisherAgentId)
  ) {
    throw new Error(
      'Verified Solution observation contradicts the local marketplace Task',
    );
  }
  return {
    schemaVersion: 'jinn-autopilot-verified-solution-delivery.v1',
    task: {
      id: taskId,
      creationTransactionHash: createdAtTx,
      creationBlockNumber: createdAtBlock,
      ...(execution.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: execution.solverNetManifestCid }),
    },
    attempt: {
      index: attemptIndex,
      v2AttemptId: manifest.attemptId,
      manifestPath: manifest.paths.manifest,
    },
    request: { id: requestId },
    operator: {
      id: publisherAgentId,
      address: operator,
      role: 'solver',
    },
    envelope: {
      cid: envelopeCid,
      author: publisherAgentId,
    },
    transaction: {
      hash: transactionHash,
      blockNumber,
    },
    result,
    session,
  };
}

export async function observeMarketplaceSolutionDelivery(
  manifestPath: string,
  options: MarketplaceDeliveryClientOptions = {},
): Promise<MarketplaceSolutionObservation> {
  const manifest = readAttemptManifest(manifestPath);
  const session = sessionFromRequest(manifest);
  const requestFile = writeObservationRequest(
    manifest,
    observationRequest(manifest, session),
  );
  const raw = await (options.runner ?? defaultRunner)(
    options.cliBin ?? 'jinn',
    [
      'tasks',
      'observe-autopilot-delivery',
      '--expectation-file',
      requestFile,
      '--json',
    ],
    {
      env: marketplaceCommandEnvironment(
        options.environment ?? process.env,
      ),
      replaceEnv: true,
    },
  );
  const observation = parseMachineObservation(raw);
  if (observation.status === 'pending') {
    return {
      status: 'pending',
      reason: stringField(observation.reason, 'pending reason'),
      ...(observation.detail === undefined
        ? {}
        : {
            detail: stringField(
              observation.detail,
              'pending observation detail',
            ),
          }),
    };
  }
  if (observation.status === 'contradiction') {
    return {
      status: 'contradiction',
      reason: stringField(observation.reason, 'contradiction reason'),
      detail: stringField(observation.detail, 'contradiction detail'),
    };
  }
  if (observation.status !== 'verified') {
    throw new Error('Autopilot delivery observation returned an unknown state');
  }
  const verified = verifiedDelivery(manifest, session, observation);
  const reference = {
    taskId: verified.task.id,
    attemptIndex: verified.attempt.index,
    requestId: verified.request.id,
    deliveryEnvelopeCid: verified.envelope.cid,
  };
  recordMarketplaceSolutionDelivery({
    manifestPath,
    taskId: verified.task.id,
    taskCid: manifest.execution.backend === 'marketplace'
      ? manifest.execution.taskCid!
      : '',
    attemptIndex: verified.attempt.index,
    requestId: verified.request.id,
    deliveryEnvelopeCid: verified.envelope.cid,
    deliveryTransactionHash: verified.transaction.hash,
    deliveryBlockNumber: verified.transaction.blockNumber,
    solutionOperatorAddress: verified.operator.address,
    solutionPublisherAgentId: verified.operator.id,
    taskProvenance: {
      creationTransactionHash: verified.task.creationTransactionHash,
      creationBlockNumber: verified.task.creationBlockNumber,
      ...(verified.task.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: verified.task.solverNetManifestCid }),
    },
    now: options.now,
  });
  return {
    status: 'verified',
    reference,
    delivery: verified,
  };
}

function verdictObservationRequest(
  origin: AttemptManifest,
  review: AttemptManifest,
  session: AutopilotSessionCapsule,
): Record<string, unknown> {
  const originExecution = origin.execution;
  const reviewExecution = review.execution;
  const adoption = originExecution.backend === 'marketplace'
    ? originExecution.adoptionReceiptState
    : undefined;
  if (
    origin.phase !== 'implement'
    || review.phase !== 'review'
    || originExecution.backend !== 'marketplace'
    || reviewExecution.backend !== 'marketplace'
    || reviewExecution.originManifestPath !== origin.paths.manifest
    || originExecution.taskId === undefined
    || originExecution.taskCid === undefined
    || originExecution.creationBlockNumber === undefined
    || adoption?.disposition !== 'accepted'
    || adoption.resultingHead === undefined
    || adoption.reviewManifestPath !== review.paths.manifest
    || adoption.reviewAttemptId !== review.attemptId
    || adoption.reviewGeneration !== review.reviewGeneration
    || adoption.reviewRefOid !== review.claimOid
    || review.expectedHead !== adoption.resultingHead
    || reviewExecution.solutionOperatorAddress === undefined
  ) {
    throw new Error('Marketplace Verdict observation lacks an exact adopted review');
  }
  return AutopilotDeliveryExpectationSchema.parse({
    schemaVersion: OBSERVATION_SCHEMA,
    role: 'verdict',
    taskId: originExecution.taskId,
    taskCid: originExecution.taskCid,
    creationBlockNumber: originExecution.creationBlockNumber,
    session,
    solutionOperator: reviewExecution.solutionOperatorAddress,
    expectedCorrelation: {
      resultingHead: adoption.resultingHead,
      reviewedHead: adoption.resultingHead,
      reviewGeneration: adoption.reviewGeneration,
      reviewRefOid: adoption.reviewRefOid,
    },
    ...(reviewExecution.attemptIndex === undefined
      ? {}
      : {
          attemptIndex: reviewExecution.attemptIndex,
          requestId: reviewExecution.requestId,
        }),
    ...(reviewExecution.deliveryEnvelopeCid === undefined
      ? {}
      : { deliveryEnvelopeCid: reviewExecution.deliveryEnvelopeCid }),
    ...(reviewExecution.deliveryTx === undefined
      ? {}
      : {
          deliveryTransactionHash: reviewExecution.deliveryTx,
          deliveryBlockNumber: reviewExecution.deliveryBlockNumber,
        }),
  });
}

function verifiedVerdictDelivery(
  origin: AttemptManifest,
  review: AttemptManifest,
  session: AutopilotSessionCapsule,
  observation: Extract<AutopilotDeliveryObservation, { status: 'verified' }>,
): VerifiedMarketplaceVerdictDelivery {
  const originExecution = origin.execution;
  const reviewExecution = review.execution;
  if (
    originExecution.backend !== 'marketplace'
    || reviewExecution.backend !== 'marketplace'
    || originExecution.taskId === undefined
    || originExecution.taskCid === undefined
    || originExecution.creationTransactionHash === undefined
    || originExecution.creationBlockNumber === undefined
    || reviewExecution.solutionOperatorAddress === undefined
    || review.reviewGeneration === undefined
  ) {
    throw new Error('Marketplace review attempt lost Task provenance');
  }
  const task = record(observation.task, 'verified Verdict Task');
  const attempt = record(observation.attempt, 'verified Verdict attempt');
  const delivery = record(observation.delivery, 'verified Verdict delivery');
  const result = AutopilotReviewResultSchema.parse(observation.result);
  const taskId = stringField(task.taskId, 'verified Verdict Task ID');
  const taskCid = stringField(task.taskCid, 'verified Verdict Task CID');
  const createdAtBlock = integerField(
    task.createdAtBlock,
    'verified Verdict Task creation block',
  );
  const createdAtTx = stringField(
    task.createdAtTx,
    'verified Verdict Task creation transaction',
  );
  const attemptIndex = integerField(
    attempt.attemptIndex,
    'verified Verdict attempt index',
  );
  const requestId = stringField(
    attempt.requestId,
    'verified Verdict request ID',
  );
  const evaluator = stringField(
    attempt.operator,
    'verified Verdict evaluator',
  );
  const envelopeCid = stringField(
    delivery.envelopeCid,
    'verified Verdict envelope CID',
  );
  const publisherAgentId = stringField(
    delivery.publisherAgentId,
    'verified Verdict publisher agent ID',
  );
  const transactionHash = stringField(
    delivery.transactionHash,
    'verified Verdict transaction',
  );
  const blockNumber = integerField(
    delivery.blockNumber,
    'verified Verdict block',
  );
  if (
    observation.role !== 'verdict'
    || taskId !== originExecution.taskId
    || taskCid !== originExecution.taskCid
    || createdAtBlock !== originExecution.creationBlockNumber
    || createdAtTx.toLowerCase()
      !== originExecution.creationTransactionHash.toLowerCase()
    || evaluator.toLowerCase()
      === reviewExecution.solutionOperatorAddress.toLowerCase()
    || !TRANSACTION_PATTERN.test(createdAtTx)
    || !TRANSACTION_PATTERN.test(transactionHash)
    || !ADDRESS_PATTERN.test(evaluator)
    || !/^[1-9][0-9]*$/.test(publisherAgentId)
  ) {
    throw new Error(
      'Verified Verdict observation contradicts the adopted marketplace Task',
    );
  }
  return {
    schemaVersion: 'jinn-autopilot-verified-verdict-delivery.v1',
    task: {
      id: taskId,
      creationTransactionHash: createdAtTx,
      creationBlockNumber: createdAtBlock,
      ...(originExecution.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: originExecution.solverNetManifestCid }),
    },
    origin: {
      v2AttemptId: origin.attemptId,
      manifestPath: origin.paths.manifest,
    },
    review: {
      attemptId: review.attemptId,
      manifestPath: review.paths.manifest,
      head: review.expectedHead,
      generation: review.reviewGeneration,
      refOid: review.claimOid,
      reviewer: review.selectedLogin,
    },
    attempt: {
      index: attemptIndex,
      requestId,
    },
    solutionOperator: reviewExecution.solutionOperatorAddress,
    evaluator: {
      publisherAgentId,
      address: evaluator,
    },
    envelope: {
      cid: envelopeCid,
      author: publisherAgentId,
    },
    transaction: {
      hash: transactionHash,
      blockNumber,
    },
    result,
    session,
  };
}

export async function observeMarketplaceVerdictDelivery(
  originManifestPath: string,
  reviewManifestPath: string,
  options: MarketplaceDeliveryClientOptions = {},
): Promise<MarketplaceVerdictObservation> {
  const origin = readAttemptManifest(originManifestPath);
  const review = readAttemptManifest(reviewManifestPath);
  const session = sessionFromRequest(origin);
  const verdictRequest = writeObservationRequest(
    review,
    verdictObservationRequest(origin, review, session),
    'marketplace-verdict-observation.json',
  );
  const raw = await (options.runner ?? defaultRunner)(
    options.cliBin ?? 'jinn',
    [
      'tasks',
      'observe-autopilot-delivery',
      '--expectation-file',
      verdictRequest,
      '--json',
    ],
    {
      env: marketplaceCommandEnvironment(
        options.environment ?? process.env,
      ),
      replaceEnv: true,
    },
  );
  const observation = parseMachineObservation(raw);
  if (observation.status === 'pending') {
    return {
      status: 'pending',
      reason: stringField(observation.reason, 'pending Verdict reason'),
      ...(observation.detail === undefined
        ? {}
        : {
            detail: stringField(
              observation.detail,
              'pending Verdict detail',
            ),
          }),
    };
  }
  if (observation.status === 'contradiction') {
    return {
      status: 'contradiction',
      reason: stringField(
        observation.reason,
        'Verdict contradiction reason',
      ),
      detail: stringField(
        observation.detail,
        'Verdict contradiction detail',
      ),
    };
  }
  if (observation.status !== 'verified') {
    throw new Error('Autopilot Verdict observation returned an unknown state');
  }
  const verified = verifiedVerdictDelivery(
    origin,
    review,
    session,
    observation,
  );
  recordMarketplaceVerdictDelivery({
    reviewManifestPath,
    taskId: verified.task.id,
    taskCid: origin.execution.backend === 'marketplace'
      ? origin.execution.taskCid!
      : '',
    attemptIndex: verified.attempt.index,
    requestId: verified.attempt.requestId,
    deliveryEnvelopeCid: verified.envelope.cid,
    deliveryTransactionHash: verified.transaction.hash,
    deliveryBlockNumber: verified.transaction.blockNumber,
    evaluatorOperatorAddress: verified.evaluator.address,
    evaluatorPublisherAgentId: verified.evaluator.publisherAgentId,
    taskProvenance: {
      creationTransactionHash: verified.task.creationTransactionHash,
      creationBlockNumber: verified.task.creationBlockNumber,
      ...(verified.task.solverNetManifestCid === undefined
        ? {}
        : { solverNetManifestCid: verified.task.solverNetManifestCid }),
    },
    now: options.now,
  });
  return { status: 'verified', delivery: verified };
}
