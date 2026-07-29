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
import {
  EVAL_SEMANTICS_VERSION,
  EVALUATION_SPEC_FORMAT_URI,
  sealEvaluationSpec,
} from "@jinn-network/task-execution-profiles";
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

/** Honest EvaluationSpec body — sealed digest is pinned into every miniature Task. */
const evaluationSpecDocument = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: EVAL_SEMANTICS_VERSION,
  family: "deterministic-process",
  grader: {
    name: "jinn.parser.miniature",
    digest: { sha256: "1".repeat(64) },
    accessClass: "public",
  },
  familyBlock: {
    image: {
      uri: "https://example.org/images/miniature-runner",
      digest: { sha256: "2".repeat(64) },
    },
    platform: "linux/amd64",
    workspace: {},
    testMaterial: [{
      uri: "https://example.org/tests/miniature.py",
      accessClass: "public",
    }],
    parser: {
      id: "jinn.parser.miniature",
      version: "1.0.0",
      digest: `sha256:${"1".repeat(64)}`,
    },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 600,
  },
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
};
const sealedEvaluationSpec = sealEvaluationSpec(evaluationSpecDocument);
const evaluationDigest = sealedEvaluationSpec.digest.slice("sha256:".length);
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
  let firstEvaluator;
  for (let verdictIndex = 0; verdictIndex < verdictCount; verdictIndex += 1) {
    const verdictLabel = (index + verdictIndex) % 3 === 0 ? "fail" : "pass";
    const evaluator =
      `urn:uuid:${String(500 + index + verdictIndex).padStart(8, "0")}-0000-5000-8000-000000000000`;
    if (firstEvaluator === undefined) firstEvaluator = evaluator;
    // Consistency material: measurements must recompute to the delivered verdict.
    const measurements = { passed: verdictLabel === "pass" };
    const verdict = {
      cellKey,
      verdict: verdictLabel,
      evaluator,
      evaluationSpecification: `sha256:${evaluationDigest}`,
      measurements,
    };
    const digest = digestOf({
      cellKey: verdict.cellKey,
      verdict: verdict.verdict,
      evaluator: verdict.evaluator,
      evaluationSpecification: verdict.evaluationSpecification,
    });
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
  const solver = hasDelivery
    ? `urn:uuid:${String(300 + index).padStart(8, "0")}-0000-5000-8000-000000000000`
    : undefined;
  const evaluator = firstEvaluator
    ?? (hasDelivery ? "unresolved" : undefined);
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
      solver,
      cost: { value: coordinate.armId === "armA" ? "1.25" : "0.75", unit: "USD", source: "reported" },
      latencyMs: 1000 + index,
    } : {}),
    ...(evaluator === undefined ? {} : { evaluator }),
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
const portOutputs = Object.fromEntries(cells.map((cell, sortedIndex) => {
  void sortedIndex;
  const originalIndex = coordinates.findIndex((coordinate) =>
    `${coordinate.task.digest}/${coordinate.armId}/${coordinate.replicate}` === cell.cellKey
  );
  return [cell.cellKey, {
    ...(cell.solver === undefined ? {} : { solver: cell.solver }),
    ...(cell.evaluator === undefined || cell.evaluator === "unresolved"
      ? {}
      : { evaluator: cell.evaluator }),
    verification: {
      harness: cell.verification.harness,
      model: cell.verification.model,
      loadout: cell.verification.loadout,
      isolation: cell.verification.isolation,
    },
    integrityTier: cell.integrityTier,
    ...(cell.cost === undefined ? {} : { cost: cell.cost }),
    ...(cell.latencyMs === undefined ? {} : { latencyMs: cell.latencyMs }),
    ...(outcomePlan[originalIndex] === "unscorable"
      ? { evaluationTerminal: "could-not-grade" }
      : {}),
  }];
}));

await writeJson("miniature-run/evaluation-spec.json", evaluationSpecDocument);
await writeBytes("miniature-run/evaluation-spec.sealed.json", sealedEvaluationSpec.bytes);
await writeJson("miniature-run/injected-scope.json", {
  submissions,
  deliveries,
  verdicts,
  evidence,
  exclusions: [
    {
      cellKey: cells.find((cell) => cell.outcome === "excluded").cellKey,
      reason: "participant-exclusion",
    },
  ],
  replacementLineage: [{
    cellKey: cells.find((cell) => cell.dispatches > 1).cellKey,
    dispatches: 2,
    reason: "expired",
  }],
  portOutputs,
  evaluationSpec: evaluationSpecDocument,
  evaluationSpecDigest: sealedEvaluationSpec.digest,
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
    evidence: {
      // Distinctive injected EvidenceResolver refs (non-vacuous port use).
      transcriptRef: `transcript:miniature:${cell.cellKey}`,
      evidenceRef: `evidence:miniature:${cell.cellKey}`,
    },
  })),
});
await writeJson("exports/croissant.json", {
  "@context": "https://mlcommons.org/croissant/1.0",
  "@type": "sc:Dataset",
  name: benchmark.name,
  version: benchmark.version,
  distribution: tasks.map((task) => ({
    "@type": "cr:FileObject",
    name: `${task.digest}.task.json`,
    sha256: task.digest,
  })),
});
await writeJson("exports/static-bundle.json", {
  format: "jinn-benchmarking-static-bundle/1",
  matrixSha256: matrixSealed.digest.slice("sha256:".length),
  files: ["benchmark.json", "run.json", "matrix.json", "verdicts.json", "evidence.json"],
});

// Method fixtures are owned by `generate-method-fixtures.mjs` — do not overwrite them here.

console.log(`Generated miniature-run, ordering, and export fixtures under ${fixturesRoot}.`);
console.log(`Multi-verdict cell (methods fixtures are separate): ${multiVerdictCell.cellKey}`);
