import { describe, expect, test } from "vitest";

import { trajectoryFixtureUrl } from "./fixtures.js";

describe("trajectory fixture paths", () => {
  test("rejects raw traversal", () => {
    expect(() => trajectoryFixtureUrl("../secret.json")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded traversal", () => {
    expect(() => trajectoryFixtureUrl("..%2F..%2Fsecret.json")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("accepts contained relative paths", () => {
    expect(trajectoryFixtureUrl("trajectory/valid.json").pathname).toContain(
      "/fixtures/trajectory/valid.json",
    );
  });
});
