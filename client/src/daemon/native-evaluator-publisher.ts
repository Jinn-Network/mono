import {
  RECORD_KINDS,
  type SourceIdentity,
} from '@jinn-network/record-discovery-protocol';
import type { ArchiveHttpHandler } from '@jinn-network/record-discovery-transport-http';
import type { NativeEvaluatorPublisherPort } from './native-evaluator-coordinator.js';
import {
  LOCATION_PROFILE_HTTPS,
  openNativeSignedSource,
  type NativeSignedSourceFaults,
  type NativeSignedSourceSigner,
} from './native-signed-source.js';

const SOURCE_NAME = 'evaluator-records';
const DELIVERY_SIGNATURE_KIND = 'https://spec.jinn.network/records/delivery-signature/v1';

export interface NativeEvaluatorPublisher extends NativeEvaluatorPublisherPort {
  readonly handler: ArchiveHttpHandler;
  close(): Promise<void>;
}

export class NativeEvaluatorPublisherOwnershipError extends Error {
  override readonly name = 'NativeEvaluatorPublisherOwnershipError';
}

function kind(role: string): string {
  switch (role) {
    case 'evaluation-task': return RECORD_KINDS.task;
    case 'evaluation-submission': return RECORD_KINDS.submission;
    case 'verdict': return RECORD_KINDS.resultEvaluation;
    case 'evaluation-delivery': return RECORD_KINDS.delivery;
    case 'evaluation-evidence': return RECORD_KINDS.executionEvidence;
    case 'evaluation-delivery-envelope': return DELIVERY_SIGNATURE_KIND;
    default: throw new Error(`unsupported evaluator publication role ${role}`);
  }
}

/** Dedicated evaluator source: it never shares the solver publisher's identity, root, or lock. */
export async function openNativeEvaluatorPublisher(input: {
  readonly rootDir: string;
  readonly publicBaseUrl: string;
  readonly source: SourceIdentity;
  readonly signer: NativeSignedSourceSigner;
  readonly faults?: NativeSignedSourceFaults;
  readonly owner?: {
    readonly now?: () => Date;
    readonly ttlMs?: number;
    readonly isPidAlive?: (pid: number) => boolean;
  };
}): Promise<NativeEvaluatorPublisher> {
  if (input.source.name !== SOURCE_NAME) {
    throw new Error(`native evaluator publisher requires source name "${SOURCE_NAME}"`);
  }
  const core = await openNativeSignedSource({
    ...input,
    ownerFile: '.evaluator-publisher-owner',
    ownershipError: (message) => new NativeEvaluatorPublisherOwnershipError(message),
  });
  return {
    sourceId: core.sourceId,
    handler: core.handler,
    close: () => core.close(),
    publish: (value) => {
      if (value.publication.recordDigest !== value.artifact.digest || value.artifact.mediaType === undefined) {
        throw new Error('evaluation publication does not match exact stored artifact metadata');
      }
      return core.publish({
        publicationKey: value.publication.publicationKey,
        sourceId: value.publication.sourceId,
        recordDigest: value.publication.recordDigest,
        bytes: value.artifact.bytes,
        mediaType: value.artifact.mediaType,
        timestamp: value.publication.createdAt,
        makeAnnouncement: ({ location }) => ({
            announcementId: value.publication.publicationKey,
            action: 'available',
            record: {
              kind: kind(value.publication.role),
              digest: value.publication.recordDigest,
              mediaType: value.artifact.mediaType,
            },
            locations: [{ profile: LOCATION_PROFILE_HTTPS, locator: location }],
            facts: {
              evaluationId: value.publication.evaluationId,
              role: value.publication.role,
              name: value.artifact.name,
            },
        }),
      });
    },
  };
}
