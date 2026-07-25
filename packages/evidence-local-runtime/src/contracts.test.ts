// SPDX-License-Identifier: MIT
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  LOCAL_EVIDENCE_RUNTIME_ERROR_CODES,
  LocalEvidenceRuntimeError,
  type LocalEvidenceRuntime,
  type LocalEvidenceRuntimeStatus,
} from "./index.js";

describe("local runtime contracts", () => {
  it("freezes stable lifecycle errors", () => {
    expect(LOCAL_EVIDENCE_RUNTIME_ERROR_CODES).toEqual([
      "ROOT_IN_USE",
      "ROOT_VERSION_UNSUPPORTED",
      "RUNTIME_CORRUPT",
      "UNSAFE_PATH",
      "RUNTIME_CLOSING",
      "RUNTIME_CLOSED",
      "INVALID_QUERY",
      "OPERATION_ABORTED",
      "SYNCHRONIZATION_UNAVAILABLE",
      "IO_FAILURE",
    ]);
    expect(new LocalEvidenceRuntimeError("RUNTIME_CLOSED", "closed").code)
      .toBe("RUNTIME_CLOSED");
  });

  it("exposes the approved public surface", () => {
    expectTypeOf<LocalEvidenceRuntime["getStatus"]>()
      .returns.toEqualTypeOf<Promise<LocalEvidenceRuntimeStatus>>();
  });
});
