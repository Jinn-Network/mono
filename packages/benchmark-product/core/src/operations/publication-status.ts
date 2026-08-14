import { assessPublicationCompatibility } from "../run/publication-compatibility.js";
import { projectPublicationStatus, type PublicationStatusProjection } from "../run/publication-status.js";
import { requireRunState } from "../run/state.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

/** Read-only publication state. It never calls a venue, source URL, or report publisher. */
export function publicationStatus(context: OperationContext, input: { readonly draftId: string }): OperationResult<PublicationStatusProjection> {
  return operate({ context, action: "publication.status", subject: input.draftId, inputs: input, run: () => {
    const document = readDraftDocument(context.workspaceDir, input.draftId);
    const state = requireRunState(context.workspaceDir, input.draftId);
    return projectPublicationStatus({ state, lifecycleState: document.state, compatibility: assessPublicationCompatibility(context.workspaceDir, input.draftId) });
  } });
}
