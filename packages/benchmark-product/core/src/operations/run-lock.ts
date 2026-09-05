/**
 * `lock` (spec §4.1: quoted --lock--> locked, GATED): "seals the Run record; refuses if
 * validation fails; irreversible." Recompiles the draft (the same `compileDraft` `run-quote.ts`
 * uses) with a FRESH `closeAt` resolved against the current clock — the quote's own provisional
 * `closeAt` was a price-time estimate, not a promise — seals the resulting Run record, and
 * stores its exact bytes in the workspace's sealed-bytes store (spec §4.5).
 *
 * A2 (quote invalidation): `run-quote.ts` persists `RunState.specSha256`, the digest of the
 * draft spec as of the most recent quote. `lock` refuses `"conflict"` unless that digest still
 * matches the CURRENT draft spec — an edit between quote and lock invalidates the quote, and
 * the product refuses to lock a draft whose priced description no longer describes it.
 *
 * Once locked, the draft is immutable by construction: `isDraftMutable` (domain/lifecycle.ts)
 * already fences every draft-mutation operation (`updateDraft`, `armAdd`/`armUpdate`/`armRemove`,
 * the intake operations) to `draft`/`quoted` states only — this module adds no separate
 * enforcement, it just drives the draft into a state those checks already treat as immutable.
 */

import { taskSelectionContradiction } from "@colophon-claims/verify";
import {
  RUN_RECORD_KIND,
  parseRun,
  sealRun,
  withRunAnchorIntentExtension,
  withRunTaskSelectionExtension,
  withRunBeaconSourceExtension,
  withRunPublicationExtension,
  withRunSampleSizeAdvisoryExtension,
  parseBenchmark,
} from "@jinn-network/benchmarking-records";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { compileDraft } from "../run/compile.js";
import { sampleSizeAdvisory, type DeclaredAnalysis, type SampleSizeAdvisory } from "../run/sample-size-advisory.js";
import {
  inspectRuntimeMethodForBinding,
  type InspectRuntimeMethodDisclosure,
} from "../runtime/inspect/disclosure.js";
import { requireRunState, specDigest, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { HarborSelectionManifestSchema, isHarborCompatibleEvaluationRuntime } from "../runtime/harbor/manifest.js";
import { suiteProtocolDisplayName } from "../runtime/suite-protocol/comparability.js";
import { suiteSelectionFromHarbor } from "../runtime/suite-protocol/from-harbor.js";
import { SwebenchVerifiedSelectionManifestSchema } from "../runtime/swe-bench-verified/manifest.js";
import { APEX_SWE_DEV_ADAPTER_ID, ApexSweDevSelectionManifestSchema } from "../runtime/apex-swe-dev/manifest.js";
import { ApexAgentsSelectionManifestSchema } from "../runtime/apex-agents/manifest.js";
import { readInspectEvalSelectionManifest } from "../runtime/inspect/host.js";
import { runtimeRegistrationArtifacts } from "../runtime/adapter.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface RunLockInput {
  readonly draftId: string;
  /**
   * Set when the caller has been shown the seal-time sample-size advisory (issue #2978) and locked
   * at the declared n anyway. Optional and defaulted off: a caller that does not acknowledge seals
   * byte-identical Run bytes to before the advisory existed, so no stored record or fixture moves.
   */
  readonly acknowledgedSampleSizeAdvisory?: boolean;
}

export interface RunLockResult {
  readonly draft: DraftDocument;
  readonly runSha256: string;
  readonly closeAt: string;
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
  /** Present exactly when the caller acknowledged it, which is exactly when the seal carries it. */
  readonly sampleSizeAdvisory?: SampleSizeAdvisory;
}

/**
 * The advisory a lock of this draft would print and seal (issue #2978), so an operator surface can
 * show the width BEFORE the irreversible seal and `runLock` can seal the same numbers afterwards.
 *
 * `undefined` for a draft no lock could seal right now — not quoted, or carrying no benchmark, so
 * there is no item count and therefore no n. Returning `undefined` rather than refusing keeps this
 * a pure advisory: the caller gating on it does not have to restate the lock's own preconditions,
 * and `runLock` stays the one place that says why a lock cannot happen.
 */
export function draftSampleSizeAdvisory(
  workspaceDir: string,
  draftId: string,
): SampleSizeAdvisory | undefined {
  const document = readDraftDocument(workspaceDir, draftId);
  if (document.state !== "quoted" || document.spec.taskSet.kind !== "benchmark") return undefined;
  const benchmark = parseBenchmark(getSealedBytes(workspaceDir, document.spec.taskSet.benchmarkSha256));
  if (benchmark.items.length < 1) return undefined;
  return sampleSizeAdvisory({
    items: benchmark.items.length,
    replicates: document.spec.replicates,
    declaredAnalyses: declaredAnalyses(document.spec),
  });
}

/**
 * The draft's declared analysis-plan entries, primary first — the same order `buildAnalysisPlan`
 * seals them in. Read only so the advisory can name the readouts its width does not bound
 * (issue #3832); it never reaches the sealed extension.
 */
function declaredAnalyses(spec: DraftDocument["spec"]): readonly DeclaredAnalysis[] {
  return [...(spec.analysis === undefined ? [] : [spec.analysis]), ...(spec.additionalAnalyses ?? [])];
}

function computeCloseAt(at: string, closeAfterMs: number): string {
  return new Date(Date.parse(at) + closeAfterMs).toISOString();
}

export function runLock(context: OperationContext, input: RunLockInput): OperationResult<RunLockResult> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "lock",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (document.state !== "quoted") {
        refuse(
          "illegal-transition",
          `drafts.${input.draftId}.state`,
          `draft ${input.draftId} is in state "${document.state}" — only a quoted draft can be locked`,
        );
      }
      const runtimeMethod = inspectRuntimeMethodForBinding(
        clockedContext.workspaceDir,
        document.spec.evaluationRuntime,
        resolveAssurance(document.spec.assurance),
      );

      const runState = requireRunState(clockedContext.workspaceDir, input.draftId);
      const currentSpecSha256 = specDigest(document.spec);
      if (runState.specSha256 !== currentSpecSha256) {
        refuse(
          "conflict",
          `drafts.${input.draftId}.spec`,
          "quote invalidated by edit — re-quote",
        );
      }
      if (isHarborCompatibleEvaluationRuntime(document.spec.evaluationRuntime)) {
        const harborSelection = HarborSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        const suite = suiteSelectionFromHarbor(harborSelection);
        // Select seals replicates into the suite; the draft spec stays patchable until lock, so a
        // post-select `replicates: 1` would otherwise lock and quote as protocol-conforming k=5.
        if (suite !== undefined && document.spec.replicates !== suite.replicates) {
          refuse(
            "conflict",
            `drafts.${input.draftId}.spec.replicates`,
            `Terminal-Bench 2.1 sealed replicates ${suite.replicates} at select; the draft now says ${document.spec.replicates} — re-run "runtime terminal-bench-2-1 select"`,
          );
        }
        if (suite?.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            `full-suite ${suiteProtocolDisplayName(suite.protocol)} lock requires a quote that recorded comparability bits`,
          );
        }
      }
      if (document.spec.evaluationRuntime?.adapterId === "swebench-harness") {
        const verified = SwebenchVerifiedSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        if (verified.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite SWE-bench Verified lock requires a quote that recorded comparability bits",
          );
        }
      }
      if (document.spec.evaluationRuntime?.adapterId === "archipelago") {
        const apex = ApexAgentsSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        if (apex.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite APEX-Agents lock requires a quote that recorded comparability bits",
          );
        }
      }
      if (document.spec.evaluationRuntime?.adapterId === APEX_SWE_DEV_ADAPTER_ID) {
        const apex = ApexSweDevSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        // Select seals replicates into the suite; the draft spec stays patchable until lock, so a
        // post-select `replicates: 5` would otherwise lock and quote as protocol-conforming k=1.
        if (document.spec.replicates !== apex.suite.replicates) {
          refuse(
            "conflict",
            `drafts.${input.draftId}.spec.replicates`,
            `APEX-SWE-dev sealed replicates ${apex.suite.replicates} at select; the draft now says ${document.spec.replicates} — re-run "runtime apex-swe-dev select"`,
          );
        }
        if (apex.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite APEX-SWE-dev lock requires a quote that recorded comparability bits",
          );
        }
      }
      if (document.spec.evaluationRuntime?.adapterId === "inspect") {
        const inspectSuite = readInspectEvalSelectionManifest(
          clockedContext.workspaceDir,
          document.spec.evaluationRuntime.selectionManifestSha256,
        );
        if (inspectSuite?.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite Inspect eval lock requires a quote that recorded comparability bits",
          );
        }
      }

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
      const compiled = compileDraft({
        workspaceDir: clockedContext.workspaceDir,
        draft: document,
        owner: runState.owner,
        closeAt,
      });

      const runWithPublicationAuthorization = withRunPublicationExtension(
        compiled.plannedRun.record as unknown as Record<string, unknown>,
        {
          registrationArtifacts: [...runtimeRegistrationArtifacts(clockedContext.workspaceDir, document.spec.evaluationRuntime)],
        },
      );
      // Declared anchoring intent (anchor-evidence design §7.3), sealed ONLY when the draft
      // declares it. A draft that declares nothing produces byte-identical Run records to the
      // ones this operation produced before the extension existed: the record object is not
      // touched at all, rather than extended with an empty declaration. Intent is the draft's own
      // statement, never derived from workspace configuration — deriving it would make the sealed
      // bytes depend on the machine that produced them.
      const declaredProviders = document.spec.anchoring?.declaredProviders;
      const runWithDeclaredIntent = declaredProviders === undefined
        ? runWithPublicationAuthorization
        : withRunAnchorIntentExtension(runWithPublicationAuthorization, {
          providers: [...new Set(declaredProviders)].sort(),
        });
      // Declared task-selection provenance (#2980), sealed on exactly the same terms as the
      // anchoring intent above: only when the draft declares it, so a draft that declares nothing
      // produces byte-identical Run records to the ones this operation produced before the
      // extension existed. Sealing is what makes the answer unforgeable after the lock; the cold
      // verifier separately refuses a declaration the Benchmark and Run records contradict.
      const declaredTaskSelection = document.spec.taskSelection;
      const runWithTaskSelection = declaredTaskSelection === undefined
        ? runWithDeclaredIntent
        : withRunTaskSelectionExtension(runWithDeclaredIntent, { mode: declaredTaskSelection });
      // The beacon source this run will bind to (#3426), sealed on exactly the same terms. Naming
      // it here — before any admissible beacon value exists — is what leaves `bind` no source to
      // choose: with the round already determined by `(source, sealedAt)` (#3322), a sealed source
      // determines the beacon outright. Declaring nothing stays legal and seals byte-identical
      // bytes; it just leaves the choice where PR #3375 found it, and the report face says so.
      const declaredBeaconSource = document.spec.beaconSource;
      const runWithBeaconSource = declaredBeaconSource === undefined
        ? runWithTaskSelection
        : withRunBeaconSourceExtension(runWithTaskSelection, { source: declaredBeaconSource });
      // Check the declaration against the records BEFORE the irreversible seal, using the exact
      // rule the cold verifier applies afterwards. Left to publish time, a contradiction would
      // surface only once the run had been locked, executed, reported, and materialized -- a
      // bundle the workspace can never verify, and no way back. Same rule, earlier and cheaper.
      // Computed from the benchmark this lock just compiled, so the sealed width can never describe
      // a different plan than the one being sealed. Sealed only on acknowledgement: n and the width
      // are both derivable from the plan, and the fact worth recording is that the operator saw the
      // width before the seal and locked at this n regardless.
      // An itemless benchmark has no n and therefore no width. It cannot reach a lock through any
      // shipped path, but guarding here keeps that a missing advisory rather than an untyped throw
      // out of the arithmetic, one line before the irreversible seal.
      const advisory = compiled.benchmarkRecord.items.length < 1
        ? undefined
        : sampleSizeAdvisory({
          items: compiled.benchmarkRecord.items.length,
          replicates: document.spec.replicates,
          declaredAnalyses: declaredAnalyses(document.spec),
        });
      const runWithSampleSizeAdvisory = input.acknowledgedSampleSizeAdvisory !== true || advisory === undefined
        ? runWithBeaconSource
        : withRunSampleSizeAdvisoryExtension(runWithBeaconSource, {
          n: advisory.n,
          expectedIntervalWidth: advisory.expectedIntervalWidth,
        });
      const sealed = sealRun(runWithSampleSizeAdvisory);
      if (declaredTaskSelection !== undefined) {
        // Judged on the exact bytes just sealed, so the rule cannot be shown a different Run from
        // the one that gets stored. This is the only refusal after `sealRun`, and it is safe there
        // because sealing is pure — the first side effect is the `putSealedBytes` below.
        const contradiction = taskSelectionContradiction({
          benchmarkRecord: compiled.benchmarkRecord,
          runRecord: parseRun(sealed.bytes),
        });
        if (contradiction !== undefined) refuse("validation", "spec.taskSelection", contradiction);
      }
      const runSha256 = putSealedBytes(clockedContext.workspaceDir, sealed.bytes);
      recordWorkspaceAuthorship({
        workspaceDir: clockedContext.workspaceDir,
        recordSha256: runSha256,
        recordKind: RUN_RECORD_KIND,
        authoredAt: at,
      });

      const transitioned = transition("quoted", "lock");
      if (!transitioned.ok) {
        // Unreachable given the state guard above — kept so a future TRANSITIONS edit fails
        // loud here instead of silently locking a state the table no longer permits.
        refuse("illegal-transition", `drafts.${input.draftId}.state`, transitioned.error.detail);
      }

      writeRunState(clockedContext.workspaceDir, input.draftId, {
        ...runState,
        runSha256,
        closeAt,
        lockedAt: at,
      });

      const draft: DraftDocument = { ...document, state: transitioned.state, updatedAt: at };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));

      return {
        draft,
        runSha256,
        closeAt,
        ...(runtimeMethod === undefined ? {} : { runtimeMethod }),
        ...(input.acknowledgedSampleSizeAdvisory === true && advisory !== undefined
          ? { sampleSizeAdvisory: advisory }
          : {}),
      };
    },
  });
}
