// SPDX-License-Identifier: MIT

/**
 * `optimize campaign create | run | status`.
 *
 * Three verbs over the C7a/C7b surfaces, and one honest gap.
 *
 * - **`create`** seals the document with its seed referents, so §5.1's frozen-axis check actually
 *   runs. Seeds are supplied as *documents*, not as `{kind, digest}` pairs: the discriminant is
 *   read from each file's `formatToken` and the digest is derived from the bytes, which is the
 *   difference between verifying a seed and being told about one.
 * - **`status`** replays the journal and prints what the replay derives — the phase, the spend, the
 *   arms. It computes nothing else, because everything else *is* the journal.
 * - **`run`** decides the allocation, plans the wave, seals the Run, journals all three, and then
 *   **stops**, because it must. Dispatching cells needs a `TaskExecutionBackend` *binding*, and
 *   this package names the backend contract and is forbidden by its own source boundary from
 *   naming any implementation of it (`task-execution-backend-local` is denied by name). A CLI in
 *   this package therefore cannot execute a wave, and it says so rather than pretending. See
 *   FINDING F-C7d-2.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseBenchmark } from "@jinn-network/benchmarking-records";
import {
  CANDIDATE_MANIFEST_FORMAT_TOKEN,
  EXECUTION_TUPLE_FORMAT_TOKEN,
  canonicalTupleBytes,
  parseExactCandidateManifest,
  prefixedDigest,
  tupleDigest,
  type ExecutionPolicyTuple,
} from "@jinn-network/policy-identity";
import { decideAllocation } from "../allocation.js";
import { refuse } from "../errors.js";
import { atomicWriteFileSync } from "../fs-atomic.js";
import { createCampaign, openCampaign, type CampaignHandle } from "../journal-store.js";
import { WAVES_DIRNAME } from "../archive/tokens.js";
import { committedCells, planWave } from "../wave.js";
import {
  allocationDecidedPayload,
  appendWaveEvent,
  runSealedPayload,
  wavePlannedPayload,
} from "../wave-journal.js";
import type { CampaignDocument, SeedResolution } from "../types.js";
import type {
  AdmittedCandidate,
  OutcomesProjectionRow,
  TaskInformativenessRow,
  WaveReportRow,
  WaveRunSettings,
} from "../wave-types.js";
import {
  assertKnownFlags, many, optional, pathFrom, present, readBytes, readJson, required,
  type ParsedArgs,
} from "./args.js";
import { type CliContext, type CliResult, lines, ok } from "./result.js";

// --- create -------------------------------------------------------------------------------------

/**
 * Reads one seed document and discriminates it by its own `formatToken`.
 *
 * The alternative — a hand-written `{kind, digest}` list — asks the operator to restate two facts
 * the file already carries, and gets the campaign refused at sealing when either restatement is
 * wrong. Here the digest is derived and the kind is read.
 */
function resolveSeed(path: string): SeedResolution {
  const bytes = readBytes(path);
  const document = readJson(path) as { formatToken?: unknown };
  if (document.formatToken === EXECUTION_TUPLE_FORMAT_TOKEN) {
    const tuple = document as unknown as ExecutionPolicyTuple;
    return { kind: "tuple", digest: tupleDigest(tuple), tuple };
  }
  if (document.formatToken === CANDIDATE_MANIFEST_FORMAT_TOKEN) {
    // Re-sealed through the canonicalizer: a seed file that is merely *equivalent* to canonical
    // form would otherwise digest to something the campaign document does not name.
    parseExactCandidateManifest(bytes);
    return { kind: "candidate", digest: prefixedDigest(bytes), manifestBytes: bytes };
  }
  refuse("seed-resolution", path,
    `${path} carries no recognized formatToken; a seed is an execution tuple (${EXECUTION_TUPLE_FORMAT_TOKEN}) or a candidate manifest (${CANDIDATE_MANIFEST_FORMAT_TOKEN})`);
}

export function campaignCreate(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, ["dir", "document", "seed", "at"]);
  const directory = pathFrom(context.cwd, required(args, "dir"));
  const campaign = readJson(pathFrom(context.cwd, required(args, "document"))) as CampaignDocument;
  const seedPaths = many(args, "seed");
  if (seedPaths.length === 0) {
    refuse("invalid-document", "--seed",
      "at least one --seed <file> is required; §5.1's frozen-axis check is uncomputable without the referents");
  }
  const handle = createCampaign({
    directory,
    campaign,
    seedResolutions: seedPaths.map((path) => resolveSeed(pathFrom(context.cwd, path))),
    createdAt: optional(args, "at") ?? context.now(),
  });
  return ok(lines(
    `campaign  ${handle.digest}`,
    `directory ${handle.directory}`,
    `seeds     ${seedPaths.length}`,
    `phase     ${handle.state.phase}`,
  ));
}

// --- status -------------------------------------------------------------------------------------

interface ArmLine {
  readonly wave: number;
  readonly armId: string;
  readonly tupleDigest: string;
}

/**
 * The arms of the most recently planned wave, read off `wave-planned` payloads.
 *
 * Read from `wave-planned` and not from `candidate-admitted` on purpose (FINDING F-C7d-3): the
 * admission payload's schema belongs to C7c, and C7a's rule is that a payload schema belongs to
 * the sub-unit that emits it. Rendering the *planned arms* answers "what is this campaign actually
 * comparing right now" out of a payload this unit's sibling already froze, with no cross-unit
 * schema guess. The admitted-but-never-planned population is therefore not shown; the honest
 * alternative would have been to show nothing.
 */
function armsOfLatestWave(handle: CampaignHandle): readonly ArmLine[] {
  const planned = [...handle.entries].reverse().find((entry) => entry.type === "wave-planned");
  if (planned === undefined) return [];
  const wave = planned.payload["wave"];
  const arms = planned.payload["arms"];
  if (!Array.isArray(arms) || typeof wave !== "number") return [];
  return arms.flatMap((arm) => {
    const entry = arm as { armId?: unknown; tupleDigest?: unknown };
    return typeof entry.armId === "string" && typeof entry.tupleDigest === "string"
      ? [{ wave, armId: entry.armId, tupleDigest: entry.tupleDigest }]
      : [];
  });
}

export function campaignStatus(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, ["dir"]);
  const handle = openCampaign(pathFrom(context.cwd, required(args, "dir")));
  const spend = committedCells(handle.entries);
  const arms = armsOfLatestWave(handle);
  const budgets = handle.campaign.budgets;
  return ok(lines(
    `campaign     ${handle.digest}`,
    `phase        ${handle.state.phase}`,
    `entries      ${handle.state.entries}`,
    `recorded     ${handle.state.lastRecordedAt ?? "never"}`,
    `development  ${spend.development} / ${budgets.evaluation.maxCells} cells`,
    `promotion    ${spend.promotion} cells`,
    `hard cap     ${spend.total} / ${budgets.hardCap.maxCells} cells`,
    `arms         ${arms.length}`,
    ...arms.map((arm) => `  ${arm.armId}  ${arm.tupleDigest}  wave ${arm.wave}`),
  ));
}

// --- run ----------------------------------------------------------------------------------------

function readRows<T>(context: CliContext, args: ParsedArgs, flag: string): readonly T[] {
  const path = optional(args, flag);
  if (path === undefined || path === "") return [];
  const value = readJson(pathFrom(context.cwd, path));
  if (!Array.isArray(value)) {
    refuse("invalid-document", `--${flag}`, `${path} must be a JSON array of rows`);
  }
  return value as readonly T[];
}

function waveNumberOf(handle: CampaignHandle): number {
  return (handle.state.eventCounts["wave-planned"] ?? 0) + 1;
}

/** `--candidates` is a JSON array of `{armId, tuple, source}`; the tuple digest is derived here. */
function readCandidates(context: CliContext, args: ParsedArgs): readonly AdmittedCandidate[] {
  const rows = readRows<{
    armId?: unknown; tuple?: unknown; source?: unknown;
  }>(context, args, "candidates");
  if (rows.length === 0) {
    refuse("wave-composition", "--candidates",
      "a wave needs at least one admitted candidate; admission is `optimize candidate` territory and its output feeds this flag");
  }
  return rows.map((row, index) => {
    if (typeof row.armId !== "string" || typeof row.tuple !== "object" || row.tuple === null) {
      refuse("wave-composition", `candidates.${index}`,
        "each candidate needs an armId and a tuple");
    }
    const tuple = row.tuple as ExecutionPolicyTuple;
    const digest = prefixedDigest(canonicalTupleBytes(tuple));
    return {
      armId: row.armId,
      tupleDigest: digest,
      tuple,
      source: (row.source as AdmittedCandidate["source"]) ?? { kind: "tuple", digest },
    };
  });
}

export function campaignRun(args: ParsedArgs, context: CliContext): CliResult {
  assertKnownFlags(args, [
    "dir", "settings", "benchmark", "candidates", "reports", "outcomes", "informativeness",
    "promotion-benchmark", "trusted-at", "trusted-run-not-closed", "at",
  ]);
  const directory = pathFrom(context.cwd, required(args, "dir"));
  const handle = openCampaign(directory);
  const waveNumber = waveNumberOf(handle);
  const recordedAt = optional(args, "at") ?? context.now();

  const developmentBenchmarkBytes = readBytes(pathFrom(context.cwd, required(args, "benchmark")));
  const benchmark = parseBenchmark(developmentBenchmarkBytes);
  const settings = readJson(pathFrom(context.cwd, required(args, "settings"))) as WaveRunSettings;
  const candidates = readCandidates(context, args);

  const allocation = decideAllocation({
    campaign: handle.campaign,
    waveNumber,
    population: candidates,
    taskDigests: benchmark.items.map((item) => item.task.digest.sha256),
    reports: readRows<WaveReportRow>(context, args, "reports"),
    outcomes: readRows<OutcomesProjectionRow>(context, args, "outcomes"),
    informativeness: readRows<TaskInformativenessRow>(context, args, "informativeness"),
  });

  const plan = planWave({
    campaign: handle.campaign,
    campaignDigest: handle.digest,
    waveNumber,
    candidates,
    allocation,
    developmentBenchmarkBytes,
    settings,
    committed: committedCells(handle.entries),
  });

  // The §6.3 gate, needed exactly once: the first `wave-planned` crosses DRAFT -> EXPLORING, and
  // the journal refuses that append without the promotion Benchmark's bytes and a reveal moment.
  const exploringEntry = handle.state.phase === "DRAFT"
    ? {
      benchmarkBytes: readBytes(pathFrom(context.cwd, requiredForExploring(args, "promotion-benchmark"))),
      revealContext: revealContextFrom(args),
    }
    : undefined;

  // FINDING F-C7d-5. `allocation-decided` is illegal in `DRAFT` (C7a's lifecycle table) and the
  // first `wave-planned` is what enters `EXPLORING` — so the wave-1 allocation can only be recorded
  // *after* the boundary it chronologically precedes. From wave 2 on the decision is recorded
  // before the wave it decided, which is the order it happened in. The conditional exists so
  // chronology is preserved wherever the lifecycle admits it, rather than being uniformly wrong.
  const allocationEvent = {
    type: "allocation-decided" as const, recordedAt, payload: allocationDecidedPayload(allocation),
  };
  const waveEvent = { type: "wave-planned" as const, recordedAt, payload: wavePlannedPayload(plan) };
  const waveOptions = exploringEntry === undefined ? undefined : { exploringEntry };

  let next = handle.state.phase === "DRAFT"
    ? appendWaveEvent(appendWaveEvent(handle, waveEvent, waveOptions), allocationEvent)
    : appendWaveEvent(appendWaveEvent(handle, allocationEvent), waveEvent, waveOptions);
  next = appendWaveEvent(next, {
    type: "run-sealed", recordedAt, payload: runSealedPayload(plan),
  });

  const waveDirectory = join(directory, WAVES_DIRNAME, String(waveNumber));
  mkdirSync(waveDirectory, { recursive: true });
  atomicWriteFileSync(join(waveDirectory, "benchmark.json"), plan.benchmark.bytes);
  atomicWriteFileSync(join(waveDirectory, "run.json"), plan.run.bytes);

  return ok(lines(
    `wave         ${plan.waveNumber} (${plan.kind})`,
    `phase        ${next.state.phase}`,
    `allocation   ${allocation.policyRef}: ${allocation.retained.length} retained, ${allocation.pruned.length} pruned`,
    `benchmark    ${plan.benchmark.digest}`,
    `run          ${plan.run.digest}`,
    `cells        ${plan.cells}`,
    `sealed to    ${waveDirectory}`,
    "",
    "Not dispatched. Executing these cells needs a TaskExecutionBackend binding, and this package",
    "names the backend contract without naming any implementation of it (its source boundary denies",
    "every concrete backend by name). Drive `executeWave` from a host that holds one, passing the",
    "sealed Run above; then journal matrix-assembled and report-recorded.",
  ));
}

function requiredForExploring(args: ParsedArgs, flag: string): string {
  const value = optional(args, flag);
  if (value === undefined || value === "") {
    refuse("promotion-benchmark", `--${flag}`,
      `--${flag} is required for the first wave: DRAFT -> EXPLORING needs the promotion Benchmark committed and unrevealed (§6.3)`);
  }
  return value;
}

/**
 * The trusted, caller-supplied fact that makes "unrevealed" a claim about a moment.
 *
 * Both of `benchmarking-records`' context kinds are reachable, and the operator states which one
 * applies rather than the CLI inferring it: the record's declared reveal policy says *when* items
 * become readable, and the context says what the caller trusts to be true right now. Those are two
 * different facts, and the records package refuses the pair when they disagree — which is the whole
 * value of asking.
 */
function revealContextFrom(args: ParsedArgs): { kind: "scheduled"; trustedAtTime: string }
  | { kind: "after-run"; trustedRunNotClosed: true } {
  const trustedAt = optional(args, "trusted-at");
  const runNotClosed = present(args, "trusted-run-not-closed");
  if (trustedAt !== undefined && trustedAt !== "" && runNotClosed) {
    refuse("promotion-benchmark", "--trusted-at",
      "--trusted-at and --trusted-run-not-closed are alternatives; supply the one the promotion Benchmark's reveal policy calls for");
  }
  if (runNotClosed) return { kind: "after-run", trustedRunNotClosed: true };
  return {
    kind: "scheduled",
    trustedAtTime: requiredForExploring(args, "trusted-at"),
  };
}
