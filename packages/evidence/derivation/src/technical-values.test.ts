import { expect, test } from "vitest";

import { classifyTechnicalValue } from "./technical-values.js";

test.each([
  [`sha256:${"a".repeat(64)}`, "digest"],
  [`0x${"b".repeat(64)}`, "transaction-digest"],
  ["bafkreibm6jg3ux5qu3hbutfqc3hdoclhwd3bk4ufuyt7xzhsg7cdqs2m7a", "cid"],
  ["1.2.3", "version"],
])("classifies structurally supported technical value %s", (value, expected) => {
  expect(classifyTechnicalValue(value, { field: expected })).toBe(expected);
});

test("never treats explicit credentials as technical values", () => {
  expect(classifyTechnicalValue("sk-secret-example", { field: "modelId" })).toBe(
    null,
  );
});
