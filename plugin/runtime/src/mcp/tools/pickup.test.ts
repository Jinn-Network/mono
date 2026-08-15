// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";

import type { CorpusMirror, MirrorSyncOutcome } from "../../corpus/index.js";
import type { RuntimeLogger } from "../../logger.js";
import type { AdmissionFilter } from "../../relevance/admission.js";
import type { RelevanceIndex } from "../../relevance/index.js";
import { handlePickup, pickupInputShape } from "./pickup.js";

const silentLog: RuntimeLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const emptyIndex = { databasePath: ":memory:", close: () => {} } as unknown as RelevanceIndex;

const allowAll: AdmissionFilter = {
  admit: async (candidates) => candidates,
};

function mirror(outcome: MirrorSyncOutcome, calls: number[] = []): CorpusMirror {
  return {
    syncOnce: async () => {
      calls.push(Date.now());
      return outcome;
    },
  } as unknown as CorpusMirror;
}

describe("pickup", () => {
  test("the input schema bounds the message and the budget", () => {
    const schema = z.object(pickupInputShape);
    expect(schema.safeParse({ message: "hello" }).success).toBe(true);
    expect(schema.safeParse({ message: "" }).success).toBe(false);
    expect(schema.safeParse({ message: "a", maxChars: 100000 }).success).toBe(false);
    expect(schema.safeParse({ message: "a", maxRecords: 0 }).success).toBe(false);
  });

  test("a projected result returns its text verbatim", async () => {
    const runPickup = vi.fn().mockResolvedValue({
      status: "projected",
      terms: ["flaky", "vitest"],
      records: [{ reference: { family: "execution-evidence", digest: "sha256:x" } }],
      text: "PRE-RENDERED BLOCK",
      usedChars: 18,
      budget: { maxChars: 3500, maxRecords: 2 },
    });
    const response = await handlePickup(
      { index: emptyIndex, admission: allowAll, log: silentLog, runPickup },
      { message: "fix the flaky vitest suite" },
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(payload.status).toBe("projected");
    expect(payload.text).toBe("PRE-RENDERED BLOCK");
    expect(payload.terms).toEqual(["flaky", "vitest"]);
    expect(payload.recordCount).toBe(1);
  });

  test("nothing-relevant is a first-class outcome with empty text", async () => {
    const runPickup = vi.fn().mockResolvedValue({
      status: "nothing-relevant",
      terms: ["obscure"],
      records: [],
      text: "",
      usedChars: 0,
      budget: { maxChars: 3500, maxRecords: 2 },
    });
    const response = await handlePickup(
      { index: emptyIndex, admission: allowAll, log: silentLog, runPickup },
      { message: "obscure" },
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(response.isError).toBeUndefined();
    expect(payload.status).toBe("nothing-relevant");
    expect(payload.text).toBe("");
    expect(payload.recordCount).toBe(0);
  });

  test("the mirror sync is kicked after the answer, never awaited before it", async () => {
    const order: string[] = [];
    const runPickup = vi.fn().mockImplementation(async () => {
      order.push("pickup");
      return {
        status: "nothing-relevant",
        terms: [],
        records: [],
        text: "",
        usedChars: 0,
        budget: { maxChars: 1, maxRecords: 1 },
      };
    });
    const slowMirror = {
      syncOnce: () =>
        new Promise<MirrorSyncOutcome>((resolve) => {
          order.push("sync-start");
          setTimeout(() => resolve({ status: "synced", sources: [] }), 50);
        }),
    } as unknown as CorpusMirror;
    await handlePickup(
      { index: emptyIndex, admission: allowAll, log: silentLog, mirror: slowMirror, runPickup },
      { message: "x" },
    );
    expect(order).toEqual(["pickup", "sync-start"]);
  });

  test("a lock-held sync is a silent no-op for the caller", async () => {
    const calls: number[] = [];
    const runPickup = vi.fn().mockResolvedValue({
      status: "nothing-relevant",
      terms: [],
      records: [],
      text: "",
      usedChars: 0,
      budget: { maxChars: 1, maxRecords: 1 },
    });
    const response = await handlePickup(
      {
        index: emptyIndex,
        admission: allowAll,
        log: silentLog,
        mirror: mirror({ status: "skipped-locked", sources: [] }, calls),
        runPickup,
      },
      { message: "x" },
    );
    expect(response.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("a thrown sync cannot become an unhandled rejection", async () => {
    const warnings: string[] = [];
    const log: RuntimeLogger = { ...silentLog, warn: (message) => warnings.push(message) };
    const throwing = {
      syncOnce: async () => {
        throw new Error("sync exploded");
      },
    } as unknown as CorpusMirror;
    const runPickup = vi.fn().mockResolvedValue({
      status: "nothing-relevant",
      terms: [],
      records: [],
      text: "",
      usedChars: 0,
      budget: { maxChars: 1, maxRecords: 1 },
    });
    await handlePickup(
      { index: emptyIndex, admission: allowAll, log, mirror: throwing, runPickup },
      { message: "x" },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warnings.join(" ")).toContain("mirror sync");
  });

  test("a pickup failure fails open with an empty projection, never an error", async () => {
    const runPickup = vi.fn().mockRejectedValue(new Error("index unavailable"));
    const response = await handlePickup(
      { index: emptyIndex, admission: allowAll, log: silentLog, runPickup },
      { message: "x" },
    );
    const payload = JSON.parse(response.content[0]!.text);
    expect(response.isError).toBeUndefined();
    expect(payload.status).toBe("unavailable");
    expect(payload.text).toBe("");
  });
});
