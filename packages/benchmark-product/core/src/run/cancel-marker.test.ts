import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { runCancelMarkerPath } from "../workspace/layout.js";
import { cancelRequested, readCancelMarker, writeCancelMarker } from "./cancel-marker.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp22-cancel-marker-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

describe("cancelRequested", () => {
  test("false when no marker file exists", () => {
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(false);
  });

  test("true once a valid marker has been written", () => {
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    expect(cancelRequested(workspaceDir, "draft-1")).toBe(true);
  });

  test("is scoped per draftId", () => {
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    expect(cancelRequested(workspaceDir, "draft-2")).toBe(false);
  });

  test("refuses a symlink in place of the regular marker file", () => {
    mkdirSync(join(workspaceDir, "runs"), { recursive: true });
    const target = join(workspaceDir, "foreign-marker.json");
    writeFileSync(target, JSON.stringify({ requestedAt: "2026-08-05T00:00:00Z", principal: "attacker" }));
    symlinkSync(target, runCancelMarkerPath(workspaceDir, "draft-1"));
    expect(() => cancelRequested(workspaceDir, "draft-1")).toThrow(/regular file|symbolic link/iu);
  });

  test("fails closed with record-integrity when regular marker bytes are malformed", () => {
    mkdirSync(join(workspaceDir, "runs"), { recursive: true });
    writeFileSync(runCancelMarkerPath(workspaceDir, "draft-1"), "not json");
    try {
      cancelRequested(workspaceDir, "draft-1");
      expect.unreachable("expected malformed marker refusal");
    } catch (cause) {
      expect(cause).toBeInstanceOf(BenchmarkProductError);
      expect((cause as BenchmarkProductError).code).toBe("record-integrity");
    }
  });
});

describe("writeCancelMarker / readCancelMarker", () => {
  test("round-trips requestedAt and principal", () => {
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T12:34:56Z", principal: "agent-1" });
    const marker = readCancelMarker(workspaceDir, "draft-1");
    expect(marker).toEqual({ requestedAt: "2026-08-05T12:34:56Z", principal: "agent-1" });
  });

  test("fsyncs the runs directory after canonical link publication and owner unlink", () => {
    const steps: string[] = [];
    writeCancelMarker(
      workspaceDir,
      "draft-1",
      { requestedAt: "2026-08-05T12:34:56Z", principal: "agent-1" },
      { onPublicationStep: (step) => steps.push(step) },
    );
    expect(steps).toEqual([
      "owner-file-synced",
      "canonical-linked",
      "directory-synced-after-link",
      "owner-unlinked",
      "directory-synced-after-unlink",
    ]);
  });

  test("readCancelMarker returns undefined when no marker exists", () => {
    expect(readCancelMarker(workspaceDir, "draft-1")).toBeUndefined();
  });

  test("writeCancelMarker refuses validation on a malformed marker (bad timestamp)", () => {
    expect(() =>
      writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "not-a-timestamp", principal: "sponsor-1" }),
    ).toThrowError(/RFC 3339/);
  });

  test("writeCancelMarker refuses validation on an empty principal", () => {
    expect(() =>
      writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "" }),
    ).toThrow();
  });

  test("readCancelMarker refuses validation when the file is not valid JSON", () => {
    // mkdir the runs dir first via a legitimate write, then corrupt it directly.
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    writeFileSync(runCancelMarkerPath(workspaceDir, "draft-1"), "not json");
    expect(() => readCancelMarker(workspaceDir, "draft-1")).toThrowError(/validation|JSON/);
  });

  test("readCancelMarker refuses validation when the file fails the schema", () => {
    writeCancelMarker(workspaceDir, "draft-1", { requestedAt: "2026-08-05T00:00:00Z", principal: "sponsor-1" });
    writeFileSync(runCancelMarkerPath(workspaceDir, "draft-1"), JSON.stringify({ requestedAt: "2026-08-05T00:00:00Z" }));
    expect(() => readCancelMarker(workspaceDir, "draft-1")).toThrow();
  });
});
