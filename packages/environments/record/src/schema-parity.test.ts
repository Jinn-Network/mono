import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson, loadPublishedSchema } from "./fixtures.js";
import { ENVIRONMENT_RECORD_SCHEMA_ID } from "./identifiers.js";
import { EnvironmentRecordSchema } from "./schema.js";

const published = loadPublishedSchema;

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
    expect(validate(await loadInvalidJson("shell-command-exe-spelling"))).toBe(false);
  });

  // The two surfaces are only useful together if they agree. Each case below is one a third
  // party validating with the published schema could otherwise decide differently than this
  // package does.
  describe("agrees with the runtime schema", () => {
    const withInvocation = async (bin: string) => {
      const record = (await loadGoldenJson("imported")) as Record<string, unknown>;
      return { ...record, invocations: { test: [{ bin, args: ["-c", "pytest -q"] }] } };
    };
    const withTopLevelKey = async (key: string) => ({
      ...(await loadGoldenJson("imported")) as Record<string, unknown>,
      [key]: "x",
    });

    test.each(["bash.exe", "/bin/SH", "Bash", "/usr/bin/env BASH", "pwsh.EXE"])(
      "refuses %s as bin on both surfaces",
      async (bin) => {
        const document = await withInvocation(bin);
        expect((await validator())(document), "published schema").toBe(false);
        expect(EnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
      },
    );

    test.each(["python", "make", "/usr/bin/python3", "environment-setup"])(
      "accepts %s as bin on both surfaces",
      async (bin) => {
        const document = await withInvocation(bin);
        expect((await validator())(document), "published schema").toBe(true);
        expect(EnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(true);
      },
    );

    test.each(["http://example.test/ext a", "network.jinn.x y", "note"])(
      "refuses the top-level extension key %j on both surfaces",
      async (key) => {
        const document = await withTopLevelKey(key);
        expect((await validator())(document), "published schema").toBe(false);
        expect(EnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(false);
      },
    );

    test.each(["http://example.test/ext", "network.jinn.note"])(
      "accepts the top-level extension key %j on both surfaces",
      async (key) => {
        const document = await withTopLevelKey(key);
        expect((await validator())(document), "published schema").toBe(true);
        expect(EnvironmentRecordSchema.safeParse(document).success, "runtime").toBe(true);
      },
    );
  });

  test("documents the runtime-only checks it cannot express", async () => {
    const comment = String((await published()).$comment);
    expect(comment).toContain("reference");
    expect(comment).toContain("indexDigest");
    expect(comment).toContain("canonical");
  });
});
