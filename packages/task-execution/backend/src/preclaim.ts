// SPDX-License-Identifier: MIT

import type { TaskExecutionBackend } from "./backend.js";
import type { BackendCapabilities } from "./capabilities.js";

export type PreclaimNotClaimedReason =
  | "profile-mismatch"
  | "unsupported-requirement"
  | "preflight-unavailable"
  | "preflight-not-ready";

export type PreclaimResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PreclaimNotClaimedReason; readonly detail?: string };

/** Venue-neutral inputs for the capability and preflight gate before a product claims work. */
export interface BackendPreclaimRequest {
  readonly taskProfile: string;
  readonly requirements: Readonly<Record<string, unknown>>;
  /** A product-selected isolation pin, when one exists outside the requirements map. */
  readonly requestedIsolationPolicy?: string;
}

function requestedInventoryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  if (typeof record.id === "string") return record.id;
  if (typeof record.kind === "string") return record.kind;
  return undefined;
}

/** Returns the first requirement key the backend's run-pinning inventory cannot honor. */
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
    if (support === undefined) return key;
    const requested = requestedInventoryValue(value);
    if (
      support.inventory.length > 0
      && !support.inventory.includes("*")
      && requested !== undefined
      && !support.inventory.includes(requested)
    ) return key;
  }
  return undefined;
}

function pinnedIsolationUnsupported(
  request: BackendPreclaimRequest,
  capabilities: BackendCapabilities,
): boolean {
  const pinned = request.requestedIsolationPolicy;
  if (pinned === undefined) return false;

  const requested = requestedInventoryValue(request.requirements["isolationPolicy"]);
  if (requested !== pinned || pinned === "*" || pinned === "unrestricted") return true;

  const support = capabilities.runPinning.keys.find(({ key }) => key === "isolationPolicy");
  return support === undefined
    || support.posture !== "enforced"
    || !support.inventory.includes(pinned)
    || !capabilities.isolation.includes(pinned);
}

/**
 * Fail-closed, policy-neutral backend capability and preflight gate. Products remain responsible
 * for deciding whether work is desirable; this helper only establishes whether the backend can
 * honor the declared execution shape before any venue claim.
 */
export async function verifyPreclaim(
  request: BackendPreclaimRequest,
  backend: TaskExecutionBackend,
  capabilities: BackendCapabilities,
): Promise<PreclaimResult> {
  if (!capabilities.taskProfiles.includes(request.taskProfile)) {
    return { ok: false, reason: "profile-mismatch" };
  }

  const unsupportedKey = validateRequirementsAgainstRunPinning(
    request.requirements,
    capabilities.runPinning,
  );
  if (unsupportedKey !== undefined) {
    return { ok: false, reason: "unsupported-requirement", detail: unsupportedKey };
  }
  if (pinnedIsolationUnsupported(request, capabilities)) {
    return { ok: false, reason: "unsupported-requirement", detail: "isolationPolicy" };
  }

  if (!capabilities.preflight || backend.preflight === undefined) {
    return { ok: false, reason: "preflight-unavailable" };
  }

  let report;
  try {
    report = await backend.preflight({
      taskProfile: request.taskProfile,
      requirements: request.requirements,
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
