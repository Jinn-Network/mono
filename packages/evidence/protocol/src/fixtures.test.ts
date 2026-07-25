import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ExecutionEvidenceDocumentSchema,
  checkArtifactIntegrity,
  sha256Hex,
} from "./index.js";

const fixtureRoot = new URL(
  "../fixtures/golden-execution-evidence-v1/",
  import.meta.url,
);

async function document(path: string) {
  return JSON.parse(await readFile(new URL(path, fixtureRoot), "utf8")) as {
    "@graph": Array<Record<string, any> & { "@id": string }>;
  };
}

describe("checked-in fixture integrity", () => {
  it("keeps every available top-level collection artifact byte-current", async () => {
    const collection = await document("ro-crate-metadata.json");
    const mismatches: string[] = [];
    let checked = 0;

    for (const entity of collection["@graph"]) {
      if (
        typeof entity.sha256 !== "string" ||
        entity["@id"] === "ro-crate-metadata.json"
      ) {
        continue;
      }
      try {
        const artifact = await readFile(new URL(entity["@id"], fixtureRoot));
        checked += 1;
        if (sha256Hex(artifact) !== entity.sha256) {
          mismatches.push(entity["@id"]);
        }
      } catch {
        // Contextual graph entities do not name collection files.
      }
    }

    expect(checked).toBeGreaterThan(30);
    expect(mismatches).toEqual([]);
  });

  it("has no unavailable or mismatched private execution artifacts", async () => {
    const executionRoot = new URL("execution/", fixtureRoot);
    const execution = ExecutionEvidenceDocumentSchema.parse(
      await document("execution/ro-crate-metadata.json"),
    );
    const available = new Map<string, Uint8Array>();
    for (const entity of execution["@graph"]) {
      if (typeof entity.sha256 !== "string") continue;
      available.set(entity["@id"], await readFile(new URL(entity["@id"], executionRoot)));
    }

    const report = checkArtifactIntegrity(execution, available);
    expect(report.mismatched).toBe(0);
    expect(report.unavailable).toBe(0);
  });

  it("binds verification to the exact private metadata serialization", async () => {
    const metadata = await readFile(
      new URL("execution/ro-crate-metadata.json", fixtureRoot),
    );
    const statement = JSON.parse(
      await readFile(
        new URL(
          "claims/execution-verification/statement.json",
          fixtureRoot,
        ),
        "utf8",
      ),
    );

    expect(statement.subject).toEqual([
      {
        name: "ro-crate-metadata.json",
        digest: { sha256: sha256Hex(metadata) },
      },
    ]);
  });
});
