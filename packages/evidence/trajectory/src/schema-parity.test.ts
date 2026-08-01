import { readFile } from "node:fs/promises";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";

import { loadGoldenJson, loadInvalidJson, readAdversarialJson } from "./fixtures.js";
import { TRAJECTORY_RECORD_KIND } from "./identifiers.js";
import { TrajectoryRecordSchema, parseTrajectory, sealTrajectory } from "./schema.js";

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
    expect(validate(await readAdversarialJson("message-content-attribute", "document.json"))).toBe(
      false,
    );
    expect(validate(await readAdversarialJson("full-with-skipped", "document.json"))).toBe(false);
    expect(validate(await readAdversarialJson("nested-native-trace-key", "document.json"))).toBe(
      false,
    );
  });

  test("accepts namespaced extension fixtures under the standalone validator", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(
      validate(await readAdversarialJson("namespaced-extension-preserved", "document.json")),
    ).toBe(true);
  });

  test("accepts nested nativeTrace extension under AJV and runtime", async () => {
    const golden = (await loadGoldenJson("valid")) as Record<string, unknown>;
    const source = golden["source"] as Record<string, unknown>;
    const nativeTrace = source["nativeTrace"] as Record<string, unknown>;
    const withNested = {
      ...golden,
      source: {
        ...source,
        nativeTrace: {
          ...nativeTrace,
          "network.jinn.note": "nested kept",
        },
      },
    };
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    expect(validate(withNested)).toBe(true);
    expect(TrajectoryRecordSchema.safeParse(withNested).success).toBe(true);
    const sealed = sealTrajectory(withNested);
    const parsed = parseTrajectory(sealed.bytes);
    expect((parsed.source.nativeTrace as Record<string, unknown>)["network.jinn.note"]).toBe(
      "nested kept",
    );
  });

  test("AJV and runtime agree on vocabulary/completeness adversarial cases", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    for (const id of ["message-content-attribute", "full-with-skipped", "nested-native-trace-key"]) {
      const document = await readAdversarialJson(id, "document.json");
      expect(validate(document)).toBe(false);
      expect(TrajectoryRecordSchema.safeParse(document).success).toBe(false);
    }
    const accepted = await readAdversarialJson("namespaced-extension-preserved", "document.json");
    expect(validate(accepted)).toBe(true);
    expect(TrajectoryRecordSchema.safeParse(accepted).success).toBe(true);
  });

  test("documents runtime-only checks it cannot express", async () => {
    const comment = String((await published()).$comment);
    expect(comment).toContain("traceId");
    expect(comment).toContain("spanId");
    expect(comment).toContain("parentSpanId");
    expect(comment).not.toContain("completeness");
    expect(comment).toContain("I-JSON safe integers");
    expect(comment).toContain("AnyValue");
  });

  test("AJV and runtime agree on extension number and AnyValue law", async () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(await published());
    const golden = (await loadGoldenJson("valid")) as Record<string, unknown>;
    const source = golden["source"] as Record<string, unknown>;
    const nativeTrace = source["nativeTrace"] as Record<string, unknown>;

    const fractionalExtension = {
      ...golden,
      source: {
        ...source,
        nativeTrace: { ...nativeTrace, "network.jinn.note": 1.5 },
      },
    };
    expect(validate(fractionalExtension)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(fractionalExtension).success).toBe(false);

    const unsafeInteger = {
      ...golden,
      source: {
        ...source,
        nativeTrace: { ...nativeTrace, "network.jinn.note": Number.MAX_SAFE_INTEGER + 1 },
      },
    };
    expect(validate(unsafeInteger)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(unsafeInteger).success).toBe(false);

    const span = (golden["spans"] as Record<string, unknown>[])[0]!;
    const emptyAnyValue = {
      ...golden,
      spans: [{ ...span, attributes: [{ key: "gen_ai.provider.name", value: {} }] }],
    };
    expect(validate(emptyAnyValue)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(emptyAnyValue).success).toBe(false);

    const dualAnyValue = {
      ...golden,
      spans: [
        {
          ...span,
          attributes: [{ key: "gen_ai.provider.name", value: { stringValue: "x", intValue: "1" } }],
        },
      ],
    };
    expect(validate(dualAnyValue)).toBe(false);
    expect(TrajectoryRecordSchema.safeParse(dualAnyValue).success).toBe(false);
  });
});
