/**
 * `quote` (spec §4.1: draft --quote--> quoted; §4.6 Quote row): a side-effect-free-on-the-run
 * read of venue facts — compiles the draft, boots the local venue just far enough to read its
 * `BackendCapabilities`, and prices the compiled Run via `@jinn-network/benchmarking-run`'s
 * `quoteRun`. Nothing signs, posts, or spends (spec §4.1's own words for this row).
 *
 * Ungated: `"quote"` is deliberately NOT in `GATED_OPERATIONS` (`authority/policy.ts`) — reading
 * venue facts requires workspace membership only, the same as every other read.
 *
 * A quote with `ok: false` (e.g. an unsupported pinning key) is still persisted and still
 * returned as a successful operation result: `QuoteReport.ok` is a fact about the venue, not an
 * operation failure — the typed-error posture (spec §4.3) is reserved for the operation itself
 * going wrong (bad draftId, illegal state), not for an honest "this won't quote clean" answer.
 */

import { quoteRun, type QuoteReport } from "@jinn-network/benchmarking-run";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import type { DraftDocument } from "../domain/draft.js";
import { transition, type LifecycleState } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { assertWorkspace } from "../workspace/workspace.js";
import { compileDraft } from "../run/compile.js";
import { deriveRunOwner, specDigest, writeRunState } from "../run/state.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunQuoteInput {
  readonly draftId: string;
}

export interface RunQuoteResult {
  readonly draft: DraftDocument;
  readonly quote: QuoteReport;
}

export interface RunQuoteDeps {
  readonly createVenue?: typeof createLocalVenue;
}

/** `draft`: drives the `quote` transition to `quoted`. `quoted`: re-quoting is idempotent — the
 * state does not change, only the persisted RunState is refreshed. Anything else refuses. */
function ensureQuotable(state: LifecycleState, draftId: string): LifecycleState {
  if (state === "quoted") return "quoted";
  if (state === "draft") {
    const result = transition("draft", "quote");
    if (!result.ok) {
      refuse("illegal-transition", `drafts.${draftId}.state`, result.error.detail);
    }
    return result.state;
  }
  refuse(
    "illegal-transition",
    `drafts.${draftId}.state`,
    `draft ${draftId} is in state "${state}" and cannot be quoted`,
  );
}

function computeCloseAt(at: string, closeAfterMs: number): string {
  return new Date(Date.parse(at) + closeAfterMs).toISOString();
}

export function runQuote(
  context: OperationContext,
  input: RunQuoteInput,
  deps: RunQuoteDeps = {},
): Promise<OperationResult<RunQuoteResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  const createVenue = deps.createVenue ?? createLocalVenue;

  return operateAsync({
    context: clockedContext,
    action: "quote",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const nextState = ensureQuotable(document.state, input.draftId);

      const closeAt = computeCloseAt(at, document.spec.policy.closeAfterMs);
      const workspaceMetadata = assertWorkspace(clockedContext.workspaceDir);
      const owner = deriveRunOwner(workspaceMetadata.createdAt, input.draftId);

      const compiled = compileDraft({
        workspaceDir: clockedContext.workspaceDir,
        draft: document,
        owner,
        closeAt,
      });

      // The venue's OWN clock is the live, unfrozen `context.clock` — deliberately not the
      // `at`-frozen `clockedContext.clock` above. The backend's internal bookkeeping (expiry,
      // watch loops) needs real elapsed time even though this operation's own document and
      // audit timestamps are pinned to one instant.
      let venue: LocalVenue;
      try {
        venue = createVenue({ workspaceDir: clockedContext.workspaceDir, now: context.clock });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      let quote: QuoteReport;
      try {
        const capabilities = await venue.backend.capabilities();
        quote = quoteRun(compiled.benchmarkRecord, compiled.plannedRun.record, capabilities);
      } finally {
        await venue.shutdown();
      }

      writeRunState(clockedContext.workspaceDir, input.draftId, {
        draftId: input.draftId,
        specSha256: specDigest(document.spec),
        owner,
        quote,
        quotedAt: at,
      });

      let draft = document;
      if (nextState !== document.state) {
        draft = { ...document, state: nextState, updatedAt: at };
        atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      }

      return { draft, quote };
    },
  });
}
