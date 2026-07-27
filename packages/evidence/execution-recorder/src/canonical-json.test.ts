// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { serializeCanonicalJson } from "./canonical-json.js";

describe("canonical JSON serialization", () => {
  test("sorts object keys recursively while retaining array order", () => {
    const bytes = serializeCanonicalJson({
      zebra: {
        beta: 2,
        alpha: 1,
      },
      array: [
        {
          delta: 4,
          charlie: 3,
        },
        "second",
      ],
      alpha: true,
    });

    expect(new TextDecoder().decode(bytes)).toBe(`{
  "alpha": true,
  "array": [
    {
      "charlie": 3,
      "delta": 4
    },
    "second"
  ],
  "zebra": {
    "alpha": 1,
    "beta": 2
  }
}
`);
  });

  test("uses locale-independent UTF-16 key ordering", () => {
    const bytes = serializeCanonicalJson({
      ä: 3,
      a: 2,
      Z: 1,
    });

    expect(new TextDecoder().decode(bytes)).toBe(`{
  "Z": 1,
  "a": 2,
  "ä": 3
}
`);
  });
});
