/**
 * SWE-bench-shaped row intake (spec §10.1 op 1, product side): turns an untyped
 * SWE-bench row file into the platform's sealed `ImportedBenchmark` via
 * `@jinn-network/benchmarking-interop`'s `importSweBench`.
 *
 * This module validates the row FILE payload before any platform call, so a
 * malformed row fails HERE with typed `validation` issues at `rows.<index>.<field>`
 * paths, ahead of the platform's own deeper (throw-on-first-mismatch) mapping.
 * `image` and `testMaterial` are validated only as plain-object / array-of-plain-object
 * shapes here — their full ResourceDescriptor shape belongs to
 * `@jinn-network/task-execution-profiles`, which this product deliberately does not
 * depend on. A row whose `image`/`testMaterial`/`parser` fails the platform's own
 * stricter shape surfaces as a generic re-raised `validation` error below, not a
 * `rows.<index>.<field>` issue — the platform's deeper mapping ran and threw.
 *
 * Two platform-named checks are surfaced as typed issues rather than left as bare
 * throws:
 *  - `benchmark-judgeability` — the platform's own named check, run inside
 *    `importSweBench`; its throw message is passed through as the issue message.
 *  - `benchmark-item-distinctness` — `checkItemDistinctness`, run here explicitly.
 *    The Benchmark schema itself does not refuse duplicate items, so this product
 *    surfaces the platform's named check as a typed refusal instead of silently
 *    admitting a Benchmark with repeated Task digests.
 */

import { importSweBench, type ImportedBenchmark, type SweBenchRow } from "@jinn-network/benchmarking-interop";
import { checkItemDistinctness } from "@jinn-network/benchmarking-records";
import { sealEvaluationSpec, sweRebenchRowToTaskAndSpec } from "@jinn-network/task-execution-profiles";
import { z } from "zod";
import { refuse, refuseWithIssues } from "../errors.js";

const PlainObjectSchema = z.record(z.string(), z.unknown());

const SweBenchRowSchema = z.object({
  instance_id: z.string().min(1),
  repo: z.string().min(1),
  base_commit: z.string().min(1),
  problem_statement: z.string().min(1),
  language: z.string().min(1),
  image: PlainObjectSchema,
  testMaterial: z.array(PlainObjectSchema),
  parser: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    digest: z.string().min(1),
  }),
  transitions: z.object({
    failToPass: z.array(z.string()),
    passToPass: z.array(z.string()),
  }),
  timeout: z.number().int().positive(),
});

const SweBenchRowsFileSchema = z.array(SweBenchRowSchema);

export interface ConvertSweBenchRowsOptions {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  /** Omitted keeps the platform importer's own deterministic default (see `importSweBench`). */
  readonly provenanceTimestamp?: string;
}

export interface ConvertedSweBenchRows {
  readonly imported: ImportedBenchmark;
  /** One entry per row, keyed by its own digest. The platform's `ImportedBenchmark` deliberately
   *  carries only the digest, so the product re-seals to retain the bytes the venue requires. */
  readonly evaluationSpecs: readonly { readonly digest: string; readonly bytes: Uint8Array }[];
}

function issuesFromZodError(error: z.ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? `rows.${issue.path.join(".")}` : "rows",
    message: issue.message,
  }));
}

/**
 * Validates `rowsInput` against the SWE-bench row file shape, then converts it via
 * the platform's `importSweBench` (see module header). Refuses `"validation"`:
 *  - with `rows.<index>.<field>` issues when the row file itself is malformed;
 *  - with a single `"benchmark-judgeability"` issue when the platform's own named
 *    judgeability check fails (the platform's throw message is carried through);
 *  - with a single `"benchmark-item-distinctness"` issue naming the duplicate task
 *    digest when two rows import to the same Task.
 */
export function convertSweBenchRows(rowsInput: unknown, opts: ConvertSweBenchRowsOptions): ConvertedSweBenchRows {
  const parsedRows = SweBenchRowsFileSchema.safeParse(rowsInput);
  if (!parsedRows.success) {
    refuseWithIssues("validation", issuesFromZodError(parsedRows.error));
  }

  let imported: ImportedBenchmark;
  try {
    imported = importSweBench(parsedRows.data as unknown as readonly SweBenchRow[], opts);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Fragile-by-necessity coupling: the importer throws a plain Error on a
    // judgeability failure, so the named check is recovered by matching its
    // message. If the platform ever rewords that message, this degrades to
    // the generic `rows` path below — and the golden-row test for this
    // mapping goes red on that drift, so the coupling is self-detecting,
    // never silent.
    if (message.includes("checkJudgeability")) {
      refuseWithIssues("validation", [{ path: "benchmark-judgeability", message }]);
    }
    refuse("validation", "rows", message);
  }

  const distinctness = checkItemDistinctness(imported.benchmark.record);
  if (!distinctness.ok) {
    refuseWithIssues("validation", [
      { path: "benchmark-item-distinctness", message: `duplicate task digest ${distinctness.duplicate}` },
    ]);
  }

  const evaluationSpecs = (parsedRows.data as unknown as readonly SweBenchRow[]).map((row) => {
    const mapped = sweRebenchRowToTaskAndSpec(row);
    const sealed = sealEvaluationSpec(mapped.evaluationSpec);
    // Sealing is deterministic, so re-sealing reproduces the exact bytes the Task already commits
    // to. Assert rather than assume — a drift here would persist bytes under a digest no Task
    // references, which is silent and would only surface as an ungradeable cell mid-run.
    if (sealed.digest !== mapped.evaluationSpecDigest) {
      refuse("record-integrity", "rows", `re-sealed EvaluationSpec digest ${sealed.digest} does not match ${mapped.evaluationSpecDigest}`);
    }
    return { digest: sealed.digest.slice("sha256:".length), bytes: sealed.bytes };
  });

  return { imported, evaluationSpecs };
}
