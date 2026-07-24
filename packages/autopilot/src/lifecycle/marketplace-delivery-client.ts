import {
  chmodSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  AutopilotMutationResultSchema,
  AutopilotSessionCapsuleSchema,
  type AutopilotSessionCapsule,
} from '../../../sdk/src/autopilot-session.js';
import type { CommandRunner } from '../dispatcher/issue-source.js';
import { defaultRunner } from '../dispatcher/issue-source.js';
import {
  readAttemptManifest,
  type AttemptManifest,
} from './attempt-workspace.js';
import {
  recordMarketplaceSolutionDelivery,
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
  const request = record(
    JSON.parse(readFileSync(manifest.execution.requestFile, 'utf8')),
    'marketplace request',
  );
  const spec = record(request.spec, 'marketplace request spec');
  return AutopilotSessionCapsuleSchema.parse(spec.session);
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
  return {
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
  };
}

function writeObservationRequest(
  manifest: AttemptManifest,
  value: Record<string, unknown>,
): string {
  const target = join(
    dirname(manifest.paths.manifest),
    'marketplace-solution-observation.json',
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

function parseMachineObservation(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Autopilot delivery observation returned malformed JSON');
  }
  const envelope = record(parsed, 'Autopilot delivery observation response');
  return record(
    envelope.observation,
    'Autopilot delivery observation result',
  );
}

function verifiedDelivery(
  manifest: AttemptManifest,
  session: AutopilotSessionCapsule,
  observation: Record<string, unknown>,
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
