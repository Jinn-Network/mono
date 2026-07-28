// Generates the §16 method-fixture set for `describeMethodRegistryConformance` (Task 2.4).
//
// Ground truth is computed HERE, independently of `@jinn-network/benchmarking-aggregate`'s
// implementation (kit-precedes-implementation, program §7.6): this script re-implements the
// closed-form Wilson interval, the exact McNemar test (ported verbatim from the already-shipped
// `packages/core/src/paired.ts`, itself independently tested), and the Chen 2021 unbiased
// pass@k estimator from scratch. `aggregate` is written afterward to reproduce these pinned
// numbers, not the other way around.
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
 *   + verdict-consistency passed) -- the ones a Method's `resolveVerdict` port can resolve
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
    protocol: "https://jinn.network/protocols/benchmarking/1.0",
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
const passKCellsAll = [...passKT1, ...passKT2];
const passKVerdictOutcomes = {};
[["passk/t1", t1Outcomes], ["passk/t2", t2Outcomes]].forEach(([label, outcomes]) => {
  outcomes.forEach((kind, index) => {
    passKVerdictOutcomes[digest(`${label}/armA/verdict/v${index + 1}`)] = verdictOutcome(kind);
  });
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
    perTask: {
      [taskDigest("passk/t1")]: { n: 3, c: 2, passAtK: fixed4(t1PassAt2) },
      [taskDigest("passk/t2")]: { n: 3, c: 1, passAtK: fixed4(t2PassAt2) },
    },
    mean: fixed4((t1PassAt2 + t2PassAt2) / 2),
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
    perTask: {
      [taskDigest("passk/t1")]: { n: 3, c: 2, avgRate: fixed4(2 / 3) },
      [taskDigest("passk/t2")]: { n: 3, c: 1, avgRate: fixed4(1 / 3) },
    },
    mean: fixed4(avgAt1),
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
    excluded: { count: 0, cellKeys: [] },
    pValue: fixed4(mcnemarP),
  },
};

// --- fixture 4: clean-subset@1 (delegates to wilson) -----------------------------------------

const cleanSubsetTimestamps = {
  [taskDigest("wilson/t1")]: "2026-01-01T00:00:00Z",
  [taskDigest("wilson/t2")]: "2026-01-15T00:00:00Z",
  [taskDigest("wilson/t3")]: "2026-02-10T00:00:00Z",
  [taskDigest("wilson/t4")]: "2026-04-01T00:00:00Z",
  [taskDigest("wilson/t5")]: "2026-04-15T00:00:00Z",
  [taskDigest("wilson/t6")]: "2026-05-01T00:00:00Z",
};
// cutoff keeps t1,t2,t3 (all pass) out of armA's 4 scored cells; t4 (fail) and the
// unjudged/conflicted cells fall away regardless.
const cleanSubsetKept = wilsonInterval(3, 3);
const cleanSubsetFixture = {
  methodId: "jinn.benchmarking.method/clean-subset",
  methodVersion: "1",
  parameters: {
    cutoff: "2026-02-15T00:00:00Z",
    basis: "self-declared",
    delegate: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
  },
  verdictRule: "unanimous",
  matrices: [matrix(wilsonCells)],
  verdictOutcomes: wilsonVerdictOutcomes,
  taskTimestamps: cleanSubsetTimestamps,
  expectedResults: {
    basis: "self-declared",
    cutoff: "2026-02-15T00:00:00Z",
    kept: 3,
    excludedByPredicate: 3,
    delegate: {
      verdictRule: "unanimous",
      arms: {
        armA: {
          n: 3,
          passRate: fixed4(cleanSubsetKept.p),
          wilsonInterval: { low: fixed4(cleanSubsetKept.lo), high: fixed4(cleanSubsetKept.hi) },
        },
      },
      conflicted: { count: 0, cellKeys: [] },
    },
  },
};

// --- write ------------------------------------------------------------------------------------

const fixtures = {
  "wilson": wilsonFixture,
  "pass-at-k": passAtKFixture,
  "avg-at-k": avgAtKFixture,
  "paired-mcnemar": mcnemarFixture,
  "clean-subset": cleanSubsetFixture,
};

for (const [name, fixture] of Object.entries(fixtures)) {
  const path = join(outDir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
