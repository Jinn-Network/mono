import "server-only";

import {
  armList,
  authorityShow,
  getDraft,
  inspectDraft,
  listDrafts,
} from "@jinn-network/benchmark-product-core";
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
