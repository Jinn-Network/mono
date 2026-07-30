// SPDX-License-Identifier: Apache-2.0
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

import { createSyntheticDerivationInput } from "@jinn-network/evidence-derivation/testing";
import {
  createRecordReference,
  type EvidenceRepository,
} from "@jinn-network/evidence-repository";
import { InMemoryEvidenceRepository } from "@jinn-network/evidence-repository/testing";
import { describe, expect, test } from "vitest";

import { EvidenceContributionError } from "./errors.js";
import {
  loadAndValidateEvidenceSource,
  type RepositoryResolver,
} from "./source.js";
import type { EvidenceSourceSelection } from "./types.js";

const require = createRequire(import.meta.url);

async function loadGoldenFixture(path: string): Promise<Uint8Array> {
  const fixturePath = require.resolve(
    `@jinn-network/evidence-protocol/fixtures/${path}`,
  );
  return new Uint8Array(await readFile(fixturePath));
}

function resolverFor(repository: EvidenceRepository): RepositoryResolver {
  return { resolve: async () => repository };
}

describe("loadAndValidateEvidenceSource", () => {
  test("reports SOURCE_NOT_FOUND for a missing record", async () => {
    const repository = new InMemoryEvidenceRepository();
    const selection: EvidenceSourceSelection = {
      repositoryBindingId: "private-local",
      record: { family: "execution-evidence", digest: `sha256:${"a".repeat(64)}` },
    };
    await expect(
      loadAndValidateEvidenceSource(selection, resolverFor(repository)),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  test("reports SOURCE_DIGEST_MISMATCH when the repository returns the wrong bytes", async () => {
    const wrongBytes = new TextEncoder().encode(JSON.stringify({ not: "the record" }));
    const repository: EvidenceRepository = {
      capabilities: Object.freeze({}),
      putRecord: async () => {
        throw new Error("unused");
      },
      putArtifact: async () => {
        throw new Error("unused");
      },
      getRecord: async () => wrongBytes,
      getArtifact: async () => null,
    };
    const selection: EvidenceSourceSelection = {
      repositoryBindingId: "private-local",
      record: { family: "execution-evidence", digest: `sha256:${"a".repeat(64)}` },
    };
    await expect(
      loadAndValidateEvidenceSource(selection, resolverFor(repository)),
    ).rejects.toMatchObject({ code: "SOURCE_DIGEST_MISMATCH" });
  });

  test("calls the Execution Evidence validator for execution-evidence", async () => {
    const repository = new InMemoryEvidenceRepository();
    const { sourceRecord } = createSyntheticDerivationInput();
    await repository.putRecord("execution-evidence", sourceRecord.bytes);
    const selection: EvidenceSourceSelection = {
      repositoryBindingId: "private-local",
      record: sourceRecord.reference,
    };
    const loaded = await loadAndValidateEvidenceSource(
      selection,
      resolverFor(repository),
    );
    expect(loaded.reference).toEqual(sourceRecord.reference);
    expect(loaded.bytes).toEqual(sourceRecord.bytes);
  });

  test("calls the Result Evaluation validator for result-evaluation", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
    );
    const repository = new InMemoryEvidenceRepository();
    const reference = createRecordReference("result-evaluation", bytes);
    await repository.putRecord("result-evaluation", bytes);
    const loaded = await loadAndValidateEvidenceSource(
      { repositoryBindingId: "private-local", record: reference },
      resolverFor(repository),
    );
    expect(loaded.reference.family).toBe("result-evaluation");
  });

  test("calls the Execution Verification validator for execution-verification", async () => {
    const bytes = await loadGoldenFixture(
      "golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
    );
    const repository = new InMemoryEvidenceRepository();
    const reference = createRecordReference("execution-verification", bytes);
    await repository.putRecord("execution-verification", bytes);
    const loaded = await loadAndValidateEvidenceSource(
      { repositoryBindingId: "private-local", record: reference },
      resolverFor(repository),
    );
    expect(loaded.reference.family).toBe("execution-verification");
  });

  test("reports SOURCE_NONCONFORMING for self-consistent but invalid bytes, without diagnostics", async () => {
    const repository = new InMemoryEvidenceRepository();
    const bytes = new TextEncoder().encode(JSON.stringify({ garbage: true }));
    const receipt = await repository.putRecord("execution-evidence", bytes);
    let caught: unknown;
    try {
      await loadAndValidateEvidenceSource(
        { repositoryBindingId: "private-local", record: receipt.reference },
        resolverFor(repository),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EvidenceContributionError);
    expect((caught as EvidenceContributionError).code).toBe("SOURCE_NONCONFORMING");
    expect((caught as Error).message).toBe(
      "The source Evidence record does not conform to its protocol family.",
    );
    expect(caught as object).not.toHaveProperty("diagnostics");
  });
});
