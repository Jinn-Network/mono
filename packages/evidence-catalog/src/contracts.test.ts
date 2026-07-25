// SPDX-License-Identifier: MIT
import { describe, expect, test } from "vitest";

import {
  CATALOG_SCHEMA_VERSION,
  EVIDENCE_CATALOG_ERROR_CODES,
  EVIDENCE_RECORD_FAMILIES,
} from "./index.js";

describe("Evidence Catalog root contracts", () => {
  test("freezes the catalog schema version", () => {
    expect(CATALOG_SCHEMA_VERSION).toBe("1.0.0");
  });

  test("freezes stable error codes", () => {
    expect(EVIDENCE_CATALOG_ERROR_CODES).toEqual([
      "INVALID_QUERY",
      "INVALID_PROJECTION",
      "PROJECTION_CONFLICT",
      "LOCATION_CONFLICT",
      "OPERATION_ABORTED",
      "IO_FAILURE",
    ]);
  });

  test("exposes the three supported record families", () => {
    expect(EVIDENCE_RECORD_FAMILIES).toEqual([
      "execution-evidence",
      "result-evaluation",
      "execution-verification",
    ]);
  });
});
