import { describe, expect, test } from "vitest";

import * as api from "./index.js";

describe("public surface", () => {
  test("exports the identifiers, sealing primitives, and record API", () => {
    for (const name of [
      "TRACE_PROTOCOL",
      "TRACE_RECORD_KIND",
      "TRACE_MEDIA_TYPE",
      "TRACE_VOCABULARY_PROFILE",
      "GEN_AI_ATTRIBUTES",
      "JINN_ATTRIBUTES",
      "OPERATION_NAMES",
      "VOCABULARY_UPSTREAM",
      "SPAN_KIND",
      "STATUS_CODE",
      "SpanSchema",
      "TraceRecordSchema",
      "parseTrace",
      "sealTrace",
      "deriveTraceId",
      "deriveSpanId",
      "sealRecord",
      "InvalidDocumentError",
      "serializeCanonicalJson",
      "documentDigest",
      "compareCodeUnitStrings",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("does not leak the testing kit through the root entrypoint", () => {
    expect(api).not.toHaveProperty("describeTraceRecordConformance");
  });
});
