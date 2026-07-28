import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseAnnouncementEntry,
  parseSourceHead,
} from "@jinn-network/record-discovery-protocol";

import { loadVectors, loadVectorsByKind, VECTOR_KINDS } from "./vectors.js";

// Task 10 Step 2: every fixture loads, parses under protocol schemas where
// applicable, and carries a well-formed `expect`. Data-only -- no
// verification procedure is invoked here (that is Task 11's harness,
// wired against the M2 skeletons, intentionally RED until M4).

const vectorsRoot = fileURLToPath(new URL("../fixtures/vectors/", import.meta.url));

// Vectors that are deliberately malformed at the Announcement Entry parse
// level (§18 "missing reason code" / "non-genesis previous:null") -- their
// primary coverage is M1's entry.test.ts; here they only need to
// demonstrate the parse failure, not a SourceChainOutcome.
const PARSE_ERROR_VECTORS = new Set(["missing-withdrawal-reason", "non-genesis-previous-null"]);

describe("loadVectors", () => {
  it("loads exactly one vector per fixtures/vectors/<name> directory", () => {
    const directoryCount = readdirSync(vectorsRoot, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory(),
    ).length;
    expect(loadVectors().length).toBe(directoryCount);
    expect(loadVectors().length).toBeGreaterThan(0);
  });

  it("every vector's directory name matches its own name field", () => {
    for (const vector of loadVectors()) {
      expect(typeof vector.name).toBe("string");
      expect(vector.name.length).toBeGreaterThan(0);
    }
  });

  it("is sorted by name under UTF-16 code-unit order", () => {
    const names = loadVectors().map((vector) => vector.name);
    const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(names).toEqual(sorted);
  });

  it("covers every kind named in §18 at least once", () => {
    for (const kind of VECTOR_KINDS) {
      expect(loadVectorsByKind(kind).length).toBeGreaterThan(0);
    }
  });

  it("every vector carries a non-empty description and a well-formed (object) expect", () => {
    for (const vector of loadVectors()) {
      expect(vector.description.length).toBeGreaterThan(0);
      expect(typeof vector.expect).toBe("object");
      expect(vector.expect).not.toBeNull();
    }
  });
});

describe("source-chain vectors parse under protocol schemas where applicable", () => {
  for (const vector of loadVectorsByKind("source-chain")) {
    it(`"${vector.name}" -- every entry (and head, if present) parses, or the vector is a declared parse-error case`, () => {
      const input = vector.input as {
        head?: unknown;
        headA?: { payload: string };
        headB?: { payload: string };
        entries?: Array<{ entry: unknown }>;
        rawEntry?: unknown;
      };

      if (PARSE_ERROR_VECTORS.has(vector.name)) {
        expect(() => parseAnnouncementEntry(input.rawEntry)).toThrow();
        return;
      }

      if (input.head !== undefined) {
        expect(() => parseSourceHead(input.head)).not.toThrow();
      }
      for (const key of ["headA", "headB"] as const) {
        const envelope = input[key];
        if (envelope !== undefined) {
          expect(() => parseSourceHead(JSON.parse(envelope.payload))).not.toThrow();
        }
      }
      for (const { entry } of input.entries ?? []) {
        expect(() => parseAnnouncementEntry(entry)).not.toThrow();
      }
    });
  }
});

describe("facts-consistency vectors carry a well-formed `facts` expectation", () => {
  for (const vector of loadVectorsByKind("facts-consistency")) {
    it(`"${vector.name}" expects a recognized FactsConsistency value`, () => {
      const expected = vector.expect as { facts: string };
      expect(["consistent", "inconsistent", "indeterminate"]).toContain(expected.facts);
    });
  }
});

describe("item vectors carry a well-formed ItemOutcome-shaped `status`", () => {
  for (const vector of loadVectorsByKind("item")) {
    it(`"${vector.name}" expects a recognized ItemOutcome status`, () => {
      const expected = vector.expect as { status: string };
      expect(["content-corruption", "verified", "unauthorized-provenance"]).toContain(expected.status);
    });
  }
});

describe("derivation-consistency vectors carry a well-formed `derivation` expectation", () => {
  for (const vector of loadVectorsByKind("derivation-consistency")) {
    it(`"${vector.name}" expects a recognized derivation-consistency outcome`, () => {
      const expected = vector.expect as { derivation: string };
      expect(["present", "fabricated", "reorged-away"]).toContain(expected.derivation);
    });
  }
});

describe("named checks in isolation are represented (design §18)", () => {
  it("source-chain-verification vectors cover stale, forked, broken-chain, and unauthorized-signer", () => {
    const statuses = new Set(
      loadVectorsByKind("source-chain")
        .map((vector) => (vector.expect as { status?: string }).status)
        .filter((status): status is string => status !== undefined),
    );
    for (const required of ["ok", "stale", "forked", "broken-chain", "unauthorized-signer"]) {
      expect(statuses).toContain(required);
    }
  });

  it("facts-consistency vectors cover all three outcomes", () => {
    const outcomes = new Set(loadVectorsByKind("facts-consistency").map((vector) => (vector.expect as { facts: string }).facts));
    for (const required of ["consistent", "inconsistent", "indeterminate"]) {
      expect(outcomes).toContain(required);
    }
  });

  it("derivation-consistency vectors cover present, fabricated, and reorged-away", () => {
    const outcomes = new Set(
      loadVectorsByKind("derivation-consistency").map((vector) => (vector.expect as { derivation: string }).derivation),
    );
    for (const required of ["present", "fabricated", "reorged-away"]) {
      expect(outcomes).toContain(required);
    }
  });
});
