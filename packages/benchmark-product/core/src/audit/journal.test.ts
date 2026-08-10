import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAuditEntry, inputsDigest, readAuditEntries, type AuditEntry } from "./journal.js";
import { BenchmarkProductError } from "../errors.js";
import { journalPath } from "../workspace/layout.js";
import { appendFsyncedLineSync, readTextIfExistsSync } from "../fs/atomic.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bp10-aa-"));
});

afterEach(() => {
  rmSync(workspaceDir, { recursive: true, force: true });
});

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    at: "2026-08-05T00:00:00Z",
    actor: "sponsor-1",
    action: "draft.create",
    subject: "draft-1",
    inputsDigest: inputsDigest({ taskSet: "abc" }),
    outcome: "ok",
    ...overrides,
  };
}

describe("appendAuditEntry / readAuditEntries", () => {
  test("append then read round-trips the exact entry", () => {
    const e = entry();
    appendAuditEntry(workspaceDir, e);
    expect(readAuditEntries(workspaceDir)).toEqual([e]);
  });

  test("multiple appends come back in append order", () => {
    const first = entry({
      at: "2026-08-05T00:00:00Z",
      action: "workspace.init",
      subject: "workspace",
      inputsDigest: inputsDigest({}),
    });
    const second = entry({
      at: "2026-08-05T00:01:00Z",
      action: "draft.create",
      subject: "draft-1",
      inputsDigest: inputsDigest({ name: "x" }),
    });
    const third = entry({
      at: "2026-08-05T00:02:00Z",
      actor: "agent-1",
      action: "draft.edit",
      subject: "draft-1",
      inputsDigest: inputsDigest({ name: "y" }),
      outcome: "validation",
    });

    appendAuditEntry(workspaceDir, first);
    appendAuditEntry(workspaceDir, second);
    appendAuditEntry(workspaceDir, third);

    const entries = readAuditEntries(workspaceDir);
    expect(entries.map((e) => e.action)).toEqual(["workspace.init", "draft.create", "draft.edit"]);
    expect(entries).toEqual([first, second, third]);
  });

  test("an absent journal reads as an empty array", () => {
    expect(readAuditEntries(workspaceDir)).toEqual([]);
  });

  test("a hand-corrupted line refuses journal-integrity naming the line index", () => {
    appendAuditEntry(workspaceDir, entry());
    appendFsyncedLineSync(journalPath(workspaceDir), "not json at all {{{");

    let caught: unknown;
    try {
      readAuditEntries(workspaceDir);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(BenchmarkProductError);
    const error = caught as BenchmarkProductError;
    expect(error.code).toBe("journal-integrity");
    expect(error.issues[0]?.path).toBe("journal.1");
  });

  test("an entry failing the schema refuses validation and appends nothing", () => {
    const before = readTextIfExistsSync(journalPath(workspaceDir));
    const bad = entry({ actor: "", inputsDigest: "not-a-digest" });

    let caught: unknown;
    try {
      appendAuditEntry(workspaceDir, bad);
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(BenchmarkProductError);
    expect((caught as BenchmarkProductError).code).toBe("validation");
    expect(readTextIfExistsSync(journalPath(workspaceDir))).toBe(before);
  });
});

describe("inputsDigest", () => {
  test("is a lowercase sha256 hex digest", () => {
    expect(inputsDigest({ a: 1 })).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic and key-order-insensitive, including for nested objects", () => {
    expect(inputsDigest({ a: 1, b: 2 })).toBe(inputsDigest({ b: 2, a: 1 }));
    expect(inputsDigest({ x: { a: 1, b: 2 }, y: [1, 2, 3] })).toBe(
      inputsDigest({ y: [1, 2, 3], x: { b: 2, a: 1 } }),
    );
  });

  test("differs for different inputs", () => {
    expect(inputsDigest({ a: 1 })).not.toBe(inputsDigest({ a: 2 }));
    expect(inputsDigest({ a: 1 })).not.toBe(inputsDigest({ a: 1, b: 1 }));
  });
});
