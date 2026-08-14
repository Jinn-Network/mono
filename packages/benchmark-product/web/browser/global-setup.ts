import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeAgentProfile, storeApiKeyCredential } from "@colophon-claims/core";
import { readRuntimeConfig } from "./runtime-config";
import { cleanupRuntimeWorkspace, prepareRuntimeWorkspace } from "./runtime-workspace";

function seedInertAgentProfiles(runtime: ReturnType<typeof readRuntimeConfig>): void {
  const fixtureRoot = join(runtime.agentDataDir, "browser-fixtures");
  mkdirSync(fixtureRoot, { mode: 0o700 });
  const credentialSource = join(fixtureRoot, "credential.txt");
  writeFileSync(credentialSource, runtime.credentialSecret, { mode: 0o600 });
  for (const fixture of [
    {
      agentId: "claude-low",
      adapter: "claude-code" as const,
      model: "claude-haiku-4-5-20251001",
      executableName: "claude-fixture",
      version: "1.0.0",
      versionOutput: "1.0.0 (Claude Code)",
    },
    {
      agentId: "codex-low",
      adapter: "codex" as const,
      model: "gpt-5.3-codex-mini",
      executableName: "codex-fixture",
      version: "1.0.0",
      versionOutput: "codex-cli 1.0.0",
    },
  ] as const) {
    const executable = join(fixtureRoot, fixture.executableName);
    writeFileSync(executable, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' '${fixture.versionOutput}'; else exit 97; fi\n`, { mode: 0o700 });
    chmodSync(executable, 0o700);
    storeAgentProfile(runtime.agentDataDir, {
      format: "colophon-agent/1",
      agentId: fixture.agentId,
      adapter: fixture.adapter,
      executable: {
        path: executable,
        sha256: createHash("sha256").update(readFileSync(executable)).digest("hex"),
        version: fixture.version,
      },
      model: fixture.model,
      effort: "low",
      network: "provider-required",
    });
    storeApiKeyCredential(runtime.agentDataDir, fixture.agentId, credentialSource);
  }
}

export default function globalSetup(): () => void {
  const runtime = readRuntimeConfig();
  const ownership = prepareRuntimeWorkspace(runtime);
  try {
    seedInertAgentProfiles(runtime);
  } catch (cause) {
    cleanupRuntimeWorkspace(runtime, ownership);
    throw cause;
  }
  // Playwright retains and invokes this closure during teardown. The original
  // BigInt inode identities never cross a JSON or filesystem trust boundary.
  return () => cleanupRuntimeWorkspace(runtime, ownership);
}
