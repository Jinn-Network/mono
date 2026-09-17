import { describe, expect, it } from "vitest";
import { verifySourceHead } from "@jinn-network/record-discovery-protocol";

import { checkSourceHeadVector, type SourceHeadVerify } from "./conformance.js";
import { loadVectorsByKind } from "./vectors.js";

// The harness's "stored mark unchanged" check must be able to fail: a
// procedure that answers every vector correctly but touches the mark store it
// is handed is non-conforming (§10.5 adopts nothing).

const vectors = loadVectorsByKind("source-head");

describe("checkSourceHeadVector rejects a procedure that touches the stored mark", () => {
  it("covers at least one `ok` vector", () => {
    expect(vectors.some((vector) => (vector.expect as { status: string }).status === "ok")).toBe(true);
  });

  for (const vector of vectors) {
    it(`${vector.name}: advancing the mark fails the vector`, async () => {
      const advancing: SourceHeadVerify = async (opts) => {
        const outcome = await verifySourceHead(opts);
        await opts.ports.hwm.put(opts.source, {
          sequence: opts.head.sequence,
          entry: opts.head.entry,
          issuedAt: "2099-01-01T00:00:00.000Z",
        });
        return outcome;
      };
      await expect(checkSourceHeadVector(advancing, vector)).rejects.toThrow(/leave the stored mark unchanged/);
    });
  }

  it("an ok-only rewrite fails the ok vector", async () => {
    const okVector = vectors.find((vector) => (vector.expect as { status: string }).status === "ok");
    const rewriteOnOk: SourceHeadVerify = async (opts) => {
      const outcome = await verifySourceHead(opts);
      if (outcome.status === "ok") {
        await opts.ports.hwm.put(opts.source, {
          sequence: opts.head.sequence,
          entry: opts.head.entry,
          issuedAt: opts.ports.now.toISOString(),
        });
      }
      return outcome;
    };
    await expect(checkSourceHeadVector(rewriteOnOk, okVector!)).rejects.toThrow(/leave the stored mark unchanged/);
  });

  it("an in-place edit of the stored mark fails a seeded vector", async () => {
    const seededVector = vectors.find((vector) => (vector.input as { seed: { hwm: unknown } }).seed.hwm !== null);
    const editInPlace: SourceHeadVerify = async (opts) => {
      const outcome = await verifySourceHead(opts);
      const mark = await opts.ports.hwm.get(opts.source);
      if (mark) (mark as { issuedAt: string }).issuedAt = "2099-01-01T00:00:00.000Z";
      return outcome;
    };
    await expect(checkSourceHeadVector(editInPlace, structuredClone(seededVector!))).rejects.toThrow(
      /leave the stored mark unchanged/,
    );
  });

  it("the reference procedure passes every vector", async () => {
    for (const vector of vectors) await checkSourceHeadVector(verifySourceHead, vector);
  });
});
