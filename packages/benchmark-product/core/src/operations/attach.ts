/**
 * Attaches a sealed Benchmark (already stored in the workspace's sealed-bytes
 * store) to a draft's task set. Shared by the intake operations (`sample.init`
 * and `import.swebench`) so the draft-state rules live in one place:
 *
 * - a draft past `draft`/`quoted` refuses mutation (`illegal-transition`,
 *   spec §4.1);
 * - a draft whose task set is already a benchmark refuses (`conflict`) —
 *   re-running an intake operation is refused-typed, never silently
 *   re-attached;
 * - attaching to a `quoted` draft drives the `quoted --edit--> draft`
 *   transition (assumption A2): the quote described a draft without this
 *   task set.
 *
 * Not an operation itself: callers run inside their own `operate` /
 * `operateAsync` boundary and pass the single cached `at` instant so the
 * document's `updatedAt` matches the audit entry.
 */

import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { draftPath } from "../workspace/layout.js";
import { readDraftDocument } from "./drafts.js";

export function attachBenchmarkToDraft(
  workspaceDir: string,
  draftId: string,
  benchmarkSha256: string,
  at: string,
): DraftDocument {
  const document = readDraftDocument(workspaceDir, draftId);

  if (!isDraftMutable(document.state)) {
    refuse(
      "illegal-transition",
      `drafts.${draftId}.state`,
      `draft ${draftId} is in state "${document.state}" and refuses mutation`,
    );
  }

  if (document.spec.taskSet.kind === "benchmark") {
    refuse(
      "conflict",
      `drafts.${draftId}.taskSet`,
      `draft ${draftId} already has a benchmark task set attached`,
    );
  }

  let nextState: LifecycleState = document.state;
  if (document.state === "quoted") {
    const result = transition("quoted", "edit");
    if (result.ok) nextState = result.state;
  }

  const spec = parseDraftSpec({
    ...document.spec,
    taskSet: { kind: "benchmark", benchmarkSha256 },
  });
  const updated: DraftDocument = { ...document, state: nextState, updatedAt: at, spec };
  atomicWriteFileSync(draftPath(workspaceDir, draftId), JSON.stringify(updated, null, 2));
  return updated;
}
