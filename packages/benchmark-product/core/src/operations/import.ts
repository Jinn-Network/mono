/**
 * The `import.swebench` operation (spec §10.1 op 1, product side): converts an
 * untyped SWE-bench row file into sealed Task + Benchmark bytes (via
 * `../intake/swebench.js`), stores every byte in the workspace's sealed-record
 * store (`putSealedBytes`, spec §4.5), and attaches the resulting Benchmark to
 * a draft's task set (`attachBenchmarkToDraft`, spec §4.1). `attachBenchmarkToDraft`
 * itself owns the draft-mutability, already-attached-conflict, and
 * quoted→draft-on-edit rules — this module's own job is the row → sealed bytes
 * → stored digests pipeline in front of it.
 *
 * Sync, like every other operation in this facade: `convertSweBenchRows` and
 * `putSealedBytes` are both pure/local — nothing here awaits I/O beyond the
 * synchronous filesystem writes `atomicWriteFileSync`/`putSealedBytes` already do.
 */

import type { DraftDocument } from "../domain/draft.js";
import { buildRepositoryWorkProfile, sealTaskProfile } from "@jinn-network/task-execution-profiles";
import { convertSweBenchRows } from "../intake/swebench.js";
import { deriveWorkspaceAuthoredBenchmark, deriveWorkspaceAuthoredTask } from "../intake/workspace-authored.js";
import { loadOrCreateReportSigningKey } from "../report/signing.js";
import { recordWorkspaceAuthorship } from "../run/publication-authority.js";
import { BENCHMARK_RECORD_KIND } from "@jinn-network/benchmarking-records";
import { RECORD_KINDS } from "@jinn-network/record-discovery-protocol";
import { putSealedBytes } from "../workspace/sealed-store.js";
import { attachBenchmarkToDraft } from "./attach.js";
import type { OperationContext } from "./context.js";
import { readDraftDocument } from "./drafts.js";
import { operate } from "./operate.js";
import type { OperationResult } from "./result.js";

export interface ImportSweBenchRowsInput {
  readonly draftId: string;
  /** Untyped row file content — validated by `convertSweBenchRows`. */
  readonly rows: unknown;
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly provenanceTimestamp?: string;
  /** Per-instance RFC 3339 timestamps keyed by `instance_id` (see `ConvertSweBenchRowsOptions`). */
  readonly provenanceTimestamps?: Readonly<Record<string, string>>;
}

export interface ImportSweBenchRowsResult {
  readonly draft: DraftDocument;
  readonly benchmarkSha256: string;
  readonly taskSha256s: readonly string[];
  readonly evaluationSpecSha256s: readonly string[];
}

/** Strips the platform's `sha256:` digest prefix; the store deals in bare hex only. */
function bareHex(digest: `sha256:${string}` | string): string {
  return digest.startsWith("sha256:") ? digest.slice("sha256:".length) : digest;
}

export function importSweBenchRows(
  context: OperationContext,
  input: ImportSweBenchRowsInput,
): OperationResult<ImportSweBenchRowsResult> {
  const at = context.clock();
  const clockedContext: OperationContext = { ...context, clock: () => at };

  return operate({
    context: clockedContext,
    action: "import.swebench",
    subject: input.draftId,
    inputs: input,
    run: () => {
      // Read first so a missing draft fails fast, before any conversion work,
      // and so its name/description can seed the Benchmark's own metadata.
      const document = readDraftDocument(clockedContext.workspaceDir, input.draftId);

      const converted = convertSweBenchRows(input.rows, {
        name: input.name ?? document.spec.name,
        description: input.description ?? document.spec.description ?? "",
        version: input.version ?? "1.0.0",
        ...(input.provenanceTimestamp !== undefined ? { provenanceTimestamp: input.provenanceTimestamp } : {}),
        ...(input.provenanceTimestamps !== undefined ? { provenanceTimestamps: input.provenanceTimestamps } : {}),
      });
      const imported = converted.imported;
      const author = loadOrCreateReportSigningKey(clockedContext.workspaceDir).keyId;

      // SWE-bench Tasks bind the repository-work profile by digest. Keep its exact sealed bytes
      // in the workspace so the publication closure remains content-addressed and offline.
      putSealedBytes(
        clockedContext.workspaceDir,
        sealTaskProfile(buildRepositoryWorkProfile()).bytes,
      );

      const authoredTasks = imported.tasks.map((task) => {
        // Retain the exact imported source Task, then create an explicit provenance-bearing,
        // digest-changing Colophon record. The source bytes are never silently reattributed.
        const sourceStored = putSealedBytes(clockedContext.workspaceDir, task.bytes);
        const authored = deriveWorkspaceAuthoredTask({
          sourceBytes: task.bytes,
          author,
          sourceKind: "swe-bench-import",
        });
        const stored = putSealedBytes(clockedContext.workspaceDir, authored.bytes);
        const expected = bareHex(task.digest);
        // putSealedBytes derives its returned digest from sha256(bytes) itself, so this
        // can only diverge if the platform's reported digest disagrees with the exact
        // bytes it also handed us — a platform invariant violation, not a caller error,
        // but still worth a loud failure over a silently mis-addressed store entry.
        if (sourceStored !== expected) {
          throw new Error(`sealed source task digest mismatch: platform reported ${expected}`);
        }
        recordWorkspaceAuthorship({
          workspaceDir: clockedContext.workspaceDir,
          recordSha256: stored,
          recordKind: RECORD_KINDS.task,
          authoredAt: at,
        });
        return { sha256: stored, bytes: authored.bytes };
      });
      const taskSha256s = authoredTasks.map((task) => task.sha256);

      const evaluationSpecSha256s = converted.evaluationSpecs.map((spec) => {
        const stored = putSealedBytes(clockedContext.workspaceDir, spec.bytes);
        // Bare throw, matching the two structurally identical assertions above: this is a
        // platform/store invariant violation, not a caller error, and `operate()` audits it as
        // `execution`. (`record-integrity` is documented as the read-side digest check.)
        if (stored !== spec.digest) {
          throw new Error(
            `sealed evaluation spec digest mismatch: intake reported ${spec.digest}, store computed ${stored}`,
          );
        }
        return stored;
      });

      const sourceBenchmarkStored = putSealedBytes(clockedContext.workspaceDir, imported.benchmark.bytes);
      const expectedBenchmarkSha256 = bareHex(imported.benchmark.digest);
      if (sourceBenchmarkStored !== expectedBenchmarkSha256) {
        throw new Error(
          `sealed source benchmark digest mismatch: platform reported ${expectedBenchmarkSha256}`,
        );
      }
      const authoredBenchmark = deriveWorkspaceAuthoredBenchmark({
        sourceBytes: imported.benchmark.bytes,
        taskSha256s,
        author,
      });
      const benchmarkSha256 = putSealedBytes(clockedContext.workspaceDir, authoredBenchmark.bytes);
      recordWorkspaceAuthorship({
        workspaceDir: clockedContext.workspaceDir,
        recordSha256: benchmarkSha256,
        recordKind: BENCHMARK_RECORD_KIND,
        authoredAt: at,
      });

      const draft = attachBenchmarkToDraft(clockedContext.workspaceDir, input.draftId, benchmarkSha256, at);

      return { draft, benchmarkSha256, taskSha256s, evaluationSpecSha256s };
    },
  });
}
