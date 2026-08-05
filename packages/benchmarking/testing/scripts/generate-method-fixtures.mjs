// Generates the §16 method-fixture set for `describeMethodRegistryConformance` (Task 2.4).
//
// Ground truth is computed HERE, independently of `@jinn-network/benchmarking-aggregate`'s
// implementation (kit-precedes-implementation, program §7.6): this script re-implements the
// closed-form Wilson interval, exact McNemar and whole-provenance sign tests (independently of the
// registry), and the Chen 2021 unbiased pass@k estimator from scratch. `aggregate` is written
// afterward to reproduce these pinned numbers, not the other way around.
//
// Run: `node scripts/generate-method-fixtures.mjs` from the package root. Deterministic —
// re-running reproduces byte-identical fixture files.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(packageRoot, "fixtures", "methods");
await mkdir(outDir, { recursive: true });

// --- independent ground-truth math (never imported by `aggregate`) ---------------------------

function sha256Hex(label) {
  return createHash("sha256").update(label, "utf8").digest("hex");
}
function digest(label) {
  return `sha256:${sha256Hex(label)}`;
}
function taskDigest(label) {
  return sha256Hex(label);
}

function wilsonInterval(passed, n, z = 1.96) {
  if (n === 0) return { p: 0, lo: 0, hi: 0 };
  const p = passed / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    p,
    lo: Math.max(0, (centre - margin) / denom),
    hi: Math.min(1, (centre + margin) / denom),
  };
}

function mcnemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let term = Math.pow(0.5, n);
  let cdf = term;
  for (let i = 1; i <= k; i++) {
    term = (term * (n - i + 1)) / i;
    cdf += term;
  }
  return Math.min(1, 2 * cdf);
}

function exactTwoSidedSign(favorable, unfavorable) {
  const n = favorable + unfavorable;
  if (n === 0) return 1;
  if (favorable === 0 || unfavorable === 0) return 2 ** (1 - n);
  const k = Math.min(favorable, unfavorable);
  let numerator = 0;
  for (let index = 0; index <= k; index++) numerator += binomial(n, index);
  return Math.min(1, (2 * numerator) / (2 ** n));
}

function binomial(n, k) {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 0; i < k; i++) result = (result * (n - i)) / (i + 1);
  return result;
}

/** Chen 2021 unbiased pass@k: 1 - C(n-c,k)/C(n,k), numerically stable product form. */
function passAtK(n, c, k) {
  if (n - c < k) return 1;
  let product = 1;
  for (let i = n - c + 1; i <= n; i++) product *= 1 - k / i;
  return 1 - product;
}

function fixed4(x) {
  return x.toFixed(4);
}

/** Independent §7.47 disclosure oracle for the deterministic fixture source families. */
function sourceClusters(taskDigests, resamples) {
  const clusters = taskDigests.map((taskDigest) => ({
    key: ["source", `fixture-source/${taskDigest}`],
    members: [taskDigest],
  })).sort((left, right) => {
    const leftKey = JSON.stringify(left.key);
    const rightKey = JSON.stringify(right.key);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return {
    basis: "task-provenance-source-family",
    count: clusters.length,
    unit: "source-cluster",
    draws: clusters.length * resamples,
    clusters,
  };
}

// --- Matrix-record builders (structurally valid per @jinn-network/benchmarking-records' schema,
//     but built here from scratch -- not routed through `sealMatrix`, since fixture *content*,
//     not sealed *bytes*, is what these method fixtures pin) --------------------------------

const RUN_DESCRIPTOR = { digest: { sha256: sha256Hex("method-fixtures/run") } };
const CLOSE_BOUNDARY = { at: "2026-08-04T00:00:00Z" };
const ASSEMBLY = { procedure: "jinn.benchmarking.assembly", version: "1.0" };

function cellKey(task, armId, replicate) {
  return `${task}/${armId}/${replicate}`;
}

const MATCH_ALL = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] };

/**
 * @param taskLabel stable label the task's 64-hex digest is derived from
 * @param armId
 * @param opts.outcome one of the frozen six-value vocabulary
 * @param opts.verdicts array of verdict labels (each hashed to a digest); first is the delivered
 *   Result Evaluation Statement referenced by `verdicts[]`
 * @param opts.validVerdicts subset of `opts.verdicts` that are structurally valid (verdict-spec-match
 *   + verdict-consistency passed) -- the ones a Method's exact-byte resolver can resolve
 */
function cell(taskLabel, armId, replicate, opts) {
  const task = taskDigest(taskLabel);
  const verdicts = (opts.verdicts ?? []).map((label) => digest(`${taskLabel}/${armId}/verdict/${label}`));
  const validLabels = opts.validVerdicts ?? opts.verdicts ?? [];
  const validVerdicts = validLabels
    .map((label) => digest(`${taskLabel}/${armId}/verdict/${label}`))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const sortedVerdicts = [...verdicts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    cellKey: cellKey(task, armId, replicate),
    taskDigest: task,
    armId,
    replicate,
    dispatches: 1,
    accounted: 1,
    verdicts: sortedVerdicts,
    validVerdicts,
    outcome: opts.outcome,
    verification: MATCH_ALL,
    integrityTier: "re-derivable",
    ...(opts.cost === undefined ? {} : { cost: { value: opts.cost, unit: "USD", source: "reported" } }),
  };
}

function matrix(cells, opts = {}) {
  const perArm = {};
  for (const c of cells) {
    perArm[c.armId] ??= {
      expected: 0, judged: 0, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
    };
    perArm[c.armId].expected += 1;
    perArm[c.armId][c.outcome] += 1;
  }
  return {
    protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
    run: opts.run ?? RUN_DESCRIPTOR,
    closeBoundary: CLOSE_BOUNDARY,
    cells,
    exclusions: [],
    attrition: { perArm, asymmetryFlags: [] },
    completeness: { expected: cells.length, judged: cells.filter((c) => c.outcome === "judged").length, floor: "0.5", runOutcome: "complete" },
    assembly: ASSEMBLY,
  };
}

function verdictOutcome(kind) {
  return kind === "pass" ? { verdict: "pass" } : kind === "fail" ? { verdict: "fail" } : { verdict: "inconclusive" };
}

// --- fixture 1: wilson@1 -----------------------------------------------------------------

const wilsonCells = [
  cell("wilson/t1", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass
  cell("wilson/t2", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass
  cell("wilson/t3", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass
  cell("wilson/t4", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // fail
  cell("wilson/t5", "armA", 1, { outcome: "unjudged", verdicts: [], validVerdicts: [] }),
  cell("wilson/t6", "armA", 1, { outcome: "judged", verdicts: ["v1", "v2"], validVerdicts: ["v1", "v2"] }), // conflicted (pass+fail, unanimous)
  cell("wilson/t1", "armB", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // fail
  cell("wilson/t2", "armB", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass
  cell("wilson/t3", "armB", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // fail
  cell("wilson/t4", "armB", 1, { outcome: "excluded", verdicts: [], validVerdicts: [] }),
  cell("wilson/t5", "armB", 1, { outcome: "unjudged", verdicts: [], validVerdicts: [] }),
];

const wilsonVerdictOutcomes = {
  [digest("wilson/t1/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("wilson/t2/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("wilson/t3/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("wilson/t4/armA/verdict/v")]: verdictOutcome("fail"),
  [digest("wilson/t6/armA/verdict/v1")]: verdictOutcome("pass"),
  [digest("wilson/t6/armA/verdict/v2")]: verdictOutcome("fail"),
  [digest("wilson/t1/armB/verdict/v")]: verdictOutcome("fail"),
  [digest("wilson/t2/armB/verdict/v")]: verdictOutcome("pass"),
  [digest("wilson/t3/armB/verdict/v")]: verdictOutcome("fail"),
};

const wA = wilsonInterval(3, 4);
const wB = wilsonInterval(1, 3);
const conflictedCellKey = cellKey(taskDigest("wilson/t6"), "armA", 1);
const wilsonFixture = {
  methodId: "jinn.benchmarking.method/wilson",
  methodVersion: "1",
  parameters: {},
  verdictRule: "unanimous",
  matrices: [matrix(wilsonCells)],
  verdictOutcomes: wilsonVerdictOutcomes,
  expectedResults: {
    verdictRule: "unanimous",
    arms: {
      armA: { n: 4, passRate: fixed4(wA.p), wilsonInterval: { low: fixed4(wA.lo), high: fixed4(wA.hi) } },
      armB: { n: 3, passRate: fixed4(wB.p), wilsonInterval: { low: fixed4(wB.lo), high: fixed4(wB.hi) } },
    },
    conflicted: { count: 1, cellKeys: [conflictedCellKey] },
  },
};

// --- fixture 2: avg-at-k@1 / pass-at-k@1 (share one matrix; three replicates per task) -------

// Each replicate is a distinct `replicate` index (1..3) of the SAME taskDigest — the real §7.3
// shape for a repeated cell — with its own per-replicate verdict digest so they don't collide.
function passKCells(taskLabel, armId, outcomes) {
  return outcomes.map((kind, index) =>
    cell(taskLabel, armId, index + 1, { outcome: "judged", verdicts: [`v${index + 1}`], validVerdicts: [`v${index + 1}`] }));
}
const t1Outcomes = ["pass", "pass", "fail"];
const t2Outcomes = ["pass", "fail", "fail"];
const passKT1 = passKCells("passk/t1", "armA", t1Outcomes);
const passKT2 = passKCells("passk/t2", "armA", t2Outcomes);
const armBT1Outcomes = ["fail", "fail", "fail"];
const passKArmBT1 = passKCells("passk/t1", "armB", armBT1Outcomes);
const passKCellsAll = [...passKT1, ...passKT2, ...passKArmBT1];
const passKVerdictOutcomes = {};
[["passk/t1", t1Outcomes], ["passk/t2", t2Outcomes]].forEach(([label, outcomes]) => {
  outcomes.forEach((kind, index) => {
    passKVerdictOutcomes[digest(`${label}/armA/verdict/v${index + 1}`)] = verdictOutcome(kind);
  });
});
armBT1Outcomes.forEach((kind, index) => {
  passKVerdictOutcomes[digest(`passk/t1/armB/verdict/v${index + 1}`)] = verdictOutcome(kind);
});

const t1PassAt2 = passAtK(3, 2, 2);
const t2PassAt2 = passAtK(3, 1, 2);
const avgAt1 = (2 / 3 + 1 / 3) / 2;

const passAtKFixture = {
  methodId: "jinn.benchmarking.method/pass-at-k",
  methodVersion: "1",
  parameters: { k: 2 },
  verdictRule: "unanimous",
  matrices: [matrix(passKCellsAll)],
  verdictOutcomes: passKVerdictOutcomes,
  expectedResults: {
    verdictRule: "unanimous",
    k: 2,
    arms: {
      armA: {
        perTask: {
          [taskDigest("passk/t1")]: { n: 3, c: 2, passAtK: fixed4(t1PassAt2) },
          [taskDigest("passk/t2")]: { n: 3, c: 1, passAtK: fixed4(t2PassAt2) },
        },
        mean: fixed4((t1PassAt2 + t2PassAt2) / 2),
        missingTaskDigests: [],
      },
      armB: {
        perTask: {
          [taskDigest("passk/t1")]: { n: 3, c: 0, passAtK: fixed4(0) },
        },
        mean: fixed4(0),
        missingTaskDigests: [taskDigest("passk/t2")],
      },
    },
    incompatible: { count: 0, tasks: [] },
    conflicted: { count: 0, cellKeys: [] },
  },
};

const avgAtKFixture = {
  methodId: "jinn.benchmarking.method/avg-at-k",
  methodVersion: "1",
  parameters: {},
  verdictRule: "unanimous",
  matrices: [matrix(passKCellsAll)],
  verdictOutcomes: passKVerdictOutcomes,
  expectedResults: {
    verdictRule: "unanimous",
    arms: {
      armA: {
        perTask: {
          [taskDigest("passk/t1")]: { n: 3, c: 2, avgRate: fixed4(2 / 3) },
          [taskDigest("passk/t2")]: { n: 3, c: 1, avgRate: fixed4(1 / 3) },
        },
        mean: fixed4(avgAt1),
        missingTaskDigests: [],
      },
      armB: {
        perTask: {
          [taskDigest("passk/t1")]: { n: 3, c: 0, avgRate: fixed4(0) },
        },
        mean: fixed4(0),
        missingTaskDigests: [taskDigest("passk/t2")],
      },
    },
    conflicted: { count: 0, cellKeys: [] },
  },
};

// --- fixture 3: paired-mcnemar@1 ------------------------------------------------------------

const pairedOutcomes = [
  ["mcnemar/t1", "pass", "pass"], // concordant pass
  ["mcnemar/t2", "fail", "pass"], // improved (b)
  ["mcnemar/t3", "fail", "pass"], // improved (b)
  ["mcnemar/t4", "fail", "pass"], // improved (b)
  ["mcnemar/t5", "pass", "fail"], // regressed (c)
  ["mcnemar/t6", "fail", "fail"], // concordant fail
];
const mcnemarCells = pairedOutcomes.flatMap(([label]) => [
  cell(label, "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }),
  cell(label, "armB", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }),
]);
const mcnemarVerdictOutcomes = {};
for (const [label, a, b] of pairedOutcomes) {
  mcnemarVerdictOutcomes[digest(`${label}/armA/verdict/v`)] = verdictOutcome(a);
  mcnemarVerdictOutcomes[digest(`${label}/armB/verdict/v`)] = verdictOutcome(b);
}
const mcnemarP = mcnemarExact(3, 1);
const mcnemarFixture = {
  methodId: "jinn.benchmarking.method/paired-mcnemar",
  methodVersion: "1",
  parameters: { baseline: "armA", candidate: "armB" },
  verdictRule: "unanimous",
  matrices: [matrix(mcnemarCells)],
  verdictOutcomes: mcnemarVerdictOutcomes,
  expectedResults: {
    verdictRule: "unanimous",
    baseline: "armA",
    candidate: "armB",
    pairs: 6,
    improved: 3,
    regressed: 1,
    concordantPass: 1,
    concordantFail: 1,
    pairing: {
      taskDigests: pairedOutcomes.map(([label]) => taskDigest(label)).sort(),
    },
    excluded: { count: 0, cellKeys: [] },
    pValue: fixed4(mcnemarP),
    clustering: { basis: "task-provenance-source", clusters: 4 },
    clusteredPValue: "0.3173",
    designEffect: "1.0000",
    conflicted: { count: 0, cellKeys: [] },
  },
};

// --- fixture 3b: provenance-cluster-sign@1 -------------------------------------------------

const clusterSignOutcomes = Array.from({ length: 6 }, (_, index) =>
  [`cluster-sign/t${index + 1}`, "fail", "pass"]);
const clusterSignCells = clusterSignOutcomes.flatMap(([label]) => [
  cell(label, "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }),
  cell(label, "armB", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }),
]);
const clusterSignVerdictOutcomes = {};
const clusterSignTaskProvenance = {};
for (const [label, baseline, candidate] of clusterSignOutcomes) {
  const task = taskDigest(label);
  clusterSignVerdictOutcomes[digest(`${label}/armA/verdict/v`)] = verdictOutcome(baseline);
  clusterSignVerdictOutcomes[digest(`${label}/armB/verdict/v`)] = verdictOutcome(candidate);
  clusterSignTaskProvenance[task] = { source: `fixture-source/${task}` };
}
const clusterSignTasks = clusterSignOutcomes.map(([label]) => taskDigest(label)).sort();
const clusterSignFixture = {
  methodId: "jinn.benchmarking.method/provenance-cluster-sign",
  methodVersion: "1",
  parameters: { baseline: "armA", candidate: "armB" },
  verdictRule: "unanimous",
  matrices: [matrix(clusterSignCells)],
  verdictOutcomes: clusterSignVerdictOutcomes,
  taskProvenance: clusterSignTaskProvenance,
  runReplicates: 1,
  expectedResults: {
    verdictRule: "unanimous",
    baseline: "armA",
    candidate: "armB",
    pairing: { taskDigests: clusterSignTasks },
    clustering: { basis: "task-provenance-source", clusters: 6 },
    favorable: 6,
    unfavorable: 0,
    tied: 0,
    nonTied: 6,
    pValue: String(exactTwoSidedSign(6, 0)),
    votes: clusterSignTasks.map((task) => ({
      cluster: ["source", `fixture-source/${task}`],
      taskDelta: 1,
      vote: "favorable",
    })),
    excluded: { count: 0, cellKeys: [] },
    conflicted: { count: 0, cellKeys: [] },
  },
};

// --- fixture 4: clean-subset@1 (delegates to wilson) -----------------------------------------

// Contamination-filtering direction (design §9.2): "clean" means the item postdates a model's
// knowledge cutoff -- guaranteed not seen during training -- so the predicate KEEPS items whose
// provenance timestamp is >= cutoff, not before it.
const cleanSubsetCells = [
  cell("clean/t1", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass, pre-cutoff
  cell("clean/t2", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass, pre-cutoff
  cell("clean/t3", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // pass, post-cutoff
  cell("clean/t4", "armA", 1, { outcome: "judged", verdicts: ["v"], validVerdicts: ["v"] }), // fail, post-cutoff
];
const cleanSubsetVerdictOutcomes = {
  [digest("clean/t1/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("clean/t2/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("clean/t3/armA/verdict/v")]: verdictOutcome("pass"),
  [digest("clean/t4/armA/verdict/v")]: verdictOutcome("fail"),
};
const cleanSubsetTimestamps = {
  [taskDigest("clean/t1")]: "2026-01-01T00:00:00Z",
  [taskDigest("clean/t2")]: "2026-02-01T00:00:00Z",
  [taskDigest("clean/t3")]: "2026-04-01T00:00:00Z",
  [taskDigest("clean/t4")]: "2026-05-01T00:00:00Z",
};
const cleanSubsetKept = wilsonInterval(1, 2); // t3 (pass) + t4 (fail), post-cutoff
const cleanSubsetFixture = {
  methodId: "jinn.benchmarking.method/clean-subset",
  methodVersion: "1",
  parameters: {
    cutoff: "2026-03-01T00:00:00Z",
    basis: "self-declared",
    delegate: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
  },
  verdictRule: "unanimous",
  matrices: [matrix(cleanSubsetCells)],
  verdictOutcomes: cleanSubsetVerdictOutcomes,
  taskTimestamps: cleanSubsetTimestamps,
  expectedResults: {
    basis: "self-declared",
    cutoff: "2026-03-01T00:00:00Z",
    keptTaskDigests: [taskDigest("clean/t3"), taskDigest("clean/t4")].sort(),
    excludedByPredicate: {
      count: 2,
      cellKeys: [
        cellKey(taskDigest("clean/t1"), "armA", 1),
        cellKey(taskDigest("clean/t2"), "armA", 1),
      ].sort(),
    },
    delegate: {
      verdictRule: "unanimous",
      arms: {
        armA: {
          n: 2,
          passRate: fixed4(cleanSubsetKept.p),
          wilsonInterval: { low: fixed4(cleanSubsetKept.lo), high: fixed4(cleanSubsetKept.hi) },
        },
      },
      conflicted: { count: 0, cellKeys: [] },
    },
    conflicted: { count: 0, cellKeys: [] },
  },
};

// --- fixture 5: noninferiority-iut@1 exact deterministic replay ------------------------------

function erf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}
function tiedNegativeWilcoxonP(n) {
  const meanW = (n * (n + 1)) / 4;
  const sdW = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  return normCdf((0 - meanW + 0.5) / sdW);
}

function noninferiorityFixture(name, baselineOutcomes, candidateOutcomes) {
  const cells = [];
  const verdictOutcomes = {};
  const taskDigests = [];
  const costExcluded = [];
  for (let index = 0; index < baselineOutcomes.length; index++) {
    const label = `noninferiority/${name}/t${String(index + 1).padStart(2, "0")}`;
    const task = taskDigest(label);
    taskDigests.push(task);
    const baseline = baselineOutcomes[index];
    const candidate = candidateOutcomes[index];
    const baselineCell = cell(label, "armA", 1, {
      outcome: "judged",
      verdicts: ["v"],
      validVerdicts: ["v"],
      cost: "2",
    });
    const candidateCell = cell(label, "armB", 1, {
      outcome: "judged",
      verdicts: ["v"],
      validVerdicts: ["v"],
      cost: "1",
    });
    cells.push(baselineCell, candidateCell);
    verdictOutcomes[digest(`${label}/armA/verdict/v`)] = verdictOutcome(baseline);
    verdictOutcomes[digest(`${label}/armB/verdict/v`)] = verdictOutcome(candidate);
    if (baseline !== "pass" || candidate !== "pass") {
      costExcluded.push(baselineCell.cellKey, candidateCell.cellKey);
    }
  }
  taskDigests.sort();
  costExcluded.sort();

  const n = baselineOutcomes.length;
  const enoughQuality = n >= 5;
  const meanA = baselineOutcomes.filter((outcome) => outcome === "pass").length / n;
  const meanB = candidateOutcomes.filter((outcome) => outcome === "pass").length / n;
  const delta = meanB - meanA;
  const relativeRegression = meanA > 0 ? Math.max(0, meanA - meanB) / meanA : 0;
  const qualityVerdict = !enoughQuality
    ? "inconclusive"
    : delta > -0.05 && relativeRegression <= 0.15
      ? "pass"
      : "fail";
  const bothSolve = baselineOutcomes.filter((outcome, index) =>
    outcome === "pass" && candidateOutcomes[index] === "pass").length;
  const costVerdict = bothSolve < 10 ? "inconclusive" : "lower";
  const overall = qualityVerdict === "fail"
    ? "FAIL"
    : qualityVerdict === "inconclusive" || costVerdict === "inconclusive"
      ? "INCONCLUSIVE"
      : "PASS";

  return {
    methodId: "jinn.benchmarking.method/noninferiority-iut",
    methodVersion: "1",
    parameters: { baseline: "armA", candidate: "armB", seed: 123456789, resamples: 1000 },
    verdictRule: "unanimous",
    matrices: [matrix(cells)],
    verdictOutcomes,
    expectedResults: {
      verdictRule: "unanimous",
      baseline: "armA",
      candidate: "armB",
      verdict: overall,
      pairing: { taskDigests },
      quality: {
        verdict: qualityVerdict,
        lowerBound: enoughQuality ? fixed4(delta) : null,
        relativeRegression: enoughQuality ? fixed4(relativeRegression) : null,
        reasons: !enoughQuality
          ? [`fewer than minN=5 paired tasks (got ${n})`]
          : qualityVerdict === "fail"
            ? [
                `absolute NI failed: lower bound ${delta.toFixed(3)} <= -delta (-0.05)`,
                ...(relativeRegression > 0.15
                  ? [`relative guard failed: regression ${(relativeRegression * 100).toFixed(1)}% > cap 15%`]
                  : []),
              ]
            : [],
      },
      cost: {
        verdict: costVerdict,
        pValue: costVerdict === "lower" ? fixed4(tiedNegativeWilcoxonP(bothSolve)) : null,
        n: bothSolve,
        excluded: { count: costExcluded.length, cellKeys: costExcluded },
      },
      excluded: { count: 0, cellKeys: [] },
      conflicted: { count: 0, cellKeys: [] },
      bootstrap: {
        procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
        ...sourceClusters(taskDigests, 1000),
      },
    },
  };
}

const noninferiorityPassFixture = noninferiorityFixture(
  "pass",
  Array(10).fill("pass"),
  Array(10).fill("pass"),
);
const noninferiorityFailFixture = noninferiorityFixture(
  "fail",
  Array(10).fill("pass"),
  Array(10).fill("fail"),
);
const noninferiorityInconclusiveFixture = noninferiorityFixture(
  "inconclusive",
  Array(3).fill("pass"),
  Array(3).fill("pass"),
);

// --- write ------------------------------------------------------------------------------------

const fixtures = {
  "wilson": wilsonFixture,
  "pass-at-k": passAtKFixture,
  "avg-at-k": avgAtKFixture,
  "paired-mcnemar": mcnemarFixture,
  "provenance-cluster-sign": clusterSignFixture,
  "clean-subset": cleanSubsetFixture,
  "noninferiority-pass": noninferiorityPassFixture,
  "noninferiority-fail": noninferiorityFailFixture,
  "noninferiority-inconclusive": noninferiorityInconclusiveFixture,
};

for (const [name, fixture] of Object.entries(fixtures)) {
  const path = join(outDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
