import { describe, expect, it } from "vitest";
import { ANCHOR_EVIDENCE_KIND } from "@jinn-network/trust-core";
import { RECORD_KINDS } from "../identifiers.js";
import type { AnchoredEntryHold } from "./outcomes.js";
import type { AnchoredEntryHoldStore } from "./ports.js";
import {
  enumerateEntryAnchorCoverage,
  isAnchorAnnouncingEntry,
  verifyAnchoredEntryHold,
} from "./anchored-entry.js";

function holdStore(): AnchoredEntryHoldStore & { readonly data: Map<string, AnchoredEntryHold> } {
  const data = new Map<string, AnchoredEntryHold>();
  return {
    data,
    async get(origin) {
      return data.get(origin);
    },
    async put(hold) {
      data.set(hold.origin, hold);
    },
  };
}

const ORIGIN = "did:key:zPublisher/colophon-benchmarks";
const ENTRY = `sha256:${"a".repeat(64)}` as const;
const ANCHOR = `sha256:${"b".repeat(64)}` as const;

describe("verifyAnchoredEntryHold", () => {
  it("records the first observed tuple and later refuses a chain that dropped it", async () => {
    const holds = holdStore();
    const first = await verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: ENTRY }],
      ports: { holds },
      observed: {
        sequence: "0000000000000001",
        entryDigest: ENTRY,
        anchorRecordDigest: ANCHOR,
        anchoredTime: "2026-09-18T00:00:00.000Z",
      },
    });
    expect(first).toEqual({
      status: "ok",
      hold: {
        origin: ORIGIN,
        sequence: "0000000000000001",
        entryDigest: ENTRY,
        anchorRecordDigest: ANCHOR,
        anchoredTime: "2026-09-18T00:00:00.000Z",
      },
    });

    const stillPresent = await verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [
        { sequence: "0000000000000001", digest: ENTRY },
        { sequence: "0000000000000002", digest: `sha256:${"c".repeat(64)}` },
      ],
      ports: { holds },
    });
    expect(stillPresent.status).toBe("ok");

    const truncated = await verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: `sha256:${"d".repeat(64)}` }],
      ports: { holds },
    });
    expect(truncated.status).toBe("missing-held-entry");
  });

  it("treats an HWM-covered held sequence as present when the suffix omits it", async () => {
    const holds = holdStore();
    await verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: ENTRY }],
      ports: { holds },
      observed: {
        sequence: "0000000000000001",
        entryDigest: ENTRY,
        anchorRecordDigest: ANCHOR,
        anchoredTime: "2026-09-18T00:00:00.000Z",
      },
    });

    await expect(verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000003", digest: `sha256:${"c".repeat(64)}` }],
      ports: { holds },
      coveredThrough: { sequence: "0000000000000002" },
    })).resolves.toMatchObject({ status: "ok" });

    await expect(verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000003", digest: `sha256:${"c".repeat(64)}` }],
      ports: { holds },
    })).resolves.toMatchObject({ status: "missing-held-entry" });
  });

  it("still refuses a fed digest mismatch at the held sequence even when HWM covers it", async () => {
    const holds = holdStore();
    await verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: ENTRY }],
      ports: { holds },
      observed: {
        sequence: "0000000000000001",
        entryDigest: ENTRY,
        anchorRecordDigest: ANCHOR,
        anchoredTime: "2026-09-18T00:00:00.000Z",
      },
    });

    await expect(verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: `sha256:${"d".repeat(64)}` }],
      ports: { holds },
      coveredThrough: { sequence: "0000000000000002" },
    })).resolves.toMatchObject({ status: "missing-held-entry" });
  });

  it("does not invent a hold when none has been recorded", async () => {
    const holds = holdStore();
    await expect(verifyAnchoredEntryHold({
      origin: ORIGIN,
      entries: [{ sequence: "0000000000000001", digest: ENTRY }],
      ports: { holds },
    })).resolves.toEqual({ status: "ok", hold: undefined });
  });
});

describe("enumerateEntryAnchorCoverage", () => {
  it("treats an all-anchor entry as outside the denominator and the newest substantive as pending", () => {
    const substantiveDigest = `sha256:${"1".repeat(64)}` as const;
    const coverage = enumerateEntryAnchorCoverage({
      entries: [
        {
          sequence: "0000000000000001",
          digest: substantiveDigest,
          announcements: [{
            announcementId: "run",
            action: "available",
            record: { kind: RECORD_KINDS.task, digest: `sha256:${"e".repeat(64)}` },
          }],
        },
        {
          sequence: "0000000000000002",
          digest: `sha256:${"2".repeat(64)}`,
          announcements: [{
            announcementId: "anchor",
            action: "available",
            record: { kind: ANCHOR_EVIDENCE_KIND, digest: `sha256:${"f".repeat(64)}` },
          }],
        },
      ],
      anchors: [{
        subjectKind: RECORD_KINDS.announcementEntry,
        subjectDigest: substantiveDigest.slice("sha256:".length),
      }],
      unreadable: [],
    });
    expect(isAnchorAnnouncingEntry({
      announcements: [{
        announcementId: "anchor",
        action: "available",
        record: { kind: ANCHOR_EVIDENCE_KIND, digest: `sha256:${"f".repeat(64)}` },
      }],
    })).toBe(true);
    expect(coverage).toEqual({
      anchored: ["0000000000000001"],
      gaps: [],
      pending: undefined,
      unreadable: [],
    });
  });

  it("holds an unreadable announcing entry out of the ordinary gap list", () => {
    const coverage = enumerateEntryAnchorCoverage({
      entries: [{
        sequence: "0000000000000001",
        digest: `sha256:${"1".repeat(64)}`,
        announcements: [{
          announcementId: "run",
          action: "available",
          record: { kind: RECORD_KINDS.task, digest: `sha256:${"e".repeat(64)}` },
        }],
      }],
      anchors: [],
      unreadable: ["0000000000000001"],
    });
    expect(coverage.gaps).toEqual([]);
    expect(coverage.pending).toBeUndefined();
    expect(coverage.unreadable).toEqual(["0000000000000001"]);
  });
});
