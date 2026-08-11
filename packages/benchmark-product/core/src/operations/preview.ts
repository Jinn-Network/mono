/**
 * `preview` (BP-20, spec §4.1: `draft --preview--> draft`, `quoted --preview--> quoted`; §7.2
 * "preview = disclosed rehearsal"): drives the SAME `@jinn-network/benchmarking-run` solve-leg
 * machinery the official run path uses (`launchAndWatch`, `../venue/venue.ts`'s real local venue),
 * but against an EPHEMERAL, in-memory subset Benchmark (`../run/compile.ts`'s `compilePreviewRun`)
 * and a disposable scratch venue root (`../workspace/layout.ts`'s `previewScratchDir`) — never the
 * official sealed store, the official venue root, or the official run journal.
 *
 * Deliberately NOT in `GATED_OPERATIONS` (`../authority/policy.ts`): a rehearsal is a read of the
 * venue's own behavior, not a spend or an official-state mutation, so any workspace member may run
 * one — the same reasoning `run-quote.ts`'s header gives for `quote`.
 *
 * `preview` is modeled in `../domain/lifecycle.ts`'s transition table as a repeatable,
 * NON-advancing event (`draft`->`draft`, `quoted`->`quoted`, assumption A5). This operation drives
 * that transition only to VALIDATE legality (refusing `"illegal-transition"` once a draft is
 * locked or later) and never writes the draft document — the only durable traces a preview leaves
 * are (a) the audit-journal entry `operateAsync` itself appends (spec §4.4) and (b) the artifact,
 * per-preview journal, and per-draft preview log under `previews/` (`../run/preview-log.ts`).
 *
 * Scope is deliberately narrow: this rehearses solve cells only (`PreviewArtifact.scope ===
 * "solve-cells-only"`). It consumes `launchAndWatch`'s raw `CellStatusEvent` stream directly,
 * never through `../run/drive.ts`'s `createRecordingProxy`/`driveCellEvents` — those durably
 * record every accepted Submission into the OFFICIAL sealed store and the official run journal,
 * exactly what a preview must never do. No evaluation leg runs; a preview reports per-arm
 * solve-cell outcomes only, folded from the terminal events `launchAndWatch` itself emits.
 */

import { mkdirSync } from "node:fs";
import { launchAndWatch, type CellStatusEvent } from "@jinn-network/benchmarking-run";
import type { DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { appendFsyncedLineSync, atomicWriteFileSync } from "../fs/atomic.js";
import { compilePreviewRun } from "../run/compile.js";
import {
  appendPreviewLogEntry,
  PREVIEW_MARKER,
  readPreviewLog,
  type PreviewArmSummary,
  type PreviewLogEntry,
} from "../run/preview-log.js";
import { deriveRunOwner } from "../run/state.js";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import { createRuntimeVenue } from "../runtime/adapter.js";
import { draftPreviewsDir, previewArtifactPath, previewDir, previewJournalPath, previewScratchDir } from "../workspace/layout.js";
import { getSealedBytes } from "../workspace/sealed-store.js";
import { assertWorkspace } from "../workspace/workspace.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface RunPreviewInput {
  readonly draftId: string;
  /** Max sample items to rehearse; absent rehearses every item in the attached benchmark. Must
   * be a positive integer when present — refuses `"validation"` otherwise. */
  readonly items?: number;
}

export interface RunPreviewDeps {
  readonly createVenue?: typeof createLocalVenue;
}

export interface PreviewArtifact extends PreviewLogEntry {
  readonly marker: typeof PREVIEW_MARKER;
  readonly draftId: string;
  /** Honest about what ran: a preview drives solve cells only, no evaluation leg. */
  readonly scope: "solve-cells-only";
  /** Bare hex sha256 of the ephemeral subset benchmark's bytes — informational; those bytes are
   * never stored in the sealed store. */
  readonly previewBenchmarkSha256: string;
  /** Bare hex sha256 of the ephemeral planned Run's bytes — informational; that Run is never
   * sealed into the workspace's own store either. */
  readonly previewRunSha256: string;
}

export interface RunPreviewResult {
  readonly draft: DraftDocument;
  readonly preview: PreviewArtifact;
  readonly previewCount: number;
}

function computeCloseAt(at: string, closeAfterMs: number): string {
  return new Date(Date.parse(at) + closeAfterMs).toISOString();
}

/** Upper bound on the id-claim loop below — collisions past this many consecutive numbers mean
 * something other than a crash remnant or a concurrent preview is occupying the namespace. */
const PREVIEW_ID_CLAIM_ATTEMPTS = 1000;

/**
 * Claims the next preview id by creating its directory EXCLUSIVELY (`mkdirSync` without
 * `recursive`, so an already-existing directory throws `EEXIST`). The log's `count` is only a
 * starting hint: a crash between an earlier preview's directory/artifact writes and its log
 * append leaves an orphaned `preview-NNN` directory the log never counted, and a concurrent
 * `runPreview` for the same draft may have claimed a number this call also computed. In both
 * cases the exclusive create refuses the collision and the loop moves to the next number,
 * instead of silently reusing an id — which would concatenate a fresh rehearsal's journal onto
 * a stale one and overwrite its artifact.
 */
function claimPreviewId(workspaceDir: string, draftId: string, countHint: number): string {
  mkdirSync(draftPreviewsDir(workspaceDir, draftId), { recursive: true });
  for (let sequence = countHint + 1; sequence <= countHint + PREVIEW_ID_CLAIM_ATTEMPTS; sequence += 1) {
    const previewId = `preview-${String(sequence).padStart(3, "0")}`;
    try {
      mkdirSync(previewDir(workspaceDir, draftId, previewId));
      return previewId;
    } catch (cause) {
      const code = typeof cause === "object" && cause !== null && "code" in cause
        ? (cause as { code: unknown }).code
        : undefined;
      if (code !== "EEXIST") throw cause;
    }
  }
  refuse("conflict", `previews.${draftId}`, "could not claim a fresh preview id after repeated collisions");
}

function freshOutcomeCounts(): PreviewArmSummary["outcomes"] {
  return { delivered: 0, failed: 0, expired: 0, cancelled: 0, other: 0 };
}

/**
 * Maps a solve-leg terminal `CellStatusEvent` onto one outcome bucket; `undefined` for the
 * non-terminal `"dispatch"`/`"claimed"` kinds `launchAndWatch` also emits along the way (module
 * header: this operation reports terminal outcomes only).
 */
function classifyOutcome(event: CellStatusEvent): keyof PreviewArmSummary["outcomes"] | undefined {
  switch (event.kind) {
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    case "judged":
      return "other";
    case "error":
      // The platform's other replaceable reasons ("unscorable"/"exclusion-hit") arise only from
      // host-supplied terminal facts an evaluation dispatcher provides — a preview never
      // dispatches an evaluation leg, so any non-expired error here folds honestly into "failed".
      return event.replaceableReason === "expired" ? "expired" : "failed";
    case "dispatch":
    case "claimed":
      return undefined;
  }
}

export function runPreview(
  context: OperationContext,
  input: RunPreviewInput,
  deps: RunPreviewDeps = {},
): Promise<OperationResult<RunPreviewResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "preview",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const createVenue: typeof createLocalVenue = deps.createVenue
        ?? ((options) => createRuntimeVenue(document.spec.evaluationRuntime, options));

      const transitioned = transition(document.state, "preview");
      if (!transitioned.ok) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }
      // "preview" is legal only in "draft" and "quoted" (../domain/lifecycle.ts's transition
      // table) and is modeled there as non-advancing — reaching this point proves document.state
      // was one of the two. This operation never writes the draft document either way.
      const draftState = document.state as "draft" | "quoted";

      if (input.items !== undefined && (!Number.isInteger(input.items) || input.items < 1)) {
        refuse("validation", "items", "items must be a positive integer");
      }

      const workspaceMetadata = assertWorkspace(clockedContext.workspaceDir);
      const owner = deriveRunOwner(workspaceMetadata.createdAt, `${input.draftId}#preview`);
      const closeAt = computeCloseAt(at, document.spec.policy.closeAfterMs);

      const compiled = compilePreviewRun({
        workspaceDir: clockedContext.workspaceDir,
        draft: document,
        owner,
        closeAt,
        ...(input.items !== undefined ? { itemLimit: input.items } : {}),
      });

      // Claimed only after every pure refusal above has passed, so a draft that cannot even
      // compile (no attached benchmark, one arm) burns no id slot and leaves no empty directory.
      const existingLog = readPreviewLog(clockedContext.workspaceDir, input.draftId);
      const previewId = claimPreviewId(clockedContext.workspaceDir, input.draftId, existingLog?.count ?? 0);

      // The scratch venue's OWN clock is the live, unfrozen `context.clock` — same reasoning as
      // run-quote.ts's own note: the backend's internal bookkeeping needs real elapsed time even
      // though this operation's own artifact/log timestamps outside started/finished are pinned.
      let venue: LocalVenue;
      try {
        venue = createVenue({
          workspaceDir: previewScratchDir(clockedContext.workspaceDir, input.draftId, previewId),
          runtimeBindingWorkspaceDir: clockedContext.workspaceDir,
          now: context.clock,
        });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      const armOutcomes = new Map<string, PreviewArmSummary["outcomes"]>();
      let cellCount = 0;
      const startedAt = context.clock();

      try {
        const events = launchAndWatch(compiled.previewBenchmarkRecord, compiled.plannedRun.record, venue.backend, {
          runDigest: compiled.plannedRun.digest,
          taskBytesFor: (taskDigestHex) => getSealedBytes(clockedContext.workspaceDir, taskDigestHex),
          clock: { now: () => new Date(context.clock()) },
        });

        for await (const event of events) {
          appendFsyncedLineSync(
            previewJournalPath(clockedContext.workspaceDir, input.draftId, previewId),
            JSON.stringify({ at: context.clock(), event }),
          );

          const outcome = classifyOutcome(event);
          if (outcome === undefined) continue;
          cellCount += 1;
          const counts = armOutcomes.get(event.armId) ?? freshOutcomeCounts();
          counts[outcome] += 1;
          armOutcomes.set(event.armId, counts);
        }
      } finally {
        await venue.shutdown();
      }

      const finishedAt = context.clock();
      const elapsedMs = Date.parse(finishedAt) - Date.parse(startedAt);

      const arms: PreviewArmSummary[] = [...armOutcomes.entries()].map(([armId, outcomes]) => ({
        armId,
        cells: outcomes.delivered + outcomes.failed + outcomes.expired + outcomes.cancelled + outcomes.other,
        outcomes,
      }));

      const logEntry: PreviewLogEntry = {
        previewId,
        at,
        startedAt,
        finishedAt,
        elapsedMs,
        draftState,
        itemCount: compiled.itemCount,
        cellCount,
        arms,
      };

      const artifact: PreviewArtifact = {
        marker: PREVIEW_MARKER,
        ...logEntry,
        draftId: input.draftId,
        scope: "solve-cells-only",
        previewBenchmarkSha256: compiled.previewBenchmarkSha256,
        previewRunSha256: compiled.plannedRun.digest.slice("sha256:".length),
      };

      atomicWriteFileSync(
        previewArtifactPath(clockedContext.workspaceDir, input.draftId, previewId),
        JSON.stringify(artifact, null, 2),
      );
      const updatedLog = appendPreviewLogEntry(clockedContext.workspaceDir, input.draftId, logEntry);

      return { draft: document, preview: artifact, previewCount: updatedLog.count };
    },
  });
}
