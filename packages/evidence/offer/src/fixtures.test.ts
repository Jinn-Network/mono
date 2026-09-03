import { describe, expect, test } from "vitest";

import {
  GOLDEN_OFFERS,
  INVALID_OFFERS,
  listInvalidFixtureNames,
  listUnsealableFixtureNames,
  loadGoldenDocument,
  loadGoldenEnvelope,
  offerFixtureUrl,
  UNSEALABLE_OFFERS,
} from "./fixtures.js";
import { parseOfferEnvelope } from "./seal.js";

describe("the shipped fixture corpus", () => {
  test("refuses a path that escapes fixtures/", () => {
    expect(() => offerFixtureUrl("/etc/passwd")).toThrow();
    expect(() => offerFixtureUrl("../package.json")).toThrow();
    expect(() => offerFixtureUrl("offer/../../package.json")).toThrow();
    // WHATWG URL resolves these as double-dot path segments, so a textual ".." scan misses
    // them and the guard has to be on the resolved url instead.
    expect(() => offerFixtureUrl("offer/%2e%2e/%2e%2e/package.json")).toThrow();
    expect(() => offerFixtureUrl("offer/%2E%2E/%2E%2E/package.json")).toThrow();
    expect(() => offerFixtureUrl("offer/.%2e/.%2e/package.json")).toThrow();
    expect(() => offerFixtureUrl("file:///etc/passwd")).toThrow();
    expect(() => offerFixtureUrl("https://example.invalid/x")).toThrow();
  });

  test("every golden envelope parses to its pinned document", async () => {
    for (const name of GOLDEN_OFFERS) {
      expect(parseOfferEnvelope(await loadGoldenEnvelope(name)).offer)
        .toEqual(await loadGoldenDocument(name));
    }
  });

  // Without this the conformance kit could silently stop covering a shipped refusal case.
  test("every refused case on disk is one the conformance kit runs, and vice versa", async () => {
    expect(await listInvalidFixtureNames()).toEqual([...INVALID_OFFERS].sort());
  });

  test("every unsealable case on disk is one the conformance kit runs, and vice versa", async () => {
    expect(await listUnsealableFixtureNames()).toEqual([...UNSEALABLE_OFFERS].sort());
  });

  // The two corpora prove different refusals, so a name in both would mean one of them is
  // asserting the wrong thing about that document.
  test("the two refused corpora share no name", () => {
    expect(INVALID_OFFERS.filter((name) => UNSEALABLE_OFFERS.includes(name))).toEqual([]);
  });

  test("the superseding fixture names the priced fixture it replaces", async () => {
    const superseding = parseOfferEnvelope(await loadGoldenEnvelope("superseding")).offer;
    const priced = parseOfferEnvelope(await loadGoldenEnvelope("priced"));
    expect(superseding.supersedes).toBe(priced.digest);
    expect(superseding.subject).toBe(priced.offer.subject);
  });
});
