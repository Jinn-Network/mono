import { describe, expect, it } from "vitest";
import { parseFactsProfile } from "../facts-profile.js";
import { RECORD_DISCOVERY_VERSION } from "../identifiers.js";
import type { AnnouncedItem } from "../item.js";
import { factsConsistency } from "./facts-consistency.js";
import type { FactsRecompute, RecordFactValue, RecordFetcher } from "./ports.js";

const KIND = "https://jinn.network/records/benchmark-report/1.0";
const PROFILE = "https://jinn.network/records/benchmark-report/1.0/facts/1.0";

const profile = parseFactsProfile({
  protocol: RECORD_DISCOVERY_VERSION,
  kind: KIND,
  profile: PROFILE,
  fields: [
    { name: "scalarField", class: "record" },
    { name: "matrixDigests", class: "record", referenceBearing: true },
  ],
});

const recordBytes = new TextEncoder().encode('{"ok":true}');

function itemWithFacts(facts: Record<string, unknown>): AnnouncedItem {
  return {
    record: { kind: KIND, digest: `sha256:${"a".repeat(64)}` },
    provenance: {
      source: { agent: "did:key:zTest", name: "feed" },
      entry: `sha256:${"b".repeat(64)}`,
      announcementId: "ann-1",
    },
    facts,
  };
}

function recomputeOf(values: Record<string, RecordFactValue>): FactsRecompute {
  return {
    get() {
      return async () => values;
    },
  };
}

const unusedRecords: RecordFetcher = {
  async "fetch"() {
    throw new Error("records port must not be called when recompute ignores refs");
  },
};

describe("factsConsistency RecordFactValue (program §7.129)", () => {
  it("keeps scalar string/number/boolean equality consistent", async () => {
    for (const [name, value] of [
      ["scalarField", "owner-iri"],
      ["scalarField", 42],
      ["scalarField", true],
    ] as const) {
      const outcome = await factsConsistency({
        item: itemWithFacts({ [name]: value }),
        profile,
        recordBytes,
        factsRecompute: recomputeOf({ [name]: value }),
        records: unusedRecords,
      });
      expect(outcome, String(value)).toBe("consistent");
    }
  });

  it("treats equal ordered scalar arrays as consistent", async () => {
    const digests = [
      "sha256:" + "1".repeat(64),
      "sha256:" + "2".repeat(64),
    ] as const;
    const outcome = await factsConsistency({
      item: itemWithFacts({ matrixDigests: [...digests] }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({ matrixDigests: digests }),
      records: unusedRecords,
    });
    expect(outcome).toBe("consistent");
  });

  it("treats array order mismatch as inconsistent", async () => {
    const announced = ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)];
    const recomputed = ["sha256:" + "2".repeat(64), "sha256:" + "1".repeat(64)] as const;
    const outcome = await factsConsistency({
      item: itemWithFacts({ matrixDigests: announced }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({ matrixDigests: recomputed }),
      records: unusedRecords,
    });
    expect(outcome).toBe("inconsistent");
  });

  it("treats array length mismatch as inconsistent", async () => {
    const outcome = await factsConsistency({
      item: itemWithFacts({ matrixDigests: ["sha256:" + "1".repeat(64)] }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({
        matrixDigests: ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)],
      }),
      records: unusedRecords,
    });
    expect(outcome).toBe("inconsistent");
  });

  it("treats array element value mismatch as inconsistent", async () => {
    const outcome = await factsConsistency({
      item: itemWithFacts({
        matrixDigests: ["sha256:" + "1".repeat(64), "sha256:" + "2".repeat(64)],
      }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({
        matrixDigests: ["sha256:" + "1".repeat(64), "sha256:" + "3".repeat(64)],
      }),
      records: unusedRecords,
    });
    expect(outcome).toBe("inconsistent");
  });

  it("treats undefined recomputed values as indeterminate", async () => {
    const outcome = await factsConsistency({
      item: itemWithFacts({
        matrixDigests: ["sha256:" + "1".repeat(64)],
      }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({ matrixDigests: undefined }),
      records: unusedRecords,
    });
    expect(outcome).toBe("indeterminate");
  });

  it("rejects scalar-vs-array mismatches as inconsistent", async () => {
    const outcome = await factsConsistency({
      item: itemWithFacts({ matrixDigests: "sha256:" + "1".repeat(64) }),
      profile,
      recordBytes,
      factsRecompute: recomputeOf({
        matrixDigests: ["sha256:" + "1".repeat(64)],
      }),
      records: unusedRecords,
    });
    expect(outcome).toBe("inconsistent");
  });
});
