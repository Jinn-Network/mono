import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BENCHMARKING_PROTOCOL,
  documentDigest,
  sealBenchmark,
  sealMatrix,
  sealRun,
  serializeCanonicalJson,
} from "@jinn-network/benchmarking-records";
import { sealDelivery, sealSubmission, sealTask } from "@jinn-network/task-execution-protocol";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = join(packageRoot, "fixtures");
const miniatureRoot = join(fixturesRoot, "miniature-run");
const orderingRoot = join(fixturesRoot, "ordering");
const exportsRoot = join(fixturesRoot, "exports");
const methodsRoot = join(fixturesRoot, "methods");
const text = new TextEncoder();

function hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function digestOf(value) {
  return `sha256:${hex(serializeCanonicalJson(value))}`;
}

async function writeBytes(relative, bytes) {
  const path = join(fixturesRoot, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

async function writeJson(relative, value) {
  await writeBytes(relative, serializeCanonicalJson(value));
}

const evaluationDigest = "e".repeat(64);
const profileDigest = "f".repeat(64);
const tasks = ["alpha", "beta", "gamma"].map((name) => {
  const bytes = sealTask({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    profile: { digest: { sha256: profileDigest } },
    instructions: `Solve miniature task ${name}.`,
    outputs: [{ name: "answer", mediaType: "text/plain", required: true }],
    evaluation: { digest: { sha256: evaluationDigest } },
  });
  return { name, bytes, digest: hex(bytes) };
});

const benchmarkSealed = sealBenchmark({
  protocol: BENCHMARKING_PROTOCOL,
  name: "benchmarking-testing miniature run",
  description: "Three tasks used only by the conformance kit's independent assembly oracle.",
  author: "urn:uuid:10000000-0000-5000-8000-000000000001",
  version: "1.0.0",
  items: tasks.map((task) => ({ task: { digest: { sha256: task.digest } } })),
  reveal: { policy: "immediate" },
});
const benchmark = JSON.parse(new TextDecoder().decode(benchmarkSealed.bytes));

const runSealed = sealRun({
  protocol: BENCHMARKING_PROTOCOL,
  benchmark: { digest: { sha256: benchmarkSealed.digest.slice("sha256:".length) } },
  owner: "urn:uuid:20000000-0000-5000-8000-000000000002",
  arms: [
    { armId: "armA", pinning: { model: { id: "model-a" }, harness: { id: "kit", version: "1" } } },
    { armId: "armB", pinning: { model: { id: "model-b" }, harness: { id: "kit", version: "1" } } },
  ],
  replicates: 2,
  policy: {
    completenessFloor: "0.5",
    cellWindow: 3600000,
    replacement: { allowed: true, maxPerCell: 1 },
    independence: "gating",
    evaluation: { minVerdicts: 1, distinctEvaluator: true },
    submissionBaseline: { isolationPolicy: "fixture" },
  },
  analysisPlan: [
    { method: "jinn.benchmarking.method/wilson", version: "1", parameters: { verdictRule: "unanimous" } },
  ],
  venue: { kind: "self-run", note: "fixture-only append-order venue" },
  closeAt: "2026-08-04T00:00:00Z",
});
const run = JSON.parse(new TextDecoder().decode(runSealed.bytes));

const outcomePlan = [
  "judged", "unjudged", "judged", "unscorable",
  "expired", "invalidated", "excluded", "judged",
  "judged", "judged", "judged", "judged",
];
const coordinates = [];
for (const task of tasks) {
  for (const armId of ["armA", "armB"]) {
    for (const replicate of [1, 2]) coordinates.push({ task, armId, replicate });
  }
}

const submissions = [];
const deliveries = [];
const verdicts = [];
const evidence = [];
const cells = coordinates.map((coordinate, index) => {
  const cellKey = `${coordinate.task.digest}/${coordinate.armId}/${coordinate.replicate}`;
  const dispatches = outcomePlan[index] === "expired" ? 2 : 1;
  let latestSubmissionDigest;
  for (let dispatch = 1; dispatch <= dispatches; dispatch += 1) {
    const submission = {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      submission: `urn:uuid:${String(index + 1).padStart(8, "0")}-0000-5000-8000-${String(dispatch).padStart(12, "0")}`,
      task: { digest: { sha256: coordinate.task.digest } },
      requester: "urn:uuid:20000000-0000-5000-8000-000000000002",
      nonce: `miniature-${index + 1}-${dispatch}`,
      idempotencyKey: `miniature/${cellKey}/${dispatch}`,
      deadline: "2026-08-04T00:00:00Z",
      requirements: coordinate.armId === "armA" ? { model: { id: "model-a" } } : { model: { id: "model-b" } },
      "jinn.benchmarking/cell": {
        run: runSealed.digest,
        cellKey,
        armId: coordinate.armId,
      },
    };
    const bytes = sealSubmission(submission);
    latestSubmissionDigest = `sha256:${hex(bytes)}`;
    submissions.push({
      cellKey,
      dispatch,
      digest: latestSubmissionDigest,
      record: JSON.parse(new TextDecoder().decode(bytes)),
    });
  }

  const outcome = outcomePlan[index];
  const hasDelivery = !["expired", "excluded"].includes(outcome);
  let deliveryDigest;
  if (hasDelivery) {
    const delivery = {
      protocol: "https://jinn.network/profiles/task-execution/1.0",
      task: `sha256:${coordinate.task.digest}`,
      attempt: `urn:uuid:${String(index + 101).padStart(8, "0")}-0000-5000-8000-000000000000`,
      outcome: "fulfilled",
      outputs: [{ name: "answer", mediaType: "text/plain", digest: { sha256: hex(text.encode(`answer-${index}`)) } }],
      createdAt: "2026-08-03T12:00:00Z",
    };
    const bytes = sealDelivery(delivery);
    deliveryDigest = `sha256:${hex(bytes)}`;
    deliveries.push({ cellKey, digest: deliveryDigest, record: JSON.parse(new TextDecoder().decode(bytes)) });
  }

  const verdictCount = index === 2 ? 2 : outcome === "judged" ? 1 : 0;
  const cellVerdicts = [];
  for (let verdictIndex = 0; verdictIndex < verdictCount; verdictIndex += 1) {
    const verdict = {
      cellKey,
      verdict: (index + verdictIndex) % 3 === 0 ? "fail" : "pass",
      evaluator: `urn:uuid:${String(500 + index + verdictIndex).padStart(8, "0")}-0000-5000-8000-000000000000`,
      evaluationSpecification: `sha256:${evaluationDigest}`,
    };
    const digest = digestOf(verdict);
    verdicts.push({ digest, ...verdict });
    cellVerdicts.push(digest);
  }
  cellVerdicts.sort();
  evidence.push({
    cellKey,
    runtimeObservation: `sha256:${hex(text.encode(`runtime/${cellKey}`))}`,
    integrityTier: index % 4 === 0 ? "attested-only" : "re-derivable",
  });

  const verificationStatus = outcome === "invalidated" ? "mismatch" : "match";
  return {
    cellKey,
    taskDigest: coordinate.task.digest,
    armId: coordinate.armId,
    replicate: coordinate.replicate,
    dispatches,
    accounted: dispatches,
    submission: latestSubmissionDigest,
    ...(deliveryDigest === undefined ? {} : { delivery: deliveryDigest }),
    verdicts: cellVerdicts,
    validVerdicts: cellVerdicts,
    outcome,
    verification: {
      harness: verificationStatus,
      model: verificationStatus,
      loadout: "match",
      isolation: "match",
      checksFailed: outcome === "invalidated" ? ["pinning-observation"] : [],
    },
    integrityTier: index % 4 === 0 ? "attested-only" : "re-derivable",
    ...(hasDelivery ? {
      attempt: `urn:uuid:${String(index + 101).padStart(8, "0")}-0000-5000-8000-000000000000`,
      solver: `urn:uuid:${String(300 + index).padStart(8, "0")}-0000-5000-8000-000000000000`,
      cost: { value: coordinate.armId === "armA" ? "1.25" : "0.75", unit: "USD", source: "reported" },
      latencyMs: 1000 + index,
    } : {}),
  };
});
cells.sort((left, right) => left.cellKey < right.cellKey ? -1 : left.cellKey > right.cellKey ? 1 : 0);
const multiVerdictCell = cells.find((cell) => cell.verdicts.length > 1);
if (multiVerdictCell === undefined) throw new Error("miniature corpus must contain a multi-verdict cell");

const emptyArm = () => ({
  expected: 6, judged: 0, unjudged: 0, unscorable: 0, expired: 0,
  invalidated: 0, excluded: 0, replacements: 0,
});
const perArm = { armA: emptyArm(), armB: emptyArm() };
for (const cell of cells) {
  perArm[cell.armId][cell.outcome] += 1;
  perArm[cell.armId].replacements += cell.dispatches - 1;
}

const matrixSealed = sealMatrix({
  protocol: BENCHMARKING_PROTOCOL,
  run: { digest: { sha256: runSealed.digest.slice("sha256:".length) } },
  closeBoundary: { at: "2026-08-04T00:00:00Z" },
  cells,
  exclusions: [
    { cellKey: cells.find((cell) => cell.outcome === "excluded").cellKey, reason: "participant-exclusion" },
  ],
  attrition: { perArm, asymmetryFlags: ["nonjudged-arm-imbalance"] },
  completeness: {
    expected: cells.length,
    judged: cells.filter((cell) => cell.outcome === "judged").length,
    floor: "0.5",
    runOutcome: "complete",
  },
  assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
});
const matrix = JSON.parse(new TextDecoder().decode(matrixSealed.bytes));

await writeBytes("miniature-run/benchmark.json", benchmarkSealed.bytes);
await writeBytes("miniature-run/benchmark.sha256", text.encode(benchmarkSealed.digest));
await writeBytes("miniature-run/run.json", runSealed.bytes);
await writeBytes("miniature-run/run.sha256", text.encode(runSealed.digest));
await writeJson("miniature-run/tasks.json", tasks.map((task) => ({
  digest: `sha256:${task.digest}`,
  record: JSON.parse(new TextDecoder().decode(task.bytes)),
})));
await writeJson("miniature-run/submissions.json", submissions);
await writeJson("miniature-run/deliveries.json", deliveries);
await writeJson("miniature-run/verdicts.json", verdicts);
await writeJson("miniature-run/evidence.json", evidence);
await writeJson("miniature-run/injected-scope.json", {
  submissions,
  deliveries,
  verdicts,
  evidence,
  replacementLineage: [{
    cellKey: cells.find((cell) => cell.dispatches > 1).cellKey,
    dispatches: 2,
    reason: "expired",
  }],
});
await writeBytes("miniature-run/expected-matrix.json", matrixSealed.bytes);
await writeBytes("miniature-run/expected-matrix.sha256", text.encode(matrixSealed.digest));

await writeJson("ordering/transcripts.json", {
  anchoredPositive: {
    runAnnouncedAt: "2026-08-03T09:00:00Z",
    earliestCellPostAt: "2026-08-03T09:00:01Z",
    violatesOrder: false,
  },
  anchoredViolation: {
    runAnnouncedAt: "2026-08-03T09:00:02Z",
    earliestCellPostAt: "2026-08-03T09:00:01Z",
    violatesOrder: true,
  },
  localAppendOrder: {
    runAppendedBeforeCells: true,
    decisionGrade: false,
    label: "append-order-only",
  },
});

await writeJson("exports/eval-log.json", {
  schema: "inspect-ai/eval-log/1",
  status: "success",
  samples: cells.map((cell) => ({
    id: cell.cellKey,
    epoch: cell.replicate,
    target: cell.armId,
    outcome: cell.outcome,
  })),
});
await writeJson("exports/croissant.json", {
  "@context": "https://mlcommons.org/croissant/1.0",
  "@type": "sc:Dataset",
  name: benchmark.name,
  version: benchmark.version,
  distribution: tasks.map((task) => ({
    "@type": "cr:FileObject",
    name: `${task.name}.task.json`,
    sha256: task.digest,
  })),
});
await writeJson("exports/static-bundle.json", {
  format: "jinn-benchmarking-static-bundle/1",
  matrixSha256: matrixSealed.digest.slice("sha256:".length),
  files: ["benchmark.json", "run.json", "matrix.json", "verdicts.json", "evidence.json"],
});

const methodSpecs = [
  {
    id: "jinn.benchmarking.method/wilson",
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] } }, additionalProperties: false },
    outputShape: "per-arm pass rate + Wilson interval + conflicted cells",
    exclusionRule: "judged-only; conflicted dropped-with-report",
    clusteringRule: "none",
  },
  {
    id: "jinn.benchmarking.method/avg-at-k",
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] } }, additionalProperties: false },
    outputShape: "per-arm per-task repetition rate + arm mean + conflicted cells",
    exclusionRule: "judged-only; preserve arm identity",
    clusteringRule: "none",
  },
  {
    id: "jinn.benchmarking.method/pass-at-k",
    requiredInputs: ["matrix.cells", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule", "k"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] }, k: { type: "integer", minimum: 1 } }, additionalProperties: false },
    outputShape: "per-arm per-task unbiased pass@k + arm mean + conflicted cells",
    exclusionRule: "judged-only; preserve arm identity",
    clusteringRule: "none",
  },
  {
    id: "jinn.benchmarking.method/paired-mcnemar",
    requiredInputs: ["matrix.cells", "referenced-verdicts", "task-provenance-source"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] }, baseline: { type: "string" }, candidate: { type: "string" } }, additionalProperties: false },
    outputShape: "paired exact McNemar + provenance-cluster correction + excluded cells",
    exclusionRule: "pair shared task digests judged in both arms; report full remainder",
    clusteringRule: "task-provenance-source",
  },
  {
    id: "jinn.benchmarking.method/noninferiority-iut",
    requiredInputs: ["matrix.cells", "matrix.cost", "referenced-verdicts"],
    parameterSchema: { type: "object", required: ["verdictRule", "baseline", "candidate", "seed", "resamples"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] }, baseline: { type: "string" }, candidate: { type: "string" }, seed: { type: "integer", minimum: 1 }, resamples: { type: "integer", minimum: 100 } }, additionalProperties: false },
    outputShape: "BCa quality lower bound AND one-sided paired-cost Wilcoxon + exclusions + conflicted cells",
    exclusionRule: "paired both-arm judged cells; cost only both-solve pairs; report remainder",
    clusteringRule: "task-provenance-source",
    resamplingProcedure: "xorshift32-v1; sample paired tasks with replacement; one uint32 draw per position; index=floor(uint32/2^32*n); BCa uses jackknife acceleration",
  },
  {
    id: "jinn.benchmarking.method/clean-subset",
    requiredInputs: ["matrix.cells", "referenced-verdicts", "exact-task-bytes-or-anchored-benchmark-announcement"],
    parameterSchema: { type: "object", required: ["verdictRule", "basis", "cutoff", "delegate"], properties: { verdictRule: { enum: ["sole", "unanimous", "any-pass", "majority"] }, basis: { enum: ["self-declared", "announcement-anchored"] }, cutoff: { type: "string", format: "date-time" }, delegate: { type: "object" } }, additionalProperties: false },
    outputShape: "named contamination subset + delegated results + conflicted cells",
    exclusionRule: "predicate exclusions reported before delegate exclusions",
    clusteringRule: "delegate-defined",
  },
].map((spec) => ({
  ...spec,
  version: "1",
  referenceSet: "v1-reference",
  deterministic: true,
  computeAvailability: "available",
}));
methodSpecs.push({
  id: "jinn.benchmarking.method/bradley-terry",
  version: "1",
  requiredInputs: ["pairwise-judgment-records (not frozen in v1)"],
  parameterSchema: { type: "object", required: [], properties: {}, additionalProperties: false },
  outputShape: "unavailable until genuine pairwise judgment input is frozen",
  exclusionRule: "unavailable",
  clusteringRule: "unavailable",
  referenceSet: "registered-non-reference",
  deterministic: true,
  computeAvailability: "unavailable",
});
await writeJson("methods/method-specs.json", methodSpecs);
await writeJson("methods/conformance-cases.json", {
  conflicts: methodSpecs.filter((spec) => spec.referenceSet === "v1-reference").map((spec) => spec.id),
  pairedExclusions: true,
  pinnedClustering: "task-provenance-source",
  comparability: {
    marginalCrossVersion: "reject",
    pairedSharedTaskDigests: "permit-only-when-declared-and-observed",
  },
});
const conflictMatrix = structuredClone(matrix);
const conflictDigest = digestOf({
  cellKey: multiVerdictCell.cellKey,
  verdict: "fail",
  evaluator: "urn:uuid:90000000-0000-5000-8000-000000000009",
});
const conflictCell = conflictMatrix.cells.find((cell) => cell.cellKey === multiVerdictCell.cellKey);
if (conflictCell === undefined) throw new Error("conflict fixture cell missing from Matrix");
conflictCell.verdicts = [...new Set([...conflictCell.verdicts, conflictDigest])].sort();
conflictCell.validVerdicts = [...conflictCell.verdicts];
const conflictOutcomes = {
  ...Object.fromEntries(verdicts.map((verdict) => [verdict.digest, { verdict: verdict.verdict }])),
  [conflictDigest]: { verdict: "fail" },
};
await writeJson("methods/conflict-cases.json", {
  matrix: conflictMatrix,
  verdictOutcomes: conflictOutcomes,
  taskTimestamps: Object.fromEntries(tasks.map((task) => [task.digest, "2026-01-01T00:00:00Z"])),
  expectedConflicted: { count: 1, cellKeys: [multiVerdictCell.cellKey] },
  cases: [
    { methodId: "jinn.benchmarking.method/wilson", parameters: {} },
    { methodId: "jinn.benchmarking.method/avg-at-k", parameters: {} },
    { methodId: "jinn.benchmarking.method/pass-at-k", parameters: { k: 1 } },
    { methodId: "jinn.benchmarking.method/paired-mcnemar", parameters: { baseline: "armA", candidate: "armB" } },
    { methodId: "jinn.benchmarking.method/noninferiority-iut", parameters: { baseline: "armA", candidate: "armB", seed: 123456789, resamples: 1000 } },
    {
      methodId: "jinn.benchmarking.method/clean-subset",
      parameters: {
        cutoff: "2026-03-01T00:00:00Z",
        basis: "self-declared",
        delegate: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      },
    },
  ],
});
await writeJson("methods/paired-contract.json", {
  matrix,
  verdictOutcomes: Object.fromEntries(verdicts.map((verdict) => [verdict.digest, { verdict: verdict.verdict }])),
  clusterKeys: Object.fromEntries(tasks.map((task, index) => [task.digest, `source-${index % 2}`])),
  parameters: { baseline: "armA", candidate: "armB" },
  expected: {
    clusteringBasis: "task-provenance-source",
    excludedCount: cells.filter((cell) => cell.outcome !== "judged").length,
    excludedCellKeys: cells.filter((cell) => cell.outcome !== "judged").map((cell) => cell.cellKey).sort(),
  },
});
await writeJson("methods/noninferiority-iut.json", {
  kind: "compute",
  methodId: "jinn.benchmarking.method/noninferiority-iut",
  methodVersion: "1",
  parameters: {
    verdictRule: "unanimous",
    baseline: "armA",
    candidate: "armB",
    seed: 123456789,
    resamples: 1000,
  },
  verdictRule: "unanimous",
  matrices: [matrix],
  verdictOutcomes: Object.fromEntries(verdicts.map((verdict) => [verdict.digest, { verdict: verdict.verdict }])),
  expectedResults: {
    verdict: "inconclusive",
    quality: { verdict: "inconclusive", lowerBound: null, relativeRegression: null, reasons: ["insufficient paired judged tasks"] },
    cost: { verdict: "inconclusive", pValue: null, n: 4 },
    excluded: {
      count: cells.filter((cell) => cell.outcome !== "judged").length,
      cellKeys: cells.filter((cell) => cell.outcome !== "judged").map((cell) => cell.cellKey).sort(),
    },
    conflicted: { count: 1, cellKeys: [multiVerdictCell.cellKey] },
    bootstrap: { procedure: "xorshift32-v1", seed: 123456789, resamples: 1000 },
  },
});
await writeJson("methods/bradley-terry.json", {
  kind: "registration",
  methodId: "jinn.benchmarking.method/bradley-terry",
  methodVersion: "1",
  referenceSet: "registered-non-reference",
  computeAvailability: "unavailable",
  expectedCompute: "reject",
});

console.log(`Generated miniature-run, ordering, export, and method-contract fixtures under ${fixturesRoot}.`);
