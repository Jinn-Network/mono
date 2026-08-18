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

import { RUN_RECORD_KIND, sealRun, withRunPublicationExtension } from "@jinn-network/benchmarking-records";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { transition } from "../domain/lifecycle.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import { compileDraft } from "../run/compile.js";
import {
  inspectRuntimeMethodForBinding,
  type InspectRuntimeMethodDisclosure,
} from "../runtime/inspect/disclosure.js";
import { requireRunState, specDigest, writeRunState } from "../run/state.js";
import { draftPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes } from "../workspace/sealed-store.js";
import { HarborSelectionManifestSchema } from "../runtime/harbor/manifest.js";
import { suiteSelectionFromHarbor } from "../runtime/suite-protocol/from-harbor.js";
import { readInspectAsSpecifiedSelectionManifest } from "../runtime/inspect/host.js";
import { runtimeRegistrationArtifacts } from "../runtime/adapter.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface RunLockInput {
  readonly draftId: string;
}

export interface RunLockResult {
  readonly draft: DraftDocument;
  readonly runSha256: string;
  readonly closeAt: string;
  readonly runtimeMethod?: InspectRuntimeMethodDisclosure;
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
      if (document.spec.evaluationRuntime?.adapterId === "harbor") {
        const harborSelection = HarborSelectionManifestSchema.parse(
          JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(getSealedBytes(clockedContext.workspaceDir, document.spec.evaluationRuntime.selectionManifestSha256))),
        );
        const suite = suiteSelectionFromHarbor(harborSelection);
        if (suite?.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite Terminal-Bench 2.1 lock requires a quote that recorded comparability bits",
          );
        }
      }
      if (document.spec.evaluationRuntime?.adapterId === "inspect") {
        const inspectSuite = readInspectAsSpecifiedSelectionManifest(
          clockedContext.workspaceDir,
          document.spec.evaluationRuntime.selectionManifestSha256,
        );
        if (inspectSuite?.coverage === "full" && runState.suiteQuote === undefined) {
          refuse(
            "conflict",
            `runs.${input.draftId}.suiteQuote`,
            "full-suite Inspect-as-specified lock requires a quote that recorded comparability bits",
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
      const sealed = sealRun(runWithPublicationAuthorization);
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
      };
    },
  });
}
