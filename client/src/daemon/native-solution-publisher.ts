import {
  RECORD_KINDS,
  type SourceIdentity,
  type WithdrawnAnnouncement,
} from '@jinn-network/record-discovery-protocol';
import type { ArchiveHttpHandler } from '@jinn-network/record-discovery-transport-http';
import type { NativeSolutionPublisherPort } from './native-solution-coordinator.js';
import {
  LOCATION_PROFILE_HTTPS,
  openNativeSignedSource,
  type NativeSignedSourceFaults,
  type NativeSignedSourceSigner,
} from './native-signed-source.js';

const SOLVER_RECORDS_SOURCE_NAME = 'solver-records';
const SOLVER_RECORDS_OUTPUT_KIND = 'https://spec.jinn.network/records/task-output/v1';
const SOLVER_RECORDS_DELIVERY_SIGNATURE_KIND = 'https://spec.jinn.network/records/delivery-signature/v1';

export class NativeSolutionPublisherOwnershipError extends Error {
  override readonly name = 'NativeSolutionPublisherOwnershipError';
}

export interface NativeSolutionPublisher extends NativeSolutionPublisherPort {
  readonly handler: ArchiveHttpHandler;
  withdraw(input: {
    readonly withdrawalKey: string;
    readonly targetAnnouncementId: string;
    readonly recordDigest: `sha256:${string}`;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly timestamp: string;
    readonly reason: WithdrawnAnnouncement['reason'];
  }): Promise<{ readonly sequence: string; readonly entryDigest: `sha256:${string}` }>;
  close(): Promise<void>;
}

function recordKind(role: 'output' | 'evidence' | 'delivery' | 'delivery-envelope'): string {
  switch (role) {
    case 'delivery': return RECORD_KINDS.delivery;
    case 'evidence': return RECORD_KINDS.executionEvidence;
    case 'output': return SOLVER_RECORDS_OUTPUT_KIND;
    case 'delivery-envelope': return SOLVER_RECORDS_DELIVERY_SIGNATURE_KIND;
  }
}

export async function openNativeSolutionPublisher(input: {
  readonly rootDir: string;
  readonly publicBaseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly settlementDeclarationKey: string;
  /** Deterministic crash seams used by the B8 recovery matrix. */
  readonly faults?: NativeSignedSourceFaults;
  /** Lease seams are deterministic-test-only; production uses wall time and real PID liveness. */
  readonly owner?: {
    readonly now?: () => Date;
    readonly ttlMs?: number;
    readonly isPidAlive?: (pid: number) => boolean;
  };
}): Promise<NativeSolutionPublisher> {
  if (input.source.name !== SOLVER_RECORDS_SOURCE_NAME) {
    throw new Error(`native solution publisher requires the distinct "${SOLVER_RECORDS_SOURCE_NAME}" source name`);
  }
  const core = await openNativeSignedSource({
    ...input,
    ownerFile: '.solution-publisher-owner',
    ownershipError: (message) => new NativeSolutionPublisherOwnershipError(message),
  });
  return {
    sourceId: core.sourceId,
    handler: core.handler,
    close: () => core.close(),
    publish: (value) => {
      if (value.publication.recordDigest !== value.artifact.digest) {
        throw new Error('solution publication digest does not equal the stored artifact digest');
      }
      return core.publish({
        publicationKey: value.publication.publicationKey,
        sourceId: value.publication.sourceId,
        recordDigest: value.publication.recordDigest,
        bytes: value.bytes,
        mediaType: value.artifact.mediaType,
        timestamp: value.publication.createdAt,
        makeAnnouncement: ({ location }) => ({
            announcementId: value.publication.publicationKey,
            action: 'available',
            record: {
              kind: recordKind(value.publication.role),
              digest: value.publication.recordDigest,
              mediaType: value.artifact.mediaType,
            },
            locations: [{ profile: LOCATION_PROFILE_HTTPS, locator: location }],
            facts: {
              engagementId: value.publication.engagementId,
              role: value.publication.role,
              family: value.artifact.family,
              settlementDeclarationKey: input.settlementDeclarationKey,
              ...(value.artifact.name === null ? {} : { name: value.artifact.name }),
            },
        }),
      });
    },
    async withdraw(value) {
      const receipt = await core.publish({
        publicationKey: value.withdrawalKey,
        sourceId: core.sourceId,
        recordDigest: value.recordDigest,
        bytes: value.bytes,
        mediaType: value.mediaType,
        timestamp: value.timestamp,
        makeAnnouncement: () => ({
            announcementId: value.withdrawalKey,
            action: 'withdrawn',
            retracts: value.targetAnnouncementId,
            reason: value.reason,
        }),
      });
      return { sequence: receipt.sequence, entryDigest: receipt.entryDigest };
    },
  };
}
