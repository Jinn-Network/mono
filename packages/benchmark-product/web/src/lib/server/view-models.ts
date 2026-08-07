import "server-only";

import {
  armList,
  authorityShow,
  getDraft,
  inspectDraft,
  listDrafts,
  runStatus,
  type RunStatusResult,
} from "@jinn-network/benchmark-product-core";
import { projectProductErrorForGui } from "./gui-error";
import {
  createProductOperationContext,
  ProductContextConfigurationError,
  readProductServerConfiguration,
} from "./product-context";

function safeFailureDetail(cause: unknown): string {
  return cause instanceof ProductContextConfigurationError
    ? cause.message
    : "The server could not load product state. Retry after checking the server logs.";
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
    return {
      ok: true as const,
      configuration,
      drafts: listDrafts(context),
      authority: authorityShow(context),
    };
  } catch (cause) {
    return { ok: false as const, detail: safeFailureDetail(cause) };
  }
}

export function loadDraftView(draftId: string) {
  try {
    const context = createProductOperationContext();
    return {
      ok: true as const,
      draft: getDraft(context, { draftId }),
      inspection: inspectDraft(context, { draftId }),
      arms: armList(context, { draftId }),
    };
  } catch (cause) {
    return { ok: false as const, detail: safeFailureDetail(cause) };
  }
}

export function loadRunView(draftId: string) {
  try {
    const context = createProductOperationContext();
    const status = runStatus(context, { draftId });
    return {
      ok: true as const,
      draft: getDraft(context, { draftId }),
      status: status.ok
        ? { ...status, result: projectRunStatusForGui(status.result) }
        : { ...status, error: projectProductErrorForGui(status.error) },
    };
  } catch (cause) {
    return { ok: false as const, detail: safeFailureDetail(cause) };
  }
}
