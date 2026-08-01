// SPDX-License-Identifier: Apache-2.0

import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";
import type { EvidenceRecordReference } from "@jinn-network/evidence-repository";
import {
  createEvidenceRetrieval,
  createEvidenceRetrievalFailure,
  type ArtifactHydrationRequest,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type EvidenceRetrievalFailure,
  type RetrievalHardLimits,
  type RetrievalLocationAttempt,
  type RetrievalLocationObservation,
  type RetrievalTelemetry,
  type ValidatedEvidenceResult,
} from "@jinn-network/evidence-retrieval";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";
import { sourceIdOf } from "./announcements.js";
import { describeError } from "./errors.js";
import { producerIdOf } from "./read.js";
import { MIRROR_REPOSITORY_ID, createCorpusRepositoryResolver } from "./repositories.js";
import { withCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

export interface CorpusFetchOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly artifacts?: ArtifactHydrationRequest;
}

export type CorpusFetchOutcome =
  | { readonly status: "fetched"; readonly result: ValidatedEvidenceResult }
  | { readonly status: "failed"; readonly failure: EvidenceRetrievalFailure };

export interface CorpusRetrieval {
  fetchRecord(
    reference: EvidenceRecordReference,
    options?: CorpusFetchOptions,
  ): Promise<CorpusFetchOutcome>;
}

export interface CreateCorpusRetrievalOptions {
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly sources: readonly MirrorSourceConfig[];
  readonly admission: CorpusAdmission;
  /** Overridable for tests; production builds the allowlist resolver per call. */
  readonly repositories?: EvidenceRepositoryResolver;
  readonly hardLimits?: Partial<RetrievalHardLimits>;
  readonly telemetry?: RetrievalTelemetry;
  readonly transport?: Parameters<typeof createCorpusRepositoryResolver>[0]["transport"];
}

/**
 * Exact-byte fetch over the public-corpus mirror.
 *
 * Order of operations, and why: the catalog projection is read FIRST so the
 * producing agent's identity is known, producer admission runs SECOND so an
 * unadmitted producer's bytes are never fetched at all, and only then does the
 * stack's `EvidenceRetrieval` run — which re-hashes the fetched bytes and
 * refuses `RECORD_DIGEST_MISMATCH` at stage `record`
 * (`packages/evidence/retrieval/src/validation.ts:60-68`).
 *
 * `fetchRecord` never throws for a data problem; every refusal is a value.
 */
export function createCorpusRetrieval(
  options: CreateCorpusRetrievalOptions,
): CorpusRetrieval {
  const sourceIdByRepositoryId = new Map(
    options.sources.map((source) => [source.repositoryId, sourceIdOf(source)] as const),
  );

  // The local mirror ranks first, then each configured archive in the order
  // the operator listed it. An unranked repository sorts last.
  const rank = new Map<string, number>([
    [MIRROR_REPOSITORY_ID, 0],
    ...options.sources.map((source, index) => [source.repositoryId, index + 1] as const),
  ]);

  const locationPolicy: EvidenceLocationPolicy = {
    select(
      _reference: EvidenceRecordReference,
      locations: readonly RetrievalLocationObservation[],
    ): readonly RetrievalLocationAttempt[] {
      return [...locations]
        .filter(
          (observation): observation is RetrievalLocationObservation & { repositoryId: string } =>
            observation.status === "available" && observation.repositoryId !== undefined,
        )
        .sort(
          (left, right) =>
            (rank.get(left.repositoryId) ?? Number.MAX_SAFE_INTEGER) -
            (rank.get(right.repositoryId) ?? Number.MAX_SAFE_INTEGER),
        )
        .map((observation) => ({ repositoryId: observation.repositoryId, observation }));
    },
  };

  return Object.freeze({
    async fetchRecord(
      reference: EvidenceRecordReference,
      fetchOptions?: CorpusFetchOptions,
    ): Promise<CorpusFetchOutcome> {
      try {
        return await withCorpusMirrorStore(options.storePaths, async (store) => {
          const catalogOptions =
            fetchOptions?.signal === undefined ? undefined : { signal: fetchOptions.signal };

          const projection = await store.catalog.getRecord(reference, catalogOptions);
          if (projection === null) {
            return {
              status: "failed" as const,
              failure: createEvidenceRetrievalFailure({
                code: "NO_LOCATION",
                stage: "location",
                message: "This record is not in the local mirror; sync the followed archives first.",
                reference,
              }),
            };
          }

          const decision = options.admission.admitProducer(producerIdOf(projection));
          if (decision.status === "rejected") {
            return {
              status: "failed" as const,
              failure: createEvidenceRetrievalFailure({
                code: "ACCEPTANCE_REJECTED",
                stage: "acceptance",
                message: `The producing agent is not admitted by trust policy (${decision.reason}).`,
                reference,
              }),
            };
          }

          const locator: EvidenceRecordLocator = {
            async locate(target, hints, operation) {
              const stored = await store.catalog.getRecordLocations(target, {
                signal: operation.signal,
              });
              const observations: RetrievalLocationObservation[] = [];
              let ordinal = 0;
              for (const location of stored) {
                if (observations.length >= operation.maximumLocations) break;
                observations.push({
                  observationId: `${target.digest}#${String(ordinal)}`,
                  sourceId: sourceIdByRepositoryId.get(location.repositoryId) ?? MIRROR_REPOSITORY_ID,
                  status: "available",
                  repositoryId: location.repositoryId,
                  ...(location.publishedLocation === undefined
                    ? {}
                    : { publishedLocation: location.publishedLocation }),
                });
                ordinal += 1;
              }
              for (const hint of hints) {
                if (observations.length >= operation.maximumLocations) break;
                if (observations.some((seen) => seen.repositoryId === hint.repositoryId)) continue;
                observations.push({
                  observationId: `${target.digest}#hint:${hint.repositoryId}`,
                  sourceId: hint.sourceId,
                  status: "available",
                  repositoryId: hint.repositoryId,
                  ...(hint.publishedLocation === undefined
                    ? {}
                    : { publishedLocation: hint.publishedLocation }),
                });
              }
              // The mirror's own store always holds a mirrored record.
              if (!observations.some((seen) => seen.repositoryId === MIRROR_REPOSITORY_ID)) {
                observations.unshift({
                  observationId: `${target.digest}#mirror`,
                  sourceId: MIRROR_REPOSITORY_ID,
                  status: "available",
                  repositoryId: MIRROR_REPOSITORY_ID,
                });
              }
              return observations;
            },
          };

          const repositoryResolver =
            options.repositories ??
            createCorpusRepositoryResolver({
              sources: options.sources,
              local: store.repository,
              ...(options.transport === undefined
                ? // With no transport the mirror serves only what it already
                  // holds — the always-available local view, offline.
                  { transport: { async fetch() { return { status: 503, bytes: new Uint8Array() }; } } }
                : { transport: options.transport }),
            });

          const retrieval = createEvidenceRetrieval({
            locator,
            locationPolicy,
            repositoryResolver,
            ...(options.hardLimits === undefined ? {} : { hardLimits: options.hardLimits }),
            ...(options.telemetry === undefined ? {} : { telemetry: options.telemetry }),
          });

          const outcome = await retrieval.retrieve(
            {
              reference,
              ...(fetchOptions?.artifacts === undefined
                ? {}
                : { artifacts: fetchOptions.artifacts }),
            },
            {
              ...(fetchOptions?.signal === undefined ? {} : { signal: fetchOptions.signal }),
              ...(fetchOptions?.timeoutMs === undefined ? {} : { timeoutMs: fetchOptions.timeoutMs }),
            },
          );

          return outcome.status === "validated"
            ? { status: "fetched" as const, result: outcome.result }
            : { status: "failed" as const, failure: outcome.failure };
        });
      } catch (error) {
        return {
          status: "failed",
          failure: createEvidenceRetrievalFailure({
            code: "OPERATION_ABORTED",
            stage: "record",
            message: describeError(error),
            reference,
            retryable: true,
          }),
        };
      }
    },
  });
}
