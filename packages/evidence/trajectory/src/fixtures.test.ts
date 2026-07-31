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

  test("rejects raw backslashes", () => {
    expect(() => trajectoryFixtureUrl("..\\..\\outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded backslashes", () => {
    expect(() => trajectoryFixtureUrl("..%5c..%5coutside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("..%5C..%5Coutside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects percent-encoded slashes", () => {
    expect(() => trajectoryFixtureUrl("trajectory%2fvalid.json")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("trajectory%2Fvalid.json")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects double-encoded separators", () => {
    expect(() => trajectoryFixtureUrl("%252e%252e/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects query and hash suffixes", () => {
    expect(() => trajectoryFixtureUrl("trajectory/valid.json?x=1")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("trajectory/valid.json#frag")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("accepts contained relative paths", () => {
    expect(trajectoryFixtureUrl("trajectory/valid.json").pathname).toContain(
      "/fixtures/trajectory/valid.json",
    );
    expect(trajectoryFixtureUrl("adversarial-v1/nested-native-trace-key/document.json").pathname).toContain(
      "/fixtures/adversarial-v1/nested-native-trace-key/document.json",
    );
  });

  test("rejects http and https scheme prefixes", () => {
    expect(() => trajectoryFixtureUrl("https://example.com/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("HTTP://example.com/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects file and data schemes", () => {
    expect(() => trajectoryFixtureUrl("file:///etc/passwd")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("data:text/plain,hello")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects scheme-relative and backslash authority paths", () => {
    expect(() => trajectoryFixtureUrl("//host/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
    expect(() => trajectoryFixtureUrl("\\\\host\\outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects drive-style paths", () => {
    expect(() => trajectoryFixtureUrl("C:/Windows/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects encoded scheme revealed by decoding", () => {
    expect(() => trajectoryFixtureUrl("https%3a//example.com/outside")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });

  test("rejects nul and control characters", () => {
    expect(() => trajectoryFixtureUrl("trajectory/valid\u0000.json")).toThrow(
      "trajectory fixture paths must stay inside fixtures/",
    );
  });
});
