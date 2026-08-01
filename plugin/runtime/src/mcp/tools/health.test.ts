// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import type { HealthReport } from "../../health.js";
import { handleHealth, healthInputShape } from "./health.js";

const report: HealthReport = {
  ok: false,
  version: "0.1.0",
  checks: [
    { name: "corpus-index", ok: true, detail: "12 local, 40 public records indexed", remedy: null },
    { name: "corpus-trust-policy", ok: false, detail: "policy unresolvable", remedy: null },
    { name: "corpus-mirror", ok: false, detail: "never synced", remedy: "jinn-plugin-runtime sync" },
  ],
};

describe("health tool", () => {
  test("takes no arguments", () => {
    expect(Object.keys(healthInputShape)).toEqual([]);
  });

  test("returns the report verbatim, preserving null remedies", async () => {
    const response = await handleHealth({ health: async () => report });
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.version).toBe("0.1.0");
    expect(payload.checks).toHaveLength(3);
    expect(payload.checks[1].remedy).toBeNull();
    expect(payload.checks[2].remedy).toBe("jinn-plugin-runtime sync");
  });

  test("a null remedy survives the JSON round trip as null, not as the string null", async () => {
    const response = await handleHealth({ health: async () => report });
    expect(response.content[0]!.text).toContain('"remedy":null');
    expect(response.content[0]!.text).not.toContain('"remedy":"null"');
  });

  test("a failing health call is itself a reportable check, not a crash", async () => {
    const response = await handleHealth({
      health: async () => {
        throw new Error("catalog unreadable");
      },
    });
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.ok).toBe(false);
    expect(payload.checks[0].name).toBe("runtime-health");
    expect(payload.checks[0].detail).toContain("catalog unreadable");
    expect(payload.checks[0].remedy).toBeTypeOf("string");
  });
});
