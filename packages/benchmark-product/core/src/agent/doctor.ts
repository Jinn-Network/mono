import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentProfile } from "./profile.js";
import { credentialGrantIsReady, readCredentialGrant } from "./store.js";
import { readRegularFileNoFollow } from "./safe-file.js";
import { observeAgentVersion, type AgentVersionCommand } from "./version.js";

export interface AgentDoctorFinding {
  readonly agentId: string;
  readonly adapter: string;
  readonly ready: boolean;
  readonly detail: string;
  readonly credential: "configured" | "missing";
  readonly executable: "ready" | "missing" | "invalid" | "mismatch";
}

/** A local-only preflight: no harness process and no provider request is made. */
export function doctorAgent(
  dataDir: string,
  profile: AgentProfile,
  options: { readonly versionCommand?: AgentVersionCommand } = {},
): AgentDoctorFinding {
  const executable = profile.executable.path;
  const credentialGrant = readCredentialGrant(dataDir, profile.agentId);
  const credential = credentialGrant !== undefined && credentialGrantIsReady(dataDir, credentialGrant)
    ? "configured" as const
    : "missing" as const;
  if (!existsSync(executable)) {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "missing", credential, detail: `${profile.adapter} executable is missing at ${executable}` };
  }
  let actual: string;
  try {
    actual = createHash("sha256").update(readRegularFileNoFollow(executable)).digest("hex");
  } catch {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "invalid", credential, detail: `${profile.adapter} executable must be a regular non-symlink file` };
  }
  if (actual !== profile.executable.sha256) {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "mismatch", credential, detail: `${profile.adapter} executable digest differs from its stored profile` };
  }
  let observedVersion: string;
  try {
    observedVersion = observeAgentVersion(profile, options.versionCommand);
  } catch {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "invalid", credential, detail: `${profile.adapter} version could not be observed safely` };
  }
  if (observedVersion !== profile.executable.version) {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "mismatch", credential, detail: `${profile.adapter} version differs from its stored profile` };
  }
  if (credential === "missing") {
    return { agentId: profile.agentId, adapter: profile.adapter, ready: false, executable: "ready", credential, detail: `${profile.adapter} has no configured credential grant; real runs may make paid provider calls` };
  }
  return { agentId: profile.agentId, adapter: profile.adapter, ready: true, executable: "ready", credential, detail: `${profile.adapter} executable identity and configured credential grant are ready; provider acceptance is not tested` };
}
