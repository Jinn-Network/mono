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

import { convertSweBenchRows } from "../intake/swebench.js";
import type { DraftDocument } from "../domain/draft.js";
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
}

export interface ImportSweBenchRowsResult {
  readonly draft: DraftDocument;
  readonly benchmarkSha256: string;
  readonly taskSha256s: readonly string[];
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
      });

      const taskSha256s = converted.tasks.map((task) => {
        const stored = putSealedBytes(clockedContext.workspaceDir, task.bytes);
        const expected = bareHex(task.digest);
        // putSealedBytes derives its returned digest from sha256(bytes) itself, so this
        // can only diverge if the platform's reported digest disagrees with the exact
        // bytes it also handed us — a platform invariant violation, not a caller error,
        // but still worth a loud failure over a silently mis-addressed store entry.
        if (stored !== expected) {
          throw new Error(`sealed task digest mismatch: platform reported ${expected}, store computed ${stored}`);
        }
        return stored;
      });

      const benchmarkSha256 = putSealedBytes(clockedContext.workspaceDir, converted.benchmark.bytes);
      const expectedBenchmarkSha256 = bareHex(converted.benchmark.digest);
      if (benchmarkSha256 !== expectedBenchmarkSha256) {
        throw new Error(
          `sealed benchmark digest mismatch: platform reported ${expectedBenchmarkSha256}, store computed ${benchmarkSha256}`,
        );
      }

      const draft = attachBenchmarkToDraft(clockedContext.workspaceDir, input.draftId, benchmarkSha256, at);

      return { draft, benchmarkSha256, taskSha256s };
    },
  });
}
