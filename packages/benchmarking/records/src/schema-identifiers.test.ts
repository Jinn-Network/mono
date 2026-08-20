import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const SCHEMA_DIR = fileURLToPath(new URL("../schemas", import.meta.url));
const CANONICAL_PREFIX = "https://spec.jinn.network/protocols/benchmarking/v1/schemas/";

const schemaFiles = readdirSync(SCHEMA_DIR)
  .filter((name) => name.endsWith(".schema.json"))
  .sort();

const loadSchema = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

describe("record schema identifiers", () => {
  test("covers exactly the published schemas", () => {
    expect(schemaFiles).toEqual([
      "benchmark-accounting.schema.json",
      "benchmark.schema.json",
      "matrix.schema.json",
      "observation-archive.schema.json",
      "report.schema.json",
      "run.schema.json",
    ]);
  });

  test.each(schemaFiles)("%s declares its canonical $id and the 2020-12 dialect", (name) => {
    const schema = loadSchema(name);
    expect(schema.$id).toBe(`${CANONICAL_PREFIX}${name}`);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("declares no duplicate identifiers", () => {
    const ids = schemaFiles.map((name) => loadSchema(name).$id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
