// SPDX-License-Identifier: Apache-2.0
// Test-only. Not exported from `src/corpus/index.ts`.

import { createEvidenceIndexer } from "@jinn-network/evidence-discovery/indexer";
import { validateAndProjectEvidenceRecord } from "@jinn-network/evidence-discovery/indexer";
import type { ExecutionEvidenceProjection } from "@jinn-network/evidence-discovery";
import { recordDigest, validateExecutionEvidence } from "@jinn-network/evidence-protocol";
import type {
  EvidenceRecordReference,
  EvidenceRepository,
} from "@jinn-network/evidence-repository";
import {
  RECORD_DISCOVERY_VERSION,
  RECORD_KINDS,
  headPath,
  sealJson,
} from "@jinn-network/record-discovery-protocol";
import type { Transport, TransportResponse } from "@jinn-network/record-discovery-client";
import {
  TRUST_POLICY_FORMAT,
  parseDsseEnvelope,
  sealTrustPolicy,
  type DsseChainVerifier,
  type DsseProducedSignature,
  type DsseSigner,
  type Sha256Digest,
} from "@jinn-network/trust-core";

import fixtureSource from "../../fixtures/corpus/execution-evidence.valid.json?raw";

import type { MirrorSourceConfig } from "../config.js";
import { DEFAULT_CORPUS_PRODUCER_PURPOSE } from "./admission.js";
import { openCorpusMirrorStore, type OpenCorpusMirrorStoreOptions } from "./store.js";

/**
 * A conforming Execution Evidence record, taken byte-for-byte from
 * `packages/evidence/protocol`'s own golden fixture so this tree never
 * authors a second copy of the record family's truth.
 */
export const executionEvidenceFixture = {
  bytes: new TextEncoder().encode(fixtureSource),
};

/** The golden fixture's primary Execution entity `@id`. */
const GOLDEN_EXECUTION_ID = "urn:uuid:22222222-2222-4222-8222-222222222222";

/** The golden fixture's Executor Agent entity `@id`. */
const GOLDEN_EXECUTOR_ID = "urn:uuid:33333333-3333-4333-8333-333333333333";

/** Distinct `urn:uuid` execution IRIs for the three seeded variants. */
const EXECUTION_IRIS = {
  "exec-1": "urn:uuid:a0000001-0001-4001-8001-000000000001",
  "exec-2": "urn:uuid:a0000002-0002-4002-8002-000000000002",
  "exec-3": "urn:uuid:a0000003-0003-4003-8003-000000000003",
} as const;

type ExecutionVariantLabel = keyof typeof EXECUTION_IRIS;

type RoCrateEntity = Record<string, unknown> & { "@id": string };
type RoCrateDocument = {
  readonly "@context": unknown;
  readonly "@graph": RoCrateEntity[];
};

function replaceEntityId(value: unknown, from: string, to: string): unknown {
  if (value === from) return to;
  if (Array.isArray(value)) return value.map((entry) => replaceEntityId(entry, from, to));
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) {
      next[key] = key === "@id" && entry === from ? to : replaceEntityId(entry, from, to);
    }
    return next;
  }
  return value;
}

function applyVariant(
  template: RoCrateDocument,
  variant: { readonly executorId: string; readonly executionId: string },
): RoCrateDocument {
  const executionIri =
    EXECUTION_IRIS[variant.executionId as ExecutionVariantLabel] ?? variant.executionId;
  const document = structuredClone(template) as RoCrateDocument;
  const execution = document["@graph"].find((entity) => entity["@id"] === GOLDEN_EXECUTION_ID);
  const executor = document["@graph"].find((entity) => entity["@id"] === GOLDEN_EXECUTOR_ID);
  if (execution === undefined || executor === undefined) {
    throw new Error("golden execution-evidence fixture is missing required entities");
  }
  execution["@id"] = executionIri;
  executor["@id"] = variant.executorId;
  let mutated = replaceEntityId(document, GOLDEN_EXECUTION_ID, executionIri) as RoCrateDocument;
  mutated = replaceEntityId(mutated, GOLDEN_EXECUTOR_ID, variant.executorId) as RoCrateDocument;
  return mutated;
}

function canonicalize(document: RoCrateDocument): Uint8Array {
  // Same canonical shape the protocol's own golden tests use: pretty-printed
  // JSON with a trailing newline (`packages/evidence/protocol` execution.test.ts).
  return new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`);
}

function variantBytes(variant: {
  readonly executorId: string;
  readonly executionId: string;
}): Uint8Array {
  const template = JSON.parse(new TextDecoder().decode(executionEvidenceFixture.bytes)) as RoCrateDocument;
  const bytes = canonicalize(applyVariant(template, variant));
  const report = validateExecutionEvidence(bytes);
  if (!report.conforms) {
    throw new Error(
      `variant ${variant.executionId} is not conforming: ${JSON.stringify(report.diagnostics)}`,
    );
  }
  return bytes;
}

const VARIANTS = [
  { executorId: "https://agents.test/alice", executionId: "exec-1" },
  { executorId: "https://agents.test/alice", executionId: "exec-2" },
  { executorId: "https://agents.test/mallory", executionId: "exec-3" },
] as const;

const VARIANT_BYTES = VARIANTS.map((variant) => ({
  variant,
  bytes: variantBytes(variant),
}));

const FIXTURE_SIGNER_KEY = "did:key:z6MkhaTEeQnCVYnQwFRZmpFotWSU7Fdd5tkVEQxCwPvzMWzz";

function fixtureSigner(keyids: readonly string[]): DsseSigner {
  return async () =>
    keyids.map((keyid, index) => ({
      signature: new Uint8Array([index + 1]),
      keyid,
    })) as [DsseProducedSignature, ...DsseProducedSignature[]];
}

/**
 * Trusts every keyid an envelope's own signatures claim — the same honest
 * test double `trust-core`'s policy tests use (`policy.test.ts`).
 */
export const fixtureTrustDsseVerifier: DsseChainVerifier = (envelopeBytes) => {
  const parsed = parseDsseEnvelope(envelopeBytes);
  return {
    validSignerKeyids: parsed.signatures.flatMap((signature) =>
      signature.keyid === undefined ? [] : [signature.keyid],
    ),
  };
};

async function sealProducerPolicy(
  admittedProducers: readonly string[],
): Promise<{ readonly envelopeBytes: Uint8Array; readonly digest: Sha256Digest }> {
  const sealed = await sealTrustPolicy(
    {
      protocol: TRUST_POLICY_FORMAT,
      version: 1,
      purposes: {
        [DEFAULT_CORPUS_PRODUCER_PURPOSE]: {
          accepted: [...admittedProducers],
          requiredStrength: "strong",
        },
      },
      signerSet: { keys: [FIXTURE_SIGNER_KEY], threshold: 1 },
      refreshBy: "2027-01-01T00:00:00.000Z",
    },
    fixtureSigner([FIXTURE_SIGNER_KEY]),
  );
  return { envelopeBytes: sealed.envelopeBytes, digest: sealed.recordDigest };
}

const [alicePolicy, emptyPolicy] = await Promise.all([
  sealProducerPolicy(["https://agents.test/alice"]),
  sealProducerPolicy([]),
]);

function policyCacheKey(admittedProducers: readonly string[]): string {
  return admittedProducers.join("\0");
}

const POLICY_BY_ADMISSION = new Map<string, { readonly envelopeBytes: Uint8Array; readonly digest: Sha256Digest }>([
  [policyCacheKey(["https://agents.test/alice"]), alicePolicy],
  [policyCacheKey([]), emptyPolicy],
]);

export interface SeededMirror {
  readonly aliceReferences: readonly EvidenceRecordReference[];
  readonly malloryReference: EvidenceRecordReference;
  readonly localRepository: EvidenceRepository;
}

/**
 * Seeds a mirror with three execution records — two produced by
 * `https://agents.test/alice`, one by `https://agents.test/mallory` — by
 * running the real indexer against an in-memory repository, so the seeded
 * projections are the ones production would write, not hand-built ones.
 *
 * The three records differ only in their `executorId`, so each has a distinct
 * digest and the trust-filtering tests can assert on producer identity alone.
 */
export async function seedMirror(
  paths: OpenCorpusMirrorStoreOptions,
  source: MirrorSourceConfig,
): Promise<SeededMirror> {
  const store = await openCorpusMirrorStore(paths);
  try {
    const seeded: { reference: EvidenceRecordReference; executorId: string }[] = [];
    const byDigest = new Map<string, Uint8Array>();

    for (const entry of VARIANT_BYTES) {
      const bytes = entry.bytes;
      const reference = {
        family: "execution-evidence" as const,
        digest: recordDigest(bytes),
      };
      byDigest.set(reference.digest, bytes);
      seeded.push({ reference, executorId: entry.variant.executorId });
    }

    const indexer = createEvidenceIndexer({
      catalog: store.catalog,
      repositories: {
        async resolve() {
          return {
            capabilities: {},
            async getRecord(reference: EvidenceRecordReference) {
              return byDigest.get(reference.digest) ?? null;
            },
            async getArtifact() {
              return null;
            },
            async putRecord() {
              throw new Error("seed repository is read-only");
            },
            async putArtifact() {
              throw new Error("seed repository is read-only");
            },
          } as EvidenceRepository;
        },
      },
    });

    let ordinal = 0;
    for (const entry of seeded) {
      ordinal += 1;
      await indexer.index({
        kind: "available",
        sourceId: `${source.agent}/${source.name}`,
        announcementId: `ann-${String(ordinal)}`,
        repositoryId: source.repositoryId,
        reference: entry.reference,
      });
      await store.repository.putRecord(
        "execution-evidence",
        byDigest.get(entry.reference.digest)!,
      );
    }

    return {
      aliceReferences: seeded
        .filter((entry) => entry.executorId === "https://agents.test/alice")
        .map((entry) => entry.reference),
      malloryReference: seeded.find(
        (entry) => entry.executorId === "https://agents.test/mallory",
      )!.reference,
      localRepository: store.repository,
    };
  } finally {
    await store.close();
  }
}

export function executionProjection(overrides: {
  readonly executorId: string;
}): ExecutionEvidenceProjection {
  const bytes =
    VARIANT_BYTES.find((entry) => entry.variant.executorId === overrides.executorId)?.bytes
    ?? VARIANT_BYTES[0]!.bytes;
  const reference = {
    family: "execution-evidence" as const,
    digest: recordDigest(bytes),
  };
  const projected = validateAndProjectEvidenceRecord(reference, bytes);
  if (!projected.conforms) {
    throw new Error("seeded execution-evidence variant failed projection");
  }
  if (projected.projection.family !== "execution-evidence") {
    throw new Error("expected an execution-evidence projection");
  }
  return projected.projection;
}

export interface FixtureArchive {
  readonly transport: Transport;
  readonly slowTransport: Transport;
  readonly policyVersions: readonly Uint8Array[];
  readonly genesisDigest: Sha256Digest;
  readonly reference: EvidenceRecordReference;
}

function jsonResponse(value: unknown): TransportResponse {
  return {
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
  };
}

function buildArchiveTransport(
  source: MirrorSourceConfig,
  recordBytes: readonly Uint8Array[],
  delayMs = 0,
): Transport {
  const announcements = recordBytes.map((bytes, index) => ({
    announcementId: `ann-${String(index + 1)}`,
    action: "available" as const,
    record: { kind: RECORD_KINDS.executionEvidence, digest: recordDigest(bytes) },
  }));
  const entry = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: { agent: source.agent, name: source.name },
    sequence: "0000000000000001",
    previous: null,
    timestamp: "2026-07-30T00:00:00Z",
    announcements,
  };
  const entryDigest = sealJson(entry).digest;
  const head = {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: `${source.agent}/${source.name}`,
    sequence: "0000000000000001",
    entry: entryDigest,
    issuedAt: "2026-07-30T00:00:00Z",
    refreshBy: "2026-08-30T00:00:00Z",
  };
  const page = {
    protocol: RECORD_DISCOVERY_VERSION,
    source: `${source.agent}/${source.name}`,
    page: "0000000000000001",
    prevArchive: null,
    entries: [{ entry }],
  };
  const recordsByDigest = new Map(
    recordBytes.map((bytes) => [recordDigest(bytes), bytes] as const),
  );

  return {
    async fetch(url: string): Promise<TransportResponse> {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (url === `${source.servingRoot}${headPath(source.name)}`) return jsonResponse(head);
      if (url === source.archiveRootUrl) return jsonResponse(page);
      for (const [digest, bytes] of recordsByDigest) {
        if (url === `${source.servingRoot}/records/${digest.slice("sha256:".length)}`) {
          return { status: 200, bytes };
        }
      }
      return { status: 404, bytes: new Uint8Array() };
    },
  };
}

/**
 * Builds a fixture archive that serves the alice execution variants and a
 * signed trust-policy chain admitting `admittedProducers`.
 */
export function buildFixtureArchive(
  source: MirrorSourceConfig,
  admittedProducers: readonly string[],
): FixtureArchive {
  const policy = POLICY_BY_ADMISSION.get(policyCacheKey(admittedProducers)) ?? emptyPolicy;
  const aliceBytes = VARIANT_BYTES.filter(
    (entry) => entry.variant.executorId === "https://agents.test/alice",
  ).map((entry) => entry.bytes);
  const reference = {
    family: "execution-evidence" as const,
    digest: recordDigest(aliceBytes[0]!),
  };
  const transport = buildArchiveTransport(source, aliceBytes);
  return {
    transport,
    slowTransport: buildArchiveTransport(source, aliceBytes, 50),
    policyVersions: [policy.envelopeBytes],
    genesisDigest: policy.digest,
    reference,
  };
}
