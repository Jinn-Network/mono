// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from "vitest";
import type { RankedCandidate } from "./search.js";

import { createCorpusAdmissionFilter } from "./admission.js";

const digest = (seed: string): `sha256:${string}` =>
  `sha256:${seed.repeat(64).slice(0, 64)}` as `sha256:${string}`;

const candidate = (
  seed: string,
  plane: RankedCandidate["plane"],
  origin: string,
): RankedCandidate => ({
  plane,
  reference: { family: "execution-evidence", digest: digest(seed) },
  score: 6,
  coverage: 2,
  matchedTerms: ["flaky", "index"],
  summary: "Rebuild the flaky corpus index",
  origin,
  capturedAt: "2026-07-12T09:14:22.000Z",
  outcome: "completed",
  excerpts: [],
});

describe("admission filter", () => {
  test("keeps admitted public candidates", async () => {
    const filter = createCorpusAdmissionFilter({
      admitProducer: async () => ({ admitted: true }),
    });
    const kept = await filter.admit([candidate("a", "public", "urn:jinn:agent:one")]);
    expect(kept).toHaveLength(1);
  });

  test("drops rejected public candidates", async () => {
    const filter = createCorpusAdmissionFilter({
      admitProducer: async () => ({ admitted: false }),
    });
    expect(await filter.admit([candidate("a", "public", "urn:jinn:agent:one")])).toEqual([]);
  });

  test("local candidates bypass admission entirely", async () => {
    const admitProducer = vi.fn(async () => ({ admitted: false }));
    const filter = createCorpusAdmissionFilter({ admitProducer });
    const kept = await filter.admit([candidate("a", "local", "urn:jinn:agent:me")]);
    expect(kept).toHaveLength(1);
    expect(admitProducer).not.toHaveBeenCalled();
  });

  test("a throwing admission decision fails closed", async () => {
    const filter = createCorpusAdmissionFilter({
      admitProducer: async () => {
        throw new Error("policy chain unavailable");
      },
    });
    expect(await filter.admit([candidate("a", "public", "urn:jinn:agent:one")])).toEqual([]);
  });

  test("each producer is consulted once per pickup, not once per candidate", async () => {
    const admitProducer = vi.fn(async () => ({ admitted: true }));
    const filter = createCorpusAdmissionFilter({ admitProducer });
    await filter.admit([
      candidate("a", "public", "urn:jinn:agent:one"),
      candidate("b", "public", "urn:jinn:agent:one"),
      candidate("c", "public", "urn:jinn:agent:two"),
    ]);
    expect(admitProducer).toHaveBeenCalledTimes(2);
  });

  test("ranking order is preserved among survivors", async () => {
    const filter = createCorpusAdmissionFilter({
      admitProducer: async (producerId: string) => ({
        admitted: producerId !== "urn:jinn:agent:blocked",
      }),
    });
    const kept = await filter.admit([
      candidate("a", "public", "urn:jinn:agent:blocked"),
      candidate("b", "public", "urn:jinn:agent:ok"),
      candidate("c", "local", "urn:jinn:agent:me"),
    ]);
    expect(kept.map((entry) => entry.reference.digest)).toEqual([digest("b"), digest("c")]);
  });
});
