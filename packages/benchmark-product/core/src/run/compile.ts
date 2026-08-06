/**
 * Compiles a draft into a `planRun` input and seals the platform's Run record from it
 * (BP-12, M1 composition dossier §1: "Run wiring"). This is the one place a draft's product
 * policy fields become the platform's `@jinn-network/benchmarking-run` / `-records` shapes —
 * `run-quote.ts` and `run-lock.ts` both call it so the exact same compilation runs at quote
 * time and again at lock time (A2's quote-invalidation check compares the draft spec's own
 * digest, not the compiled output, so re-compiling at lock is always safe and always exact).
 *
 * Product-policy refusals (draft content this module itself judges invalid) run FIRST, before
 * any platform call: no attached benchmark, and fewer than two arms (charter decision 7 — a
 * comparative benchmark needs at least two configurations to compare). Everything after that is
 * `planRun`'s and `sealRun`'s own platform-schema validation; failures there are caught and
 * re-raised as this product's typed `"validation"` error carrying the platform's own detail —
 * this module never redefines what a valid Run record is, it only forwards the platform's
 * judgment through the product's typed-error posture (spec §4.3).
 */

import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  InvalidDocumentError,
  parseBenchmark,
  type BenchmarkRecord,
  type RunArm,
} from "@jinn-network/benchmarking-records";
import { planRun, type PlannedRun } from "@jinn-network/benchmarking-run";
import { VENUE_ISOLATION_POLICY } from "../venue/venue.js";
import { resolveAssurance, type DraftDocument } from "../domain/draft.js";
import { refuse, refuseWithIssues } from "../errors.js";
import { getSealedBytes } from "../workspace/sealed-store.js";

export interface CompileDraftInput {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  /** The run owner IRI (`state.ts`'s `deriveRunOwner`). */
  readonly owner: string;
  /** Absolute RFC 3339 close instant — the caller resolves `closeAfterMs` against its clock. */
  readonly closeAt: string;
}

export interface CompiledRun {
  readonly plannedRun: PlannedRun;
  readonly benchmarkRecord: BenchmarkRecord;
  readonly benchmarkSha256: string;
}

function detailFromCause(cause: unknown): string {
  if (cause instanceof InvalidDocumentError) {
    return cause.errors.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Product-policy refusals, then `planRun` — see module header. */
export function compileDraft(input: CompileDraftInput): CompiledRun {
  const { workspaceDir, draft, owner, closeAt } = input;
  const spec = draft.spec;

  if (spec.taskSet.kind !== "benchmark") {
    refuse(
      "validation",
      "spec.taskSet",
      "the draft has no attached benchmark task set — run sample.init or import.swebench first",
    );
  }
  if (spec.arms.length < 2) {
    refuse(
      "validation",
      "spec.arms",
      "a benchmark run compares configurations — at least 2 arms are required",
    );
  }

  const benchmarkSha256 = spec.taskSet.benchmarkSha256;
  const benchmarkRecord = parseBenchmark(getSealedBytes(workspaceDir, benchmarkSha256));

  const arms: RunArm[] = spec.arms.map((arm) => ({
    armId: arm.armId,
    pinning: arm.pinning as Record<string, unknown>,
  }));

  const resolvedAssurance = resolveAssurance(spec.assurance);

  let plannedRun: PlannedRun;
  try {
    plannedRun = planRun({
      benchmarkDigest: `sha256:${benchmarkSha256}`,
      owner,
      arms,
      replicates: spec.replicates,
      policy: {
        completenessFloor: spec.policy.completenessFloor,
        cellWindow: spec.policy.cellWindowMs,
        replacement: spec.policy.replacement,
        independence: resolvedAssurance.independence,
        evaluation: {
          minVerdicts: resolvedAssurance.minVerdicts,
          distinctEvaluator: resolvedAssurance.distinctEvaluator,
        },
        submissionBaseline: { isolationPolicy: VENUE_ISOLATION_POLICY },
      },
      analysisPlan: [
        { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
      ],
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      venue: { kind: "self-run" },
      closeAt,
    });
  } catch (cause) {
    refuse("validation", "spec", `run compilation failed platform validation: ${detailFromCause(cause)}`);
  }

  return { plannedRun, benchmarkRecord, benchmarkSha256 };
}
