import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadAdversarialManifest, loadGoldenJson, readAdversarialJson } from "./fixtures.js";
import {
  INFORMATION_WORLD_KIND,
  INFORMATION_WORLD_MEDIA_TYPE,
  INFORMATION_WORLD_SCHEMA_ID,
} from "./identifiers.js";
import { InformationWorldRecordSchema } from "./schema.js";

const schemaPath = fileURLToPath(new URL("../schemas/information-world.schema.json", import.meta.url));

const loadSchema = async (): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;

const validator = async () => new Ajv2020({ strict: false, allErrors: true }).compile(await loadSchema());

describe("published JSON Schema", () => {
  test("carries the derived $id, the pinned kind, and compiles under a 2020-12 validator", async () => {
    const schema = await loadSchema();
    const properties = schema.properties as Record<string, Record<string, unknown>>;
    expect(schema.$id).toBe(INFORMATION_WORLD_SCHEMA_ID);
    expect(properties.kind?.const).toBe(INFORMATION_WORLD_KIND);
    expect(String(schema.$comment)).toContain(INFORMATION_WORLD_MEDIA_TYPE);
    expect(() => new Ajv2020({ strict: false, allErrors: true }).compile(schema)).not.toThrow();
  });

  test("accepts every golden fixture", async () => {
    const validate = await validator();
    for (const name of ["synthetic", "captured", "extension"] as const) {
      expect(validate(await loadGoldenJson(name)), `${name}: ${validate.errors?.map(({ message }) => message).join(", ")}`)
        .toBe(true);
    }
  });

  test("keeps every nested object closed", async () => {
    const document = structuredClone(await loadGoldenJson("synthetic")) as {
      missPolicy: { body: Record<string, unknown> };
      corpus: { entries: Array<{ response: Record<string, unknown> }> };
    };
    document.missPolicy.body.extra = true;
    document.corpus.entries[0]!.response.extra = true;

    expect((await validator())(document), "published schema").toBe(false);
    expect(InformationWorldRecordSchema.safeParse(document).success, "runtime schema").toBe(false);
  });

  test("keeps fixed-length header and query tuples closed", async () => {
    const document = structuredClone(await loadGoldenJson("synthetic")) as {
      corpus: {
        entries: Array<{
          request: { query: unknown[][] };
          response: { headers: unknown[][] };
        }>;
      };
    };
    const entry = document.corpus.entries.find(({ request }) => request.query.length > 0)!;
    entry.request.query.push(["one", "two", "three"]);
    entry.response.headers[0]!.push("unexpected");

    expect((await validator())(document), "published schema").toBe(false);
    expect(InformationWorldRecordSchema.safeParse(document).success, "runtime schema").toBe(false);
  });

  describe("top-level extensions", () => {
    const withTopLevelKey = async (key: string) => ({
      ...(await loadGoldenJson("synthetic")) as Record<string, unknown>,
      [key]: "extension",
    });

    test.each(["note", "network.jinn.x y", "http://example.test/ext a", "mailto:", "http://"])(
      "rejects %j on both surfaces",
      async (key) => {
        const document = await withTopLevelKey(key);
        expect((await validator())(document), "published schema").toBe(false);
        expect(InformationWorldRecordSchema.safeParse(document).success, "runtime schema").toBe(false);
      },
    );

    test.each([
      "network.jinn.note",
      "mailto:operator@example.test",
      "urn:jinn:information-world",
      "https://example.test/ext",
    ])(
      "accepts %j on both surfaces",
      async (key) => {
        const document = await withTopLevelKey(key);
        expect((await validator())(document), "published schema").toBe(true);
        expect(InformationWorldRecordSchema.safeParse(document).success, "runtime schema").toBe(true);
      },
    );
  });

  test("rejects the adversarial cases that are structurally expressible", async () => {
    const validate = await validator();
    const manifest = await loadAdversarialManifest();
    const structurallyExpressible = new Set([
      "policy-header-subset-credential",
      "miss-policy-absent",
      "miss-policy-redirect",
      "synthetic-claims-capture",
    ]);
    for (const item of manifest.cases.filter(({ name }) => structurallyExpressible.has(name))) {
      const document = await readAdversarialJson(item.name);
      expect(validate(document), `${item.name}: published schema`).toBe(false);
      expect(InformationWorldRecordSchema.safeParse(document).success, `${item.name}: runtime schema`)
        .toBe(false);
    }
  });

  test("keeps header and capture-provenance refinements in parity", async () => {
    const upperCaseHeader = structuredClone(await loadGoldenJson("synthetic")) as {
      requestKeyPolicy: { headerSubset: string[] };
    };
    upperCaseHeader.requestKeyPolicy.headerSubset = ["Authorization"];
    expect((await validator())(upperCaseHeader), "published schema").toBe(false);
    expect(InformationWorldRecordSchema.safeParse(upperCaseHeader).success, "runtime schema").toBe(false);

    const capturedWithoutSources = structuredClone(await loadGoldenJson("captured")) as {
      capture: { sources: unknown[] };
    };
    capturedWithoutSources.capture.sources = [];
    expect((await validator())(capturedWithoutSources), "published schema").toBe(false);
    expect(InformationWorldRecordSchema.safeParse(capturedWithoutSources).success, "runtime schema")
      .toBe(false);
  });

  test("leaves byte-length and relational invariants to the runtime validator", async () => {
    const overlong = structuredClone(await loadGoldenJson("synthetic")) as {
      missPolicy: { body: { inlineUtf8: string } };
    };
    overlong.missPolicy.body.inlineUtf8 = "é".repeat(2049);
    expect((await validator())(overlong), "published schema").toBe(true);
    expect(InformationWorldRecordSchema.safeParse(overlong).success, "runtime schema").toBe(false);

    for (const name of [
      "request-key-collision",
      "request-key-declared-mismatch",
      "policy-header-subset-unsorted",
      "entry-origin-undeclared",
    ]) {
      const document = await readAdversarialJson(name);
      expect((await validator())(document), `${name}: structurally valid`).toBe(true);
      expect(InformationWorldRecordSchema.safeParse(document).success, `${name}: runtime schema`)
        .toBe(false);
    }
  });

  test("documents the runtime-only parity boundary", async () => {
    const comment = String((await loadSchema()).$comment);
    for (const phrase of ["UTF-8", "request-key", "strictly ascending", "canonical"]) {
      expect(comment).toContain(phrase);
    }
  });
});
