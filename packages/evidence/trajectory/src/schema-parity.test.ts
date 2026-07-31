import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson } from "./fixtures.js";
import { TRAJECTORY_RECORD_KIND } from "./identifiers.js";

const published = async (): Promise<Record<string, unknown>> =>
  JSON.parse(
    await readFile(new URL("../schemas/trajectory.schema.json", import.meta.url), "utf8"),
  );

describe("published JSON Schema", () => {
  test("declares the record kind as its identifier", async () => {
    expect((await published()).$id).toBe(`${TRAJECTORY_RECORD_KIND}/schema`);
  });

  test("accepts the golden fixtures under a standalone validator", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(validate(await loadGoldenJson("valid"))).toBe(true);
    expect(validate(await loadGoldenJson("minimal"))).toBe(true);
  });

  test("rejects structurally invalid fixtures under the standalone validator", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(validate(await loadInvalidJson("unknown-extension-key"))).toBe(false);
  });

  test("documents the runtime-only checks it cannot express", async () => {
    expect(String((await published()).$comment)).toContain("derived");
  });
});
