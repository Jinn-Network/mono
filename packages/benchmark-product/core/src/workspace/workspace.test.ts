import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BenchmarkProductError } from "../errors.js";
import { artifactsDir, draftsDir, recordsDir, workspaceMetadataPath } from "./layout.js";
import {
  assertWorkspace,
  createWorkspaceLayout,
  isWorkspace,
  WORKSPACE_STORAGE_VERSION,
  WorkspaceMetadataSchema,
} from "./workspace.js";

const FIXED_CREATED_AT = "2026-08-05T00:00:00Z";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bp10-ws-"));
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

describe("createWorkspaceLayout", () => {
  test("creates drafts/, records/, artifacts/ and workspace.json; assertWorkspace round-trips it", () => {
    const workspaceDir = join(root, "ws1");

    const written = createWorkspaceLayout(workspaceDir, FIXED_CREATED_AT);

    expect(written).toEqual({ storageVersion: WORKSPACE_STORAGE_VERSION, createdAt: FIXED_CREATED_AT });
    expect(existsSync(draftsDir(workspaceDir))).toBe(true);
    expect(existsSync(recordsDir(workspaceDir))).toBe(true);
    expect(existsSync(artifactsDir(workspaceDir))).toBe(true);
    expect(existsSync(workspaceMetadataPath(workspaceDir))).toBe(true);

    const read = assertWorkspace(workspaceDir);
    expect(read).toEqual(written);
  });

  test("re-init of an existing workspace refuses with code conflict", () => {
    const workspaceDir = join(root, "ws2");
    createWorkspaceLayout(workspaceDir, FIXED_CREATED_AT);

    const error = catchProductError(() => createWorkspaceLayout(workspaceDir, FIXED_CREATED_AT));

    expect(error.code).toBe("conflict");
  });

  test("refuses validation for a createdAt that is not RFC 3339-shaped", () => {
    const workspaceDir = join(root, "ws3");

    const error = catchProductError(() => createWorkspaceLayout(workspaceDir, "not-a-timestamp"));

    expect(error.code).toBe("validation");
    expect(existsSync(workspaceMetadataPath(workspaceDir))).toBe(false);
  });
});

describe("assertWorkspace", () => {
  test("refuses not-found on a directory that is not a workspace", () => {
    const workspaceDir = join(root, "not-a-workspace");
    mkdirSync(workspaceDir, { recursive: true });

    const error = catchProductError(() => assertWorkspace(workspaceDir));

    expect(error.code).toBe("not-found");
  });

  test("refuses not-found when the directory itself does not exist", () => {
    const workspaceDir = join(root, "does-not-exist");

    const error = catchProductError(() => assertWorkspace(workspaceDir));

    expect(error.code).toBe("not-found");
  });

  test("refuses validation on corrupt JSON", () => {
    const workspaceDir = join(root, "corrupt");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(workspaceMetadataPath(workspaceDir), "{not json", "utf8");

    const error = catchProductError(() => assertWorkspace(workspaceDir));

    expect(error.code).toBe("validation");
  });

  test("refuses validation on well-formed JSON that fails the schema", () => {
    const workspaceDir = join(root, "wrong-shape");
    mkdirSync(workspaceDir, { recursive: true });
    writeFileSync(
      workspaceMetadataPath(workspaceDir),
      JSON.stringify({ storageVersion: 2, createdAt: FIXED_CREATED_AT }),
      "utf8",
    );

    const error = catchProductError(() => assertWorkspace(workspaceDir));

    expect(error.code).toBe("validation");
  });
});

describe("isWorkspace", () => {
  test("is false before init and true after", () => {
    const workspaceDir = join(root, "ws4");
    expect(isWorkspace(workspaceDir)).toBe(false);

    createWorkspaceLayout(workspaceDir, FIXED_CREATED_AT);

    expect(isWorkspace(workspaceDir)).toBe(true);
  });
});

describe("WorkspaceMetadataSchema", () => {
  test("accepts RFC 3339 timestamps with fractional seconds and numeric offsets", () => {
    expect(
      WorkspaceMetadataSchema.safeParse({
        storageVersion: WORKSPACE_STORAGE_VERSION,
        createdAt: "2026-08-05T12:34:56.789+02:00",
      }).success,
    ).toBe(true);
  });

  test("rejects a storageVersion that is not the current literal", () => {
    expect(
      WorkspaceMetadataSchema.safeParse({ storageVersion: 0, createdAt: FIXED_CREATED_AT }).success,
    ).toBe(false);
  });
});
