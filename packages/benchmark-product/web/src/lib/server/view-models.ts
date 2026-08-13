import "server-only";

import {
  armList,
  authorityShow,
  getDraft,
  inspectDraft,
  listDrafts,
  runStatus,
  runResults,
  publicationStatus,
  type OperationResult,
  type RunStatusResult,
} from "@jinn-network/benchmark-product-core";
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
    const context = createProductOperationContext();
    return {
      ok: true as const,
      draft: projectOutcomeForGui(getDraft(context, { draftId })),
      inspection: projectOutcomeForGui(inspectDraft(context, { draftId })),
      arms: projectOutcomeForGui(armList(context, { draftId })),
    };
  } catch {
    return { ok: false as const, detail: safeFailureDetail() };
  }
}

export function loadRunView(draftId: string) {
  try {
    const context = createProductOperationContext();
    const status = runStatus(context, { draftId });
    const publication = publicationStatus(context, { draftId });
    return {
      ok: true as const,
      draft: projectOutcomeForGui(getDraft(context, { draftId })),
      status: status.ok
        ? { ...status, result: projectRunStatusForGui(status.result) }
        : { ...status, error: projectProductErrorForGui(status.error) },
      publication: publication.ok ? publication : { ...publication, error: projectProductErrorForGui(publication.error) },
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
