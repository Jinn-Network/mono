// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end coverage for the freeze-repository export (issue #2870) against a real materialized
 * v4 qualification bundle: export, standalone check, byte-identical regeneration, and the three
 * ways a published tree can drift from the bundle it claims to be derived from.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  FREEZE_REPO_MANIFEST_FILENAME,
  exportFreezeRepo,
  runVerifierCli,
  verifyFreezeRepo,
} from "@colophon-claims/verify";
import { runCli } from "../cli/main.js";
import { createSyntheticV4BundleFixture } from "./testing/v4-synthetic-fixture.js";

const roots: string[] = [];

// One real v4 bundle build is ~20s; every test reads the same immutable bundle rather than
// rebuilding one, so the suite proves the export's behaviour without paying for the fixture N times.
let licensedBundle: string;
let unlicensedBundle: string;

beforeAll(async () => {
  const [licensed, unlicensed] = await Promise.all([
    createSyntheticV4BundleFixture({
      workspaceDir: tempDir("workspace"),
      truthAdmission: "operator-only",
      license: "CC-BY-NC-4.0",
      citation: "Colophon synthetic freeze, 2026.",
    }),
    createSyntheticV4BundleFixture({
      workspaceDir: tempDir("unlicensed-workspace"),
      truthAdmission: "operator-only",
    }),
  ]);
  licensedBundle = licensed.bundle.bundleDir;
  unlicensedBundle = unlicensed.bundle.bundleDir;
}, 300_000);

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `freeze-repo-${label}-`));
  roots.push(dir);
  return dir;
}


describe("freeze-repository export against a real v4 bundle", () => {
  test("exports, then the standalone check confirms the tree matches the bundle", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("repo"), "tree");

    const exported = await exportFreezeRepo(bundleDir, repoDir);

    expect(exported.commitId).toMatch(/^[0-9a-f]{40}$/);
    expect(exported.fileCount).toBeGreaterThan(0);
    expect(exported.roles).toContain("item-bank");
    expect(exported.roles).toContain("source-manifest");
    for (const path of ["README.md", "LICENSE", "NOTICE", "metadata/spdx.json", FREEZE_REPO_MANIFEST_FILENAME]) {
      expect(existsSync(join(repoDir, path)), path).toBe(true);
    }
    expect(readFileSync(join(repoDir, "LICENSE"), "utf8")).toContain("CC-BY-NC-4.0");

    const checked = await verifyFreezeRepo(bundleDir, repoDir);
    expect(checked.ok).toBe(true);
    expect(checked.differences).toEqual([]);
    expect(checked.commitId).toBe(exported.commitId);
  });

  test("the same bundle regenerates a byte-identical tree, from a copy of the bundle too", async () => {
    const bundleDir = licensedBundle;
    const copy = join(tempDir("copy"), "bundle");
    cpSync(bundleDir, copy, { recursive: true });

    const first = await exportFreezeRepo(bundleDir, join(tempDir("first"), "tree"));
    const second = await exportFreezeRepo(copy, join(tempDir("second"), "tree"));

    expect(second.commitId).toBe(first.commitId);
    expect(second.fileCount).toBe(first.fileCount);
    // The commit id is the pin, and the check agrees across both renderings.
    expect((await verifyFreezeRepo(copy, first.repoDir)).ok).toBe(true);
  });

  test("names an altered, a deleted, and an extra member", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("drifted"), "tree");
    await exportFreezeRepo(bundleDir, repoDir);

    writeFileSync(join(repoDir, "NOTICE"), "hand-edited\n");
    rmSync(join(repoDir, "LICENSE"));
    writeFileSync(join(repoDir, "EXTRA.md"), "smuggled\n");

    const checked = await verifyFreezeRepo(bundleDir, repoDir);
    expect(checked.ok).toBe(false);
    expect(checked.differences).toEqual([
      { path: "EXTRA.md", kind: "unexpected" },
      { path: "LICENSE", kind: "missing" },
      { path: "NOTICE", kind: "changed" },
    ]);
  });

  test("reports the git-visible drift that leaves bytes untouched", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("git-drift"), "tree");
    await exportFreezeRepo(bundleDir, repoDir);

    // Both change what git records for the path, and therefore the commit oid the announcement
    // pins, while every byte reads back identical.
    chmodSync(join(repoDir, "NOTICE"), 0o755);
    const licenseBytes = readFileSync(join(repoDir, "LICENSE"));
    rmSync(join(repoDir, "LICENSE"));
    writeFileSync(join(repoDir, ".license-payload"), licenseBytes);
    symlinkSync(join(repoDir, ".license-payload"), join(repoDir, "LICENSE"));

    const checked = await verifyFreezeRepo(bundleDir, repoDir);
    expect(checked.ok).toBe(false);
    expect(checked.differences).toEqual(
      expect.arrayContaining([
        { path: "LICENSE", kind: "changed" },
        { path: "NOTICE", kind: "changed" },
        { path: ".license-payload", kind: "unexpected" },
      ]),
    );
  });

  test("a nested .git directory is content, not verifier-invisible metadata", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("nested-git"), "tree");
    await exportFreezeRepo(bundleDir, repoDir);

    // Only the ROOT .git is git's own metadata; one at depth is ordinary content the check must see.
    mkdirSync(join(repoDir, ".git"), { recursive: true });
    writeFileSync(join(repoDir, ".git", "config"), "root metadata\n");
    mkdirSync(join(repoDir, "artifacts", ".git"), { recursive: true });
    writeFileSync(join(repoDir, "artifacts", ".git", "payload"), "smuggled\n");

    const checked = await verifyFreezeRepo(bundleDir, repoDir);
    expect(checked.ok).toBe(false);
    expect(checked.differences).toEqual([{ path: "artifacts/.git/payload", kind: "unexpected" }]);
  });

  test("the standalone verifier package checks a published tree with no product install", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("standalone"), "tree");
    await exportFreezeRepo(bundleDir, repoDir);

    const matched = await runVerifierCli([bundleDir, "--freeze-repo", repoDir, "--json"]);
    expect(matched.exitCode).toBe(0);
    expect((JSON.parse(matched.stdout) as { freezeRepo: { ok: boolean } }).freezeRepo.ok).toBe(true);

    writeFileSync(join(repoDir, "README.md"), "rewritten by hand\n");
    const drifted = await runVerifierCli([bundleDir, "--freeze-repo", repoDir]);
    expect(drifted.exitCode).toBe(1);
    expect(drifted.stdout).toContain("DOES NOT match this bundle");
    expect(drifted.stdout).toContain("changed: README.md");
  });

  test("refuses to write into a directory that already holds files", async () => {
    const repoDir = join(tempDir("occupied"), "tree");
    mkdirSync(repoDir, { recursive: true });
    writeFileSync(join(repoDir, "leftover.txt"), "from an earlier run\n");

    await expect(exportFreezeRepo(licensedBundle, repoDir)).rejects.toThrow(/already contains files/);
  });

  test("refuses a bundle whose Benchmark record declares no licence", async () => {
    await expect(exportFreezeRepo(unlicensedBundle, join(tempDir("out"), "repo")))
      .rejects.toThrow(/declares no licence/);
  });
});

describe("freeze-repo CLI verbs", () => {
  test("export then verify, both standalone: no workspace, no principal", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("cli"), "repo");

    const exported = await runCli(
      ["freeze-repo", "export", "--bundle", bundleDir, "--out", repoDir, "--json"],
      { cwd: process.cwd(), clock: () => "2026-08-29T00:00:00.000Z" },
    );
    expect(exported.exitCode).toBe(0);
    const exportEnvelope = JSON.parse(exported.stdout) as { ok: boolean; result: { commitId: string } };
    expect(exportEnvelope.ok).toBe(true);

    const verified = await runCli(
      ["freeze-repo", "verify", "--bundle", bundleDir, "--repo", repoDir, "--json"],
      { cwd: process.cwd(), clock: () => "2026-08-29T00:00:00.000Z" },
    );
    expect(verified.exitCode).toBe(0);
    const verifyEnvelope = JSON.parse(verified.stdout) as {
      ok: boolean;
      result: { ok: boolean; commitId: string; differences: readonly unknown[] };
    };
    expect(verifyEnvelope.result.ok).toBe(true);
    expect(verifyEnvelope.result.differences).toEqual([]);
    expect(verifyEnvelope.result.commitId).toBe(exportEnvelope.result.commitId);
  });

  test("a drifted tree exits non-zero and names every drifted member", async () => {
    const bundleDir = licensedBundle;
    const repoDir = join(tempDir("cli-drift"), "repo");
    await exportFreezeRepo(bundleDir, repoDir);
    writeFileSync(join(repoDir, "README.md"), "rewritten by hand\n");

    const verified = await runCli(
      ["freeze-repo", "verify", "--bundle", bundleDir, "--repo", repoDir, "--json"],
      { cwd: process.cwd(), clock: () => "2026-08-29T00:00:00.000Z" },
    );

    // `freeze-repo verify && publish` must not publish a drifted tree, so this exits non-zero.
    expect(verified.exitCode).toBe(1);
    const envelope = JSON.parse(verified.stdout) as {
      ok: boolean;
      error: { code: string; detail: string; issues: { path: string; message: string }[] };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("record-integrity");
    expect(envelope.error.issues).toEqual([{ path: "README.md", message: "changed" }]);
  });
});
