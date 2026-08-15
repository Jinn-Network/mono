import {
  AGENT_ADAPTERS,
  doctorAgent,
  listAgentProfiles,
  profileMatchesArmPinning,
  type AgentAdapter,
  type AgentDoctorFinding,
} from "../agent/index.js";

export interface AgentRuntimeReadinessRequest {
  readonly armId: string;
  readonly pinning: Readonly<Record<string, unknown>>;
}

export type AgentRuntimeReadinessCode =
  | "agent-data-unavailable"
  | "profile-missing"
  | "profile-invalid"
  | "executable-not-ready"
  | "credential-missing"
  | "ready";

/** Safe to render in the browser: no executable or credential paths are included. */
export interface AgentRuntimeReadiness {
  readonly armId: string;
  readonly adapter: AgentAdapter;
  readonly agentId?: string;
  readonly ready: boolean;
  readonly code: AgentRuntimeReadinessCode;
  readonly detail: string;
  readonly remediation?: string;
}

function requestedAdapter(pinning: Readonly<Record<string, unknown>>): AgentAdapter | undefined {
  const harness = pinning.harness;
  const id = typeof harness === "string"
    ? harness
    : typeof harness === "object" && harness !== null && !Array.isArray(harness)
      ? (harness as Readonly<Record<string, unknown>>).id
      : undefined;
  return AGENT_ADAPTERS.find((adapter) => adapter === id);
}

function executableRemediation(adapter: AgentAdapter): string {
  return `Re-observe ${adapter} with colophon agent add --agent <id> --adapter ${adapter} --model <exact-model-id> --effort low.`;
}

function projectDoctorFinding(
  armId: string,
  adapter: AgentAdapter,
  finding: AgentDoctorFinding,
): AgentRuntimeReadiness {
  if (finding.ready) {
    return {
      armId,
      adapter,
      agentId: finding.agentId,
      ready: true,
      code: "ready",
      detail: `${adapter} is ready for local preflight; provider acceptance is not tested.`,
    };
  }
  if (finding.executable !== "ready") {
    return {
      armId,
      adapter,
      agentId: finding.agentId,
      ready: false,
      code: "executable-not-ready",
      detail: `${adapter} no longer matches the executable identity recorded in its Colophon profile.`,
      remediation: executableRemediation(adapter),
    };
  }
  if (finding.credential === "missing") {
    return {
      armId,
      adapter,
      agentId: finding.agentId,
      ready: false,
      code: "credential-missing",
      detail: `${adapter} has no usable Colophon credential grant. A real run may make paid provider calls.`,
      remediation: `Run colophon agent login --agent ${finding.agentId} for a qualified subscription build, or explicitly import an API key file.`,
    };
  }
  throw new Error("unreachable agent doctor state");
}

/**
 * Checks only the two real provider-backed harnesses owned by the v1 self-serve seam. Sample and
 * third-party arms remain the venue's responsibility. The check is local: it starts no harness
 * and makes no provider request.
 */
export function assessAgentRuntimeReadiness(
  agentDataDir: string | undefined,
  requests: readonly AgentRuntimeReadinessRequest[],
): readonly AgentRuntimeReadiness[] {
  return requests.flatMap((request): readonly AgentRuntimeReadiness[] => {
    const adapter = requestedAdapter(request.pinning);
    if (adapter === undefined) return [];
    if (agentDataDir === undefined) {
      return [{
        armId: request.armId,
        adapter,
        ready: false,
        code: "agent-data-unavailable",
        detail: "This Colophon process has no private agent-data directory configured.",
        remediation: "Restart Colophon from its packaged local launcher and configure the agent there.",
      }];
    }

    let profiles;
    try {
      profiles = listAgentProfiles(agentDataDir).filter((profile) =>
        profileMatchesArmPinning(profile, request.pinning));
    } catch {
      return [{
        armId: request.armId,
        adapter,
        ready: false,
        code: "profile-invalid",
        detail: "Colophon could not validate its machine-local agent profiles.",
        remediation: executableRemediation(adapter),
      }];
    }
    if (profiles.length === 0) {
      return [{
        armId: request.armId,
        adapter,
        ready: false,
        code: "profile-missing",
        detail: `No configured ${adapter} profile matches this arm's exact harness, model, effort, and executable digest.`,
        remediation: `Add the exact profile with colophon agent add --agent <id> --adapter ${adapter} --model <exact-model-id> --effort low, then select it again.`,
      }];
    }

    const findings = profiles.map((profile) => {
      try {
        return projectDoctorFinding(request.armId, adapter, doctorAgent(agentDataDir, profile));
      } catch {
        return {
          armId: request.armId,
          adapter,
          agentId: profile.agentId,
          ready: false,
          code: "profile-invalid",
          detail: `Colophon could not validate the configured ${adapter} profile.`,
          remediation: executableRemediation(adapter),
        } satisfies AgentRuntimeReadiness;
      }
    });
    return findings.some((finding) => finding.ready)
      ? [findings.find((finding) => finding.ready)!]
      : [findings[0]!];
  });
}
