import { itemTaskDigest, type BenchmarkRecord, type MatrixRecord } from "@jinn-network/benchmarking-records";
import {
  PREDICTION_FORECAST_PROFILE_URI,
  REPOSITORY_WORK_PROFILE_URI,
} from "@jinn-network/task-execution-profiles";
import { TaskSpecificationSchema } from "@jinn-network/task-execution-protocol";
import type { BundleAssemblyCell } from "./schema.js";
import { INSPECT_TASK_PROFILE_URI } from "./profile/artifacts.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const SHA256 = /^[a-f0-9]{64}$/u;
const SAMPLE_BENCHMARK_NAME = "bundled-prediction-sample";

export interface PublicComparisonTask {
  readonly digest: string;
  readonly profileUri: string;
  readonly label: string;
  readonly summary: string;
  readonly evidencePath: string;
}

export interface PublicComparisonOutput {
  readonly name: string;
  readonly sha256: string;
  readonly summary: string;
  readonly evidencePath: string;
}

export interface PublicComparisonVerdict {
  readonly evaluator: string;
  readonly verdict: "pass" | "fail" | "inconclusive";
  readonly measurements: Readonly<Record<string, string | number | boolean>>;
  readonly evidencePath: string;
}

export interface PublicComparisonCell {
  readonly cellKey: string;
  readonly taskDigest: string;
  readonly armId: string;
  readonly replicate: number;
  readonly outcome: MatrixRecord["cells"][number]["outcome"];
  readonly outputSummary: string;
  readonly primaryScore?: {
    readonly name: "solverBrier";
    readonly value: string;
    readonly direction: "lower-is-better";
  };
  readonly outputs: readonly PublicComparisonOutput[];
  readonly verdicts: readonly PublicComparisonVerdict[];
  readonly evidencePaths: readonly string[];
}

export interface PublicDescriptiveComparison {
  readonly kind: "paired-measurement";
  readonly measurement: "solverBrier";
  readonly direction: "lower-is-better";
  readonly firstArm: string;
  readonly secondArm: string;
  readonly pairedCells: number;
  readonly lowerByFirst: number;
  readonly lowerBySecond: number;
  readonly ties: number;
  readonly formalWinner: false;
}

export interface PublicComparisonView {
  readonly profile: "colophon-public-comparison/1";
  readonly sampleKind?: "bundled-prediction";
  readonly tasks: readonly PublicComparisonTask[];
  readonly arms: readonly string[];
  readonly cells: readonly PublicComparisonCell[];
  readonly descriptiveComparison?: PublicDescriptiveComparison;
}

export interface DerivePublicComparisonInput {
  readonly benchmark: BenchmarkRecord;
  readonly matrix: MatrixRecord;
  readonly assemblyCells: readonly BundleAssemblyCell[];
  readonly recordBytes: ReadonlyMap<string, Uint8Array>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string, maximum = 480): string {
  const normalized = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  const points = Array.from(normalized);
  return points.length <= maximum ? normalized : `${points.slice(0, maximum - 1).join("")}…`;
}

function exactJson(bytes: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw new TypeError(`${label} is not valid UTF-8 JSON`);
  }
}

function requiredRecord(records: ReadonlyMap<string, Uint8Array>, sha256: string, role: string): Uint8Array {
  if (!SHA256.test(sha256)) throw new TypeError(`${role} has an invalid digest`);
  const bytes = records.get(sha256);
  if (bytes === undefined) throw new TypeError(`${role} ${sha256} is absent from the authenticated record closure`);
  return bytes;
}

function percentage(probability: string): string {
  const numeric = Number(probability);
  if (!Number.isFinite(numeric)) return probability;
  const percent = numeric * 100;
  return `${Number.isInteger(percent) ? String(percent) : percent.toFixed(1)}% Yes`;
}

function taskProjection(
  digest: string,
  bytes: Uint8Array,
  bundledPredictionSample: boolean,
): { readonly task: PublicComparisonTask; readonly profileUri: string } {
  const parsed = TaskSpecificationSchema.parse(exactJson(bytes, `Task ${digest}`));
  const profileUri = parsed.profile.uri ?? "unprofiled";
  const payload = isObject(parsed.payload) ? parsed.payload : {};
  if (profileUri === PREDICTION_FORECAST_PROFILE_URI) {
    const forecast = isObject(payload["forecast"]) ? payload["forecast"] : {};
    const question = typeof forecast["question"] === "string" ? forecast["question"] : `Prediction task ${digest.slice(0, 12)}`;
    const consensus = typeof forecast["consensusProbabilityYes"] === "string" ? forecast["consensusProbabilityYes"] : undefined;
    const syntheticOutcome = bundledPredictionSample && consensus !== undefined
      ? (Number(consensus) >= 0.5 ? "Yes" : "No")
      : undefined;
    const summary = consensus === undefined
      ? "Forecast a probability for the declared outcome."
      : bundledPredictionSample
        ? `Sample consensus input: ${percentage(consensus)}. Synthetic sample resolution: ${syntheticOutcome}.`
        : `Consensus reference at observation: ${percentage(consensus)}.`;
    return {
      task: {
        digest,
        profileUri,
        label: bounded(question, 180),
        summary,
        evidencePath: `records/${digest}.bin`,
      },
      profileUri,
    };
  }
  if (profileUri === REPOSITORY_WORK_PROFILE_URI) {
    const instance = typeof payload["instance_id"] === "string" ? payload["instance_id"] : digest.slice(0, 12);
    const language = typeof payload["language"] === "string" ? payload["language"] : "repository";
    return {
      task: {
        digest,
        profileUri,
        label: bounded(instance, 180),
        summary: bounded(`${language} task — ${parsed.instructions}`, 480),
        evidencePath: `records/${digest}.bin`,
      },
      profileUri,
    };
  }
  if (profileUri === INSPECT_TASK_PROFILE_URI) {
    const selection = typeof payload["selectionManifestSha256"] === "string"
      ? payload["selectionManifestSha256"]
      : undefined;
    return {
      task: {
        digest,
        profileUri,
        label: `Inspect evaluation ${digest.slice(0, 12)}`,
        summary: selection === undefined
          ? "Inspect evaluation with bundle-carried scoring evidence."
          : `Inspect selection ${selection.slice(0, 12)} is sealed into this task.`,
        evidencePath: `records/${digest}.bin`,
      },
      profileUri,
    };
  }
  return {
    task: {
      digest,
      profileUri,
      label: `Task ${digest.slice(0, 12)}`,
      summary: "This task profile has no plain-language Colophon projector; verified identities and measurements remain available below.",
      evidencePath: `records/${digest}.bin`,
    },
    profileUri,
  };
}

function outputProjection(
  profileUri: string,
  name: string,
  sha256: string,
  bytes: Uint8Array,
): PublicComparisonOutput {
  let summary = `${name} — ${bytes.length} authenticated bytes`;
  if (profileUri === PREDICTION_FORECAST_PROFILE_URI && name === "prediction") {
    const value = exactJson(bytes, `prediction output ${sha256}`);
    if (isObject(value) && typeof value["probabilityYes"] === "string") {
      summary = `Forecast ${percentage(value["probabilityYes"])}`;
    }
  } else if (profileUri === REPOSITORY_WORK_PROFILE_URI && name === "patch") {
    summary = `Unified-diff patch — ${bytes.length} authenticated bytes`;
  } else if (profileUri === INSPECT_TASK_PROFILE_URI) {
    summary = `Inspect ${name} — ${bytes.length} authenticated bytes`;
  }
  return { name, sha256, summary, evidencePath: `records/${sha256}.bin` };
}

function commonBrier(verdicts: readonly PublicComparisonVerdict[]): string | undefined {
  const values = verdicts.map((verdict) => verdict.measurements["solverBrier"]);
  if (values.length === 0 || values.some((value) => typeof value !== "string")) return undefined;
  return values.every((value) => value === values[0]) ? values[0] as string : undefined;
}

function descriptiveComparison(arms: readonly string[], cells: readonly PublicComparisonCell[]): PublicDescriptiveComparison | undefined {
  if (arms.length !== 2) return undefined;
  const [firstArm, secondArm] = arms as readonly [string, string];
  const first = new Map<string, number>();
  const second = new Map<string, number>();
  for (const cell of cells) {
    if (cell.primaryScore?.name !== "solverBrier") continue;
    const key = `${cell.taskDigest}\u001f${cell.replicate}`;
    const value = Number(cell.primaryScore.value);
    if (!Number.isFinite(value)) continue;
    if (cell.armId === firstArm) first.set(key, value);
    if (cell.armId === secondArm) second.set(key, value);
  }
  let lowerByFirst = 0;
  let lowerBySecond = 0;
  let ties = 0;
  for (const key of [...first.keys()].sort()) {
    const left = first.get(key)!;
    const right = second.get(key);
    if (right === undefined) continue;
    if (left < right) lowerByFirst += 1;
    else if (right < left) lowerBySecond += 1;
    else ties += 1;
  }
  const pairedCells = lowerByFirst + lowerBySecond + ties;
  if (pairedCells === 0) return undefined;
  return {
    kind: "paired-measurement",
    measurement: "solverBrier",
    direction: "lower-is-better",
    firstArm,
    secondArm,
    pairedCells,
    lowerByFirst,
    lowerBySecond,
    ties,
    formalWinner: false,
  };
}

export function derivePublicComparison(input: DerivePublicComparisonInput): PublicComparisonView {
  const bundledPredictionSample = input.benchmark.name === SAMPLE_BENCHMARK_NAME;
  const taskDigests = [...new Set(input.benchmark.items.map(itemTaskDigest))];
  const taskByDigest = new Map<string, ReturnType<typeof taskProjection>>();
  const tasks = taskDigests.map((digest) => {
    const projected = taskProjection(digest, requiredRecord(input.recordBytes, digest, "Task"), bundledPredictionSample);
    taskByDigest.set(digest, projected);
    return projected.task;
  });
  const arms = [...new Set(input.matrix.cells.map((cell) => cell.armId))];
  const assemblyByKey = new Map(input.assemblyCells.map((cell) => [cell.cellKey, cell]));
  const cells = input.matrix.cells.map((matrixCell): PublicComparisonCell => {
    const assembly = assemblyByKey.get(matrixCell.cellKey);
    if (assembly === undefined) throw new TypeError(`comparison cell ${matrixCell.cellKey} is absent from the verified assembly`);
    const profileUri = taskByDigest.get(matrixCell.taskDigest)?.profileUri;
    if (profileUri === undefined) throw new TypeError(`comparison cell ${matrixCell.cellKey} names an unknown Task`);
    const outputs = (assembly.solveOutputs ?? []).map((output) => outputProjection(
      profileUri,
      output.name,
      output.sha256,
      requiredRecord(input.recordBytes, output.sha256, "solve output"),
    ));
    const verdicts = assembly.verdicts.map((verdict): PublicComparisonVerdict => ({
      evaluator: verdict.evaluator,
      verdict: verdict.verdict,
      measurements: verdict.measurements,
      evidencePath: `records/${verdict.sha256}.bin`,
    }));
    const brier = commonBrier(verdicts);
    const outputSummary = outputs.length === 0
      ? "No solve output is present for this accounted cell."
      : outputs.map((output) => output.summary).join("; ");
    return {
      cellKey: matrixCell.cellKey,
      taskDigest: matrixCell.taskDigest,
      armId: matrixCell.armId,
      replicate: matrixCell.replicate,
      outcome: matrixCell.outcome,
      outputSummary,
      ...(brier === undefined ? {} : { primaryScore: { name: "solverBrier" as const, value: brier, direction: "lower-is-better" as const } }),
      outputs,
      verdicts,
      evidencePaths: [
        `records/${matrixCell.taskDigest}.bin`,
        ...(assembly.deliverySha256 === undefined ? [] : [`records/${assembly.deliverySha256}.bin`]),
        ...outputs.map((output) => output.evidencePath),
        ...verdicts.map((verdict) => verdict.evidencePath),
      ],
    };
  });
  const comparison = descriptiveComparison(arms, cells);
  return {
    profile: "colophon-public-comparison/1",
    ...(bundledPredictionSample ? { sampleKind: "bundled-prediction" as const } : {}),
    tasks,
    arms,
    cells,
    ...(comparison === undefined ? {} : { descriptiveComparison: comparison }),
  };
}
