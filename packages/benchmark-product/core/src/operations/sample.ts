/**
 * `sample.init` (BP-11, docs/superpowers/plans/2026-08-05-benchmark-product-issue-drafts.md
 * Draft 4): "from an empty workspace, a bundled sample produces a draft with
 * a sealed Benchmark". Builds the platform-derived sample (../intake/sample.ts),
 * stores every artifact in the workspace's digest-addressed sealed-bytes
 * store (spec §4.5), and attaches the resulting Benchmark digest to the
 * draft via `attachBenchmarkToDraft` (./attach.ts), which owns the
 * draft-state rules (mutability, quoted-invalidation, re-attach refusal).
 *
 * Runs through `operateAsync` (./operate-async.ts), not `operate`, because
 * building the sample and sealing its admission receipts are async
 * (../intake/sample.ts's own header explains why).
 *
 * Re-run semantics: a second `sample.init` on the same draft is refused
 * `"conflict"` by `attachBenchmarkToDraft` — re-putting the same bytes a
 * second time is a no-op (digest-addressed storage), so the only thing that
 * actually refuses is the draft-level "already has a benchmark" rule.
 */

import type { DraftDocument } from "../domain/draft.js";
import { buildPredictionForecastProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { buildSampleBenchmark } from "../intake/sample.js";
import { attachBenchmarkToDraft } from "./attach.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operateAsync } from "./operate-async.js";
import type { OperationResult } from "./result.js";

export interface SampleInitInput {
  readonly draftId: string;
}

export interface SampleInitTaskSummary {
  readonly marketId: string;
  readonly taskSha256: string;
  readonly receiptSha256: string;
}

export interface SampleInitResult {
  readonly draft: DraftDocument;
  readonly benchmarkSha256: string;
  readonly evaluationSpecSha256: string;
  readonly tasks: readonly SampleInitTaskSummary[];
}

export function sampleInit(
  context: OperationContext,
  input: SampleInitInput,
): Promise<OperationResult<SampleInitResult>> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operateAsync({
    context: clockedContext,
    action: "sample.init",
    subject: input.draftId,
    inputs: input,
    run: async () => {
      // Fail fast on a missing draft before doing the comparatively
      // expensive sample-build and sealed-bytes work below.
      readDraftDocument(clockedContext.workspaceDir, input.draftId);

      const sample = await buildSampleBenchmark();

      // Registration closes every digest-bearing Task descriptor. Retain the exact built-in
      // profile bytes alongside the Task/EvaluationSpec so a later prospective or post-hoc
      // publication never has to substitute a URI for the digest-pinned document.
      putSealedBytes(
        clockedContext.workspaceDir,
        sealTaskProfile(buildPredictionForecastProfile()).bytes,
      );
      const evaluationSpecSha256 = putSealedBytes(clockedContext.workspaceDir, sample.evaluationSpec.bytes);
      const tasks: SampleInitTaskSummary[] = sample.tasks.map((task) => {
        const taskSha256 = putSealedBytes(clockedContext.workspaceDir, task.bytes);
        const receiptSha256 = putSealedBytes(clockedContext.workspaceDir, task.receipt.envelopeBytes);
        return { marketId: task.marketId, taskSha256, receiptSha256 };
      });
      const benchmarkSha256 = putSealedBytes(clockedContext.workspaceDir, sample.benchmark.bytes);

      const draft = attachBenchmarkToDraft(clockedContext.workspaceDir, input.draftId, benchmarkSha256, at);

      return { draft, benchmarkSha256, evaluationSpecSha256, tasks };
    },
  });
}
