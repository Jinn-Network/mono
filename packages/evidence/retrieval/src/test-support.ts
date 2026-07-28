import { readFile } from "node:fs/promises";

import {
  createArtifactReference,
  createRecordReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { vi } from "vitest";

import { referenceKey } from "./candidates.js";
import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type CandidateSource,
  type CandidateSourceDiagnostics,
  type CandidateSourceOperationOptions,
  type CandidateSourceReport,
  type EvidenceCandidate,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type FederatedCandidateAllocation,
  type FederatedOrdering,
  type RetrievalLocationObservation,
  type RetrievalTelemetry,
  type ValidatedRecord,
} from "./contracts.js";
import { createFederatedCandidateSource } from "./federation.js";
import {
  createOperationContext,
  resolveHardLimits,
} from "./operation.js";
import { queryEvidence } from "./query.js";
import type { ResolvedValidatedRecord } from "./resolution.js";
import { createEvidenceRetrieval } from "./retrieval.js";
import { validateCanonicalRecord } from "./validation.js";

const GOLDEN_FIXTURES = {
  "execution-evidence":
    "golden-execution-evidence-v1/execution/ro-crate-metadata.json",
  "result-evaluation":
    "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
  "execution-verification":
    "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
} as const;

export async function loadProtocolFixture(
  family: EvidenceRecordReference["family"],
): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/${GOLDEN_FIXTURES[family]}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}

export function available(
  sourceId: string,
  repositoryId: string,
): RetrievalLocationObservation {
  return {
    observationId: `${sourceId}:${repositoryId}`,
    sourceId,
    status: "available",
    repositoryId,
  };
}

export function withdrawn(
  sourceId: string,
  observationId = `${sourceId}:withdrawn`,
): RetrievalLocationObservation {
  return {
    observationId,
    sourceId,
    status: "withdrawn",
  };
}

export function locatorReturning(
  observations: readonly RetrievalLocationObservation[],
) {
  return {
    locate: vi.fn(async () => observations),
  } satisfies EvidenceRecordLocator;
}

export function policyInObservedOrder(): EvidenceLocationPolicy {
  return {
    select: (_reference, observations) =>
      observations.flatMap((observation) =>
        observation.status === "available"
        && observation.repositoryId !== undefined
          ? [{ repositoryId: observation.repositoryId, observation }]
          : [],
      ),
  };
}

export function repositoryReturning(
  recordBytes: Uint8Array | null,
  artifacts: Readonly<Record<string, Uint8Array>> = {},
): EvidenceRepository & {
  readonly getRecord: ReturnType<typeof vi.fn>;
  readonly getArtifact: ReturnType<typeof vi.fn>;
} {
  const unsupported = async (): Promise<never> => {
    throw new Error("Test repository is read-only.");
  };
  return {
    capabilities: Object.freeze({}),
    putRecord: unsupported,
    putArtifact: unsupported,
    getRecord: vi.fn(async () =>
      recordBytes === null ? null : Uint8Array.from(recordBytes),
    ),
    getArtifact: vi.fn(async (reference: { readonly digest: string }) => {
      const bytes = artifacts[reference.digest];
      return bytes === undefined ? null : Uint8Array.from(bytes);
    }),
  };
}

export function resolverFrom(
  repositories: Readonly<Record<string, EvidenceRepository>>,
) {
  return {
    resolve: vi.fn(async (repositoryId: string) =>
      repositories[repositoryId] ?? null,
    ),
  };
}

export function operationContext() {
  return createOperationContext(
    resolveHardLimits(DEFAULT_RETRIEVAL_HARD_LIMITS),
  );
}

export function arbitraryReference() {
  return createRecordReference(
    "execution-evidence",
    new TextEncoder().encode("arbitrary"),
  );
}

export async function validatedFixture(
  family: EvidenceRecordReference["family"],
): Promise<ValidatedRecord> {
  const bytes = await loadProtocolFixture(family);
  const reference = createRecordReference(family, bytes);
  const validation = validateCanonicalRecord(
    reference,
    bytes,
    bytes.byteLength,
  );
  if (!validation.ok) {
    throw new Error(`Golden ${family} fixture did not validate.`);
  }
  return validation.validatedRecord;
}

export async function loadProtocolArtifact(path: string): Promise<Uint8Array> {
  const url = import.meta.resolve(
    `@jinn-network/evidence-protocol/fixtures/golden-execution-evidence-v1/${path}`,
  );
  return new Uint8Array(await readFile(new URL(url)));
}

export async function artifactFixture() {
  const canonicalBytes = await loadProtocolFixture("execution-evidence");
  const reference = createRecordReference(
    "execution-evidence",
    canonicalBytes,
  );
  const validation = validateCanonicalRecord(
    reference,
    canonicalBytes,
    canonicalBytes.byteLength,
  );
  if (!validation.ok) throw new Error("Golden execution fixture did not validate.");
  const resultBytes = await loadProtocolArtifact(
    "execution/results/slug-normalization.patch",
  );
  const resultReference = createArtifactReference(resultBytes);
  const repository = repositoryReturning(canonicalBytes, {
    [resultReference.digest]: resultBytes,
  });
  const observation = available("fixture", "memory");
  const record: ResolvedValidatedRecord = {
    reference,
    canonicalBytes: validation.canonicalBytes,
    validatedRecord: validation.validatedRecord,
    availability: [observation],
    selectedLocation: observation,
    repository,
    allowedLocationAttempts: [{
      repositoryId: "memory",
      observation,
    }],
    warnings: [],
    failures: [],
  };
  return {
    record,
    resultBytes,
    repositories: [repository],
    resolver: resolverFrom({ memory: repository }),
    context: operationContext(),
  };
}

export function candidateOptions(
  maximumCandidates: number,
): CandidateSourceOperationOptions {
  return {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
    maximumCandidates,
  };
}

export function sourceFixture(
  id: string,
  references: readonly EvidenceRecordReference[],
) {
  const identity = { id, version: "1.0.0" };
  const find = vi.fn(async (
    _query: unknown,
    operation: CandidateSourceOperationOptions,
  ) => ({
    source: identity,
    candidates: references
      .slice(0, operation.maximumCandidates)
      .map((reference) => ({ reference })),
  }));
  return {
    find,
    source: { identity, find } satisfies CandidateSource<unknown>,
  };
}

export function failingSourceFixture(id: string) {
  const identity = { id, version: "1.0.0" };
  const find = vi.fn(async (): Promise<never> => {
    throw new Error("Synthetic source failure.");
  });
  return {
    find,
    source: { identity, find } satisfies CandidateSource<unknown>,
  };
}

export const equalAllocation: FederatedCandidateAllocation<unknown> = (
  maximum,
  sources,
) => sources.map((_source, index) =>
  Math.floor(maximum / sources.length)
  + (index < maximum % sources.length ? 1 : 0),
);

export const providerOrder: FederatedOrdering<
  unknown,
  unknown,
  undefined
> = (groups) => groups.map(({ reference }) => ({ reference }));

export function federated(
  ...sources: readonly CandidateSource<unknown>[]
) {
  return createFederatedCandidateSource({
    identity: { id: "federated-fixture", version: "1.0.0" },
    sources,
    allocate: equalAllocation,
    order: providerOrder,
  });
}

export async function createKnownReferenceFixture(options: {
  readonly returnedRecordBytes?: Uint8Array | null;
} = {}) {
  const bytes = await loadProtocolFixture("execution-evidence");
  const reference = createRecordReference("execution-evidence", bytes);
  const repository = repositoryReturning(
    options.returnedRecordBytes === undefined
      ? bytes
      : options.returnedRecordBytes,
  );
  const locator = locatorReturning([available("fixture", "memory")]);
  const repositoryResolver = resolverFrom({ memory: repository });
  return {
    bytes,
    reference,
    repository,
    locator,
    repositoryResolver,
    dependencies: {
      locator,
      locationPolicy: policyInObservedOrder(),
      repositoryResolver,
      hardLimits: resolveHardLimits(),
    },
  };
}

export async function createQueryReferenceSet() {
  const executionBytes = await loadProtocolFixture("execution-evidence");
  const evaluationBytes = await loadProtocolFixture("result-evaluation");
  const nonconformingBytes = new TextEncoder().encode("{}");
  return {
    firstValidReference: createRecordReference(
      "execution-evidence",
      executionBytes,
    ),
    secondValidReference: createRecordReference(
      "result-evaluation",
      evaluationBytes,
    ),
    unavailableReference: createRecordReference(
      "execution-evidence",
      new TextEncoder().encode("unavailable"),
    ),
    nonconformingReference: createRecordReference(
      "execution-evidence",
      nonconformingBytes,
    ),
    bytesByReference: new Map([
      [
        referenceKey(createRecordReference(
          "execution-evidence",
          executionBytes,
        )),
        executionBytes,
      ],
      [
        referenceKey(createRecordReference(
          "result-evaluation",
          evaluationBytes,
        )),
        evaluationBytes,
      ],
      [
        referenceKey(createRecordReference(
          "execution-evidence",
          nonconformingBytes,
        )),
        nonconformingBytes,
      ],
    ]),
  };
}

export interface QueryFixtureOptions<ProviderData = unknown> {
  readonly pages: readonly (
    readonly (
      | EvidenceRecordReference
      | EvidenceCandidate<ProviderData>
    )[]
  )[];
  readonly sourceReports?: readonly CandidateSourceReport[];
  readonly artifactByDigest?: Readonly<Record<string, Uint8Array>>;
  readonly diagnostics?: CandidateSourceDiagnostics;
}

export async function queryFixture<ProviderData = unknown>(
  options: QueryFixtureOptions<ProviderData>,
) {
  const references = await createQueryReferenceSet();
  const repository = repositoryReturning(null, options.artifactByDigest);
  repository.getRecord.mockImplementation(async (
    reference: EvidenceRecordReference,
  ) => {
    const bytes = references.bytesByReference.get(referenceKey(reference));
    return bytes === undefined ? null : Uint8Array.from(bytes);
  });
  const locator = {
    locate: vi.fn(async (reference: EvidenceRecordReference) => {
      return references.bytesByReference.has(referenceKey(reference))
        ? [available("fixture", "memory")]
        : [];
    }),
  };
  const repositoryResolver = resolverFrom({ memory: repository });
  const identity = { id: "paged-fixture", version: "1.0.0" };
  const find = vi.fn(async (
    _query: unknown,
    operation: CandidateSourceOperationOptions,
  ) => {
    const pageIndex = operation.cursor === undefined
      ? 0
      : Number(operation.cursor.value);
    const page = options.pages[pageIndex] ?? [];
    const candidates = page
      .slice(0, operation.maximumCandidates)
      .map((value) =>
        "reference" in value ? value : { reference: value },
      );
    const nextIndex = pageIndex + 1;
    return {
      source: identity,
      candidates,
      ...(nextIndex >= options.pages.length
        ? {}
        : {
            nextCursor: {
              source: identity,
              value: nextIndex,
            },
          }),
      ...(options.sourceReports === undefined
        ? {}
        : { sourceReports: options.sourceReports }),
      ...(options.diagnostics === undefined
        ? {}
        : { diagnostics: options.diagnostics }),
    };
  });
  const source = { identity, find } satisfies CandidateSource<
    unknown,
    ProviderData
  >;
  const dependencies = {
    locator,
    locationPolicy: policyInObservedOrder(),
    repositoryResolver,
    hardLimits: resolveHardLimits(),
  };
  return {
    ...references,
    source,
    find,
    repository,
    locator,
    repositoryResolver,
    dependencies,
  };
}

export async function runQuery<ProviderData>(
  fixture: Awaited<ReturnType<typeof queryFixture<ProviderData>>>,
  limits: { readonly resultLimit: number; readonly candidateBudget: number },
) {
  return queryEvidence(
    fixture.dependencies,
    {
      candidateSource: fixture.source,
      sourceQuery: { kind: "fixture" },
      diagnostics: "detailed",
      ...limits,
    },
  );
}

export interface FacadeFixtureOptions {
  readonly providerData?: unknown;
  readonly telemetry?: RetrievalTelemetry;
}

export async function facadeFixture(
  options: FacadeFixtureOptions = {},
) {
  const references = await createQueryReferenceSet();
  const fixture = await queryFixture({
    pages: [[{
      reference: references.firstValidReference,
      ...(options.providerData === undefined
        ? {}
        : { providerData: options.providerData }),
    }]],
  });
  const retrievalOptions = {
    locator: fixture.locator,
    locationPolicy: policyInObservedOrder(),
    repositoryResolver: fixture.repositoryResolver,
    ...(options.telemetry === undefined
      ? {}
      : { telemetry: options.telemetry }),
  };
  return {
    ...fixture,
    options: retrievalOptions,
    retrieval: createEvidenceRetrieval(retrievalOptions),
    reference: references.firstValidReference,
  };
}
