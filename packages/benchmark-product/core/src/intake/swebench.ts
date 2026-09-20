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
 *    A malformed `provenanceTimestamp`/`provenanceTimestamps` value is refused at
 *    the platform edge as `ProvenanceTimestampError`; this product maps `option`
 *    onto `issues[].path` so a machine caller can distinguish a bad timestamp from
 *    a row-shape failure without parsing prose (#3365). The remaining
 *    `benchmark-judgeability` mapping matches
 *    `SWE_BENCH_JUDGEABILITY_FAILURE_MESSAGE_PREFIX` (#3364).
 *  - `benchmark-item-distinctness` — `checkItemDistinctness`, run here explicitly.
 *    The Benchmark schema itself does not refuse duplicate items, so this product
 *    surfaces the platform's named check as a typed refusal instead of silently
 *    admitting a Benchmark with repeated Task digests.
 */

import {
  importSweBench,
  ProvenanceTimestampError,
  SWE_BENCH_JUDGEABILITY_FAILURE_MESSAGE_PREFIX,
  type ImportedBenchmark,
  type SweBenchRow,
} from "@jinn-network/benchmarking-interop";
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
  /** Per-instance RFC 3339 timestamps keyed by `instance_id`; each falls back to
   *  `provenanceTimestamp`, then the importer's default. Omitting the map preserves today's
   *  behavior exactly, so the default path stays byte-deterministic. */
  readonly provenanceTimestamps?: Readonly<Record<string, string>>;
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
 *  - with a single `"provenanceTimestamp"` / `provenanceTimestamps["<id>"]` issue
 *    when the platform refuses a malformed timestamp option (#3365);
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
    if (cause instanceof ProvenanceTimestampError) {
      refuse("validation", cause.option, cause.message);
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    // The named check is recovered by matching the shared prefix exported by the
    // platform (#3364). A reword of that prefix turns this mapping test red
    // (swebench.judgeability-mapping.test.ts builds the stub from the same helper).
    if (message.startsWith(SWE_BENCH_JUDGEABILITY_FAILURE_MESSAGE_PREFIX)) {
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

  const rows = parsedRows.data as unknown as readonly SweBenchRow[];
  const evaluationSpecs = rows.map((row, index) => {
    const sealed = sealEvaluationSpec(sweRebenchRowToTaskAndSpec(row).evaluationSpec);
    const digest = sealed.digest.slice("sha256:".length);
    // The binding property is agreement with the digest the SEALED TASK actually references —
    // comparing the re-seal against the mapper's own digest would only restate that
    // `sealEvaluationSpec` is deterministic, which proves nothing about the Task. Reading the
    // Task's own bytes is what catches persisting a spec under a digest no Task points at, which
    // is silent at import and would surface only as an ungradeable cell mid-run.
    const taskDoc = JSON.parse(new TextDecoder().decode(imported.tasks[index]!.bytes)) as {
      evaluation?: { digest?: { sha256?: string } };
    };
    const referenced = taskDoc.evaluation?.digest?.sha256;
    if (referenced !== digest) {
      refuse(
        "record-integrity",
        `rows.${index}`,
        `re-sealed EvaluationSpec digest ${digest} does not match the digest task ${row.instance_id} references (${String(referenced)})`,
      );
    }
    return { digest, bytes: sealed.bytes };
  });

  return { imported, evaluationSpecs };
}
