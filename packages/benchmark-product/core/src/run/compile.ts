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
 *
 * BP-13 CORRECTION (F2): the sole `analysisPlan` entry's `parameters` carries the draft's
 * resolved `verdictRule` (`{ verdictRule: resolvedAssurance.verdictRule }`), not `{}`.
 * `@jinn-network/benchmarking-aggregate`'s `produceReport` merges `verdictRule` into the method's
 * own parameters tuple before comparing it against a Run's sealed `analysisPlan` entries
 * (`report.ts`'s `derivePreregistered`, exact-JSON equality) to derive `preregistered`. An empty
 * `parameters` object here can never equal that merged tuple, so every report produced from a
 * Run compiled this way would derive `preregistered: false` regardless of how genuinely
 * pre-registered the analysis was — this field is what BP-13's Report operation reads back to
 * prove pre-registration, so it must already carry the exact shape `produceReport` will compare
 * against.
 *
 * BP-20: `compilePreviewRun` shares the same product-policy refusals and the same
 * `planFromSpec` tail as `compileDraft` (extracted below so both call sites can never drift), but
 * plans against an EPHEMERAL, in-memory subset Benchmark instead of the draft's official one —
 * the first `itemLimit` (or all) items of the attached Benchmark, re-sealed in memory via
 * `sealBenchmark` and never written to the workspace's sealed-bytes store. A preview must never
 * produce an official sealed record (spec §7.2); this is how the plan/seal path that produces one
 * is reused for a rehearsal without ever letting the rehearsal's own subset Benchmark become one.
 */

import { BENCHMARKING_METHOD_REGISTRY } from "@jinn-network/benchmarking-aggregate";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  InvalidDocumentError,
  parseBenchmark,
  sealBenchmark,
  type BenchmarkRecord,
  type RunArm,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { planRun, type PlannedRun } from "@jinn-network/benchmarking-run";
import { resolveAssurance, type DraftDocument, type DraftSpec, type ResolvedAssurance } from "../domain/draft.js";
import { refuse, refuseWithIssues } from "../errors.js";
import { runtimeSubmissionBaseline } from "../runtime/adapter.js";
import { getSealedBytes, sha256Hex } from "../workspace/sealed-store.js";

/** The sealed Run record's own analysisPlan entry shape — reused rather than invented so this
 * module can never drift from what `planRun`/`sealRun` actually accept. */
type RunAnalysisPlanEntry = NonNullable<RunRecord["analysisPlan"]>[number];

/**
 * The sealed analysis plan. `wilson@1` is always present — it is the product's baseline read and
 * every existing consumer expects it — and a selected non-wilson method is appended, so the plan
 * honestly pre-registers both analyses at lock.
 *
 * Refusals happen HERE, at compile time, deliberately. Neither `planRun` nor the records schema
 * validates method ids (`benchmarking/run/src/plan.ts`, `records/src/run/schema.ts`'s
 * `AnalysisPlanEntrySchema` accept free strings), so an unregistered id or a malformed parameter
 * would otherwise seal into an immutable Run and only fail at `report` time — after the run has
 * been executed and paid for.
 */
/** `analysis.parameters` keys `buildAnalysisPlan` always derives itself — from the draft's
 * resolved `verdictRule` and the validated `analysis.baseline`/`analysis.candidate` — never from
 * caller-supplied `parameters`. A caller setting one of these is expressing a misunderstanding of
 * how the plan is assembled and must be told, not silently overridden or silently stripped. */
const RESERVED_ANALYSIS_PARAMETER_KEYS = ["verdictRule", "baseline", "candidate"] as const;

function buildAnalysisPlan(spec: DraftSpec, verdictRule: ResolvedAssurance["verdictRule"]): RunAnalysisPlanEntry[] {
  const wilson: RunAnalysisPlanEntry = {
    method: BENCHMARKING_METHOD_IDS.wilson,
    version: BENCHMARKING_METHOD_VERSION,
    parameters: { verdictRule },
  };
  const analysis = spec.analysis;
  if (analysis === undefined) return [wilson];

  if (analysis.method === BENCHMARKING_METHOD_IDS.wilson) {
    // An explicit wilson selection must refuse loudly on anything it can't honor, same as every
    // other malformed input in this function — it must not be the one silent exception.
    if (analysis.version !== BENCHMARKING_METHOD_VERSION) {
      refuse(
        "validation",
        "spec.analysis.version",
        `analysis.version "${analysis.version}" does not match the registered wilson method's version "${BENCHMARKING_METHOD_VERSION}"`,
      );
    }
    if (analysis.parameters !== undefined && Object.keys(analysis.parameters).length > 0) {
      refuse(
        "validation",
        "spec.analysis.parameters",
        `analysis.parameters must be empty for an explicit wilson selection — its verdictRule parameter is always derived from the draft's resolved assurance, never caller-supplied`,
      );
    }
    return [wilson];
  }

  const method = BENCHMARKING_METHOD_REGISTRY.get(analysis.method, analysis.version);
  if (method === undefined) {
    refuse("validation", "spec.analysis", `analysis.method "${analysis.method}@${analysis.version}" is not a registered method`);
  }
  if (method.computeAvailability !== "available") {
    refuse("validation", "spec.analysis", `analysis.method "${analysis.method}@${analysis.version}" is registered but its compute is unavailable`);
  }

  const suppliedParameters = analysis.parameters ?? {};
  const reservedKeysPresent = RESERVED_ANALYSIS_PARAMETER_KEYS.filter((key) => key in suppliedParameters);
  if (reservedKeysPresent.length > 0) {
    refuse(
      "validation",
      "spec.analysis.parameters",
      `analysis.parameters may not set reserved key(s) ${reservedKeysPresent.join(", ")} — these are derived from analysis.baseline/analysis.candidate and the draft's resolved verdictRule, not caller-supplied`,
    );
  }

  const armIds = new Set(spec.arms.map((arm) => arm.armId));
  const needsPair = method.parameterSchema.required.includes("baseline")
    || method.parameterSchema.required.includes("candidate");
  if (needsPair) {
    for (const role of ["baseline", "candidate"] as const) {
      const armId = analysis[role];
      if (armId === undefined) {
        refuse("validation", "spec.analysis", `analysis.${role} is required by ${analysis.method} but is absent`);
      }
      if (!armIds.has(armId)) {
        refuse("validation", "spec.analysis", `analysis.${role} "${armId}" does not name an arm of this draft`);
      }
    }
  }

  const parameters: Record<string, unknown> = {
    verdictRule,
    ...(analysis.baseline === undefined ? {} : { baseline: analysis.baseline }),
    ...(analysis.candidate === undefined ? {} : { candidate: analysis.candidate }),
    ...suppliedParameters,
  };
  const validated = method.validateParameters(parameters);
  if (!validated.ok) {
    refuse("validation", "spec.analysis.parameters", `analysis.parameters rejected by ${analysis.method}: ${validated.issues.join("; ")}`);
  }
  return [wilson, { method: analysis.method, version: analysis.version, parameters }];
}

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

/**
 * The tail shared by `compileDraft` and `compilePreviewRun`: builds `planRun`'s arms/policy/
 * analysisPlan from a draft spec and a benchmark digest, and re-raises any platform validation
 * failure as this product's typed `"validation"` error. Takes the digest as a separate parameter
 * (rather than reading `spec.taskSet.benchmarkSha256` itself) so a caller can plan against a
 * digest other than the draft's own official one — exactly what `compilePreviewRun` needs.
 */
function planFromSpec(spec: DraftSpec, benchmarkDigestHex: string, owner: string, closeAt: string): PlannedRun {
  const arms: RunArm[] = spec.arms.map((arm) => ({
    armId: arm.armId,
    pinning: arm.pinning as Record<string, unknown>,
  }));

  const resolvedAssurance = resolveAssurance(spec.assurance);

  let plannedRun: PlannedRun;
  try {
    plannedRun = planRun({
      benchmarkDigest: `sha256:${benchmarkDigestHex}`,
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
        submissionBaseline: runtimeSubmissionBaseline(spec.evaluationRuntime),
      },
      analysisPlan: buildAnalysisPlan(spec, resolvedAssurance.verdictRule),
      ...(spec.budget !== undefined ? { budget: spec.budget } : {}),
      venue: { kind: "self-run" },
      closeAt,
    });
  } catch (cause) {
    refuse("validation", "spec", `run compilation failed platform validation: ${detailFromCause(cause)}`);
  }

  return plannedRun;
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

  const plannedRun = planFromSpec(spec, benchmarkSha256, owner, closeAt);

  return { plannedRun, benchmarkRecord, benchmarkSha256 };
}

export interface CompilePreviewRunInput {
  readonly workspaceDir: string;
  readonly draft: DraftDocument;
  /** The run owner IRI (`state.ts`'s `deriveRunOwner`) — a preview uses its own `#preview`-suffixed
   * owner, distinct from the official run's, so the two can never collide. */
  readonly owner: string;
  /** Absolute RFC 3339 close instant — the caller resolves `closeAfterMs` against its clock. */
  readonly closeAt: string;
  /** Max sample items to rehearse; undefined = all. Caller validates >= 1 integer. */
  readonly itemLimit?: number;
}

export interface CompiledPreviewRun {
  readonly plannedRun: PlannedRun;
  readonly previewBenchmarkRecord: BenchmarkRecord;
  /** Bare hex sha256 of the EPHEMERAL subset benchmark bytes — informational; the bytes are
   * NEVER stored in the sealed store. */
  readonly previewBenchmarkSha256: string;
  readonly itemCount: number;
}

/**
 * Same product-policy refusals as `compileDraft` (attached benchmark, >= 2 arms), then plans
 * against an in-memory subset of the draft's official Benchmark instead of the official one —
 * see this module's own header for why. Reads the full Benchmark from the official sealed store
 * (read-only), takes its first `min(itemLimit ?? all, all)` items, and re-seals that subset in
 * memory with `sealBenchmark`. The subset document carries the parsed record's own top-level
 * fields verbatim (never re-derived) so the rehearsal Benchmark is otherwise identical to the
 * official one, differing only in which items it names.
 */
export function compilePreviewRun(input: CompilePreviewRunInput): CompiledPreviewRun {
  const { workspaceDir, draft, owner, closeAt, itemLimit } = input;
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

  const fullRecord = parseBenchmark(getSealedBytes(workspaceDir, spec.taskSet.benchmarkSha256));
  const itemCount = itemLimit === undefined ? fullRecord.items.length : Math.min(itemLimit, fullRecord.items.length);
  const subsetItems = fullRecord.items.slice(0, itemCount);

  const subsetDocument: Record<string, unknown> = {
    protocol: fullRecord.protocol,
    name: fullRecord.name,
    description: fullRecord.description,
    version: fullRecord.version,
    reveal: fullRecord.reveal,
    items: subsetItems,
    ...(fullRecord.author !== undefined ? { author: fullRecord.author } : {}),
    ...(fullRecord.license !== undefined ? { license: fullRecord.license } : {}),
    ...(fullRecord.citation !== undefined ? { citation: fullRecord.citation } : {}),
    ...(fullRecord.supersedes !== undefined ? { supersedes: fullRecord.supersedes } : {}),
  };

  let previewBenchmarkBytes: Uint8Array;
  try {
    previewBenchmarkBytes = sealBenchmark(subsetDocument).bytes;
  } catch (cause) {
    refuse("validation", "spec", `preview benchmark subset failed platform validation: ${detailFromCause(cause)}`);
  }

  const previewBenchmarkSha256 = sha256Hex(previewBenchmarkBytes);
  const previewBenchmarkRecord = parseBenchmark(previewBenchmarkBytes);

  const plannedRun = planFromSpec(spec, previewBenchmarkSha256, owner, closeAt);

  return { plannedRun, previewBenchmarkRecord, previewBenchmarkSha256, itemCount: subsetItems.length };
}
