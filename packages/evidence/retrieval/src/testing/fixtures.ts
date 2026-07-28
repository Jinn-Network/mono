import { readFile } from "node:fs/promises";

import {
  createRecordReference,
  type EvidenceRecordReference,
} from "@jinn-network/evidence-repository";
import {
  InMemoryEvidenceRepository,
} from "@jinn-network/evidence-repository/testing";

import {
  createEvidenceRetrieval,
  type CandidatePage,
  type CandidateSource,
  type CandidateSourceIdentity,
  type CandidateSourceOperationOptions,
  type EvidenceCandidate,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type EvidenceRetrieval,
  type RetrievalLocationObservation,
} from "../index.js";

const FIXTURE_PATHS = {
  "execution-evidence":
    "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
  "result-evaluation":
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  "execution-verification":
    "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
} as const;

const RESULT_ARTIFACT_PATH =
  "golden-execution-evidence-v1/execution/results/slug-normalization.patch";

async function readFixtureBytes(path: string): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/${path}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}

export async function loadGoldenEvidenceRecords(): Promise<
  ReadonlyMap<EvidenceRecordReference["family"], {
    readonly reference: EvidenceRecordReference;
    readonly bytes: Uint8Array;
  }>
> {
  const records = new Map<EvidenceRecordReference["family"], {
    readonly reference: EvidenceRecordReference;
    readonly bytes: Uint8Array;
  }>();
  for (const [family, path] of Object.entries(FIXTURE_PATHS)) {
    const bytes = await readFixtureBytes(path);
    records.set(family as EvidenceRecordReference["family"], {
      reference: createRecordReference(
        family as EvidenceRecordReference["family"],
        bytes,
      ),
      bytes,
    });
  }
  return records;
}

export class StaticCandidateSource<Query, ProviderData = unknown>
implements CandidateSource<Query, ProviderData> {
  constructor(
    readonly identity: CandidateSourceIdentity,
    readonly candidates: readonly EvidenceCandidate<ProviderData>[],
  ) {}

  async find(
    _query: Query,
    options: CandidateSourceOperationOptions,
  ): Promise<CandidatePage<ProviderData>> {
    if (options.signal.aborted) {
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    return {
      source: this.identity,
      candidates: this.candidates.slice(0, options.maximumCandidates),
    };
  }
}

export interface SyntheticRetrievalFixture {
  readonly retrieval: EvidenceRetrieval;
  readonly records: ReadonlyMap<EvidenceRecordReference["family"], {
    readonly reference: EvidenceRecordReference;
    readonly bytes: Uint8Array;
  }>;
  readonly source: CandidateSource<{ readonly kind: "all" }>;
  readonly repository: InMemoryEvidenceRepository;
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly cleanup: () => Promise<void>;
}

export async function createSyntheticRetrievalFixture(): Promise<SyntheticRetrievalFixture> {
  const records = await loadGoldenEvidenceRecords();
  const repository = new InMemoryEvidenceRepository();
  for (const { reference, bytes } of records.values()) {
    await repository.putRecord(reference.family, bytes);
  }
  const resultArtifactBytes = await readFixtureBytes(RESULT_ARTIFACT_PATH);
  await repository.putArtifact(resultArtifactBytes);

  const locator: EvidenceRecordLocator = {
    locate: async (): Promise<readonly RetrievalLocationObservation[]> => [{
      observationId: "synthetic:memory",
      sourceId: "synthetic",
      status: "available",
      repositoryId: "memory",
    }],
  };
  const locationPolicy: EvidenceLocationPolicy = {
    select: (_reference, observations) =>
      observations.flatMap((observation) =>
        observation.status === "available" && observation.repositoryId !== undefined
          ? [{ repositoryId: observation.repositoryId, observation }]
          : [],
      ),
  };
  const repositoryResolver = {
    resolve: async (repositoryId: string) =>
      repositoryId === "memory" ? repository : null,
  };

  const retrieval = createEvidenceRetrieval({
    locator,
    locationPolicy,
    repositoryResolver,
    hardLimits: {
      timeoutMs: 5_000,
      maxResultLimit: 10,
      maxCandidateBudget: 10,
      maxCandidatePageSize: 10,
    },
  });

  const source = new StaticCandidateSource<{ readonly kind: "all" }>(
    { id: "synthetic-fixture", version: "1.0.0" },
    [...records.values()].map(({ reference }) => ({ reference })),
  );

  return {
    retrieval,
    records,
    source,
    repository,
    locator,
    locationPolicy,
    cleanup: async () => {},
  };
}
