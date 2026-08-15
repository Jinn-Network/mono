// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";
import { recordDigest } from "@jinn-network/evidence-protocol";
import {
  NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,
  type EvidenceArtifactReference,
  type EvidenceRecordFamily,
  type EvidenceRecordReference,
  type EvidenceRepository,
  type RepositoryOperationOptions,
  type RepositoryWriteReceipt,
} from "@jinn-network/evidence-repository";
import type { Transport } from "@jinn-network/record-discovery-client";
import { recordPath } from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import { CORPUS_ERROR_CODES, CorpusMirrorError } from "./errors.js";

/** The repository id under which the mirror's own object store resolves. */
export const MIRROR_REPOSITORY_ID = "jinn:corpus-mirror" as const;

function readOnly(): never {
  throw new CorpusMirrorError(
    CORPUS_ERROR_CODES.repositoryReadOnly,
    "The public-corpus serving plane is read-only; this runtime does not publish.",
  );
}

export interface ServingPlaneRepositoryOptions {
  readonly servingRoot: string;
  readonly transport: Transport;
}

/**
 * A read-only `EvidenceRepository` over one archive's record-discovery
 * serving plane. Record bytes are re-hashed against the requested reference
 * before they are returned: a digest mismatch is refused loudly, never
 * silently proxied to a caller that might trust it.
 *
 * `getArtifact` returns `null`: the record-discovery serving paths
 * (`identifiers.ts:55-58`) define `/records/<digest>` and nothing for
 * artifacts, and inventing a path here would be a protocol change made by an
 * application. Recorded as C5 Finding F3.
 */
export function createServingPlaneRepository(
  options: ServingPlaneRepositoryOptions,
): EvidenceRepository {
  return Object.freeze({
    capabilities: NO_DECLARED_LIMIT_EVIDENCE_REPOSITORY_CAPABILITIES,

    async getRecord(
      reference: EvidenceRecordReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      operation?.signal?.throwIfAborted();
      const response = await options.transport.fetch(
        options.servingRoot + recordPath(reference.digest),
      );
      if (response.status >= 400) return null;
      if (recordDigest(response.bytes) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Bytes served for ${reference.digest} do not re-hash to that digest.`,
        );
      }
      return response.bytes;
    },

    async getArtifact(
      _reference: EvidenceArtifactReference,
      _operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      return null;
    },

    async putRecord(
      _family: EvidenceRecordFamily,
      _bytes: Uint8Array,
    ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
      return readOnly();
    },

    async putArtifact(_bytes: Uint8Array): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
      return readOnly();
    },
  });
}

export interface MirroringRepositoryOptions {
  readonly upstream: EvidenceRepository;
  readonly local: EvidenceRepository;
}

/**
 * Local first, upstream on a miss, digest-validated, written back. This is
 * what turns the indexer's own byte fetch into the mirroring step: indexing
 * an announcement populates the local object store as a side effect, so
 * every later read of that record is local and always-available.
 *
 * A digest mismatch refuses BEFORE the write, so a tampering upstream cannot
 * poison the local store.
 */
export function createMirroringRepository(
  options: MirroringRepositoryOptions,
): EvidenceRepository {
  return Object.freeze({
    capabilities: options.local.capabilities,

    async getRecord(
      reference: EvidenceRecordReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      const cached = await options.local.getRecord(reference, operation);
      if (cached !== null) return cached;

      const fetched = await options.upstream.getRecord(reference, operation);
      if (fetched === null) return null;
      if (recordDigest(fetched) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Upstream bytes for ${reference.digest} do not re-hash to that digest; refusing to mirror them.`,
        );
      }
      await options.local.putRecord(reference.family, fetched, operation);
      return fetched;
    },

    async getArtifact(
      reference: EvidenceArtifactReference,
      operation?: RepositoryOperationOptions,
    ): Promise<Uint8Array | null> {
      const cached = await options.local.getArtifact(reference, operation);
      if (cached !== null) return cached;

      const fetched = await options.upstream.getArtifact(reference, operation);
      if (fetched === null) return null;
      if (recordDigest(fetched) !== reference.digest) {
        throw new CorpusMirrorError(
          CORPUS_ERROR_CODES.recordDigestMismatch,
          `Upstream artifact bytes for ${reference.digest} do not re-hash to that digest.`,
        );
      }
      await options.local.putArtifact(fetched, operation);
      return fetched;
    },

    async putRecord(
      family: EvidenceRecordFamily,
      bytes: Uint8Array,
      operation?: RepositoryOperationOptions,
    ): Promise<RepositoryWriteReceipt<EvidenceRecordReference>> {
      return options.local.putRecord(family, bytes, operation);
    },

    async putArtifact(
      bytes: Uint8Array,
      operation?: RepositoryOperationOptions,
    ): Promise<RepositoryWriteReceipt<EvidenceArtifactReference>> {
      return options.local.putArtifact(bytes, operation);
    },
  });
}

export interface CorpusRepositoryResolverOptions {
  readonly sources: readonly MirrorSourceConfig[];
  readonly local: EvidenceRepository;
  readonly transport: Transport;
}

/**
 * Resolves the mirror's own store plus one mirroring repository per followed
 * archive. An unconfigured id resolves to `null` — the resolver is an
 * allowlist, so a record announcing an unknown repository is unfetchable
 * rather than an invitation to reach an arbitrary host.
 */
export function createCorpusRepositoryResolver(
  options: CorpusRepositoryResolverOptions,
): EvidenceRepositoryResolver {
  const byId = new Map<string, EvidenceRepository>([[MIRROR_REPOSITORY_ID, options.local]]);
  for (const source of options.sources) {
    byId.set(
      source.repositoryId,
      createMirroringRepository({
        upstream: createServingPlaneRepository({
          servingRoot: source.servingRoot,
          transport: options.transport,
        }),
        local: options.local,
      }),
    );
  }

  return Object.freeze({
    async resolve(repositoryId: string): Promise<EvidenceRepository | null> {
      return byId.get(repositoryId) ?? null;
    },
  });
}
