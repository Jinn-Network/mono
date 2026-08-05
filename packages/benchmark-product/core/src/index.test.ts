import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { BENCHMARKING_PROTOCOL, PRODUCT_VERSION } from "./index.js";

describe("PRODUCT_VERSION", () => {
  test("mirrors package.json's version field", () => {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(PRODUCT_VERSION).toBe(packageJson.version);
  });
});

describe("platform seam", () => {
  test("re-exports BENCHMARKING_PROTOCOL from @jinn-network/benchmarking-records", () => {
    expect(BENCHMARKING_PROTOCOL).toBe("https://spec.jinn.network/protocols/benchmarking/v1");
  });
});
