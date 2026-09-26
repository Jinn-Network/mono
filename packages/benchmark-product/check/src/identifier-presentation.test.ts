// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";
import { presentInternalProtocolIdentifiers } from "./identifier-presentation.js";

describe("presentInternalProtocolIdentifiers", () => {
  test("keeps an actionable third-party URL", () => {
    expect(presentInternalProtocolIdentifiers("see https://example.com/docs")).toBe("see https://example.com/docs");
  });

  test("drops the unhosted origin and keeps the name", () => {
    expect(
      presentInternalProtocolIdentifiers(
        "kind https://spec.jinn.network/records/benchmark-matrix/v1",
      ),
    ).toBe("kind records/benchmark-matrix/v1");
  });

  test("strips the method namespace rather than inviting a fetch", () => {
    expect(presentInternalProtocolIdentifiers("jinn.benchmarking.method/wilson @ 1"))
      .toBe("method/wilson @ 1");
  });

  test("names an anchor profile by its path remainder", () => {
    expect(
      presentInternalProtocolIdentifiers(
        "https://spec.jinn.network/trust/anchor-profiles/rfc3161-tsa/v1",
      ),
    ).toBe("rfc3161-tsa/v1");
  });
});
