import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { recordsDir } from "./layout.js";
import { getSealedBytes, hasSealedBytes, putSealedBytes, sealedRecordPath, sha256Hex } from "./sealed-store.js";

let root: string;
let workspaceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bp10-sealed-"));
  workspaceDir = join(root, "ws");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Runs `fn`, expecting it to throw a `BenchmarkProductError`, and returns it. */
function catchProductError(fn: () => unknown): BenchmarkProductError {
  try {
    fn();
  } catch (cause) {
    if (cause instanceof BenchmarkProductError) return cause;
    throw cause;
  }
  throw new Error("expected function to throw a BenchmarkProductError");
}

describe("sha256Hex", () => {
  test("matches node:crypto's own sha256 hex digest of the exact bytes", () => {
    const bytes = new TextEncoder().encode("hello world");
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(sha256Hex(bytes)).toBe(expected);
  });

  test("is the well-known digest of the empty byte sequence", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("differs for differing content", () => {
    const a = sha256Hex(new TextEncoder().encode("a"));
    const b = sha256Hex(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });
});

describe("sealedRecordPath", () => {
  test("resolves to records/<hex64>.bin under the workspace", () => {
    const digest = "a".repeat(64);
    expect(sealedRecordPath(workspaceDir, digest)).toBe(join(recordsDir(workspaceDir), `${digest}.bin`));
  });

  test.each([
    ["uppercase hex", "A".repeat(64)],
    ["too short", "a".repeat(63)],
    ["too long", "a".repeat(65)],
    ["non-hex characters", "g".repeat(64)],
    ["empty string", ""],
  ])("refuses validation for a malformed digest (%s)", (_label, malformed) => {
    const error = catchProductError(() => sealedRecordPath(workspaceDir, malformed));
    expect(error.code).toBe("validation");
  });
});

describe("putSealedBytes / getSealedBytes", () => {
  test("round-trips exact bytes, including a non-UTF-8 sequence, byte-for-byte", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0xc0, 0xc1, 0x01, 0x02, 0x03]);

    const digest = putSealedBytes(workspaceDir, bytes);
    const readBack = getSealedBytes(workspaceDir, digest);

    expect(readBack).toEqual(bytes);
    expect(Buffer.from(readBack).equals(Buffer.from(bytes))).toBe(true);
  });

  test("digest returned is the sha256 of the stored bytes", () => {
    const bytes = new TextEncoder().encode("a sealed record's exact bytes");
    const digest = putSealedBytes(workspaceDir, bytes);
    expect(digest).toBe(sha256Hex(bytes));
  });

  test("is idempotent for byte-identical content", () => {
    const bytes = new TextEncoder().encode("idempotent content");

    const first = putSealedBytes(workspaceDir, bytes);
    const second = putSealedBytes(workspaceDir, bytes);

    expect(second).toBe(first);
    expect(readdirSync(recordsDir(workspaceDir))).toEqual([`${first}.bin`]);
    expect(getSealedBytes(workspaceDir, first)).toEqual(bytes);
  });

  test("getSealedBytes refuses not-found for an unknown digest", () => {
    const unknownDigest = sha256Hex(new TextEncoder().encode("never stored"));

    const error = catchProductError(() => getSealedBytes(workspaceDir, unknownDigest));

    expect(error.code).toBe("not-found");
  });

  test("getSealedBytes refuses record-integrity when the stored file was corrupted on disk", () => {
    const bytes = new TextEncoder().encode("original content");
    const digest = putSealedBytes(workspaceDir, bytes);

    writeFileSync(sealedRecordPath(workspaceDir, digest), "tampered content");

    const error = catchProductError(() => getSealedBytes(workspaceDir, digest));

    expect(error.code).toBe("record-integrity");
  });
});

describe("hasSealedBytes", () => {
  test("is false before put and true after", () => {
    const bytes = new TextEncoder().encode("presence check");
    const digest = sha256Hex(bytes);

    expect(hasSealedBytes(workspaceDir, digest)).toBe(false);
    expect(existsSync(sealedRecordPath(workspaceDir, digest))).toBe(false);

    putSealedBytes(workspaceDir, bytes);

    expect(hasSealedBytes(workspaceDir, digest)).toBe(true);
  });
});
