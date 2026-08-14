import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorAgent } from "./doctor.js";
import { captureQualifiedSubscriptionLogin } from "./login.js";
import { profileArmPinning } from "./profile.js";
import { configuredAgentRuntimes, credentialGrantDescriptor, observeAndStoreAgentProfile, readAgentProfile, readCredentialGrant, requireQualifiedHarnessLogin, storeAgentProfile, storeApiKeyCredential, storeQualifiedLoginArtifact } from "./store.js";

let root: string;
let dataDir: string;
let executable: string;
let secretSource: string;
const secret = "fixture-provider-key-that-must-never-enter-durable-output";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "colophon-agent-"));
  dataDir = join(root, "user-data");
  executable = join(root, "codex");
  secretSource = join(root, "key.txt");
  writeFileSync(executable, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 0.1.0'; else echo codex; fi\n");
  chmodSync(executable, 0o700);
  writeFileSync(secretSource, `${secret}\n`, { mode: 0o600 });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function profile() {
  return {
    format: "colophon-agent/1",
    agentId: "codex-main",
    adapter: "codex",
    executable: {
      path: executable,
      sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
      version: "0.1.0",
    },
    model: "gpt-5.6",
    effort: "high",
    network: "provider-required",
  } as const;
}

describe("machine-local agent profiles", () => {
  it("guided setup resolves a Codex npm shim to the native binary it actually launches", () => {
    const packageRoot = join(root, "node_modules", "@openai", "codex");
    const shim = join(packageRoot, "bin", "codex.js");
    const native = join(packageRoot, "node_modules", "@openai", "codex-darwin-arm64", "vendor", "aarch64-apple-darwin", "bin", "codex");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    mkdirSync(join(native, ".."), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.147.0" }));
    writeFileSync(shim, "#!/usr/bin/env node\n// Unified entry point for Codex CLI.\n", { mode: 0o700 });
    writeFileSync(native, "#!/bin/sh\necho 'codex-cli 0.147.0'\n", { mode: 0o700 });
    chmodSync(shim, 0o700);
    chmodSync(native, 0o700);

    const stored = observeAndStoreAgentProfile(dataDir, {
      agentId: "codex-subscription",
      adapter: "codex",
      model: "gpt-5.3-codex-mini",
      effort: "low",
      executable: shim,
    }, { platform: "darwin", arch: "arm64" });
    expect(stored.executable).toEqual({
      path: realpathSync(native),
      version: "0.147.0",
      sha256: createHash("sha256").update(readFileSync(native)).digest("hex"),
    });
    expect(profileArmPinning(stored)).toMatchObject({ harness: { digest: stored.executable.sha256 } });
  });

  it("guided setup refuses drifting model aliases", () => {
    expect(() => observeAndStoreAgentProfile(dataDir, {
      agentId: "claude-alias",
      adapter: "claude-code",
      model: "sonnet",
      effort: "low",
      executable,
    })).toThrow(/exact provider model identifier/u);
  });

  it("captures a qualified Claude subscription token only inside owned temporary storage", () => {
    const temporaryBase = join(root, "login-tmp");
    mkdirSync(temporaryBase, { mode: 0o700 });
    const qualified = {
      ...profile(),
      agentId: "claude-subscription",
      adapter: "claude-code" as const,
      executable: {
        path: executable,
        version: "2.1.222",
        sha256: "c66a6cc6fa2e8145bb1a6e77831f2caf4b83690ff04650500dfa6e2c05ca997c",
      },
      model: "claude-haiku-4-5-20251001",
      effort: "low" as const,
    };
    const grant = captureQualifiedSubscriptionLogin(dataDir, qualified, {
      temporaryBase,
      validateExecutable() {},
      runner(invocation) {
        expect(invocation.args).toEqual(["setup-token"]);
        expect(invocation.captureStdout).toBe(true);
        expect(invocation.env.HOME).toContain("colophon-subscription-login-");
        expect(invocation.env.CLAUDE_CONFIG_DIR).toContain("colophon-subscription-login-");
        return { status: 0, stdout: "created sk-ant-oat01-fixture_subscription_token_1234567890\n" };
      },
    });
    expect(grant).toMatchObject({ agentId: "claude-subscription", kind: "credential-artifact" });
    expect(readFileSync(credentialGrantDescriptor(dataDir, grant).file, "utf8")).toBe("sk-ant-oat01-fixture_subscription_token_1234567890");
    expect(readdirSync(temporaryBase)).toEqual([]);
  });

  it("accepts only auth.json from an isolated qualified Codex device login", () => {
    const temporaryBase = join(root, "codex-login-tmp");
    mkdirSync(temporaryBase, { mode: 0o700 });
    const qualified = {
      ...profile(),
      agentId: "codex-subscription",
      executable: {
        path: executable,
        version: "0.147.0",
        sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
      },
      model: "gpt-5.3-codex-mini",
      effort: "low" as const,
    };
    const grant = captureQualifiedSubscriptionLogin(dataDir, qualified, {
      temporaryBase,
      validateExecutable() {},
      runner(invocation) {
        expect(invocation.args).toEqual(["login", "--device-auth"]);
        expect(invocation.captureStdout).toBe(false);
        writeFileSync(join(invocation.env.CODEX_HOME!, "auth.json"), JSON.stringify({ tokens: { access_token: "private" } }), { mode: 0o600 });
        return { status: 0, stdout: "" };
      },
    });
    expect(grant).toMatchObject({ agentId: "codex-subscription", kind: "credential-artifact" });
    expect(readdirSync(temporaryBase)).toEqual([]);
  });

  it("refuses and cleans a Codex device login that writes any unqualified extra file", () => {
    const temporaryBase = join(root, "codex-login-extra-tmp");
    mkdirSync(temporaryBase, { mode: 0o700 });
    const qualified = {
      ...profile(),
      executable: {
        path: executable,
        version: "0.147.0",
        sha256: "19c4f144c5226a9f17c58e6f0fa854843b0f77a6eb420f40e2745a12f10f5d37",
      },
      model: "gpt-5.3-codex-mini",
      effort: "low" as const,
    };
    expect(() => captureQualifiedSubscriptionLogin(dataDir, qualified, {
      temporaryBase,
      validateExecutable() {},
      runner(invocation) {
        writeFileSync(join(invocation.env.CODEX_HOME!, "auth.json"), "{}", { mode: 0o600 });
        writeFileSync(join(invocation.env.CODEX_HOME!, "config.toml"), "unexpected", { mode: 0o600 });
        return { status: 0, stdout: "" };
      },
    })).toThrow(/files other than/u);
    expect(readdirSync(temporaryBase)).toEqual([]);
  });

  it("stores strict profiles outside the workspace and compiles only identity evidence into an arm", () => {
    const stored = storeAgentProfile(dataDir, profile());
    expect(readAgentProfile(dataDir, "codex-main")).toEqual(stored);
    const pinning = JSON.stringify(profileArmPinning(stored));
    expect(pinning).toContain(stored.executable.sha256);
    expect(pinning).not.toContain(executable);
    expect(pinning).not.toContain("credential");
    expect(pinning).not.toContain("colophon-agent-profile");
    expect(() => storeAgentProfile(dataDir, { ...profile(), credential: { secret } })).toThrow();
  });

  it("copies only the explicitly supplied key into a 0700 Colophon secret boundary and leaves durable records value-free", () => {
    storeAgentProfile(dataDir, profile());
    const grant = storeApiKeyCredential(dataDir, "codex-main", secretSource);
    const descriptor = credentialGrantDescriptor(dataDir, grant);
    expect(readCredentialGrant(dataDir, "codex-main")).toEqual(grant);
    expect(readFileSync(descriptor.file, "utf8")).toBe(`${secret}\n`);
    expect(statSync(join(dataDir, "secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(descriptor.file).mode & 0o777).toBe(0o600);
    const durable = `${readFileSync(join(dataDir, "agents", "codex-main.json"), "utf8")}${readFileSync(join(dataDir, "credentials", "codex-main.json"), "utf8")}${JSON.stringify(profileArmPinning(profile()))}`;
    expect(durable).not.toContain(secret);
    expect(durable).not.toContain(secretSource);
  });

  it("fails closed instead of copying a normal harness home or pretending that a provider login succeeded", () => {
    const stored = storeAgentProfile(dataDir, profile());
    expect(() => requireQualifiedHarnessLogin(stored)).toThrow(/not qualified/i);
    expect(readCredentialGrant(dataDir, "codex-main")).toBeUndefined();
  });

  it("keeps the credential-artifact seam closed for an executable outside the qualification table", () => {
    const stored = storeAgentProfile(dataDir, profile());
    expect(() => storeQualifiedLoginArtifact(dataDir, stored, secretSource)).toThrow(/not qualified/i);

    // A machine-local document manufactured outside the API is also ignored at runtime.
    mkdirSync(join(dataDir, "secrets"), { recursive: true, mode: 0o700 });
    mkdirSync(join(dataDir, "credentials"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dataDir, "secrets", "codex-main.login-artifact"), `${secret}\n`, { mode: 0o600 });
    writeFileSync(join(dataDir, "credentials", "codex-main.json"), JSON.stringify({
      format: "colophon-agent-credential/1",
      agentId: "codex-main",
      kind: "credential-artifact",
      secretBasename: "codex-main.login-artifact",
    }), { mode: 0o600 });
    expect(configuredAgentRuntimes(dataDir)).toEqual([]);
  });

  it("refuses a caller-asserted version that the adapter does not report", () => {
    expect(() => storeAgentProfile(dataDir, {
      ...profile(),
      executable: { ...profile().executable, version: "999.0.0" },
    })).toThrow(/observed 0\.1\.0/i);
  });

  it("does not follow a symlink when importing a credential", () => {
    storeAgentProfile(dataDir, profile());
    const linked = join(root, "linked-key");
    symlinkSync(secretSource, linked);
    expect(() => storeApiKeyCredential(dataDir, "codex-main", linked)).toThrow();
  });

  it("doctor is local-only and distinguishes configured from provider-accepted", () => {
    const stored = storeAgentProfile(dataDir, profile());
    expect(doctorAgent(dataDir, stored)).toMatchObject({ ready: false, credential: "missing" });
    storeApiKeyCredential(dataDir, "codex-main", secretSource);
    expect(doctorAgent(dataDir, stored)).toMatchObject({
      ready: true,
      executable: "ready",
      credential: "configured",
      detail: expect.stringContaining("provider acceptance is not tested"),
    });
  });
});
