import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { browserCommand, runColophonCli, writeQuickstartCompanions } from "./main.js";
import { BUILD_METADATA_KIND, DEFAULT_QUALIFIED_TARGETS, type ColophonBuildMetadata } from "./build-metadata.js";

const TEST_BUILD: ColophonBuildMetadata = {
  kind: BUILD_METADATA_KIND,
  packageVersion: "1.0.0",
  sourceCommit: "b".repeat(40),
  qualifiedTargets: ["darwin/arm64", "linux/x64"],
};

describe("Colophon install surface", () => {
  const context = {
    cwd: "/tmp",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
    progress() {},
  } as const;

  test("defaults public qualification to the proved macOS arm64 and Ubuntu x64 targets, never the build host", () => {
    expect(DEFAULT_QUALIFIED_TARGETS).toEqual(["darwin/arm64", "linux/x64"]);
  });

  test("renders product help without exposing the contributor command as the default", async () => {
    const answer = await runColophonCli(["help"], {
      cwd: "/tmp",
      now: () => new Date("2026-08-13T12:00:00.000Z"),
      progress() {},
    });
    expect(answer.exitCode).toBe(0);
    expect(answer.stdout).toContain("colophon demo");
    expect(answer.stdout).toContain("No account, API key, funds, or Docker");
  });

  test("uses argument arrays rather than a shell for browser opening", () => {
    expect(browserCommand("http://127.0.0.1:3000/launch?token=x", "darwin")).toEqual({
      command: "open",
      args: ["http://127.0.0.1:3000/launch?token=x"],
    });
    expect(browserCommand("http://127.0.0.1:3000/launch?token=x", "linux").command).toBe("xdg-open");
  });

  test("renders help before command execution and rejects malformed top-level options without a stack", async () => {
    expect(await runColophonCli(["demo", "--help"], context)).toMatchObject({ exitCode: 0 });

    for (const argv of [
      ["demo", "--output"],
      ["demo", "--unknown"],
      ["demo", "unexpected"],
      ["open", "--port"],
      ["open", "--bundle", "/tmp/a", "--bundle", "/tmp/b"],
    ]) {
      const answer = await runColophonCli(argv, context);
      expect(answer.exitCode, argv.join(" ")).toBe(2);
      expect(answer.stderr).toContain("Run colophon --help");
      expect(answer.stderr).not.toContain(" at ");
    }

    const duplicateJson = await runColophonCli(["demo", "--json", "--json"], context);
    expect(duplicateJson).toMatchObject({ exitCode: 2, stderr: "" });
    expect(JSON.parse(duplicateJson.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });
  });

  test("keeps malformed JSON-mode invocation failures machine readable", async () => {
    const answer = await runColophonCli(["demo", "--output", "--json"], context);
    expect(answer).toMatchObject({ exitCode: 2, stderr: "" });
    expect(JSON.parse(answer.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });
  });

  test("writes a non-secret receipt and next steps beside, not inside, the bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-receipt-"));
    const receipt = writeQuickstartCompanions(
      root,
      join(root, "bundle"),
      "a".repeat(64),
      ["manifest", "evidence-closure", "trust", "matrix-rederivation", "report-verification", "claim-consistency"],
      new Date("2026-08-13T12:00:00.000Z"),
      TEST_BUILD,
    );
    expect(receipt.bundleIdentity).toBe(`sha256:${"a".repeat(64)}`);
    expect(receipt.bundleFormat).toBe("benchmark-product-public-bundle/2");
    expect(receipt.sourceCommit).toBe("b".repeat(40));
    const bytes = readFileSync(join(root, "quickstart-receipt.json"), "utf8");
    expect(bytes).not.toContain("must-not-appear");
    expect(readFileSync(join(root, "NEXT-STEPS.md"), "utf8")).toContain("colophon open");
  });

  test("rejects an unqualified OS and architecture before creating the output root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "colophon-unqualified-"));
    const output = join(parent, "must-not-exist");
    const answer = await runColophonCli(["demo", "--output", output, "--no-open"], {
      ...context,
      cwd: parent,
      buildMetadata: TEST_BUILD,
      runtimeTarget: { platform: "win32", architecture: "x64" },
    });
    expect(answer.exitCode).toBe(1);
    expect(answer.stderr).toContain("not qualified for win32/x64");
    expect(answer.stderr).toContain("Supported targets: darwin/arm64, linux/x64");
    expect(answer.stderr).toContain("nothing was created");
    expect(existsSync(output)).toBe(false);
  });
});
