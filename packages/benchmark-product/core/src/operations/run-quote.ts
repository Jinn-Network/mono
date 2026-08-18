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
 *
 * BP-20 (spec §4.6 Quote row: "expected cell count; per-cell and total price (paid venues) or
 * time/disk estimates (local); hard-cap check; coverage facts; venue guarantee summary"):
 * `presentation` renders the rest of that row on top of the platform's own `QuoteReport` — run
 * size (solve vs. evaluation cell demand, per arm), coverage (which pinning keys the venue
 * supports, and which requirements it refuses), the hard-cap check, and — only when this draft
 * has disclosed preview history — a wall-time estimate. The coverage-refusal walk deliberately
 * mirrors `@jinn-network/benchmarking-run`'s own `quote.ts` (`mergeRequirements` /
 * `unsupportedPinningErrors`) rather than re-deriving different logic, so a refusal here always
 * agrees with `quote.errors` (a test cross-checks the two counts) — keep both in sync if either
 * changes. The wall-time estimate's only legitimate source is this draft's own disclosed preview
 * log (`../run/preview-log.ts`) — never a synthetic or generic figure (spec §7.2: preview is
 * disclosed rehearsal, and an estimate that pretended to know a cost it never rehearsed would
 * defeat that same honesty).
 */

import { quoteRun, type QuoteReport } from "@jinn-network/benchmarking-run";
import type { RunRecord } from "@jinn-network/benchmarking-records";
import type { BackendCapabilities } from "@jinn-network/task-execution-backend";
import { createLocalVenue, type LocalVenue } from "../venue/venue.js";
import { createRuntimeVenue } from "../runtime/adapter.js";
import { deriveInspectEvaluationStrategy } from "../runtime/inspect/assurance.js";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { transition, type LifecycleState } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { draftPath } from "../workspace/layout.js";
import { compileDraft, type CompiledRun } from "../run/compile.js";
import { readPreviewLog, type PreviewLog } from "../run/preview-log.js";
import { createPublicationState, readRunState, specDigest, writeRunState } from "../run/state.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";
import { HarborSelectionManifestSchema } from "../runtime/harbor/manifest.js";
import { suiteQuoteFromHarbor } from "../runtime/suite-protocol/from-harbor.js";
import type { SuiteProtocolId } from "../runtime/suite-protocol/comparability.js";
import { SwebenchVerifiedSelectionManifestSchema } from "../runtime/swe-bench-verified/manifest.js";
import { suiteQuoteFromSwebench } from "../runtime/suite-protocol/from-swebench.js";
import { ApexAgentsSelectionManifestSchema } from "../runtime/apex-agents/manifest.js";
import { suiteQuoteFromApex } from "../runtime/suite-protocol/from-apex.js";
import { APEX_SWE_DEV_ADAPTER_ID, ApexSweDevSelectionManifestSchema } from "../runtime/apex-swe-dev/manifest.js";
import { suiteQuoteFromApexSweDev } from "../runtime/suite-protocol/from-apex-swe-dev.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface RunQuoteInput {
  readonly draftId: string;
}

/** One arm's cell demand (spec §4.6: "line items per arm x items x replicates"). */
export interface QuoteArmSize {
  readonly armId: string;
  readonly solveCells: number;
  readonly evaluationCells: number;
}

/** A pinning requirement the venue's declared capabilities cannot satisfy — either the key
 * itself is outside the venue's `runPinning` inventory, or the key's requested value id is. */
export interface QuoteCoverageRefusal {
  readonly armId: string;
  readonly key: string;
  readonly detail: string;
}

/** A wall-time estimate for this quote's solve leg, present only when this draft's own preview
 * log (`../run/preview-log.ts`) has real rehearsed cells to project from. `source` names the one
 * legitimate origin this product ever estimates from — never an invented or generic figure. */
export interface QuoteEstimatedWallTime {
  readonly source: "estimate-from-rehearsal";
  readonly previewCount: number;
  readonly rehearsedCells: number;
  readonly meanCellMs: number;
  /** `meanCellMs x solveCells`, rounded to the nearest integer millisecond. */
  readonly projectedSolveMs: number;
}

/** The rendered §4.6 Quote row, on top of the platform's own `QuoteReport`. */
export interface QuotePresentation {
  readonly runSize: {
    readonly solveCells: number;
    /**
     * The sealed Run's own evaluation policy DEMAND per solve cell (`solveCells x
     * resolveAssurance(...).minVerdicts`) — the committed number of verdicts the Matrix must
     * carry for completeness, not a promise about how many evaluation dispatches the venue will
     * actually make or how it makes them.
     */
    readonly evaluationCells: number;
    readonly totalCells: number;
    readonly perArm: readonly QuoteArmSize[];
  };
  readonly coverage: {
    readonly supportedKeys: readonly string[];
    readonly refusals: readonly QuoteCoverageRefusal[];
  };
  readonly hardCap: {
    readonly declared: boolean;
    readonly breached: boolean;
    readonly detail?: string;
  };
  readonly estimatedWallTime?: QuoteEstimatedWallTime;
  readonly suite?: {
    readonly protocol: SuiteProtocolId;
    readonly executionConformance: boolean;
    readonly coverage: "one_task" | "ten_task" | "full" | "custom";
    readonly leaderboardSubmitReady: boolean;
    readonly methodLeaderboardEligible: boolean;
    readonly cellCount: string;
    readonly harborVersion?: string;
    readonly harnessVersion?: string;
    readonly selectedTaskCount: number;
    readonly armCount: number;
    readonly replicates: number;
  };
}

export interface RunQuoteResult {
  readonly draft: DraftDocument;
  readonly quote: QuoteReport;
  readonly presentation: QuotePresentation;
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

/** `solveCells`/`evaluationCells`/`totalCells` overall, plus one `QuoteArmSize` per arm — see
 * module header and `QuotePresentation.runSize`'s own doc comment for what "evaluation cells"
 * commits to. */
function buildRunSize(compiled: CompiledRun, quote: QuoteReport, minVerdicts: number): QuotePresentation["runSize"] {
  const replicates = compiled.plannedRun.record.replicates;
  const itemCount = compiled.benchmarkRecord.items.length;
  const perArm: QuoteArmSize[] = compiled.plannedRun.record.arms.map((arm) => {
    const armSolveCells = itemCount * replicates;
    return { armId: arm.armId, solveCells: armSolveCells, evaluationCells: armSolveCells * minVerdicts };
  });
  const solveCells = quote.expectedCellCount;
  const evaluationCells = solveCells * minVerdicts;
  return { solveCells, evaluationCells, totalCells: solveCells + evaluationCells, perArm };
}

function mergeArmRequirements(
  pinning: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  return { ...baseline, ...pinning };
}

function requirementValueId(value: unknown): string | undefined {
  if (value !== null && typeof value === "object" && "id" in value) {
    return String((value as { id: unknown }).id);
  }
  return typeof value === "string" ? value : undefined;
}

/** Mirrors `@jinn-network/benchmarking-run`'s own `quote.ts` (`mergeRequirements` /
 * `unsupportedPinningErrors`) — see module header for why this walk is deliberately duplicated
 * rather than reused, and keep the two in sync. */
function coverageRefusals(run: RunRecord, capabilities: BackendCapabilities): QuoteCoverageRefusal[] {
  const supported = new Map<string, Set<string>>(
    capabilities.runPinning.keys.map((entry) => [entry.key, new Set(entry.inventory)]),
  );
  const refusals: QuoteCoverageRefusal[] = [];
  for (const arm of run.arms) {
    const requirements = mergeArmRequirements(
      arm.pinning as Record<string, unknown>,
      run.policy.submissionBaseline as Record<string, unknown>,
    );
    for (const [key, value] of Object.entries(requirements)) {
      const inventory = supported.get(key);
      if (inventory === undefined) {
        refusals.push({ armId: arm.armId, key, detail: `pinning key "${key}" is not in backend runPinning inventory` });
        continue;
      }
      const id = requirementValueId(value);
      if (id !== undefined && !inventory.has(id)) {
        refusals.push({ armId: arm.armId, key, detail: `${key} id "${id}" is not in backend inventory` });
      }
    }
  }
  return refusals;
}

function buildHardCap(compiled: CompiledRun, quote: QuoteReport): QuotePresentation["hardCap"] {
  const declared = compiled.plannedRun.record.budget !== undefined;
  const breach = quote.errors.find((error) => error.code === "hard-cap-breach");
  return { declared, breached: breach !== undefined, ...(breach !== undefined ? { detail: breach.detail } : {}) };
}

/** The only estimate this operation ever produces: real elapsed time from this draft's own
 * disclosed previews, projected onto this quote's solve-cell count. `undefined` when there is no
 * rehearsal to project from — never a synthetic fallback (module header). */
function buildEstimatedWallTime(previewLog: PreviewLog | undefined, solveCells: number): QuoteEstimatedWallTime | undefined {
  if (previewLog === undefined || previewLog.count === 0) return undefined;
  const rehearsedCells = previewLog.previews.reduce((sum, preview) => sum + preview.cellCount, 0);
  if (rehearsedCells === 0) return undefined;
  const totalElapsedMs = previewLog.previews.reduce((sum, preview) => sum + preview.elapsedMs, 0);
  const meanCellMs = Math.round(totalElapsedMs / rehearsedCells);
  return {
    source: "estimate-from-rehearsal",
    previewCount: previewLog.count,
    rehearsedCells,
    meanCellMs,
    projectedSolveMs: Math.round(meanCellMs * solveCells),
  };
}

function buildQuotePresentation(
  compiled: CompiledRun,
  quote: QuoteReport,
  capabilities: BackendCapabilities,
  minVerdicts: number,
  previewLog: PreviewLog | undefined,
  suite?: QuotePresentation["suite"],
): QuotePresentation {
  const runSize = buildRunSize(compiled, quote, minVerdicts);
  const supportedKeys = capabilities.runPinning.keys.map((entry) => entry.key).sort();
  const refusals = coverageRefusals(compiled.plannedRun.record, capabilities);
  const estimatedWallTime = buildEstimatedWallTime(previewLog, runSize.solveCells);
  return {
    runSize,
    coverage: { supportedKeys, refusals },
    hardCap: buildHardCap(compiled, quote),
    ...(estimatedWallTime !== undefined ? { estimatedWallTime } : {}),
    ...(suite === undefined ? {} : { suite }),
  };
}

export function runQuote(
  context: OperationContext,
  input: RunQuoteInput,
  deps: RunQuoteDeps = {},
): Promise<OperationResult<RunQuoteResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };
  return operateAsync({
    context: clockedContext,
    action: "quote",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      const createVenue: typeof createLocalVenue = deps.createVenue
        ?? ((options) => createRuntimeVenue(document.spec.evaluationRuntime, options, context.runtimeHost));
      const nextState = ensureQuotable(document.state, input.draftId);

      const unreadyAgent = context.runtimeHost?.assessAgentReadiness(
        document.spec.arms.map((arm) => ({ armId: arm.armId, pinning: arm.pinning })),
      ).find((finding) => !finding.ready);
      if (unreadyAgent !== undefined) {
        refuse(
          "venue-unavailable",
          `arms.${unreadyAgent.armId}.pinning`,
          `${unreadyAgent.detail}${unreadyAgent.remediation === undefined ? "" : ` ${unreadyAgent.remediation}`}`,
        );
      }

      const closeAt = computeCloseAt(at, document.spec.policy.closeAfterMs);
      // One real workspace-held did:key is both Run owner and public source agent. This avoids
      // inventing an unverifiable delegation from a deterministic URN with no private key.
      const owner = loadOrCreateReportSigningKey(clockedContext.workspaceDir).keyId;

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
        const resolvedAssurance = resolveAssurance(document.spec.assurance);
        venue = createVenue({
          workspaceDir: clockedContext.workspaceDir,
          now: context.clock,
          evaluatorCount: resolvedAssurance.minVerdicts,
          inspectEvaluationStrategy: deriveInspectEvaluationStrategy(resolvedAssurance),
          agentProfileRequirements: document.spec.arms.map((arm) => arm.pinning),
        });
      } catch (cause) {
        refuse("venue-unavailable", "venue", cause instanceof Error ? cause.message : String(cause));
      }

      let quote: QuoteReport;
      let capabilities: BackendCapabilities;
      try {
        await venue.preflightRun?.();
        capabilities = await venue.backend.capabilities();
        quote = quoteRun(compiled.benchmarkRecord, compiled.plannedRun.record, capabilities);
      } finally {
        await venue.shutdown();
      }

      const previousPublication = readRunState(clockedContext.workspaceDir, input.draftId)?.publication;
      const minVerdicts = resolveAssurance(document.spec.assurance).minVerdicts;
      const previewLog = readPreviewLog(clockedContext.workspaceDir, input.draftId);
      const suite = document.spec.evaluationRuntime?.adapterId === "harbor"
        ? suiteQuoteFromHarbor({
          manifest: HarborSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
          armCount: compiled.plannedRun.record.arms.length,
          itemCount: compiled.benchmarkRecord.items.length,
          replicates: compiled.plannedRun.record.replicates,
        })
        : document.spec.evaluationRuntime?.adapterId === "swebench-harness"
          ? suiteQuoteFromSwebench({
            manifest: SwebenchVerifiedSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
            armCount: compiled.plannedRun.record.arms.length,
            itemCount: compiled.benchmarkRecord.items.length,
            replicates: compiled.plannedRun.record.replicates,
          })
          : document.spec.evaluationRuntime?.adapterId === "archipelago"
            ? suiteQuoteFromApex({
              manifest: ApexAgentsSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
              armCount: compiled.plannedRun.record.arms.length,
              itemCount: compiled.benchmarkRecord.items.length,
              replicates: compiled.plannedRun.record.replicates,
            })
          : document.spec.evaluationRuntime?.adapterId === APEX_SWE_DEV_ADAPTER_ID
            ? suiteQuoteFromApexSweDev({
              manifest: ApexSweDevSelectionManifestSchema.parse(JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256)))),
              armCount: compiled.plannedRun.record.arms.length,
              itemCount: compiled.benchmarkRecord.items.length,
              replicates: compiled.plannedRun.record.replicates,
            })
            : undefined;
      writeRunState(clockedContext.workspaceDir, input.draftId, {
        draftId: input.draftId,
        specSha256: specDigest(document.spec),
        owner,
        quote,
        quotedAt: at,
        publication: previousPublication === undefined
          ? createPublicationState({ agentKeyRef: owner })
          : { ...previousPublication, source: { ...previousPublication.source, agentKeyRef: owner } },
        ...(suite === undefined ? {} : { suiteQuote: suite }),
      });

      let draft = document;
      if (nextState !== document.state) {
        draft = { ...document, state: nextState, updatedAt: at };
        atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      }

      const presentation = buildQuotePresentation(compiled, quote, capabilities, minVerdicts, previewLog, suite);

      return { draft, quote, presentation };
    },
  });
}
