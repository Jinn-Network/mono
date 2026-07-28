import { isDeepStrictEqual } from 'node:util';

import {
  derivePersistedAutopilotAdoptionExpectation,
} from '../../autopilot/github-adoption-receipt-observer.js';
import { rawSha256CidToDigestHex } from '../../adapters/mech/ipfs.js';
import type { PersistedTaskRun } from '../../types/task-run.js';
import type { TaskRunPersistence } from './persistence.js';
import { TaskRunState } from './state.js';

export const FAILED_ADOPTION_IDENTITY_REASON =
  'adoption-contradiction:persisted runtime Task identity or role is contradictory';

export type FailedAdoptionRecoveryMode = 'dry-run' | 'apply';

export type FailedAdoptionRecoveryResult =
  | {
      readonly status: 'eligible' | 'recovered';
      readonly requestId: string;
      readonly previousState: typeof TaskRunState.FAILED;
      readonly targetState: typeof TaskRunState.AWAITING_ADOPTION;
    }
  | {
      readonly status: 'refused';
      readonly requestId: string;
      readonly reason: string;
    };

export interface RecoverFailedAdoptionOptions {
  readonly persistence: TaskRunPersistence;
  readonly requestId: string;
  readonly mode: FailedAdoptionRecoveryMode;
  readonly now?: () => number;
}

const FALSE_IDENTITY_OBSERVATION = {
  state: 'contradictory' as const,
  detail: 'persisted runtime Task identity or role is contradictory',
};
const HEX_32 = /^0x[0-9a-f]{64}$/i;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const PRINTABLE_VALUE = /^[\x21-\x7e]+$/;

function refusal(requestId: string, reason: string): FailedAdoptionRecoveryResult {
  return { status: 'refused', requestId, reason };
}

function positiveTimestamp(value: number | null): boolean {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeInteger(value: number | null): boolean {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

function rawSha256Digest(value: string | null): string | null {
  if (value === null) return null;
  try {
    return rawSha256CidToDigestHex(value);
  } catch {
    return null;
  }
}

function validateRecoveryCandidate(run: PersistedTaskRun): string | null {
  if (run.state !== TaskRunState.FAILED) {
    return 'persisted run is not FAILED';
  }
  if (run.failureReason !== FAILED_ADOPTION_IDENTITY_REASON) {
    return 'persisted failure reason is not the recoverable identity contradiction';
  }
  if (!isDeepStrictEqual(
    run.adoptionLastObservation,
    FALSE_IDENTITY_OBSERVATION,
  )) {
    return 'persisted adoption observation is not the recoverable identity contradiction';
  }
  if (run.adoptionAcceptedReceipt !== null) {
    return 'an accepted receipt is already persisted';
  }
  if (run.adoptionLastError !== null) {
    return 'persisted adoption error is contradictory';
  }
  if (run.adoptionObservationAttempts !== 1) {
    return 'persisted adoption observation count is not the one failed observation';
  }
  if (run.taskId === null || !POSITIVE_DECIMAL.test(run.taskId)) {
    return 'persisted on-chain Task ID is not a positive decimal';
  }
  if (!nonNegativeInteger(run.attemptIndex)) {
    return 'persisted attempt index is missing or invalid';
  }
  if (run.solverType !== 'jinn-repo.v1') {
    return 'persisted solver is not the strict Autopilot jinn-repo type';
  }
  if (run.taskRole !== 'restoration' && run.taskRole !== 'evaluation') {
    return 'persisted adoption role is missing';
  }
  if (
    run.task === null
    || run.task.solverType !== 'jinn-repo.v1'
    || run.task.contractId !== 'jinn-repo'
    || run.task.contractVersion !== 'v1'
  ) {
    return 'persisted runtime Task contract is not jinn-repo.v1';
  }
  if (run.task.role !== run.taskRole) {
    return 'persisted runtime Task role differs from the durable role';
  }
  if (
    rawSha256Digest(run.taskCid) === null
    || !HEX_32.test(run.onchainCreationTx)
    || !positiveTimestamp(run.onchainCreationBlock)
  ) {
    return 'persisted on-chain Task creation evidence is invalid';
  }
  if (
    run.solverNetManifestCid === null
    || rawSha256Digest(run.solverNetManifestCid) === null
    || run.task.solverNetManifestCid !== run.solverNetManifestCid
  ) {
    return 'persisted SolverNet manifest CID is missing, invalid, or contradictory';
  }

  const manifestDigest = rawSha256Digest(run.manifestCid);
  if (manifestDigest === null) {
    return 'persisted delivery manifest or envelope CID is invalid';
  }
  const expectation = derivePersistedAutopilotAdoptionExpectation(run);
  if ('error' in expectation) return expectation.error;

  if (run.deliveryTxHash === null || !HEX_32.test(run.deliveryTxHash)) {
    return 'persisted delivery transaction is invalid';
  }
  if (
    run.deliveryDigest === null
    || !HEX_32.test(run.deliveryDigest)
    || run.deliveryDigest.toLowerCase() !== manifestDigest.toLowerCase()
  ) {
    return 'persisted delivery digest is invalid or differs from the envelope CID';
  }
  if (
    run.deliveryDiscoveryAnchorTxHash === null
    || !HEX_32.test(run.deliveryDiscoveryAnchorTxHash)
  ) {
    return 'persisted delivery anchor transaction is invalid';
  }
  if (!positiveTimestamp(run.deliveryDiscoveryAnchorBlockNumber)) {
    return 'persisted delivery anchor block is missing or invalid';
  }
  if (run.evidenceHash === null || !HEX_32.test(run.evidenceHash)) {
    return 'persisted delivery evidence hash is invalid';
  }
  if (!positiveTimestamp(run.manifestGeneratedAt)) {
    return 'persisted manifest timestamp is missing or invalid';
  }
  if (
    run.artifactCids === null
    || typeof run.artifactCids !== 'object'
    || Array.isArray(run.artifactCids)
    || Object.keys(run.artifactCids).length === 0
    || Object.entries(run.artifactCids).some(
      ([path, digest]) =>
        !PRINTABLE_VALUE.test(path)
        || typeof digest !== 'string'
        || !PRINTABLE_VALUE.test(digest),
    )
  ) {
    return 'persisted delivery artifacts are missing';
  }
  if (!positiveTimestamp(run.adoptionWaitStartedAt)) {
    return 'persisted adoption wait timestamp is missing or invalid';
  }
  if (!positiveTimestamp(run.adoptionNextObservationAt)) {
    return 'persisted next observation timestamp is missing or invalid';
  }
  if (!positiveTimestamp(run.failureAt)) {
    return 'persisted failure timestamp is missing or invalid';
  }
  if (run.stateUpdatedAt !== run.failureAt) {
    return 'persisted failure timestamp differs from terminal state';
  }
  return null;
}

export function recoverFailedAdoption(
  options: RecoverFailedAdoptionOptions,
): FailedAdoptionRecoveryResult {
  if (!HEX_32.test(options.requestId)) {
    return refusal(options.requestId, 'request ID must be an exact 32-byte hex value');
  }
  const run = options.persistence.getByRequestId(options.requestId);
  if (run === null) {
    return refusal(options.requestId, 'persisted run was not found');
  }
  const invalid = validateRecoveryCandidate(run);
  if (invalid !== null) return refusal(options.requestId, invalid);

  const success = {
    requestId: options.requestId,
    previousState: TaskRunState.FAILED,
    targetState: TaskRunState.AWAITING_ADOPTION,
  } as const;
  if (options.mode === 'dry-run') {
    return { status: 'eligible', ...success };
  }

  const recoveredAt = (options.now ?? Date.now)();
  if (!positiveTimestamp(recoveredAt)) {
    return refusal(options.requestId, 'recovery clock is invalid');
  }
  if (recoveredAt < run.stateUpdatedAt) {
    return refusal(
      options.requestId,
      'recovery clock precedes the persisted terminal timestamp',
    );
  }
  if (!options.persistence.requeueFailedAdoptionObservation(run, recoveredAt)) {
    return refusal(
      options.requestId,
      'persisted run changed before the exact compare-and-swap',
    );
  }
  return { status: 'recovered', ...success };
}
