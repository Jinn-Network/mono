import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY,
  parseBinaryJudgmentInstrument,
  sealBinaryJudgmentSnapshotProbe,
  SNAPSHOT_PROBE_MAX_AGE_MS,
} from "@jinn-network/task-execution-profiles";
import { canonicalJsonBytes } from "@jinn-network/trust-core";
import { isDraftMutable, transition, type LifecycleState } from "../domain/lifecycle.js";
import { parseDraftSpec, type DraftDocument } from "../domain/draft.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs/atomic.js";
import {
  INSPECT_BINARY_JUDGE_ADAPTER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_ID,
  INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
  InspectBinaryJudgeBindingRequestSchema,
  type InspectBinaryJudgeBindingRequest,
  type InspectBinaryJudgeSelectionManifest,
} from "../runtime/inspect/binary-judge-manifest.js";
import { inspectBinaryJudgeWorkerSha256 } from "../runtime/inspect/binary-judge.js";
import { inspectOciRunnerSha256 } from "../runtime/inspect/oci.js";
import { draftPath, runtimeHostPath } from "../workspace/layout.js";
import { getSealedBytes, putSealedBytes, sha256Hex } from "../workspace/sealed-store.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface BindInspectBinaryJudgeInput {
  readonly draftId: string;
  readonly binding: InspectBinaryJudgeBindingRequest;
}

export interface BindInspectBinaryJudgeResult {
  readonly draft: DraftDocument;
  readonly selectionManifestSha256: string;
  readonly instruments: readonly { readonly armId: string; readonly instrumentSha256: string }[];
}

function runtimeSourceSha256(name: "broker.py" | "model_provider.py"): string {
  return sha256Hex(new Uint8Array(readFileSync(new URL(`../runtime/inspect/${name}`, import.meta.url))));
}

function validateInstrumentClosure(
  workspaceDir: string,
  manifest: InspectBinaryJudgeSelectionManifest,
): void {
  for (const arm of manifest.arms) {
    const bytes = getSealedBytes(workspaceDir, arm.instrumentSha256.slice("sha256:".length));
    const instrument = parseBinaryJudgmentInstrument(bytes);
    if (
      instrument.instrumentId !== arm.armId
      || instrument.model.requested !== arm.model
      || JSON.stringify(instrument.model.generation) !== JSON.stringify(arm.generation)
    ) {
      refuse(
        "conflict",
        `inspect.binaryJudge.arms.${arm.armId}`,
        "instrument model or generation block differs from the sealed arm",
      );
    }
  }
}

/**
 * Binds already-sealed judge instruments to an imported benchmark. Intake owns Task creation;
 * this operation changes only per-arm effective requirements and the runtime selection.
 */
export function bindInspectBinaryJudge(
  context: OperationContext,
  input: BindInspectBinaryJudgeInput,
): OperationResult<BindInspectBinaryJudgeResult> {
  const at = context.clock();
  const clockedContext = { ...context, clock: () => at };
  return operate({
    context: clockedContext,
    action: "runtime.inspect.bind-judge",
    subject: input.draftId,
    inputs: input,
    run: () => {
      const current = readDraftDocument(clockedContext.workspaceDir, input.draftId);
      if (!isDraftMutable(current.state)) {
        refuse("illegal-transition", `drafts.${input.draftId}.state`, "locked drafts refuse judge runtime binding");
      }
      if (current.spec.taskSet.kind !== "benchmark") {
        refuse("conflict", `drafts.${input.draftId}.taskSet`, "bind-judge requires an imported benchmark");
      }
      const parsed = InspectBinaryJudgeBindingRequestSchema.safeParse(input.binding);
      if (!parsed.success) {
        refuse("validation", "inspect.binaryJudge.binding", "binary-judge binding does not satisfy the versioned contract");
      }
      const { manifest, host, snapshotProbe } = parsed.data;
      if (!isAbsolute(host.dockerPath)) {
        refuse("validation", "inspect.binaryJudge.host.dockerPath", "Docker path must be absolute");
      }
      if (host.imageDigest !== manifest.runtime.imageDigest || host.platform !== manifest.runtime.platform) {
        refuse("conflict", "inspect.binaryJudge.host", "private host image/platform differs from the sealed runtime");
      }
      if (
        manifest.runtime.runtimeHostSourceSha256 !== inspectOciRunnerSha256()
        || manifest.runtime.workerSourceSha256 !== inspectBinaryJudgeWorkerSha256()
        || manifest.runtime.brokerSourceSha256 !== runtimeSourceSha256("broker.py")
        || manifest.runtime.modelProviderSourceSha256 !== runtimeSourceSha256("model_provider.py")
      ) {
        refuse("conflict", "inspect.binaryJudge.runtime", "selected worker or broker source differs from this product build");
      }
      validateInstrumentClosure(clockedContext.workspaceDir, manifest);
      if (manifest.snapshotProbeSha256 !== undefined) {
        // The binding-request schema already guarantees `snapshotProbe` is present exactly when
        // `manifest.snapshotProbeSha256` is (spec §1.5 rule 2).
        const probe = snapshotProbe!;
        const sealed = sealBinaryJudgmentSnapshotProbe(probe);
        if (sealed.digest !== manifest.snapshotProbeSha256) {
          refuse(
            "conflict",
            "inspect.binaryJudge.snapshotProbe",
            "supplied snapshot-serving probe does not seal to manifest.snapshotProbeSha256",
          );
        }
        // Seal into the workspace CAS now so `materialize` can publish it as a bundle asset
        // (§1.5 rule 5); the digest is already proven above.
        putSealedBytes(clockedContext.workspaceDir, sealed.bytes);
        if (!manifest.arms.some((arm) => arm.model === probe.requestedModel)) {
          refuse(
            "conflict",
            "inspect.binaryJudge.snapshotProbe",
            "probe requestedModel does not match any bound arm's model",
          );
        }
        if (probe.outcome !== "serving") {
          // §1.5 rule 4: this is the branch where the design changes in public first.
          refuse(
            "conflict",
            "inspect.binaryJudge.snapshotProbe",
            "probe reports the dated snapshot is not serving",
          );
        }
        // §1.5 rule 3, freshness. The bind clock is `at`, computed once above. The design says
        // "immediately before the run"; 24 hours is the CHECKABLE bound, and the G4 checklist
        // keeps the operational discipline tighter. Enforced here, and only here (§0.5).
        const probedAtMs = Date.parse(probe.probedAt);
        const atMs = Date.parse(at);
        if (probedAtMs > atMs) {
          refuse(
            "conflict",
            "inspect.binaryJudge.snapshotProbe",
            "probe is dated in the future relative to the bind clock",
          );
        }
        if (atMs - probedAtMs > SNAPSHOT_PROBE_MAX_AGE_MS) {
          refuse(
            "conflict",
            "inspect.binaryJudge.snapshotProbe",
            "probe is older than the snapshot-serving freshness bound",
          );
        }
      }
      const selectionManifestSha256 = putSealedBytes(
        clockedContext.workspaceDir,
        canonicalJsonBytes(manifest),
      );
      atomicWriteFileSync(
        runtimeHostPath(clockedContext.workspaceDir, selectionManifestSha256),
        JSON.stringify(host, null, 2),
      );
      let nextState: LifecycleState = current.state;
      if (current.state === "quoted") {
        const edited = transition("quoted", "edit");
        if (edited.ok) nextState = edited.state;
      }
      const spec = parseDraftSpec({
        ...current.spec,
        arms: manifest.arms.map((arm) => ({
          armId: arm.armId,
          pinning: {
            harness: {
              id: INSPECT_BINARY_JUDGE_LAUNCHER_ID,
              version: INSPECT_BINARY_JUDGE_LAUNCHER_VERSION,
            },
            model: { id: arm.model },
            [BINARY_JUDGMENT_INSTRUMENT_REQUIREMENT_KEY]: arm.instrumentSha256,
          },
        })),
        evaluationRuntime: {
          adapterId: INSPECT_BINARY_JUDGE_ADAPTER_ID,
          selectionManifestSha256,
          isolationPolicy: "oci-container",
        },
      });
      const draft: DraftDocument = { ...current, state: nextState, updatedAt: at, spec };
      atomicWriteFileSync(draftPath(clockedContext.workspaceDir, input.draftId), JSON.stringify(draft, null, 2));
      return {
        draft,
        selectionManifestSha256,
        instruments: manifest.arms.map(({ armId, instrumentSha256 }) => ({ armId, instrumentSha256 })),
      };
    },
  });
}
