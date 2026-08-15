// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";

import { PROVENANCE_PREAMBLE } from "../projection/project.js";
import { toolFailure, toolFenced, toolJson } from "./result.js";

describe("tool responses", () => {
  test("toolJson emits one text block of JSON", () => {
    const response = toolJson({ count: 2, terms: ["a", "b"] });
    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
    expect(JSON.parse(response.content[0]!.text)).toEqual({ count: 2, terms: ["a", "b"] });
  });

  test("toolFenced emits the provenance boundary, not raw content", () => {
    const response = toolFenced("fetched record sha256:x", ["digest: sha256:x"], "hi");
    expect(response.content[0]!.text).toContain(PROVENANCE_PREAMBLE);
    expect(response.content[0]!.text).toContain("| hi");
  });

  test("toolFailure sets isError and carries a machine code", () => {
    const response = toolFailure({ code: "NO_LOCATION", detail: "not mirrored yet", retryable: true });
    expect(response.isError).toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toEqual({
      error: { code: "NO_LOCATION", detail: "not mirrored yet", retryable: true },
    });
  });

  test("a failure detail carrying control characters is sanitised", () => {
    const response = toolFailure({ code: "X", detail: "bad\u0000detail", retryable: false });
    expect(JSON.parse(response.content[0]!.text).error.detail).toBe("baddetail");
  });

  test("a failure detail is bounded", () => {
    const response = toolFailure({ code: "X", detail: "y".repeat(2000), retryable: false });
    expect(JSON.parse(response.content[0]!.text).error.detail).toHaveLength(512);
  });
});
