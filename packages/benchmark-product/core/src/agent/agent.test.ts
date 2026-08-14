import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { doctorAgent } from "./doctor.js";
import { profileArmPinning } from "./profile.js";
import { configuredAgentRuntimes, credentialGrantDescriptor, readAgentProfile, readCredentialGrant, requireQualifiedHarnessLogin, storeAgentProfile, storeApiKeyCredential, storeQualifiedLoginArtifact } from "./store.js";

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

  it("keeps the credential-artifact seam closed while the internal qualification table is empty", () => {
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
