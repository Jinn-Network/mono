import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

import {
  checkArtifactIntegrity,
  validateExecutionEvidence,
} from "./index.js";

type Document = {
  "@context": unknown;
  "@graph": Array<Record<string, any> & { "@id": string }>;
};

const publicRoot = new URL(
  "../fixtures/golden-execution-evidence-v1/public/",
  import.meta.url,
);
const privateRoot = new URL(
  "../fixtures/golden-execution-evidence-v1/execution/",
  import.meta.url,
);

let metadataBytes: Uint8Array;
let document: Document;

const entity = (source: Document, id: string) => {
  const value = source["@graph"].find((candidate) => candidate["@id"] === id);
  if (!value) throw new Error(`Missing test entity ${id}`);
  return value;
};

const encode = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

beforeAll(async () => {
  metadataBytes = await readFile(new URL("ro-crate-metadata.json", publicRoot));
  document = JSON.parse(new TextDecoder().decode(metadataBytes));
});

describe("public Execution Evidence derivation", () => {
  it("conforms without substituting the separately scrubbed trace", () => {
    const report = validateExecutionEvidence(metadataBytes);
    const execution = entity(
      document,
      "urn:uuid:22222222-2222-4222-8222-222222222222",
    );

    expect(report).toMatchObject({ conforms: true, diagnostics: [] });
    expect(execution.subjectOf).toEqual({ "@id": "trace/trace.jsonl" });
    expect(entity(document, "trace/trace.public.jsonl")).toMatchObject({
      about: { "@id": execution["@id"] },
      "prov:wasDerivedFrom": { "@id": "trace/trace.jsonl" },
      "prov:wasGeneratedBy": { "@id": "#public-scrub" },
    });
  });

  it("keeps exact Task and Result commitments from the private record", async () => {
    const privateDocument = JSON.parse(
      await readFile(
        new URL("ro-crate-metadata.json", privateRoot),
        "utf8",
      ),
    ) as Document;

    expect(entity(document, "task/task.md").sha256).toBe(
      entity(privateDocument, "task/task.md").sha256,
    );
    expect(entity(document, "results/slug-normalization.patch").sha256).toBe(
      entity(privateDocument, "results/slug-normalization.patch").sha256,
    );
  });

  it("treats unavailable exact private trace bytes as unavailable, not mismatch", async () => {
    const report = validateExecutionEvidence(metadataBytes);
    const available = new Map<string, Uint8Array>([
      [
        "task/task.md",
        await readFile(new URL("task/task.md", publicRoot)),
      ],
      [
        "results/slug-normalization.patch",
        await readFile(new URL("results/slug-normalization.patch", publicRoot)),
      ],
      [
        "trace/trace.public.jsonl",
        await readFile(new URL("trace/trace.public.jsonl", publicRoot)),
      ],
      [
        "scrub/public-execution-policy.json",
        await readFile(
          new URL("scrub/public-execution-policy.json", publicRoot),
        ),
      ],
      [
        "scrub/scrub-receipt.json",
        await readFile(new URL("scrub/scrub-receipt.json", publicRoot)),
      ],
    ]);

    const integrity = checkArtifactIntegrity(report.value!, available);
    const exactTrace = integrity.artifacts.find(
      ({ entityId }) => entityId === "trace/trace.jsonl",
    );

    expect(exactTrace).toMatchObject({ status: "unavailable" });
    expect(integrity.mismatched).toBe(0);
  });

  it("requires source commitment, policy, mappings, and disposition counts", () => {
    const missingCounts = structuredClone(document);
    delete entity(missingCounts, "#public-scrub")["jinn:dispositionCount"];

    expect(
      validateExecutionEvidence(encode(missingCounts)).diagnostics.map(
        ({ code }) => code,
      ),
    ).toContain("DERIVATION_PROVENANCE_INVALID");
  });

  it("forbids a circular derived metadata digest in scrub provenance", () => {
    const circular = structuredClone(document);
    entity(circular, "#public-scrub").derivedMetadataDigest =
      "sha256:" + "a".repeat(64);

    expect(
      validateExecutionEvidence(encode(circular)).diagnostics.map(
        ({ code }) => code,
      ),
    ).toContain("DERIVATION_PROVENANCE_INVALID");
  });

  it("does not transfer the private verification claim", () => {
    expect(
      document["@graph"].some(
        (candidate) =>
          candidate.predicateType ===
            "https://spec.jinn.network/attestations/execution-verification/v1" ||
          String(candidate["@id"]).includes("execution-verification"),
      ),
    ).toBe(false);
  });
});
