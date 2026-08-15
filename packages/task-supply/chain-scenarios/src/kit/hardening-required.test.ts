// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { assertTemplateHardened } from "../hardening.js";
import { isScenarioTemplate } from "../template.js";
import type { ScenarioTemplate } from "../template.js";

describe("exported scenario templates", () => {
  it("every exported scenario template passes its own hardening checklist", async () => {
    const surface = await import("../index.js") as Record<string, unknown>;
    const templates = Object.entries(surface)
      .filter(([, value]) => isScenarioTemplate(value)) as [string, ScenarioTemplate<never>][];
    expect(templates.length).toBeGreaterThanOrEqual(2);
    for (const [name, template] of templates) {
      expect(() => assertTemplateHardened(template), name).not.toThrow();
    }
  });
});
