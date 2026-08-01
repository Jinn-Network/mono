// SPDX-License-Identifier: Apache-2.0

import type {
  CatalogPage,
  CatalogRecordProjection,
  EvidenceRecordLocation,
} from "@jinn-network/evidence-discovery";
import type { EvidenceRecordFamily, EvidenceRecordReference } from "@jinn-network/evidence-repository";
import type { RetrievalLocationHint } from "@jinn-network/evidence-retrieval";
import type {
  HighWaterMark,
  HighWaterMarkStore,
  SourceIdentity,
} from "@jinn-network/record-discovery-protocol";

import type { MirrorSourceConfig } from "../config.js";
import type { CorpusAdmission } from "./admission.js";
import { sourceIdOf } from "./announcements.js";
import { MIRROR_REPOSITORY_ID } from "./repositories.js";
import {
  withCorpusMirrorStore,
  type CorpusMirrorStore,
  type OpenCorpusMirrorStoreOptions,
} from "./store.js";

/**
 * A record from the public plane, already past trust filtering.
 *
 * `plane` is the string literal `"public"`. C6 declares the union
 * (`EvidencePlane = "local" | "public"` in `src/relevance/planes.ts`) and this
 * literal is assignable to it — C5 does not declare the union, because that
 * would put a dependency on the layer that consumes C5.
 */
export interface CorpusRecordCandidate {
  readonly reference: EvidenceRecordReference;
  readonly projection: CatalogRecordProjection;
  readonly plane: "public";
  readonly locationHints: readonly RetrievalLocationHint[];
}

export interface CorpusReadQuery {
  readonly family?: EvidenceRecordFamily;
  readonly executorId?: string;
  readonly outcome?: "completed" | "failed" | "abandoned";
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CorpusReadPage {
  readonly items: readonly CorpusRecordCandidate[];
  readonly nextCursor?: string;
  /** How many mirrored records this page's window dropped at the trust gate. */
  readonly excludedByTrust: number;
}

export interface CorpusReadOptions {
  readonly signal?: AbortSignal;
}

export interface MirrorSourceStatus {
  readonly source: SourceIdentity;
  readonly servingRoot: string;
  readonly repositoryId: string;
  readonly highWaterMark?: HighWaterMark;
}

/**
 * The read surface over the public-corpus mirror.
 *
 * It has NO sync method and holds NO reference to `CorpusMirror`. That is
 * cross-plan contract 5 ("mirror sync never blocks pickup") enforced by the
 * type rather than by a convention a caller can forget: a caller of this
 * interface literally cannot await a sync.
 */
export interface CorpusReader {
  listRecords(query?: CorpusReadQuery, options?: CorpusReadOptions): Promise<CorpusReadPage>;
  getRecord(
    reference: EvidenceRecordReference,
    options?: CorpusReadOptions,
  ): Promise<CorpusRecordCandidate | null>;
  describeSources(options?: CorpusReadOptions): Promise<readonly MirrorSourceStatus[]>;
}

export interface CreateCorpusReaderOptions {
  readonly storePaths: OpenCorpusMirrorStoreOptions;
  readonly sources: readonly MirrorSourceConfig[];
  readonly admission: CorpusAdmission;
  readonly highWaterMarks: HighWaterMarkStore;
}

/** The attributable producing agent, per record family. */
export function producerIdOf(projection: CatalogRecordProjection): string {
  switch (projection.family) {
    case "execution-evidence":
      return projection.executorId;
    case "result-evaluation":
      return projection.evaluatorId;
    case "execution-verification":
      return projection.verifierId;
  }
}

export function createCorpusReader(options: CreateCorpusReaderOptions): CorpusReader {
  const sourceIdByRepositoryId = new Map(
    options.sources.map((source) => [source.repositoryId, sourceIdOf(source)] as const),
  );

  function toHints(locations: readonly EvidenceRecordLocation[]): readonly RetrievalLocationHint[] {
    return locations.map((location) => ({
      sourceId: sourceIdByRepositoryId.get(location.repositoryId) ?? MIRROR_REPOSITORY_ID,
      repositoryId: location.repositoryId,
      ...(location.publishedLocation === undefined
        ? {}
        : { publishedLocation: location.publishedLocation }),
    }));
  }

  async function toCandidate(
    store: CorpusMirrorStore,
    projection: CatalogRecordProjection,
    options_?: CorpusReadOptions,
  ): Promise<CorpusRecordCandidate> {
    const locations = await store.catalog.getRecordLocations(projection.reference, options_);
    return {
      reference: projection.reference,
      projection,
      plane: "public",
      locationHints: toHints(locations),
    };
  }

  async function findPage(
    store: CorpusMirrorStore,
    query: CorpusReadQuery,
    options_?: CorpusReadOptions,
  ): Promise<CatalogPage<CatalogRecordProjection>> {
    const page = {
      availability: "available" as const,
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    };

    // One family per call, deliberately: the catalog's cursors are per-query,
    // and inventing a cross-family cursor here would be this application
    // making a protocol decision. `execution-evidence` is the plane's
    // principal family and therefore the default.
    const family = query.family ?? "execution-evidence";
    if (family === "result-evaluation") {
      return store.catalog.findEvaluations(page, options_);
    }
    if (family === "execution-verification") {
      return store.catalog.findVerifications(page, options_);
    }
    return store.catalog.findExecutions(
      {
        ...page,
        ...(query.executorId === undefined ? {} : { executorId: query.executorId }),
        ...(query.outcome === undefined ? {} : { outcome: query.outcome }),
      },
      options_,
    );
  }

  return Object.freeze({
    async listRecords(
      query: CorpusReadQuery = {},
      options_?: CorpusReadOptions,
    ): Promise<CorpusReadPage> {
      return withCorpusMirrorStore(options.storePaths, async (store) => {
        const page = await findPage(store, query, options_);

        // TRUST FILTERING, before anything reaches ranking (cross-plan
        // contract 1). Catalog order is preserved exactly — filtering removes,
        // it never reorders. Relevance is C6's job.
        const items: CorpusRecordCandidate[] = [];
        let excludedByTrust = 0;
        for (const projection of page.items) {
          if (options.admission.admitProducer(producerIdOf(projection)).status === "rejected") {
            excludedByTrust += 1;
            continue;
          }
          items.push(await toCandidate(store, projection, options_));
        }

        return {
          items,
          excludedByTrust,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        };
      });
    },

    async getRecord(
      reference: EvidenceRecordReference,
      options_?: CorpusReadOptions,
    ): Promise<CorpusRecordCandidate | null> {
      return withCorpusMirrorStore(options.storePaths, async (store) => {
        const projection = await store.catalog.getRecord(reference, options_);
        if (projection === null) return null;
        if (options.admission.admitProducer(producerIdOf(projection)).status === "rejected") {
          return null;
        }
        return toCandidate(store, projection, options_);
      });
    },

    async describeSources(): Promise<readonly MirrorSourceStatus[]> {
      const statuses: MirrorSourceStatus[] = [];
      for (const source of options.sources) {
        const identity: SourceIdentity = { agent: source.agent, name: source.name };
        const mark = await options.highWaterMarks.get(identity);
        statuses.push({
          source: identity,
          servingRoot: source.servingRoot,
          repositoryId: source.repositoryId,
          ...(mark === undefined ? {} : { highWaterMark: mark }),
        });
      }
      return statuses;
    },
  });
}
