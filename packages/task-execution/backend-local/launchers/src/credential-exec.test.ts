import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeClaudeCodeLauncher } from "./claude-code.js";
import { makeCodexLauncher } from "./codex.js";
import { spawnShim, type AttemptIdentity } from "@jinn-network/task-execution-supervisor";
import type { TaskView, WorkspacePaths } from "@jinn-network/task-execution-workspace";

const view = { task: { instructions: "do the work", outputs: [] }, effectiveRequirements: {}, profile: { profile: "https://spec.jinn.network/task-profiles/repository-work/1.0" } } as unknown as TaskView;
const attempt = { attemptUri: "urn:uuid:00000000-0000-0000-0000-000000000001", nonce: "n", attemptNumber: 1 } as AttemptIdentity;
const roots: string[] = [];
const wrapper = new URL("./credential-exec.mjs", import.meta.url).pathname;

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture(): { root: string; paths: WorkspacePaths; fake: string; receipt: string } {
  const root = mkdtempSync(join(tmpdir(), "jinn-credential-exec-"));
  roots.push(root);
  const secrets = join(root, "secrets");
  const tmp = join(root, "tmp");
  const receipt = join(root, "receipt.json");
  for (const directory of [secrets, tmp, join(root, "work"), join(root, "harness"), join(root, "meta")]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const fake = join(root, "fake-harness.mjs");
  writeFileSync(fake, [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const expected = process.env.EXPECTED_SECRET;',
    'const expectedArtifact = process.env.EXPECTED_ARTIFACT;',
    'const home = process.env.CODEX_HOME;',
    'writeFileSync(process.env.RECEIPT, JSON.stringify({',
    '  anthropic: process.env.ANTHROPIC_API_KEY === expected,',
    '  openai: process.env.OPENAI_API_KEY === expected,',
    '  oauth: process.env.CLAUDE_CODE_OAUTH_TOKEN === expected,',
    '  controlsRemoved: process.env.JINN_CODEX_AUTH_JSON === undefined && process.env.JINN_ATTEMPT_SECRETS === undefined,',
    '  codexArtifact: home !== undefined && existsSync(join(home, "auth.json")) && readFileSync(join(home, "auth.json"), "utf8") === expectedArtifact,',
    '  codexHome: home,',
    '}));',
    'process.exit(Number(process.env.FAKE_EXIT ?? "0"));',
  ].join("\n"));
  return {
    root,
    paths: { root, input: join(root, "input"), work: join(root, "work"), out: join(root, "out"), logs: join(root, "logs"), harnessState: join(root, "harness"), secrets, tmp, meta: join(root, "meta") },
    fake,
    receipt,
  };
}

function run(fake: string, env: Record<string, string>): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [wrapper, "--", process.execPath, fake], { env: { ...process.env, ...env }, encoding: "utf8" });
}

async function runThroughShim(paths: WorkspacePaths, fake: string, env: Record<string, string>): Promise<number | null> {
  const outcome = join(paths.meta, "outcome.json");
  spawnShim(
    { attemptId: "credential-review", nonce: "credential-review", metaDir: paths.meta, secretsDir: paths.secrets },
    {
      argv: [process.execPath, wrapper, "--", process.execPath, fake],
      env,
      cwd: paths.work,
    },
  );
  for (let index = 0; index < 250 && !existsSync(outcome); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(outcome)) throw new Error("shim did not record a credential-bridge outcome");
  return (JSON.parse(readFileSync(outcome, "utf8")) as { exitCode: number | null }).exitCode;
}

describe("credential-qualified Claude Code and Codex launchers", () => {
  it("keeps the default plans zero-forward and unchanged by the opt-in seam", () => {
    const paths = fixture().paths;
    const claude = makeClaudeCodeLauncher().plan(view, paths, attempt);
    const codex = makeCodexLauncher().plan(view, paths, attempt);
    expect(claude.secretForwards).toEqual([]);
    expect(codex.secretForwards).toEqual([]);
    expect(claude.argv).toEqual(["claude", "--setting-sources", "project", "--permission-mode", "bypassPermissions", "--verbose", "--output-format", "stream-json", "--include-hook-events", "-p", view.task.instructions]);
    expect(codex.argv).toEqual(["codex", "exec", "--json", "--ignore-user-config", "--disable", "plugins", "--sandbox", "danger-full-access", "--dangerously-bypass-approvals-and-sandbox", "-C", paths.work, view.task.instructions]);
    expect(claude.env).not.toHaveProperty("JINN_ATTEMPT_SECRETS");
    expect(codex.env).not.toHaveProperty("JINN_ATTEMPT_SECRETS");
  });

  it("plans refs only and declares exactly the configured API-key capability", () => {
    const paths = fixture().paths;
    const secret = "not-in-plan-very-secret";
    const claude = makeClaudeCodeLauncher({ credential: { kind: "api-key", secretBasename: "claude-api" } });
    const codex = makeCodexLauncher({ credential: { kind: "api-key", secretBasename: "openai-api" } });
    for (const [launcher, ref, env] of [
      [claude, "secrets/claude-api", "ANTHROPIC_API_KEY"],
      [codex, "secrets/openai-api", "OPENAI_API_KEY"],
    ] as const) {
      const plan = launcher.plan(view, paths, attempt);
      expect(launcher.capabilities().secretForwards).toEqual(plan.secretForwards);
      expect(plan.secretForwards).toEqual([{ grantKey: ref.slice("secrets/".length), target: ref.slice("secrets/".length) }]);
      expect(plan.env[env]).toBe(ref);
      expect(JSON.stringify(plan)).not.toContain(secret);
      expect(plan.argv.join(" ")).not.toContain(secret);
    }
    expect(claude.plan(view, paths, attempt).argv).toContain("--bare");
    expect(codex.plan(view, paths, attempt).argv).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-rules"]));
  });

  it("uses a host-owned opaque handle rather than a requester capability grant", () => {
    const paths = fixture().paths;
    for (const [launcher, env] of [
      [makeClaudeCodeLauncher({ hostCredential: { kind: "api-key", secretBasename: "claude-api", handle: "agent-claude" } }), "ANTHROPIC_API_KEY"],
      [makeCodexLauncher({ hostCredential: { kind: "api-key", secretBasename: "codex-api", handle: "agent-codex" } }), "OPENAI_API_KEY"],
    ] as const) {
      const plan = launcher.plan(view, paths, attempt);
      expect(plan.secretForwards).toEqual([]);
      expect(plan.hostSecretForwards).toEqual([{ handle: expect.stringMatching(/^agent-/), target: expect.any(String), role: "harness" }]);
      expect(plan.env[env]).toMatch(/^secrets\/[A-Za-z0-9._-]+$/);
      expect(JSON.stringify(plan)).not.toContain("not-in-plan-very-secret");
    }
  });

  it("rejects an escaping credential target before planning", () => {
    const paths = fixture().paths;
    expect(() => makeClaudeCodeLauncher({ credential: { kind: "api-key", secretBasename: "../host-key" } }).plan(view, paths, attempt)).toThrow("portable basename");
    expect(() => makeCodexLauncher({ credential: { kind: "credential-artifact", secretBasename: "secrets/auth.json" } }).plan(view, paths, attempt)).toThrow("portable basename");
  });

  it("pins an explicit deployment executable instead of rediscovering one through PATH", () => {
    const { paths, fake } = fixture();
    const plan = makeCodexLauncher({ executablePath: fake }).plan(view, paths, attempt);
    expect(plan.argv[0]).toBe(fake);
    expect(() => makeClaudeCodeLauncher({ executablePath: "relative/claude" }).plan(view, paths, attempt)).toThrow("must be absolute");
  });

  it("gives a child the resolved API and OAuth values only at exec time", () => {
    const { paths, fake, receipt } = fixture();
    writeFileSync(join(paths.secrets, "credential"), "value-not-in-plan\n", { mode: 0o600 });
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
      const result = run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, [key]: "secrets/credential", EXPECTED_SECRET: "value-not-in-plan", RECEIPT: receipt });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8"))[key === "ANTHROPIC_API_KEY" ? "anthropic" : key === "OPENAI_API_KEY" ? "openai" : "oauth"]).toBe(true);
      expect(readFileSync(receipt, "utf8")).not.toContain("value-not-in-plan");
    }
  });

  it("uses a terminal-wiped temporary Codex home for a login artifact", () => {
    const { paths, fake, receipt } = fixture();
    const normalHome = join(paths.root, "normal-host-codex-home");
    mkdirSync(normalHome);
    writeFileSync(join(normalHome, "auth.json"), "host-login-must-not-be-read");
    writeFileSync(join(paths.secrets, "codex-login"), "{\"tokens\":{\"access_token\":\"artifact-value\"}}", { mode: 0o600 });
    const result = run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, CODEX_HOME: normalHome, JINN_CODEX_AUTH_JSON: "secrets/codex-login", EXPECTED_ARTIFACT: "{\"tokens\":{\"access_token\":\"artifact-value\"}}", RECEIPT: receipt });
    expect(result.status, String(result.stderr)).toBe(0);
    const observed = JSON.parse(readFileSync(receipt, "utf8"));
    expect(observed.codexArtifact).toBe(true);
    expect(observed.codexHome).toBe(join(paths.tmp, "jinn-codex-local-login"));
    expect(existsSync(join(paths.tmp, "jinn-codex-local-login"))).toBe(false);
    expect(readFileSync(join(normalHome, "auth.json"), "utf8")).toBe("host-login-must-not-be-read");
    expect(readFileSync(receipt, "utf8")).not.toContain("artifact-value");
  });

  it("composes supervisor path resolution with API-key value materialization", async () => {
    const { paths, fake, receipt } = fixture();
    writeFileSync(join(paths.secrets, "credential"), "shim-resolved-value\n", { mode: 0o600 });
    const exitCode = await runThroughShim(paths, fake, {
      JINN_ATTEMPT_SECRETS: paths.secrets,
      TMPDIR: paths.tmp,
      OPENAI_API_KEY: "secrets/credential",
      EXPECTED_SECRET: "shim-resolved-value",
      RECEIPT: receipt,
      JINN_HARNESS_PIN_DIGEST: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ openai: true, controlsRemoved: true });
  });

  it("composes supervisor path resolution with a terminal-wiped Codex login artifact", async () => {
    const { paths, fake, receipt } = fixture();
    const artifact = "{\"tokens\":{\"access_token\":\"shim-artifact\"}}";
    writeFileSync(join(paths.secrets, "codex-login"), artifact, { mode: 0o600 });
    const exitCode = await runThroughShim(paths, fake, {
      JINN_ATTEMPT_SECRETS: paths.secrets,
      TMPDIR: paths.tmp,
      JINN_CODEX_AUTH_JSON: "secrets/codex-login",
      EXPECTED_ARTIFACT: artifact,
      RECEIPT: receipt,
      JINN_HARNESS_PIN_DIGEST: createHash("sha256").update(readFileSync(process.execPath)).digest("hex"),
    });
    expect(exitCode).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ codexArtifact: true, controlsRemoved: true });
    expect(existsSync(join(paths.tmp, "jinn-codex-local-login"))).toBe(false);
  });

  it("fails closed when the executable digest changes before the bridge spawns it", () => {
    const { paths, receipt } = fixture();
    const executable = join(paths.root, "replaceable-harness");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const pinnedDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
    writeFileSync(executable, `#!/bin/sh\nprintf reached > ${JSON.stringify(receipt)}\n`);
    chmodSync(executable, 0o700);
    const result = spawnSync(process.execPath, [wrapper, "--", executable], { env: {
      ...process.env,
      JINN_ATTEMPT_SECRETS: paths.secrets,
      TMPDIR: paths.tmp,
      JINN_HARNESS_PIN_DIGEST: pinnedDigest,
    }, encoding: "utf8" });
    expect(result.status).toBe(126);
    expect(existsSync(receipt)).toBe(false);
  });

  it("rejects an absolute credential path outside the real attempt secrets root", () => {
    const { root, paths, fake, receipt } = fixture();
    const outside = join(root, "outside-secret");
    writeFileSync(outside, "must-not-forward", { mode: 0o600 });
    const result = run(fake, {
      JINN_ATTEMPT_SECRETS: paths.secrets,
      TMPDIR: paths.tmp,
      OPENAI_API_KEY: outside,
      RECEIPT: receipt,
    });
    expect(result.status).toBe(126);
    expect(existsSync(receipt)).toBe(false);
  });

  it("forwards the child exit code and termination signal", async () => {
    const { paths, fake, receipt } = fixture();
    writeFileSync(join(paths.secrets, "credential"), "value\n");
    expect(run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, ANTHROPIC_API_KEY: "secrets/credential", EXPECTED_SECRET: "value", RECEIPT: receipt, FAKE_EXIT: "23" }).status).toBe(23);

    const child = spawn(process.execPath, [wrapper, "--", process.execPath, "-e", "setInterval(() => {}, 1000)", fake], { env: { ...process.env, JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp }, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    child.kill("SIGTERM");
    const signal = await new Promise<string | null>((resolve) => child.once("exit", (_code, exited) => resolve(exited)));
    expect(signal).toBe("SIGTERM");
  });
});
