import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnShim } from "./shim.js";

const roots: string[] = [];
const wrapper = new URL("./credential-exec.mjs", import.meta.url).pathname;

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jinn-credential-exec-"));
  roots.push(root);
  const paths = {
    root,
    work: join(root, "work"),
    secrets: join(root, "secrets"),
    tmp: join(root, "tmp"),
    meta: join(root, "meta"),
  };
  const receipt = join(root, "receipt.json");
  for (const directory of Object.values(paths).filter((path) => path !== root)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const fake = join(root, "fake-harness.mjs");
  writeFileSync(fake, [
    'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const home = process.env.CODEX_HOME;',
    'writeFileSync(process.env.RECEIPT, JSON.stringify({',
    '  secret: [process.env.ANTHROPIC_API_KEY, process.env.OPENAI_API_KEY, process.env.CLAUDE_CODE_OAUTH_TOKEN].includes(process.env.EXPECTED_SECRET),',
    '  controlsRemoved: process.env.JINN_CODEX_AUTH_JSON === undefined && process.env.JINN_ATTEMPT_SECRETS === undefined,',
    '  codexArtifact: home !== undefined && existsSync(join(home, "auth.json")) && readFileSync(join(home, "auth.json"), "utf8") === process.env.EXPECTED_ARTIFACT,',
    '  codexHome: home,',
    '}));',
    'process.exit(Number(process.env.FAKE_EXIT ?? "0"));',
  ].join("\n"));
  return { root, paths, fake, receipt };
}

function run(fake: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [wrapper, "--", process.execPath, fake], { env: { ...process.env, ...env }, encoding: "utf8" });
}

async function runThroughShim(paths: { work: string; secrets: string; meta: string }, fake: string, env: Record<string, string>) {
  const outcome = join(paths.meta, "outcome.json");
  spawnShim(
    { attemptId: "credential-review", nonce: "credential-review", metaDir: paths.meta, secretsDir: paths.secrets },
    { argv: [process.execPath, wrapper, "--", process.execPath, fake], env, cwd: paths.work },
  );
  for (let index = 0; index < 250 && !existsSync(outcome); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!existsSync(outcome)) throw new Error("shim did not record a credential-bridge outcome");
  return (JSON.parse(readFileSync(outcome, "utf8")) as { exitCode: number | null }).exitCode;
}

describe("supervisor credential execution bridge", () => {
  it("materializes API-key and OAuth references only for the child", () => {
    const { paths, fake, receipt } = fixture();
    writeFileSync(join(paths.secrets, "credential"), "value-not-in-plan\n", { mode: 0o600 });
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const) {
      const result = run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, [key]: "secrets/credential", EXPECTED_SECRET: "value-not-in-plan", RECEIPT: receipt });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ secret: true, controlsRemoved: true });
    }
  });

  it("uses a terminal-wiped temporary Codex home", () => {
    const { paths, fake, receipt } = fixture();
    const artifact = '{"tokens":{"access_token":"artifact-value"}}';
    writeFileSync(join(paths.secrets, "codex-login"), artifact, { mode: 0o600 });
    const result = run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, JINN_CODEX_AUTH_JSON: "secrets/codex-login", EXPECTED_ARTIFACT: artifact, RECEIPT: receipt });
    expect(result.status, String(result.stderr)).toBe(0);
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ codexArtifact: true, controlsRemoved: true });
    expect(existsSync(join(paths.tmp, "jinn-codex-local-login"))).toBe(false);
  });

  it("composes shim path resolution with value materialization", async () => {
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
    expect(JSON.parse(readFileSync(receipt, "utf8"))).toMatchObject({ secret: true, controlsRemoved: true });
  });

  it("fails closed on executable replacement and secret-root escape", () => {
    const { root, paths, fake, receipt } = fixture();
    const executable = join(root, "replaceable-harness");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o700);
    const pinnedDigest = createHash("sha256").update(readFileSync(executable)).digest("hex");
    writeFileSync(executable, `#!/bin/sh\nprintf reached > ${JSON.stringify(receipt)}\n`);
    chmodSync(executable, 0o700);
    expect(spawnSync(process.execPath, [wrapper, "--", executable], { env: { ...process.env, JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, JINN_HARNESS_PIN_DIGEST: pinnedDigest } }).status).toBe(126);

    const outside = join(root, "outside-secret");
    writeFileSync(outside, "must-not-forward", { mode: 0o600 });
    expect(run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, OPENAI_API_KEY: outside, RECEIPT: receipt }).status).toBe(126);
    expect(existsSync(receipt)).toBe(false);
  });

  it("forwards child exit and termination", async () => {
    const { paths, fake, receipt } = fixture();
    expect(run(fake, { JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp, RECEIPT: receipt, FAKE_EXIT: "23" }).status).toBe(23);
    const child = spawn(process.execPath, [wrapper, "--", process.execPath, "-e", "setInterval(() => {}, 1000)"], { env: { ...process.env, JINN_ATTEMPT_SECRETS: paths.secrets, TMPDIR: paths.tmp }, stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 80));
    child.kill("SIGTERM");
    const signal = await new Promise<string | null>((resolve) => child.once("exit", (_code, exited) => resolve(exited)));
    expect(signal).toBe("SIGTERM");
  });
});
