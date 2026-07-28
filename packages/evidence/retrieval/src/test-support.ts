import { readFile } from "node:fs/promises";

import {
  createRecordReference,
  type EvidenceRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { vi } from "vitest";

import {
  DEFAULT_RETRIEVAL_HARD_LIMITS,
  type EvidenceLocationPolicy,
  type EvidenceRecordLocator,
  type RetrievalLocationObservation,
} from "./contracts.js";
import {
  createOperationContext,
  resolveHardLimits,
} from "./operation.js";

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
    getArtifact: vi.fn(async () => null),
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
