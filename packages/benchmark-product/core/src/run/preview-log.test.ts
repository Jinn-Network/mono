import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { draftPreviewsDir, previewLogPath } from "../workspace/layout.js";
import {
  appendPreviewLogEntry,
  PREVIEW_MARKER,
  previewDisclosureLine,
  readPreviewLog,
  type PreviewLogEntry,
} from "./preview-log.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp20-preview-log-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<PreviewLogEntry> = {}): PreviewLogEntry {
  return {
    previewId: "preview-001",
    at: "2026-08-06T00:00:00.000Z",
    startedAt: "2026-08-06T00:00:00.100Z",
    finishedAt: "2026-08-06T00:00:01.100Z",
    elapsedMs: 1000,
    draftState: "draft",
    itemCount: 3,
    cellCount: 6,
    arms: [
      { armId: "baseline", cells: 3, outcomes: { delivered: 3, failed: 0, expired: 0, cancelled: 0, other: 0 } },
      { armId: "sample", cells: 3, outcomes: { delivered: 3, failed: 0, expired: 0, cancelled: 0, other: 0 } },
    ],
    ...overrides,
  };
}

describe("PREVIEW_MARKER", () => {
  test("is the exact honest rehearsal-marker string", () => {
    expect(PREVIEW_MARKER).toBe("rehearsal — not official evidence");
  });
});

describe("readPreviewLog", () => {
  test("returns undefined when no preview log exists yet", () => {
    expect(readPreviewLog(workspaceDir, "draft-1")).toBeUndefined();
  });

  test("refuses validation when the preview log file is malformed JSON", () => {
    mkdirSync(draftPreviewsDir(workspaceDir, "draft-1"), { recursive: true });
    writeFileSync(previewLogPath(workspaceDir, "draft-1"), "{not json", "utf8");

    expect(() => readPreviewLog(workspaceDir, "draft-1")).toThrowError(BenchmarkProductError);
    try {
      readPreviewLog(workspaceDir, "draft-1");
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect((cause as BenchmarkProductError).code).toBe("validation");
    }
  });

  test("refuses validation when the preview log file fails the schema", () => {
    mkdirSync(draftPreviewsDir(workspaceDir, "draft-1"), { recursive: true });
    writeFileSync(previewLogPath(workspaceDir, "draft-1"), JSON.stringify({ draftId: "draft-1" }), "utf8");

    try {
      readPreviewLog(workspaceDir, "draft-1");
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
    }
  });

  test("refuses validation when count disagrees with previews.length (desynchronized log)", () => {
    mkdirSync(draftPreviewsDir(workspaceDir, "draft-1"), { recursive: true });
    writeFileSync(
      previewLogPath(workspaceDir, "draft-1"),
      JSON.stringify({ draftId: "draft-1", count: 2, previews: [makeEntry()] }),
      "utf8",
    );

    try {
      readPreviewLog(workspaceDir, "draft-1");
      expect.unreachable("expected a refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("validation");
    }
  });
});

describe("appendPreviewLogEntry / readPreviewLog round trip", () => {
  test("a first append creates the log at count 1 and is readable back exactly", () => {
    const entry = makeEntry();
    const log = appendPreviewLogEntry(workspaceDir, "draft-1", entry);

    expect(log).toEqual({ draftId: "draft-1", count: 1, previews: [entry] });
    expect(readPreviewLog(workspaceDir, "draft-1")).toEqual(log);
  });

  test("a second append increments count and preserves append order", () => {
    const first = makeEntry({ previewId: "preview-001", at: "2026-08-06T00:00:00.000Z" });
    const second = makeEntry({ previewId: "preview-002", at: "2026-08-06T00:05:00.000Z" });

    appendPreviewLogEntry(workspaceDir, "draft-1", first);
    const log = appendPreviewLogEntry(workspaceDir, "draft-1", second);

    expect(log.count).toBe(2);
    expect(log.previews).toEqual([first, second]);
    expect(readPreviewLog(workspaceDir, "draft-1")).toEqual(log);
  });

  test("preview logs for different draftIds are independent", () => {
    appendPreviewLogEntry(workspaceDir, "draft-1", makeEntry());
    expect(readPreviewLog(workspaceDir, "draft-2")).toBeUndefined();
  });
});

describe("previewDisclosureLine", () => {
  test("renders the exact disclosure sentence for a 2-entry log", () => {
    const log = {
      draftId: "draft-1",
      count: 2,
      previews: [
        makeEntry({ previewId: "preview-001", at: "2026-08-06T00:00:00.000Z" }),
        makeEntry({ previewId: "preview-002", at: "2026-08-06T00:05:00.000Z" }),
      ],
    };

    expect(previewDisclosureLine(log)).toBe(
      "2 disposable preview rehearsal(s) of this benchmark ran before lock "
        + "(at 2026-08-06T00:00:00.000Z, 2026-08-06T00:05:00.000Z); preview results are rehearsal "
        + "only and never entered official results.",
    );
  });
});
