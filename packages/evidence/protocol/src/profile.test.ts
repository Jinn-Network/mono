import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { profileJsonSchemas } from "./profile.js";
import { ExecutionEvidenceDocumentSchema } from "./schemas.js";

describe("generated profile schemas", () => {
  it("uses absolute profile-scoped Draft 2020-12 identifiers", () => {
    const schemas = profileJsonSchemas();

    expect(Object.keys(schemas)).toEqual([
      "dsse-envelope.schema.json",
      "execution-evidence-document.schema.json",
      "execution-verification-statement.schema.json",
      "resource-descriptor.schema.json",
      "result-evaluation-statement.schema.json",
    ]);

    for (const [name, schema] of Object.entries(schemas)) {
      expect(schema.$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      expect(schema.$id).toBe(
        `https://spec.jinn.network/profiles/execution-evidence/v1/schemas/${name}`,
      );
    }
  });

  it("leaves extension properties open", () => {
    const schemas = profileJsonSchemas();
    expect(
      schemas["execution-evidence-document.schema.json"].additionalProperties,
    ).not.toBe(false);
    expect(
      schemas["result-evaluation-statement.schema.json"].additionalProperties,
    ).not.toBe(false);
  });

  it("accepts Task and Execution identifier PropertyValues", () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(
          "../fixtures/task-execution-identifiers-v1/task-execution-identifiers.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );

    const document = ExecutionEvidenceDocumentSchema.parse(fixture);
    expect(document["@graph"].map((entity) => entity["@id"])).toEqual([
      "task.json",
      "urn:uuid:4e44d605-7a9f-4f30-9f0a-f7cac01cb935",
      "#task-digest",
      "#task-profile",
      "#github-run",
    ]);
  });
});
