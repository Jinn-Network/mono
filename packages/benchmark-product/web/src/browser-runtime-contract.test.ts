import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

function quarantines(baseDir: string): readonly string[] {
  return readdirSync(baseDir)
    .filter((name) => name.includes(".quarantine-"))
    .map((name) => join(baseDir, name));
}

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

    const staleOwner = prepareRuntimeWorkspace(stale);
    writeFileSync(join(stale.workspaceDir, "crash-remnant"), "stale", { flag: "wx" });
    const parallelOwner = prepareRuntimeWorkspace(parallel);
    expect(typeof staleOwner.rootIdentity.dev).toBe("bigint");
    expect(typeof staleOwner.rootIdentity.ino).toBe("bigint");
    expect(typeof staleOwner.markerIdentity.dev).toBe("bigint");
    expect(typeof staleOwner.markerIdentity.ino).toBe("bigint");
    expect(stale.runRoot).not.toBe(parallel.runRoot);
    expect(() => prepareRuntimeWorkspace(stale)).toThrow(/already exists/u);

    cleanupRuntimeWorkspace(parallel, parallelOwner);
    expect(existsSync(parallel.runRoot)).toBe(false);
    expect(readFileSync(join(stale.workspaceDir, "crash-remnant"), "utf8")).toBe("stale");
    cleanupRuntimeWorkspace(stale, staleOwner);
    expect(existsSync(stale.runRoot)).toBe(false);
  });

  test("refuses cleanup when the ownership marker is not exact", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({ baseDir, runId: "00000000-0000-4000-8000-000000000003", ownershipToken: "owner-exact" });
    const owner = prepareRuntimeWorkspace(runtime);
    writeFileSync(runtime.ownershipMarker, "wrong-owner");
    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/ownership/u);
    expect(existsSync(runtime.runRoot)).toBe(true);
  });

  test("retains a replacement root even when its ownership marker replays the original bytes", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-000000000005",
      ownershipToken: "owner-replayed-marker",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const replayedMarker = readFileSync(runtime.ownershipMarker, "utf8");

    const displacedOriginal = join(baseDir, "displaced-original-root");
    renameSync(runtime.runRoot, displacedOriginal);
    mkdirSync(runtime.runRoot);
    writeFileSync(runtime.ownershipMarker, replayedMarker, { flag: "wx", mode: 0o600 });
    mkdirSync(runtime.workspaceDir);
    const replacementEvidence = join(runtime.workspaceDir, "replacement-evidence");
    writeFileSync(replacementEvidence, "must survive", { flag: "wx" });

    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/identity.*retained|retained.*identity/iu);
    expect(existsSync(displacedOriginal)).toBe(true);
    expect(lstatSync(runtime.runRoot).isSymbolicLink()).toBe(true);
    const retained = quarantines(baseDir);
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(retained[0]!, "workspace", "replacement-evidence"), "utf8")).toBe("must survive");
    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/blocked.*evidence/iu);
  });

  test("refuses a replacement root and marker even beside a self-consistent replacement receipt", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-00000000000a",
      ownershipToken: "owner-replaced-receipt",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const replayedMarker = readFileSync(runtime.ownershipMarker, "utf8");

    const displacedOriginal = join(baseDir, "displaced-original-with-receipt");
    renameSync(runtime.runRoot, displacedOriginal);
    mkdirSync(runtime.runRoot);
    writeFileSync(runtime.ownershipMarker, replayedMarker, { flag: "wx", mode: 0o600 });
    mkdirSync(runtime.workspaceDir);
    const replacementEvidence = join(runtime.workspaceDir, "replacement-receipt-evidence");
    writeFileSync(replacementEvidence, "must survive", { flag: "wx" });

    const replacementReceipt = join(baseDir, ".attacker-self-consistent-receipt.json");
    writeFileSync(replacementReceipt, "", { flag: "wx", mode: 0o600 });
    const rootStat = lstatSync(runtime.runRoot, { bigint: true });
    const markerStat = lstatSync(runtime.ownershipMarker, { bigint: true });
    const receiptStat = lstatSync(replacementReceipt, { bigint: true });
    writeFileSync(replacementReceipt, `${JSON.stringify({
      format: "benchmark-product-browser-ownership-receipt/1",
      runId: runtime.runId,
      ownershipToken: runtime.ownershipToken,
      rootIdentity: { dev: rootStat.dev.toString(10), ino: rootStat.ino.toString(10) },
      markerIdentity: { dev: markerStat.dev.toString(10), ino: markerStat.ino.toString(10) },
      receiptIdentity: { dev: receiptStat.dev.toString(10), ino: receiptStat.ino.toString(10) },
    })}\n`);

    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/identity.*retained|retained.*identity/iu);
    expect(existsSync(displacedOriginal)).toBe(true);
    expect(readFileSync(replacementEvidence, "utf8")).toBe("must survive");
  });

  test("retains the root when exact marker bytes are replayed into a replacement inode", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-000000000006",
      ownershipToken: "owner-replaced-marker",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const replayedMarker = readFileSync(runtime.ownershipMarker, "utf8");
    rmSync(runtime.ownershipMarker);
    writeFileSync(runtime.ownershipMarker, replayedMarker, { flag: "wx", mode: 0o600 });

    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/marker identity.*retained|retained.*marker identity/iu);
    expect(lstatSync(runtime.runRoot).isSymbolicLink()).toBe(true);
    expect(quarantines(baseDir)).toHaveLength(1);
  });

  test.each(["symlink", "hardlink"] as const)("retains evidence for a marker %s replacement", (kind) => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: kind === "symlink" ? "00000000-0000-4000-8000-000000000007" : "00000000-0000-4000-8000-000000000008",
      ownershipToken: `owner-${kind}-marker`,
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const outside = join(baseDir, `outside-${kind}.json`);
    writeFileSync(outside, readFileSync(runtime.ownershipMarker), { flag: "wx", mode: 0o600 });
    rmSync(runtime.ownershipMarker);
    if (kind === "symlink") symlinkSync(outside, runtime.ownershipMarker);
    else linkSync(outside, runtime.ownershipMarker);

    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/marker.*retained|retained.*marker/iu);
    expect(existsSync(outside)).toBe(true);
    expect(lstatSync(runtime.runRoot).isSymbolicLink()).toBe(true);
    expect(quarantines(baseDir)).toHaveLength(1);
  });

  test("retains an exact owned root when an unexpected child would broaden recursive cleanup", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-000000000009",
      ownershipToken: "owner-unexpected-child",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    writeFileSync(join(runtime.runRoot, "unexpected-evidence"), "must survive", { flag: "wx" });

    expect(() => cleanupRuntimeWorkspace(runtime, owner)).toThrow(/unproven root entry.*retained|retained.*unproven root entry/iu);
    expect(lstatSync(runtime.runRoot).isSymbolicLink()).toBe(true);
    const retained = quarantines(baseDir);
    expect(retained).toHaveLength(1);
    expect(readFileSync(join(retained[0]!, "unexpected-evidence"), "utf8")).toBe("must survive");
  });

  test("never overwrites or deletes a new original-path occupant created after quarantine", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-00000000000b",
      ownershipToken: "owner-original-race",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const replacementEvidence = join(runtime.runRoot, "replacement-after-quarantine");

    cleanupRuntimeWorkspace(runtime, owner, {
      afterQuarantine: ({ original }) => {
        mkdirSync(original);
        writeFileSync(replacementEvidence, "must survive", { flag: "wx" });
      },
    });

    expect(readFileSync(replacementEvidence, "utf8")).toBe("must survive");
    expect(owner.cleanupCompleted).toBe(true);
    expect(quarantines(baseDir)).toHaveLength(0);
  });

  test("second validation retains a quarantine-path replacement after ABA", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "bp50-runtime-test-"));
    roots.push(baseDir);
    const runtime = deriveRuntimeWorkspace({
      baseDir,
      runId: "00000000-0000-4000-8000-00000000000c",
      ownershipToken: "owner-quarantine-aba",
    });
    const owner = prepareRuntimeWorkspace(runtime);
    const replayedMarker = readFileSync(runtime.ownershipMarker, "utf8");
    const displacedOwnedRoot = join(baseDir, "displaced-owned-quarantine");
    let replacementEvidence = "";

    expect(() => cleanupRuntimeWorkspace(runtime, owner, {
      afterFirstValidation: ({ quarantine }) => {
        renameSync(quarantine, displacedOwnedRoot);
        mkdirSync(quarantine);
        writeFileSync(join(quarantine, ".bp50-browser-owner.json"), replayedMarker, { flag: "wx", mode: 0o600 });
        mkdirSync(join(quarantine, "workspace"));
        replacementEvidence = join(quarantine, "workspace", "aba-replacement-evidence");
        writeFileSync(replacementEvidence, "must survive", { flag: "wx" });
      },
    })).toThrow(/identity.*retained|retained.*identity/iu);

    expect(existsSync(displacedOwnedRoot)).toBe(true);
    expect(readFileSync(replacementEvidence, "utf8")).toBe("must survive");
    expect(lstatSync(runtime.runRoot).isSymbolicLink()).toBe(true);
  });
});
