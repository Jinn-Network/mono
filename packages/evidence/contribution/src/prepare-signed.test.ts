// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { createRecordReference } from "@jinn-network/evidence-repository";
import type { EvidenceRepository, Sha256Digest } from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import { prepareSignedDisclosure } from "./prepare-signed.js";
import type { RepositoryResolver } from "./source.js";
import type {
  ContributionDestination,
  VerifiedSignedUnchangedDecision,
} from "./types.js";

const SOURCE_BINDING = "private-local";
const STAGING_BINDING = "private-staging";

const require = createRequire(import.meta.url);

async function loadGoldenFixture(path: string): Promise<Uint8Array> {
  const fixturePath = require.resolve(
    `@jinn-network/evidence-protocol/fixtures/${path}`,
  );
  return new Uint8Array(await readFile(fixturePath));
}

function destination(): ContributionDestination {
  return {
    destination: "https://destinations.example/ipfs",
    medium: "https://media.example/ipfs",
    profile: "https://profiles.example/evidence/v1",
    configurationDigest: `sha256:${"c".repeat(64)}`,
    label: "Public IPFS",
    irreversible: true,
    deactivation: "unsupported",
  };
}

function resolverFor(
  repositories: Readonly<Record<string, EvidenceRepository>>,
): RepositoryResolver {
  return {
    resolve: async (bindingId) => {
      const repository = repositories[bindingId];
      if (repository === undefined) throw new Error(`unknown binding ${bindingId}`);
      return repository;
    },
  };
}

const decision = {
  authorityId: "https://authority.example/policy",
  decisionId: "decision-1",
  digest: `sha256:${"a".repeat(64)}`,
} as VerifiedSignedUnchangedDecision["decision"];

describe("prepareSignedDisclosure", () => {
  test("stages a Result Evaluation envelope byte-identical", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
    );
    const reference = createRecordReference("result-evaluation", bytes);
    const source = new InMemoryEvidenceRepository();
    await source.putRecord("result-evaluation", bytes);
    const staging = new InMemoryEvidenceRepository();
    const route: VerifiedSignedUnchangedDecision = {
      kind: "disclose-signed-unchanged",
      decision,
      source: reference,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [],
    };
    const result = await prepareSignedDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference, bytes },
        route,
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        destinations: [destination()],
      },
      resolverFor({ [SOURCE_BINDING]: source, [STAGING_BINDING]: staging }),
    );
    expect(result.status).toBe("preview-ready");
    expect(result.disclosure.manifest.preparation).toEqual({ kind: "signed-unchanged" });
    expect(result.disclosure.manifest.preparedRecord).toEqual(reference);
    await expect(staging.getRecord(reference)).resolves.toEqual(bytes);
  });

  test("stages an Execution Verification envelope independently of Evaluation", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
    );
    const reference = createRecordReference("execution-verification", bytes);
    const source = new InMemoryEvidenceRepository();
    await source.putRecord("execution-verification", bytes);
    const staging = new InMemoryEvidenceRepository();
    const route: VerifiedSignedUnchangedDecision = {
      kind: "disclose-signed-unchanged",
      decision,
      source: reference,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [],
    };
    const result = await prepareSignedDisclosure(
      {
        requestId: "request-2",
        intentFingerprint: `sha256:${"f".repeat(64)}`,
        source: { reference, bytes },
        route,
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        destinations: [destination()],
      },
      resolverFor({ [SOURCE_BINDING]: source, [STAGING_BINDING]: staging }),
    );
    expect(result.disclosure.manifest.preparedRecord.family).toBe("execution-verification");
  });

  test("stages only the policy-listed companion artifacts", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
    );
    const reference = createRecordReference("result-evaluation", bytes);
    const companion = new TextEncoder().encode("allowed companion artifact");
    const notAllowed = new TextEncoder().encode("never referenced by the route");
    const source = new InMemoryEvidenceRepository();
    await source.putRecord("result-evaluation", bytes);
    const companionReceipt = await source.putArtifact(companion);
    await source.putArtifact(notAllowed);
    const staging = new InMemoryEvidenceRepository();
    const route: VerifiedSignedUnchangedDecision = {
      kind: "disclose-signed-unchanged",
      decision,
      source: reference,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [companionReceipt.reference],
    };
    const result = await prepareSignedDisclosure(
      {
        requestId: "request-1",
        intentFingerprint: `sha256:${"e".repeat(64)}`,
        source: { reference, bytes },
        route,
        sourceRepositoryBindingId: SOURCE_BINDING,
        stagingRepositoryBindingId: STAGING_BINDING,
        destinations: [destination()],
      },
      resolverFor({ [SOURCE_BINDING]: source, [STAGING_BINDING]: staging }),
    );
    expect(result.disclosure.manifest.artifacts).toEqual([companionReceipt.reference]);
    await expect(staging.getArtifact(companionReceipt.reference))
      .resolves.toEqual(companion);
  });

  test("fails closed on a companion artifact digest mismatch", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
    );
    const reference = createRecordReference("result-evaluation", bytes);
    const source = new InMemoryEvidenceRepository();
    await source.putRecord("result-evaluation", bytes);
    const staging = new InMemoryEvidenceRepository();
    const route: VerifiedSignedUnchangedDecision = {
      kind: "disclose-signed-unchanged",
      decision,
      source: reference,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [{ digest: `sha256:${"9".repeat(64)}` }],
    };
    await expect(
      prepareSignedDisclosure(
        {
          requestId: "request-1",
          intentFingerprint: `sha256:${"e".repeat(64)}`,
          source: { reference, bytes },
          route,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: source, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  test("rejects a route requesting transformation of an execution-evidence source", async () => {
    const source = new InMemoryEvidenceRepository();
    const staging = new InMemoryEvidenceRepository();
    const executionReference = {
      family: "execution-evidence" as const,
      digest: `sha256:${"b".repeat(64)}` as Sha256Digest,
    };
    const route: VerifiedSignedUnchangedDecision = {
      kind: "disclose-signed-unchanged",
      decision,
      source: executionReference,
      issuedAt: "2026-07-27T00:00:00Z",
      allowedCompanionArtifacts: [],
    };
    await expect(
      prepareSignedDisclosure(
        {
          requestId: "request-1",
          intentFingerprint: `sha256:${"e".repeat(64)}`,
          source: { reference: executionReference, bytes: new Uint8Array() },
          route,
          sourceRepositoryBindingId: SOURCE_BINDING,
          stagingRepositoryBindingId: STAGING_BINDING,
          destinations: [destination()],
        },
        resolverFor({ [SOURCE_BINDING]: source, [STAGING_BINDING]: staging }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });
  });
});
