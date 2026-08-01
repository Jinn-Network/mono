// SPDX-License-Identifier: Apache-2.0

import type {
  ChainEnvironmentRecord,
  ResolvedResources,
} from "@jinn-network/chain-environment-record";
import {
  bareHexDigest,
  chainEnvironmentRecordDigest,
  parseChainEnvironmentRecord,
  sealChainEnvironmentRecord,
  BLACKHOLE_EGRESS_POLICY_ID,
} from "@jinn-network/chain-environment-record";
import { DEFAULT_BLACKHOLE_POLICY, resolveMaterials, toDigestSet, type ResolutionRequest, type ResourceDescriptor } from "@jinn-network/chain-environment-verification";
import { recordDigest, type Sha256Digest } from "@jinn-network/trust-core";

import type { AnchorCapture } from "./anchor.js";
import type { CoverageArtifacts } from "./coverage.js";
import type { ConnectedBaseline, ExtractionRequest } from "./baseline.js";
import { stageFail, stageOk, type StageOutcome } from "./failures.js";
import {
  STATE_ARTIFACT_FORMAT,
  serializeStateArtifact,
  stateArtifactEntryCounts,
  type StateArtifact,
} from "./artifact.js";
import type { ArtifactStore, ExtractionDeps } from "./ports.js";

/** Never sealed. A test asserts it appears in no sealed record this package produces. */
export const PROVISIONAL_COMMITMENT = `0x${"f".repeat(64)}` as const;

export interface ChainEnvironmentCandidate {
  readonly record: ChainEnvironmentRecord;
  readonly recordBytes: Uint8Array;
  readonly recordDigest: Sha256Digest;
  readonly artifact: StateArtifact;
  readonly baseline: ConnectedBaseline;
  /** Stored artifact digests and census — not CE3's `SourceProofManifest` (`verified` flags). */
  readonly coverage: Omit<CoverageArtifacts, "manifest">;
}

export interface AssembleCandidateInput {
  readonly request: ExtractionRequest;
  readonly anchor: AnchorCapture;
  readonly baseline: ConnectedBaseline;
  readonly artifact: StateArtifact;
  readonly coverage: CoverageArtifacts;
  readonly initialStateCommitment: `0x${string}`;
}

interface StoredExtractionArtifacts {
  readonly artifactDigest: Sha256Digest;
  readonly artifactSize: number;
  readonly bundleDigest: Sha256Digest;
  readonly bundleSize: number;
  readonly fixtureDigest: Sha256Digest;
  readonly fixtureSize: number;
}

/**
 * CE1 rejects these at seal time; CE4 rejects them before spending money. Each one is a
 * property of the author's draft that no amount of extraction can fix.
 */
export function assertClosedStatePreconditions(
  draft: ChainEnvironmentRecord,
): StageOutcome<void> {
  const problems: string[] = [];
  if (draft.capabilityEnvelope.egressPolicyId !== BLACKHOLE_EGRESS_POLICY_ID) {
    problems.push(`capabilityEnvelope.egressPolicyId must be ${BLACKHOLE_EGRESS_POLICY_ID}`);
  }
  if (draft.verificationContract.closureCheckRequired !== true) {
    problems.push("verificationContract.closureCheckRequired must be true");
  }
  if (draft.determinismControls.resetMechanism !== "fresh-process") {
    problems.push('determinismControls.resetMechanism must be "fresh-process"');
  }
  return problems.length === 0
    ? stageOk(undefined)
    : stageFail(
        "verification-refused",
        `The draft cannot become a closed-state record: ${problems.join("; ")}.`,
      );
}

async function putChecked(
  store: ArtifactStore,
  bytes: Uint8Array,
  label: string,
): Promise<StageOutcome<{ readonly digest: Sha256Digest; readonly size: number }>> {
  const expected = recordDigest(bytes);
  const stored = await store.putArtifact(bytes);
  if (stored.digest !== expected) {
    return stageFail(
      "artifact-store-failure",
      `${label} store returned ${stored.digest}, expected ${expected}.`,
    );
  }
  return stageOk({ digest: stored.digest, size: stored.size });
}

export async function storeExtractionArtifacts(
  store: ArtifactStore,
  artifact: StateArtifact,
  coverage: CoverageArtifacts,
): Promise<StageOutcome<StoredExtractionArtifacts>> {
  const artifactBytes = serializeStateArtifact(artifact);
  const storedArtifact = await putChecked(store, artifactBytes, "state artifact");
  if (!storedArtifact.ok) return storedArtifact;
  const storedBundle = await putChecked(store, coverage.bundleBytes, "source proof bundle");
  if (!storedBundle.ok) return storedBundle;
  const storedFixture = await putChecked(store, coverage.fixtureBytes, "fixture coverage");
  if (!storedFixture.ok) return storedFixture;
  return stageOk({
    artifactDigest: storedArtifact.value.digest,
    artifactSize: storedArtifact.value.size,
    bundleDigest: storedBundle.value.digest,
    bundleSize: storedBundle.value.size,
    fixtureDigest: storedFixture.value.digest,
    fixtureSize: storedFixture.value.size,
  });
}

export function buildClosedStateRecord(
  request: ExtractionRequest,
  anchor: AnchorCapture,
  artifact: StateArtifact,
  coverage: CoverageArtifacts,
  stored: StoredExtractionArtifacts,
  initialStateCommitment: `0x${string}`,
): ChainEnvironmentRecord {
  const draft = request.draft;
  const existingAnchor = draft.sourceAnchor;
  if (existingAnchor === undefined) {
    throw new Error("An archive-dependent draft must carry a source anchor before extraction.");
  }

  const entryCounts = stateArtifactEntryCounts(artifact);
  const stateMaterialization = {
    closureClass: "closed-state" as const,
    fidelityClass: request.fidelityClass,
    constructionMethod: "archive-extraction" as const,
    materializer: draft.stateMaterialization.materializer,
    stateArtifact: {
      descriptor: {
        name: "state-artifact",
        digest: { sha256: bareHexDigest(stored.artifactDigest) },
        size: stored.artifactSize,
      },
      format: STATE_ARTIFACT_FORMAT,
      entryCounts,
    },
    ...(request.fidelityClass === "local"
      ? {}
      : {
          sourceProofManifest: {
            proofFormat: "eip-1186" as const,
            proofs: {
              name: "source-proofs",
              digest: { sha256: bareHexDigest(stored.bundleDigest) },
              size: stored.bundleSize,
            },
            coverage: coverage.proofCoverage,
          },
        }),
    fixtureCoverage: {
      manifest: {
        name: "fixture-coverage",
        digest: { sha256: bareHexDigest(stored.fixtureDigest) },
        size: stored.fixtureSize,
      },
      declared: coverage.fixtureDeclared,
      mutatedProofCoveredAccounts: coverage.mutatedProofCoveredAccounts,
    },
    mutatesSourceProtocolState: coverage.mutatesSourceProtocolState,
    initialStateCommitment,
  };

  const sourceAnchor = {
    caip2ChainId: existingAnchor.caip2ChainId ?? request.caip2ChainId,
    nativeChainId: existingAnchor.nativeChainId,
    genesisHash: existingAnchor.genesisHash,
    blockNumber: anchor.blockNumber,
    blockHash: anchor.blockHash,
    stateRoot: anchor.stateRoot,
    timestamp: anchor.timestamp,
    finalityPolicy: request.finalityPolicy,
    ...(request.headerProof === undefined
      ? anchor.headerProof === undefined ? {} : { headerProof: anchor.headerProof }
      : { headerProof: request.headerProof }),
  };

  return {
    ...draft,
    sourceAnchor: sourceAnchor as unknown as NonNullable<ChainEnvironmentRecord["sourceAnchor"]>,
    stateMaterialization,
  };
}

function asPrefixedDigest(digest: string): `sha256:${string}` {
  return digest.startsWith("sha256:") ? digest as `sha256:${string}` : `sha256:${digest}` as `sha256:${string}`;
}

function asDigestSet(digest: unknown): { sha256: string } {
  const sha256 = (digest as { sha256?: string }).sha256;
  if (sha256 === undefined) {
    throw new Error("descriptor digest.sha256 is required.");
  }
  return { sha256 };
}

function asResourceDescriptor(descriptor: unknown): ResourceDescriptor {
  const typed = descriptor as {
    readonly name?: string;
    readonly uri?: string;
    readonly mediaType?: string;
    readonly digest: { readonly sha256?: string };
  };
  return {
    ...(typed.name === undefined ? {} : { name: typed.name }),
    ...(typed.uri === undefined ? {} : { uri: typed.uri }),
    ...(typed.mediaType === undefined ? {} : { mediaType: typed.mediaType }),
    digest: asDigestSet(typed.digest),
  };
}

function prefixedDescriptor(name: string, digest: `sha256:${string}`): ResourceDescriptor {
  return { name, digest: toDigestSet(digest) };
}

function materialRequests(record: ChainEnvironmentRecord): readonly ResolutionRequest[] {
  const requests: ResolutionRequest[] = [
    {
      name: "materializer",
      descriptor: prefixedDescriptor(
        record.stateMaterialization.materializer.id,
        asPrefixedDigest(record.stateMaterialization.materializer.digest),
      ),
    },
    {
      name: "probe-suite",
      descriptor: asResourceDescriptor(record.verificationContract.probeSuite.descriptor),
    },
    {
      name: "comparator",
      descriptor: prefixedDescriptor(
        record.verificationContract.comparator.id,
        asPrefixedDigest(record.verificationContract.comparator.digest),
      ),
    },
  ];
  if (record.stateMaterialization.stateArtifact !== undefined) {
    requests.push({
      name: "state-artifact",
      descriptor: asResourceDescriptor(record.stateMaterialization.stateArtifact.descriptor),
    });
  }
  if (record.stateMaterialization.sourceProofManifest !== undefined) {
    requests.push({
      name: "source-proof-manifest",
      descriptor: asResourceDescriptor(record.stateMaterialization.sourceProofManifest.proofs),
    });
  }
  if (record.stateMaterialization.fixtureCoverage?.manifest !== undefined) {
    requests.push({
      name: "fixture-coverage-manifest",
      descriptor: asResourceDescriptor(record.stateMaterialization.fixtureCoverage.manifest),
    });
  }
  if (record.sourceAnchor?.headerProof !== undefined) {
    requests.push({
      name: "header-proof",
      descriptor: asResourceDescriptor(record.sourceAnchor.headerProof),
    });
  }
  record.fixtures.modules.forEach((module, index) => {
    requests.push({
      name: `fixture-${index}-${module.id}`,
      descriptor: asResourceDescriptor(module.module),
    });
  });
  return requests;
}

export async function resolveClosedStateResources(
  store: ArtifactStore,
  record: ChainEnvironmentRecord,
): Promise<StageOutcome<ResolvedResources>> {
  const resolution = await resolveMaterials(store, materialRequests(record));
  if (!resolution.ok) {
    return stageFail(
      "artifact-store-failure",
      `${resolution.reason}: ${resolution.detail}`,
    );
  }
  return stageOk({ byDigest: resolution.bytes as ReadonlyMap<`sha256:${string}`, Uint8Array> });
}

export async function computeSealedInitialCommitment(
  deps: Pick<ExtractionDeps, "runtime">,
  provisional: ChainEnvironmentRecord,
  resources: ResolvedResources,
  artifact: StateArtifact,
): Promise<StageOutcome<`0x${string}`>> {
  const instance = await deps.runtime.materializer.materialize({
    record: provisional,
    resources,
    instanceId: "chain-extraction/initial-commitment",
    networkPolicy: DEFAULT_BLACKHOLE_POLICY,
  });
  try {
    const report = instance.report;
    if (report === undefined) {
      return stageFail("runtime-failure", "The materializer returned no report.");
    }
    const loaded = report.artifactEntries;
    const declared = stateArtifactEntryCounts(artifact);
    for (const key of ["accounts", "codeEntries", "storageSlots"] as const) {
      if (loaded[key].length !== declared[key]) {
        return stageFail(
          "runtime-failure",
          `The materializer loaded ${loaded[key].length} ${key} from an artifact declaring ${declared[key]}.`,
        );
      }
    }
    return stageOk(report.postFixtureCommitment);
  } finally {
    await instance.stop().catch(() => undefined);
  }
}

export async function assembleCandidate(
  deps: Pick<ExtractionDeps, "artifactStore">,
  input: AssembleCandidateInput,
): Promise<StageOutcome<ChainEnvironmentCandidate>> {
  const stored = await storeExtractionArtifacts(deps.artifactStore, input.artifact, input.coverage);
  if (!stored.ok) return stored;

  const record = buildClosedStateRecord(
    input.request,
    input.anchor,
    input.artifact,
    input.coverage,
    stored.value,
    input.initialStateCommitment,
  );

  const recordBytes = sealChainEnvironmentRecord(record);
  const sealed = parseChainEnvironmentRecord(recordBytes);
  const { manifest: _manifest, ...candidateCoverage } = input.coverage;
  return stageOk({
    record: sealed,
    recordBytes,
    recordDigest: chainEnvironmentRecordDigest(recordBytes),
    artifact: input.artifact,
    baseline: input.baseline,
    coverage: candidateCoverage,
  });
}
