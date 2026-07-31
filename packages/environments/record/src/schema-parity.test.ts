import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson } from "./fixtures.js";
import { ENVIRONMENT_RECORD_SCHEMA_ID } from "./identifiers.js";

const published = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(new URL("../schemas/environment.schema.json", import.meta.url), "utf8"));

const validator = async () => new Ajv2020({ strict: false }).compile(await published());

describe("published JSON Schema", () => {
  test("declares the record kind as its identifier", async () => {
    expect((await published()).$id).toBe(ENVIRONMENT_RECORD_SCHEMA_ID);
  });

  test("accepts every golden fixture under a standalone validator", async () => {
    const validate = await validator();
    for (const name of ["imported", "tier-1", "extension"] as const) {
      expect(validate(await loadGoldenJson(name)), name).toBe(true);
    }
  });

  test("rejects the structurally-expressible invalid fixtures", async () => {
    const validate = await validator();
    expect(validate(await loadInvalidJson("bare-extension-key"))).toBe(false);
    expect(validate(await loadInvalidJson("bare-hex-manifest-digest"))).toBe(false);
    expect(validate(await loadInvalidJson("shell-command"))).toBe(false);
  });

  test("documents the runtime-only checks it cannot express", async () => {
    const comment = String((await published()).$comment);
    expect(comment).toContain("reference");
    expect(comment).toContain("indexDigest");
    expect(comment).toContain("canonical");
  });
});
