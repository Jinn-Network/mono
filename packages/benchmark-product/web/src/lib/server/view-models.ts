import "server-only";

import {
  armList,
  authorityShow,
  doctorAgent,
  getDraft,
  inspectDraft,
  listAgentProfiles,
  listDrafts,
  runStatus,
  runResults,
  publicationStatus,
  type OperationResult,
  type AgentRuntimeReadinessCode,
  type RunStatusResult,
} from "@colophon-claims/core";
import { projectProductErrorForGui } from "./gui-error";
import {
  createProductOperationContext,
  readProductServerConfiguration,
} from "./product-context";

function safeFailureDetail(): string {
  return "The server could not load product state. Correct the local server setup or retry after checking the server logs.";
}

function projectOutcomeForGui<T>(outcome: OperationResult<T>): OperationResult<T> {
  return outcome.ok
    ? outcome
    : { ...outcome, error: projectProductErrorForGui(outcome.error) };
}

/**
 * Deliberately browser-safe projection of the machine-local agent store.  In particular, do
 * not pass a profile through here: a profile contains the executable locator, while its
 * companion grant contains protected-file information.  The browser needs only a friendly
 * choice and a local readiness signal.
 */
export interface AgentProfileForGui {
  readonly agentId: string;
  readonly adapter: "claude-code" | "codex";
  readonly model: string;
  readonly effort: string;
  readonly readiness: "ready" | "needs-credential" | "needs-attention";
}

export interface AgentArmReadinessForGui {
  readonly armId: string;
  readonly adapter: "claude-code" | "codex";
  readonly ready: boolean;
  readonly code: AgentRuntimeReadinessCode;
  readonly detail: string;
  readonly remediation?: string;
}

export function loadAgentProfilesForGui(agentDataDir: string): {
  readonly status: "available" | "unavailable";
  readonly profiles: readonly AgentProfileForGui[];
} {
  try {
    return {
      status: "available",
      profiles: listAgentProfiles(agentDataDir).map((profile) => {
        const finding = doctorAgent(agentDataDir, profile);
        return {
          agentId: profile.agentId,
          adapter: profile.adapter,
          model: profile.model,
          effort: profile.effort,
          readiness: finding.ready
            ? "ready"
            : finding.executable !== "ready"
              ? "needs-attention"
              : finding.credential === "missing"
                ? "needs-credential"
                : "needs-attention",
        };
      }),
    };
  } catch {
    // The exact local failure can include a filesystem path. Keep it server-side.
    return { status: "unavailable", profiles: [] };
  }
}

/** Durable driver diagnostics can originate in launchers, subprocesses, and filesystem code.
 * Core and CLI retain the exact diagnostic; the browser receives only the typed code plus safe
 * retry guidance so an arbitrary Error message cannot disclose paths, command text, or secrets. */
export function projectRunStatusForGui(status: RunStatusResult): RunStatusResult {
  if (status.driver?.error === undefined) return status;
  return {
    ...status,
    driver: {
      ...status.driver,
      error: {
        code: status.driver.error.code,
        // Even domain-coded durable errors crossed an async runtime boundary and can wrap an
        // arbitrary cause. Never preserve their free-form detail or issues in browser state.
        detail: "The run driver stopped before completion. Retry when the condition is resolved; diagnostic details are available in server logs.",
      },
    },
  };
}

export function loadWorkspaceView() {
  try {
    const configuration = readProductServerConfiguration();
    const context = createProductOperationContext(configuration);
    const drafts = listDrafts(context);
    const authority = authorityShow(context);
    return {
      ok: true as const,
      configuration: { principal: configuration.principal },
      drafts: drafts.ok ? drafts : { ...drafts, error: projectProductErrorForGui(drafts.error) },
      authority: authority.ok ? authority : { ...authority, error: projectProductErrorForGui(authority.error) },
    };
  } catch {
    return { ok: false as const, detail: safeFailureDetail() };
  }
}

export function loadDraftView(draftId: string) {
  try {
    const configuration = readProductServerConfiguration();
    const context = createProductOperationContext(configuration);
    const draft = projectOutcomeForGui(getDraft(context, { draftId }));
    const agentFindings = draft.ok
      ? context.runtimeHost?.assessAgentReadiness(
          draft.result.draft.spec.arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning })),
        ) ?? []
      : [];
    const agentReadiness = {
      required: agentFindings.length > 0,
      ready: agentFindings.every((finding) => finding.ready),
      findings: agentFindings.map((finding): AgentArmReadinessForGui => ({
        armId: finding.armId,
        adapter: finding.adapter,
        ready: finding.ready,
        code: finding.code,
        detail: finding.detail,
        ...(finding.remediation === undefined ? {} : { remediation: finding.remediation }),
      })),
    };
    return {
      ok: true as const,
      draft,
      inspection: projectOutcomeForGui(inspectDraft(context, { draftId })),
      arms: projectOutcomeForGui(armList(context, { draftId })),
      agentProfiles: loadAgentProfilesForGui(configuration.agentDataDir),
      agentReadiness,
    };
  } catch {
    return { ok: false as const, detail: safeFailureDetail() };
  }
}

export function loadRunView(draftId: string) {
  try {
    const configuration = readProductServerConfiguration();
    const context = createProductOperationContext(configuration);
    const status = runStatus(context, { draftId });
    const publication = publicationStatus(context, { draftId });
    return {
      ok: true as const,
      draft: projectOutcomeForGui(getDraft(context, { draftId })),
      status: status.ok
        ? { ...status, result: projectRunStatusForGui(status.result) }
        : { ...status, error: projectProductErrorForGui(status.error) },
      publication: publication.ok ? publication : { ...publication, error: projectProductErrorForGui(publication.error) },
      publicationConfiguration: {
        available: configuration.publicationPublicBaseUrl !== undefined,
        ...(configuration.publicationPublicBaseUrl === undefined ? {} : { publicBaseUrl: configuration.publicationPublicBaseUrl }),
      },
    };
  } catch {
    return { ok: false as const, detail: safeFailureDetail() };
  }
}

export function loadResultsView(draftId: string) {
  try {
    const context = createProductOperationContext();
    const results = runResults(context, { draftId });
    return {
      ok: true as const,
      draft: projectOutcomeForGui(getDraft(context, { draftId })),
      results: results.ok
        ? results
        : { ...results, error: projectProductErrorForGui(results.error) },
    };
  } catch {
    return { ok: false as const, detail: safeFailureDetail() };
  }
}
