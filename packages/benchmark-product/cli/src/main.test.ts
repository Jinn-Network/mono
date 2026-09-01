import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUALIFIED_HARNESS_LOGIN_ARTIFACTS } from "@colophon-claims/core";
import { describe, expect, test } from "vitest";
import { BUILD_METADATA_KIND, DEFAULT_QUALIFIED_TARGETS, type ColophonBuildMetadata } from "./build-metadata.js";
import { browserCommand, runColophonCli, writeQuickstartCompanions } from "./main.js";

const TEST_BUILD: ColophonBuildMetadata = {
  kind: BUILD_METADATA_KIND,
  packageVersion: "0.1.0",
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

  test("forwards method --help and help method to core verb help", async () => {
    const methodHelp = await runColophonCli(["method", "--help"], context);
    expect(methodHelp.exitCode).toBe(0);
    expect(methodHelp.stdout).toContain("terminal-bench-2.1");
    expect(methodHelp.stdout).toContain("--host");
    expect(methodHelp.stdout).not.toContain("colophon demo");

    const helpMethod = await runColophonCli(["help", "method"], context);
    expect(helpMethod.exitCode).toBe(0);
    expect(helpMethod.stdout).toContain("terminal-bench-2.1");
    expect(helpMethod.stdout).toContain("homemade");

    const helpMethodFlag = await runColophonCli(["help", "method", "--help"], context);
    expect(helpMethodFlag.exitCode).toBe(0);
    expect(helpMethodFlag.stdout).toContain("terminal-bench-2.1");
    expect(helpMethodFlag.stdout).not.toContain("colophon demo");
  });

  test("bare --help stays the primary install surface", async () => {
    const answer = await runColophonCli(["--help"], context);
    expect(answer.exitCode).toBe(0);
    expect(answer.stdout).toContain("colophon demo");
    expect(answer.stdout).not.toContain("terminal-bench-2.1");
  });

  test("keeps malformed JSON-mode invocation failures machine readable", async () => {
    const answer = await runColophonCli(["demo", "--output", "--json"], context);
    expect(answer).toMatchObject({ exitCode: 2, stderr: "" });
    expect(JSON.parse(answer.stdout)).toMatchObject({ ok: false, error: { code: "invalid-invocation" } });
  });

  test("forwards subscription login only from an interactive public CLI terminal", async () => {
    const root = mkdtempSync(join(tmpdir(), "colophon-public-login-"));
    const agents = join(root, "agents");
    mkdirSync(agents, { recursive: true });
    const qualification = QUALIFIED_HARNESS_LOGIN_ARTIFACTS[0]!;
    writeFileSync(join(agents, "qualified.json"), JSON.stringify({
      format: "colophon-agent/1",
      agentId: "qualified",
      adapter: qualification.adapter,
      executable: {
        path: "/qualified/harness",
        sha256: qualification.executableSha256,
        version: qualification.executableVersion,
      },
      model: "provider-model-exact",
      effort: "low",
      network: "provider-required",
    }));
    let captures = 0;
    const subscriptionLogin = async () => {
      captures += 1;
      return {
        format: "colophon-agent-credential/1" as const,
        agentId: "qualified",
        kind: "credential-artifact" as const,
        secretBasename: "qualified.login-artifact",
      };
    };

    const refused = await runColophonCli(["agent", "login", "--agent", "qualified"], {
      ...context,
      agentDataDir: root,
      subscriptionLogin,
    });
    expect(refused.exitCode).toBe(2);
    expect(captures).toBe(0);

    const accepted = await runColophonCli(["agent", "login", "--agent", "qualified"], {
      ...context,
      interactive: true,
      agentDataDir: root,
      subscriptionLogin,
    });
    expect(accepted.exitCode).toBe(0);
    expect(captures).toBe(1);
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

  // `publication serve` is the one verb the wrapper cannot serve by forwarding flags alone: it
  // runs until interrupted, so it refuses unless the context carries a way to signal shutdown.
  // The runbook documents `colophon publication serve`, and this binary is what that name runs.
  test("forwards the shutdown-signal factory so the documented publication serve verb runs", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "colophon-publication-serve-"));
    const argv = ["publication", "serve", "--workspace", ".", "--principal", "sponsor-1", "--port", "0"];

    const served = await runColophonCli(argv, {
      ...context,
      cwd: workspaceDir,
      createShutdownSignal: () => AbortSignal.abort(),
    });
    expect(served.exitCode).toBe(0);
    expect(served.stdout).toMatch(/^served http:\/\/127\.0\.0\.1:\d+ until shutdown; /);

    // Without one the verb must refuse rather than bind a socket the process cannot stop -- which
    // is exactly what the shipped binary did before it supplied the factory.
    const refused = await runColophonCli(argv, { ...context, cwd: workspaceDir });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/signal shutdown/);
  });
});
