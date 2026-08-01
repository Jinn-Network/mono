// SPDX-License-Identifier: Apache-2.0

import type { ChainEnvironmentRecord } from "@jinn-network/chain-environment-record";
import {
  anchorAuthenticityBoundOf,
  BLACKHOLE_EGRESS_POLICY_ID,
} from "@jinn-network/chain-environment-record";
import * as chainVerification from "@jinn-network/chain-environment-verification";
import { assessArtifactCoverage } from "@jinn-network/chain-environment-verification";
import { createRequire } from "node:module";
import { createEoaTestSigner } from "@jinn-network/trust-testing";
import { recordDigest, type DsseSigner, type Sha256Digest } from "@jinn-network/trust-core";
import { describe, expect, it } from "vitest";

import type { AnchorCapture } from "./anchor.js";
import type { ConnectedBaseline, ExtractionRequest } from "./baseline.js";
import {
  assembleCandidate,
  PROVISIONAL_COMMITMENT,
} from "./candidate.js";
import {
  buildCoverageArtifacts,
  collectSourceProofs,
} from "./coverage.js";
import { createBudgetedArchivePort } from "./budget.js";
import type { ArtifactStore, ExtractionDeps } from "./ports.js";
import {
  buildFakeTrieWorld,
  fakeStateArtifact,
  FAKE_ACTOR,
  FAKE_POOL,
  FAKE_SLOT_1,
} from "./testing.js";

const require = createRequire(import.meta.url);
const { buildConformanceChainRecord, conformanceArtifactBytes } = require(
  "../../chain-verification/dist/conformance-records.js",
) as {
  buildConformanceChainRecord: (options?: { closureClass?: "archive-dependent" }) => ChainEnvironmentRecord;
  conformanceArtifactBytes: (name: string) => Uint8Array;
};

const eoa = createEoaTestSigner("chain-extraction-candidate-suite");
const signer: DsseSigner = async (request) => [{
  keyid: eoa.address,
  signature: eoa.sign(request.preAuthEncoding),
}];

function closedStateDraft(): ChainEnvironmentRecord {
  const draft = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  return {
    ...draft,
    capabilityEnvelope: {
      ...draft.capabilityEnvelope,
      egressPolicyId: BLACKHOLE_EGRESS_POLICY_ID,
    },
    determinismControls: {
      ...draft.determinismControls,
      resetMechanism: "fresh-process",
    },
    verificationContract: {
      ...draft.verificationContract,
      closureCheckRequired: true,
    },
  };
}

function conformanceArtifactNames(): string[] {
  const record = buildConformanceChainRecord({ closureClass: "archive-dependent" });
  const names = ["materializer", "probe-suite", "comparator", "state-artifact"];
  record.fixtures.modules.forEach((module, index) => {
    names.push(`fixture-${index}-${module.id}`);
  });
  return names;
}

function createConformanceArtifactStore(): ArtifactStore {
  const byDigest = new Map<string, Uint8Array>();
  for (const name of conformanceArtifactNames()) {
    const bytes = conformanceArtifactBytes(name);
    byDigest.set(recordDigest(bytes), bytes);
  }
  const stored = new Map<Sha256Digest, Uint8Array>();
  return {
    async getArtifact(descriptor) {
      const digest = `sha256:${descriptor.digest.sha256}` as Sha256Digest;
      const bytes = byDigest.get(digest) ?? stored.get(digest);
      if (bytes === undefined) {
        throw new Error(`artifact unavailable for ${digest}`);
      }
      return bytes;
    },
    async putArtifact(bytes) {
      const digest = recordDigest(bytes);
      stored.set(digest, bytes);
      return { digest, size: bytes.length };
    },
  };
}

function testAnchor(world: ReturnType<typeof buildFakeTrieWorld>): AnchorCapture {
  return {
    blockNumber: 1,
    blockHash: `0x${"1".repeat(64)}`,
    stateRoot: world.stateRoot,
    timestamp: 1,
    finality: {
      observedAt: "2026-07-31T09:00:00.000Z",
      finalizedBlockNumber: 64,
      depthBelowFinalized: 63,
      finalizedAtObservation: true,
    },
    headerProof: undefined,
  };
}

function extractionRequest(draft: ChainEnvironmentRecord): ExtractionRequest {
  return {
    draft,
    anchorBlockNumber: 1,
    fidelityClass: "anchored-subset",
    sourceAddresses: [FAKE_POOL],
    fixtureDeclarations: [{ address: FAKE_ACTOR, kind: "account" }],
    finalityPolicy: "safe",
  };
}

function stubBaseline(): ConnectedBaseline {
  return {
    observationDigest: `sha256:${"d".repeat(64)}`,
    observation: {
      schema: chainVerification.CHAIN_OBSERVATION_SCHEMA_ID,
      probes: [],
      touchedState: [],
      stateReads: [],
      traceProjectionDigest: `sha256:${"5".repeat(64)}`,
      finalStateCommitment: `0x${"a".repeat(64)}`,
      blocks: [],
    },
    runObservationDigests: [`sha256:${"d".repeat(64)}`, `sha256:${"d".repeat(64)}`],
    touched: { accounts: [], code: [], storage: [] },
    attestation: {
      envelopeBytes: new Uint8Array(),
      payloadBytes: new Uint8Array(),
      attestationDigest: `sha256:${"c".repeat(64)}`,
      statement: {} as never,
      outcome: "archive-observed",
      instanceIds: ["connected"],
      observations: [],
    },
  };
}

async function buildAssembleInput(
  options: { headerProof?: ExtractionRequest["headerProof"] } = {},
) {
  const world = buildFakeTrieWorld();
  const archive = createBudgetedArchivePort(world.archive(), { maxCalls: 100, maxBytes: 5_000_000 });
  const artifact = fakeStateArtifact();
  const proofs = await collectSourceProofs(archive, artifact, {
    addresses: [FAKE_POOL],
    stateRoot: world.stateRoot,
  });
  if (!proofs.ok) throw new Error(proofs.detail);
  const coverage = buildCoverageArtifacts({
    artifact,
    fidelityClass: "anchored-subset",
    bundle: proofs.value,
    declarations: [{ address: FAKE_ACTOR, kind: "account" }],
  });
  if (!coverage.ok) throw new Error(coverage.detail);
  const draft = closedStateDraft();
  const request = {
    ...extractionRequest(draft),
    ...(options.headerProof === undefined ? {} : { headerProof: options.headerProof }),
  };
  return {
    deps: { artifactStore: createConformanceArtifactStore() } satisfies Pick<ExtractionDeps, "artifactStore">,
    input: {
      request,
      anchor: testAnchor(world),
      baseline: stubBaseline(),
      artifact,
      coverage: coverage.value,
      initialStateCommitment: `0x${"a".repeat(64)}` as `0x${string}`,
    },
  };
}

describe("assembleCandidate", () => {
  it("balances the census and seals the record", async () => {
    const { deps, input } = await buildAssembleInput();
    const outcome = await assembleCandidate(deps, input);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const assessment = assessArtifactCoverage({
      fidelityClass: "anchored-subset",
      entries: input.coverage.entries,
      manifest: input.coverage.manifest,
      fixtureMutations: input.coverage.declarations,
      mutatesSourceProtocolState: input.coverage.mutatesSourceProtocolState,
    });
    expect(assessment.complete).toBe(true);
    expect(outcome.value.record.stateMaterialization.closureClass).toBe("closed-state");
    expect(outcome.value.recordBytes.byteLength).toBeGreaterThan(0);
  });

  it("stores bare-hex artifact descriptors whose bytes round-trip", async () => {
    const { deps, input } = await buildAssembleInput();
    const outcome = await assembleCandidate(deps, input);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stateDescriptor = outcome.value.record.stateMaterialization.stateArtifact!.descriptor;
    expect(stateDescriptor.digest!.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(stateDescriptor.digest!.sha256).not.toMatch(/^sha256:/u);

    const stored = await deps.artifactStore.getArtifact(stateDescriptor as {
      digest: { sha256: string };
      name?: string;
      uri?: string;
      mediaType?: string;
    });
    expect(recordDigest(stored)).toBe(`sha256:${stateDescriptor.digest!.sha256}`);
  });

  it("never seals the provisional commitment sentinel", async () => {
    const { deps, input } = await buildAssembleInput();
    const outcome = await assembleCandidate(deps, input);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const serialized = new TextDecoder().decode(outcome.value.recordBytes);
    expect(serialized).not.toContain(PROVISIONAL_COMMITMENT);
    expect(outcome.value.record.stateMaterialization.initialStateCommitment).not.toBe(PROVISIONAL_COMMITMENT);
  });

  it("classifies E5 via CE1's anchorAuthenticityBoundOf", async () => {
    const withoutProof = await buildAssembleInput();
    const declared = await assembleCandidate(withoutProof.deps, withoutProof.input);
    expect(declared.ok).toBe(true);
    if (!declared.ok) return;
    expect(anchorAuthenticityBoundOf(declared.value.record.sourceAnchor)).toBe("declared");

    const withProof = await buildAssembleInput({
      headerProof: { name: "header-proof", digest: { sha256: "a".repeat(64) } },
    });
    const proven = await assembleCandidate(withProof.deps, withProof.input);
    expect(proven.ok).toBe(true);
    if (!proven.ok) return;
    expect(anchorAuthenticityBoundOf(proven.value.record.sourceAnchor)).toBe("header-proven");
  });
});
