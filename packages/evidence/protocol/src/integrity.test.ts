import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ExecutionEvidenceDocumentSchema,
  checkArtifactIntegrity,
} from "./index.js";

const root = new URL(
  "../fixtures/golden-execution-evidence-v1/execution/",
  import.meta.url,
);

describe("artifact integrity", () => {
  it("separates verified, mismatched, and unavailable artifacts", async () => {
    const document = ExecutionEvidenceDocumentSchema.parse(
      JSON.parse(await readFile(new URL("ro-crate-metadata.json", root), "utf8")),
    );
    const available = new Map<string, Uint8Array>([
      [
        "task/task.md",
        await readFile(new URL("task/task.md", root)),
      ],
      [
        "results/slug-normalization.patch",
        new TextEncoder().encode("wrong bytes"),
      ],
    ]);

    const report = checkArtifactIntegrity(document, available);
    const byId = new Map(
      report.artifacts.map((artifact) => [artifact.entityId, artifact]),
    );

    expect(byId.get("task/task.md")).toMatchObject({ status: "verified" });
    expect(byId.get("results/slug-normalization.patch")).toMatchObject({
      status: "mismatch",
    });
    expect(byId.get("trace/trace.jsonl")).toMatchObject({
      status: "unavailable",
    });
    expect(report.verified).toBe(1);
    expect(report.mismatched).toBe(1);
    expect(report.unavailable).toBe(report.artifacts.length - 2);
  });
});
