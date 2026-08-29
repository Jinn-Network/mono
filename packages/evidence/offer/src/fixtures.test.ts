import { describe, expect, test } from "vitest";

import {
  GOLDEN_OFFERS,
  INVALID_OFFERS,
  listInvalidFixtureNames,
  loadGoldenDocument,
  loadGoldenEnvelope,
  offerFixtureUrl,
} from "./fixtures.js";
import { parseOfferEnvelope } from "./seal.js";

describe("the shipped fixture corpus", () => {
  test("refuses a path that escapes fixtures/", () => {
    expect(() => offerFixtureUrl("/etc/passwd")).toThrow();
    expect(() => offerFixtureUrl("../package.json")).toThrow();
    expect(() => offerFixtureUrl("offer/../../package.json")).toThrow();
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

  test("the superseding fixture names the priced fixture it replaces", async () => {
    const superseding = parseOfferEnvelope(await loadGoldenEnvelope("superseding")).offer;
    const priced = parseOfferEnvelope(await loadGoldenEnvelope("priced"));
    expect(superseding.supersedes).toBe(priced.digest);
    expect(superseding.subject).toBe(priced.offer.subject);
  });
});
