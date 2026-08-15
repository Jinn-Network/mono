// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { captureAnchor, confirmAnchorUnchanged } from "./anchor.js";
import { createBudgetedArchivePort } from "./budget.js";
import type { ArchiveBlockHeader, ArchiveRpcPort, BlockSelector } from "./ports.js";

const CLOCK = { now: () => new Date("2026-07-31T09:00:00.000Z") };

function header(number: number, marker: string): ArchiveBlockHeader {
  return {
    number,
    hash: `0x${marker.repeat(64)}`,
    parentHash: `0x${"0".repeat(64)}`,
    stateRoot: `0x${marker.repeat(64)}`,
    timestamp: 1_760_000_000 + number,
  };
}

function archiveWith(headers: (selector: BlockSelector, call: number) => ArchiveBlockHeader): ArchiveRpcPort {
  let call = 0;
  return {
    async getBlockHeader(selector) {
      call += 1;
      return headers(selector, call);
    },
    async getAccount() { throw new Error("unused"); },
    async getCode() { throw new Error("unused"); },
    async getStorageAt() { throw new Error("unused"); },
    async getProof() { throw new Error("unused"); },
  };
}

describe("anchor capture", () => {
  it("captures number, hash, root, timestamp and the observed finality depth", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(21_000_064, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.blockNumber).toBe(21_000_000);
    expect(outcome.value.stateRoot).toBe(`0x${"1".repeat(64)}`);
    expect(outcome.value.finality).toEqual({
      observedAt: "2026-07-31T09:00:00.000Z",
      finalizedBlockNumber: 21_000_064,
      depthBelowFinalized: 64,
      finalizedAtObservation: true,
    });
  });

  it("carries the author's header proof and lets CE1's function classify the E5 bound", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(21_000_064, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!outcome.ok) throw new Error("expected a capture");
    expect(outcome.value.headerProof).toBeUndefined();

    const proven = await captureAnchor(
      archive,
      {
        blockNumber: 21_000_000,
        headerProof: { name: "header-proof", digest: { sha256: "a".repeat(64) } },
      },
      CLOCK,
    );
    if (!proven.ok) throw new Error("expected a capture");
    expect(proven.value.headerProof?.name).toBe("header-proof");
    // The classification itself is CE1's: T11 asserts
    // `anchorAuthenticityBoundOf(record.sourceAnchor)` is "header-proven" for this case.
  });

  it("reports an anchor above the finalized head honestly instead of failing", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector) => selector === "finalized" ? header(20_999_990, "9") : header(21_000_000, "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!outcome.ok) throw new Error("expected a capture");
    expect(outcome.value.finality.finalizedAtObservation).toBe(false);
    expect(outcome.value.finality.depthBelowFinalized).toBe(-10);
  });

  it("fails archive-self-disagreement when the same block answers differently later", async () => {
    const archive = createBudgetedArchivePort(
      archiveWith((selector, call) => selector === "finalized"
        ? header(21_000_064, "9")
        : header(21_000_000, call > 2 ? "7" : "1")),
      { maxCalls: 10, maxBytes: 1_000_000 },
    );
    const captured = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    if (!captured.ok) throw new Error("expected a capture");
    const confirmed = await confirmAnchorUnchanged(archive, captured.value);
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.reason).toBe("archive-self-disagreement");
    expect(confirmed.detail).toMatch(/stateRoot/u);
  });

  it("fails archive-anchor-pruned when the archive cannot serve the block", async () => {
    const archive = createBudgetedArchivePort({
      async getBlockHeader() { throw new Error("missing trie node 0xabc (path ) state 0xdef"); },
      async getAccount() { throw new Error("unused"); },
      async getCode() { throw new Error("unused"); },
      async getStorageAt() { throw new Error("unused"); },
      async getProof() { throw new Error("unused"); },
    }, { maxCalls: 10, maxBytes: 1_000_000 });
    const outcome = await captureAnchor(archive, { blockNumber: 21_000_000 }, CLOCK);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("archive-anchor-pruned");
  });
});
