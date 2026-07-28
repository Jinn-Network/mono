// SPDX-License-Identifier: Apache-2.0
import { derivePublicationIdentities } from "@jinn-network/evidence-publication";
import {
  createArtifactReference,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import {
  createPreparedDisclosureManifest,
  parsePreparedDisclosureManifest,
  type CreatePreparedDisclosureManifestInput,
} from "./manifest.js";
import type { ContributionDestination } from "./types.js";

const source = createRecordReference("execution-evidence", new Uint8Array([1]));
const preparedRecord = createRecordReference(
  "execution-evidence",
  new Uint8Array([2]),
);
const artifactA = createArtifactReference(new Uint8Array([10]));
const artifactB = createArtifactReference(new Uint8Array([11]));

function destination(
  overrides: Partial<ContributionDestination> = {},
): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "unsupported",
    ...overrides,
  };
}

function baseInput(
  overrides: Partial<CreatePreparedDisclosureManifestInput> = {},
): CreatePreparedDisclosureManifestInput {
  return {
    requestId: "request-1",
    intentFingerprint: `sha256:${"e".repeat(64)}`,
    source,
    preparedRecord,
    artifacts: [artifactB, artifactA],
    preparation: { kind: "signed-unchanged" },
    policyDecision: {
      authorityId: "https://authority.example/policy",
      decisionId: "decision-1",
      digest: `sha256:${"a".repeat(64)}`,
    },
    destinations: [destination()],
    unavailableArtifacts: [],
    risk: {
      irreversibility: "immutable-or-replicable",
      sourceCommitmentCorrelation: "none-declared",
    },
    ...overrides,
  };
}

describe("createPreparedDisclosureManifest", () => {
  test("derives Publication identities per destination from the prepared record and artifacts", () => {
    const disclosure = createPreparedDisclosureManifest(baseInput());
    const expected = derivePublicationIdentities(
      [preparedRecord],
      [artifactA, artifactB],
      destination().destination,
    );
    expect(disclosure.manifest.destinations[0]).toMatchObject({
      bundleKey: expected.bundleKey,
      payloadFingerprint: expected.payloadFingerprint,
    });
  });

  test("sorts the artifact set by digest regardless of input order", () => {
    const disclosure = createPreparedDisclosureManifest(baseInput({
      artifacts: [artifactB, artifactA],
    }));
    const digests = disclosure.manifest.artifacts.map((artifact) => artifact.digest);
    expect(digests).toEqual([...digests].sort());
  });

  test("previewFingerprint is the hash of the exact manifest bytes", async () => {
    const { hashExactBytes } = await import("@jinn-network/evidence-publication");
    const disclosure = createPreparedDisclosureManifest(baseInput());
    expect(disclosure.previewFingerprint)
      .toBe(hashExactBytes(disclosure.manifestBytes));
  });

  test("is deterministic for logically identical destinations in different order", () => {
    const a = destination({ destination: "https://a.example" });
    const b = destination({ destination: "https://b.example" });
    const first = createPreparedDisclosureManifest(baseInput({ destinations: [a, b] }));
    const second = createPreparedDisclosureManifest(baseInput({ destinations: [b, a] }));
    expect(first.previewFingerprint).toBe(second.previewFingerprint);
  });

  test("rejects an empty destination set", () => {
    expect(() => createPreparedDisclosureManifest(baseInput({ destinations: [] })))
      .toThrow(EvidenceContributionError);
  });
});

describe("parsePreparedDisclosureManifest", () => {
  test("round-trips a created manifest byte-for-byte", () => {
    const disclosure = createPreparedDisclosureManifest(baseInput());
    const parsed = parsePreparedDisclosureManifest(disclosure.manifestBytes);
    expect(parsed).toEqual(disclosure.manifest);
  });

  test("fails closed on an unsupported major schema version", () => {
    const disclosure = createPreparedDisclosureManifest(baseInput());
    const tampered = JSON.parse(new TextDecoder().decode(disclosure.manifestBytes));
    tampered.schemaVersion = 2;
    const bytes = new TextEncoder().encode(JSON.stringify(tampered));
    expect(() => parsePreparedDisclosureManifest(bytes))
      .toThrow(EvidenceContributionError);
  });

  test("rejects malformed JSON", () => {
    expect(() => parsePreparedDisclosureManifest(new TextEncoder().encode("{not json")))
      .toThrow(EvidenceContributionError);
  });
});
