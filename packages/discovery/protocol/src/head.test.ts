import { describe, it, expect } from "vitest";
import { parseSourceHead } from "./head.js";
import { formatOrigin } from "./grammar.js";
import { RECORD_DISCOVERY_VERSION, GENESIS_SEQUENCE } from "./identifiers.js";

const DIGEST_A = `sha256:${"a".repeat(64)}` as const;

function validHead(overrides: Record<string, unknown> = {}) {
  return {
    protocol: RECORD_DISCOVERY_VERSION,
    origin: formatOrigin("urn:uuid:1234", "feed"),
    sequence: GENESIS_SEQUENCE,
    entry: DIGEST_A,
    issuedAt: "2026-07-27T12:00:00Z",
    refreshBy: "2026-07-28T12:00:00Z",
    ...overrides,
  };
}

describe("parseSourceHead", () => {
  it("accepts an origin composed via formatOrigin (§5.2 last-slash grammar)", () => {
    const source = { agent: "urn:uuid:1234", name: "feed" };
    const head = parseSourceHead(validHead({ origin: formatOrigin(source.agent, source.name) }));
    expect(head.origin).toBe(formatOrigin(source.agent, source.name));
  });

  it("accepts an origin whose agent IRI itself contains slashes", () => {
    const source = { agent: "https://ex.org/a/b", name: "feed" };
    const head = parseSourceHead(validHead({ origin: formatOrigin(source.agent, source.name) }));
    expect(head.origin).toBe("https://ex.org/a/b/feed");
  });

  it("rejects an origin with no slash separating agent from source name", () => {
    expect(() => parseSourceHead(validHead({ origin: "no-separator-here" }))).toThrow();
  });

  it("rejects an origin whose source-name segment is not source-name-shaped", () => {
    expect(() => parseSourceHead(validHead({ origin: "urn:uuid:1234/UPPERCASE" }))).toThrow();
  });

  it("requires a 16-digit fixed-width sequence", () => {
    expect(() => parseSourceHead(validHead({ sequence: "1" }))).toThrow();
    expect(() => parseSourceHead(validHead({ sequence: "00000000000000001" }))).toThrow();
  });

  it("rejects a non sha256 entry digest", () => {
    expect(() => parseSourceHead(validHead({ entry: "not-a-digest" }))).toThrow();
  });
});
