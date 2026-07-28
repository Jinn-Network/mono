import { readFile } from "node:fs/promises";

import {
  createArtifactReference,
  createRecordReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type CandidateSource,
  type CandidateSourceOperationOptions,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type FederatedCandidateAllocation,
  type FederatedOrdering,
  type RetrievalLocationObservation,
  type ValidatedRecord,
} from "./contracts.js";
import { createFederatedCandidateSource } from "./federation.js";
import {
  createOperationContext,
  resolveHardLimits,
} from "./operation.js";
import type { ResolvedValidatedRecord } from "./resolution.js";
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
