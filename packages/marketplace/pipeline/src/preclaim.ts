// SPDX-License-Identifier: MIT

import type {
  BackendCapabilities,
  TaskExecutionBackend,
} from "@jinn-network/task-execution-backend";
import type { SubmissionFacts } from "./types.js";

export type PreclaimNotClaimedReason =
  | "profile-mismatch"
  | "unsupported-requirement"
  | "preflight-unavailable"
  | "preflight-not-ready";

export type PreclaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PreclaimNotClaimedReason; readonly detail?: string };

function requestedInventoryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  if (typeof record.id === "string") return record.id;
  if (typeof record.kind === "string") return record.kind;
  return undefined;
}

/**
 * Validates declared requirements against the backend's `runPinning` inventory (profiles §5.2).
 * Returns the first unsupported key, if any.
 */
export function validateRequirementsAgainstRunPinning(
  requirements: Readonly<Record<string, unknown>>,
  runPinning: BackendCapabilities["runPinning"],
): string | undefined {
  const supportByKey = new Map(
    runPinning.keys.map((support) => [support.key, support]),
  );
  for (const [key, value] of Object.entries(requirements)) {
    if (key === "maxAttemptDurationMs") continue;
    const support = supportByKey.get(key);
    if (support === undefined) {
      return key;
    }
    const requested = requestedInventoryValue(value);
    if (
      support.inventory.length > 0
      && !support.inventory.includes("*")
      && requested !== undefined
      && !support.inventory.includes(requested)
    ) {
      return key;
    }
  }
  return undefined;
}

/**
 * Fail-closed backend capability + preflight gate (design §7). Runs after operator policy
 * gates and before any venue claim.
 */
export async function verifyPreclaim(
  facts: Pick<SubmissionFacts, "profileUri" | "requirements">,
  backend: TaskExecutionBackend,
  capabilities: BackendCapabilities,
): Promise<PreclaimResult> {
  if (!capabilities.taskProfiles.includes(facts.profileUri)) {
    return { ok: false, reason: "profile-mismatch" };
  }

  const unsupportedKey = validateRequirementsAgainstRunPinning(
    facts.requirements,
    capabilities.runPinning,
  );
  if (unsupportedKey !== undefined) {
    return { ok: false, reason: "unsupported-requirement", detail: unsupportedKey };
  }

  if (!capabilities.preflight || backend.preflight === undefined) {
    return { ok: false, reason: "preflight-unavailable" };
  }

  let report;
  try {
    report = await backend.preflight({
      taskProfile: facts.profileUri,
      requirements: facts.requirements,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "preflight-not-ready",
      detail: error instanceof Error ? error.message : undefined,
    };
  }

  if (!report.ready) {
    return {
      ok: false,
      reason: "preflight-not-ready",
      detail: report.detail ?? report.error?.detail,
    };
  }

  return { ok: true };
}
