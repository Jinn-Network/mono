import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  cleanupRuntimeWorkspace,
  deriveRuntimeWorkspace,
  prepareRuntimeWorkspace,
} from "../browser/runtime-workspace";
import {
  BUILD_SECRET_ENV,
  createRuntimeEnvironment,
  CREDENTIAL_SECRET_ENV,
  OWNERSHIP_TOKEN_ENV,
  RUN_ID_ENV,
  RUNTIME_SECRET_ENV,
} from "../browser/runtime-config";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("production browser workspace ownership", () => {
  test("reuses one complete inherited run identity and refuses a partial child-process identity", () => {
    const complete: Record<string, string> = {
      [BUILD_SECRET_ENV]: "BP50_BUILD_SECRET_SENTINEL_test",
      [RUN_ID_ENV]: "00000000-0000-4000-8000-000000000004",
      [OWNERSHIP_TOKEN_ENV]: "owner-inherited-token-000004",
      [RUNTIME_SECRET_ENV]: "BP50_RUNTIME_SECRET_inherited",
      [CREDENTIAL_SECRET_ENV]: "BP50_CREDENTIAL_inherited_value",
    };
    expect(createRuntimeEnvironment(complete)).toEqual({
      [RUN_ID_ENV]: complete[RUN_ID_ENV],
      [OWNERSHIP_TOKEN_ENV]: complete[OWNERSHIP_TOKEN_ENV],
      [RUNTIME_SECRET_ENV]: complete[RUNTIME_SECRET_ENV],
      [CREDENTIAL_SECRET_ENV]: complete[CREDENTIAL_SECRET_ENV],
    });
    expect(() => createRuntimeEnvironment({
      [BUILD_SECRET_ENV]: complete[BUILD_SECRET_ENV],
      [RUN_ID_ENV]: complete[RUN_ID_ENV],
    })).toThrow(/partial/u);
  });

  test("parallel and crash-repeated runs have unique roots and clean only their exact owner", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const stale = deriveRuntimeWorkspace({ baseDir, runId: "00000000-0000-4000-8000-000000000001", ownershipToken: "owner-stale" });
    const parallel = deriveRuntimeWorkspace({ baseDir, runId: "00000000-0000-4000-8000-000000000002", ownershipToken: "owner-parallel" });

    prepareRuntimeWorkspace(stale);
    writeFileSync(join(stale.workspaceDir, "crash-remnant"), "stale", { flag: "wx" });
    prepareRuntimeWorkspace(parallel);
    expect(stale.runRoot).not.toBe(parallel.runRoot);
    expect(() => prepareRuntimeWorkspace(stale)).toThrow(/already exists/u);

    cleanupRuntimeWorkspace(parallel);
    expect(existsSync(parallel.runRoot)).toBe(false);
    expect(readFileSync(join(stale.workspaceDir, "crash-remnant"), "utf8")).toBe("stale");
    cleanupRuntimeWorkspace(stale);
    expect(existsSync(stale.runRoot)).toBe(false);
  });

  test("refuses cleanup when the ownership marker is not exact", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({ baseDir, runId: "00000000-0000-4000-8000-000000000003", ownershipToken: "owner-exact" });
    prepareRuntimeWorkspace(runtime);
    writeFileSync(runtime.ownershipMarker, "wrong-owner");
    expect(() => cleanupRuntimeWorkspace(runtime)).toThrow(/ownership/u);
    expect(existsSync(runtime.runRoot)).toBe(true);
  });
});
