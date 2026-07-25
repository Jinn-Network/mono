import { describe, expect, it } from "vitest";

import { profileJsonSchemas } from "./profile.js";

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
        `https://jinn.network/profiles/execution-evidence/1.0/schemas/${name}`,
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
});
