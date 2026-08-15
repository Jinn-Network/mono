import { readFile } from "node:fs/promises";

import {
  validateExecutionEvidence,
  validateExecutionVerification,
  validateResultEvaluation,
} from "@jinn-network/evidence-protocol";
import { describe, expect, test } from "vitest";

import { createOrasCliEvidenceRepository } from "./index.js";

const registryEnabled = process.env.JINN_OCI_REGISTRY_TEST === "1";

describe.runIf(registryEnabled)("ORAS 1.3.2 Distribution registry", () => {
  test("round-trips all record families and independent artifact bytes", async () => {
    const repository = await createOrasCliEvidenceRepository({
      repository:
        process.env.JINN_OCI_TEST_REPOSITORY ??
        "localhost:5000/jinn/evidence",
      orasPath: process.env.ORAS_PATH ?? "oras",
      plainHttp: true,
    });
    const fixtures = [
      {
        family: "execution-evidence",
        path: "../../protocol/fixtures/golden-execution-evidence-v1/execution/ro-crate-metadata.json",
        validate: validateExecutionEvidence,
      },
      {
        family: "result-evaluation",
        path: "../../protocol/fixtures/golden-execution-evidence-v1/claims/result-evaluation/result-evaluation.dsse.json",
        validate: validateResultEvaluation,
      },
      {
        family: "execution-verification",
        path: "../../protocol/fixtures/golden-execution-evidence-v1/claims/execution-verification/execution-verification.dsse.json",
        validate: validateExecutionVerification,
      },
    ] as const;

    for (const fixture of fixtures) {
      const bytes = new Uint8Array(
        await readFile(new URL(fixture.path, import.meta.url)),
      );
      const first = await repository.putRecord(fixture.family, bytes);
      const second = await repository.putRecord(fixture.family, bytes);
      const retrieved = await repository.getRecord(first.reference);

      expect(first.status).toBe("created");
      expect(second.status).toBe("existing");
      expect(second.manifestDigest).toBe(first.manifestDigest);
      expect(retrieved).toEqual(bytes);
      expect(fixture.validate(retrieved!).conforms).toBe(true);
    }

    const artifactBytes = new Uint8Array([0, 1, 127, 128, 255]);
    const artifact = await repository.putArtifact(artifactBytes);
    expect(await repository.getArtifact(artifact.reference)).toEqual(
      artifactBytes,
    );
  }, 60_000);
});
