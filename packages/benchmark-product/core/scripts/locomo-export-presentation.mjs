#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

/**
 * Builds the `colophon.report-presentation/2` payload for the LoCoMo judge report from that run's
 * OWN sealed records, and refuses to emit one that has drifted from them.
 *
 * The narrative is authored — the title, the summary, the five questions in the words they were
 * posted in, the ten limitations, the practice framing. Every NUMBER is read out of the sealed
 * Report and Run in the workspace's content-addressed store. Nothing is typed twice, because a
 * number typed twice is a number that will eventually disagree with itself.
 *
 * The guard at the bottom is the point of the script, and it is modelled on
 * `demo1-export-public-bundle.mjs`: the published sentences make specific claims about the shape of
 * this experiment (240 items, 80 per class, four strata, six arms, 4,320 of 4,320 cells, 22 neutral
 * results, 7 exclusions all in one arm). If the sealed record ever stops backing one of those, the
 * honest outcome is a hard throw naming what moved, not a page whose prose and whose table have
 * quietly diverged.
 *
 *   node scripts/locomo-export-presentation.mjs \
 *     --workspace /path/to/workspace --draft <draftId> --output presentation.json
 *
 * The output is a file, deliberately, not a workspace write: sealing it is `presentation set`'s job,
 * and that operation is the one that binds it to the run and records its digest.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_SLUG = "judging-the-locomo-judges";
export const PUBLIC_TITLE = "Judging the LoCoMo judges";
const PRESENTATION_SCHEMA = "colophon.report-presentation/2";
const BUNDLE_FORMAT = "benchmark-product-public-bundle/7";
const VERIFY_COMMAND = "npx @colophon-claims/verify@0.2.1 <bundle-dir>";
const VERIFY_COMPATIBLE_COMMAND = "npx @colophon-claims/verify@0.2 <bundle-dir>";
/**
 * What a reader running the pinned command against THIS bundle will actually see. Eight, not the
 * format's seven: a `/7` bundle that carries a presentation runs `report-presentation` too, and a
 * page that promised seven while the reader counted eight would be wrong in the one place a reader
 * is most entitled to be able to check.
 */
const BUNDLE_CHECKS = [
  "manifest",
  "evidence-closure",
  "trust",
  "matrix-rederivation",
  "report-verification",
  "claim-consistency",
  "integrity-anchors",
  "report-presentation",
];
const DESIGN_URL = "https://github.com/snap-research/locomo/issues/23#issuecomment-5334425775";

/**
 * The shape the published sentences assert. Every entry is re-derived below and compared; a
 * mismatch throws with both sides printed. These are NOT inputs to the payload — every number the
 * payload carries is read from the record, and these only decide whether the prose may ship.
 */
const ACCOUNTING_CONTRACT = {
  items: 240,
  itemsPerCandidateClass: 80,
  candidateClasses: 3,
  strata: 4,
  arms: 6,
  expectedCells: 4320,
  judgedCells: 4320,
  lostCells: 0,
  parserNeutralCalls: 22,
  excludedItems: 7,
  excludedArms: 1,
  conflictedCells: 0,
};

/**
 * The two companion modules are separately registered runs with their own published bundles. Their
 * digests are quoted from the report text; they are NOT re-derivable from this workspace, and the
 * payload marks the questions they answer as proven by them rather than by this bundle.
 */
const COMPANION_BUNDLES = [
  {
    name: "consistency-gate",
    runSha256: "06ae9e458b12562015296228297828e22f291ec0c73ec6833eec4288f0511be6",
    matrixSha256: "aaeddc612a8625d598ccce4ffa03318ed546cce3854912244baa4cce91a79d60",
    bundleIdentity: "d1535f32bfa850f2e5ecedcae4be97e17e6dedff37aebe412f2ef6d36fc6a404",
  },
  {
    name: "corrupt-key-check",
    runSha256: "bdc3b0e2ac4c22e9a859b5879118af7df3939ad4501ea3afd4c8ede0770e509d",
    matrixSha256: "2a788dc9cdcaa53260dac8b0f7728d3bfd62aac24ccfcbaddc213fa0729ea2d7",
    bundleIdentity: "271f87db4e616992dea75483ec69e92624ab7fc84aeb32e6a0bc82674dc506ed",
  },
];

/** Reader-facing names for the six arms. The ids themselves come from the sealed Run. */
const ARM_LABELS = {
  "strict-dial": "strict-dial",
  audited: "audited",
  mem0: "mem0",
  "mem0-evidence": "mem0-evidence",
  backboard: "backboard",
  revised: "revised",
};

/** The five questions as posted on 18 August 2026, before anything ran. */
const PRE_REGISTERED = [
  {
    id: "q1",
    question:
      "How often does each judge accept a known-wrong answer, and does it depend on how the answer is wrong?",
    answer:
      "Constantly, and it depends enormously: 2.5 to 28.8 percent for confidently wrong answers, 32.5 to 88.8 percent for vague on-topic answers.",
    provenBy: "this-bundle",
  },
  {
    id: "q2",
    question: "What does strictness cost in rejected right answers?",
    answer:
      "Almost nothing when the key is right: one rejection across 479 graded right answers. The cost appears when the key is wrong (question 5).",
    provenBy: "this-bundle",
  },
  {
    id: "q3",
    question: "Is \"the LoCoMo score\" one instrument or several?",
    answer:
      "Several. The same answers score 60.8 to 87.9 percent depending only on the grader.",
    provenBy: "this-bundle",
  },
  {
    id: "q4",
    question: "Does showing the judge the evidence matter, holding the prompt fixed?",
    answer:
      "Yes: 7.7 points of agreement, 95 percent interval 4.3 to 11.2, concentrated entirely in vague on-topic answers.",
    provenBy: "paired-majority-delta",
  },
  {
    id: "q5",
    question: "When the answer key is wrong, does the judge follow the broken key or the truth?",
    answer:
      "It depends on the judge: judges followed a broken key against a true answer 10 to 70 percent of the time.",
    provenBy: "corrupt-key-check",
  },
];

/** Section 13, verbatim. */
const LIMITATIONS = [
  "Judges are measured as reconstructed here: posted prompts, declared parsers, one model snapshot. Vendors' full harnesses may differ in parsing, aggregation, or shipped judge model, and the audit did not pin the provider behind its 62.81 percent figure, so exact reproduction is not promised. No published run can be exactly re-run by anyone, including its publisher, which is the disclosure problem this experiment exists to document.",
  "Labels are model-proposed and sample-checked, not fully hand-labelled. They can be wrong. The sample agreement rate, published evidence pointers, and published exclusions make that inspectable rather than infallible.",
  "Drawn candidates were originally generated with access to the answer key, so this measures judge behaviour on declared answer types, not how often those types occur in the wild.",
  "80 items per class detects effects of the size the audit found, not subtle ones.",
  "The corrupt-key check and the consistency gate are constructed and say nothing about prevalence.",
  "Majority of three tempers but does not remove randomness.",
  "This is a local, self-run venue: one operator controls dispatch, execution, and evaluation. Pre-registration is a discipline enforced by the tooling, not a proof against the run's own owner.",
  "Harness and model pinning are enforced at dispatch for all 4,320 gradings. Isolation and loadout pinning are unverifiable for all of them. The integrity tier is attested-only for every cell.",
  "Judge cost is self-reported by this venue and was never independently settled.",
  "Published materials carry pointers into the dataset, not full conversations, per its licence.",
];

const SELF_RUN_DISCLOSURE =
  "This is a local, self-run venue: one operator controls dispatch, execution, and evaluation."
  + " Pre-registration is a discipline enforced by the tooling, not a proof against the run's own owner."
  + " Harness and model pinning are enforced at dispatch for all 4,320 gradings; isolation and loadout"
  + " pinning are unverifiable for all of them, and the integrity tier is attested-only for every cell."
  + " Judge cost is self-reported by this venue and was never independently settled.";

const SUMMARY =
  "Every score in the LoCoMo dispute is compared as though it came from one fixed test. It did not:"
  + " each publisher brings its own judge model and judge prompt, scores its own system, and reports"
  + " the number next to everyone else's. This experiment put six published judge prompts on one"
  + " shared bank of 240 answers with published, evidence-checked labels, held the judge model fixed"
  + " at one dated snapshot, and graded every answer three times. The same answers score 60.8 to 87.9"
  + " percent depending only on the grader, a 27 point swing. Every judge is three to seven times more"
  + " forgiving of a vague on-topic answer than a confidently wrong one. It measures graders. It does"
  + " not evaluate, rank, or re-score any memory system.";

const INTERPRETATION =
  "Swapping the grader moves the score by 27 points on identical inputs, which is wider than most"
  + " published gaps between competing systems. Judges ranked next to each other have overlapping"
  + " intervals: the ordering of neighbouring judges is not established, the spread is.";

const METHOD_STATEMENT =
  "This method measures graders against a shared labelled bank. It does not rank memory systems,"
  + " certify a judge, or establish how often any of these behaviours occurs inside a published score.";

const decoder = new TextDecoder("utf-8", { fatal: true });
const codeUnitCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Reads a sealed record by digest and re-verifies it, exactly as the product's own store does. */
function sealedRecord(workspaceDir, sha256) {
  const path = join(workspaceDir, "records", `${sha256}.bin`);
  const bytes = new Uint8Array(readFileSync(path));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== sha256) throw new Error(`sealed record ${sha256} does not match its own bytes`);
  return JSON.parse(decoder.decode(bytes));
}

function proportion(source) {
  return {
    numerator: source.numerator,
    denominator: source.denominator,
    estimate: source.estimate,
    wilsonInterval: { low: source.wilsonInterval.low, high: source.wilsonInterval.high },
  };
}

/** Points between two decimal-string proportions, rendered at the same precision the record uses. */
function pointsBetween(high, low) {
  return ((Number(high) - Number(low)) * 100).toFixed(1);
}

export function buildLocomoPresentation({ workspaceDir, draftId }) {
  const runState = readJson(join(workspaceDir, "runs", `${draftId}.json`));
  for (const field of ["runSha256", "matrixSha256", "reportSha256", "reportEnvelopeSha256", "reportedAt"]) {
    if (runState[field] === undefined) throw new Error(`run ${draftId} has no ${field}; report it before presenting it`);
  }
  const report = sealedRecord(workspaceDir, runState.reportSha256);
  const run = sealedRecord(workspaceDir, runState.runSha256);
  const benchmark = sealedRecord(workspaceDir, run.benchmark.digest.sha256);

  if (report.method.id !== "jinn.benchmarking.method/binary-instrument") {
    throw new Error(`this presentation projects a binary-instrument report, not ${report.method.id}`);
  }
  const perSubject = report.results.perSubject;
  if (perSubject.length !== 1) throw new Error(`expected exactly one subject, found ${perSubject.length}`);
  const results = perSubject[0].results;
  const disclosures = report.disclosures.perSubject[0];
  const configuration = results.configuration;

  // ── Everything below is READ, never typed ────────────────────────────────────────────────────
  const armIds = Object.keys(results.arms).sort(codeUnitCompare);
  const perArm = armIds.map((armId) => {
    const arm = results.arms[armId];
    const byClass = arm.byCandidateClass;
    return {
      armId,
      agreement: proportion(arm.agreement),
      acceptsSpecificWrong: proportion(byClass["specific-wrong"].falseAccept),
      acceptsVagueTopicalWrong: proportion(byClass["vague-topical-wrong"].falseAccept),
      rejectsCorrect: proportion(byClass.correct.falseReject),
    };
  });
  const ranked = [...perArm].sort((left, right) => Number(left.agreement.estimate) - Number(right.agreement.estimate));
  const lowest = ranked[0];
  const highest = ranked[ranked.length - 1];

  const perCandidateClass = configuration.candidateClasses.map((candidateClass) => ({
    candidateClass,
    // Item counts come from the arm with no exclusions, which is the bank as drawn.
    items: results.arms[armIds.find((armId) => results.arms[armId].item.excluded === 0)]
      .byCandidateClass[candidateClass].item.expected,
  }));
  const cleanArmId = armIds.find((armId) => results.arms[armId].item.excluded === 0);
  const perStratum = configuration.strata.map((stratum) => ({
    stratum,
    items: results.arms[cleanArmId].byStratum[stratum].item.expected,
  }));

  const parserNeutralCalls = armIds.reduce((total, armId) => total
    + configuration.candidateClasses.reduce(
      (sum, candidateClass) => sum + results.arms[armId].byCandidateClass[candidateClass].parserInvalid.numerator,
      0,
    ), 0);
  const excludedByArm = armIds
    .map((armId) => ({ armId, items: results.arms[armId].item.excluded }))
    .filter((entry) => entry.items > 0);
  const unstableItems = armIds.reduce((total, armId) => total + results.arms[armId].item.unstable, 0);
  const gradedItems = armIds.reduce((total, armId) => total + results.arms[armId].item.complete, 0);

  const armInstruments = new Map(run.arms.map((arm) => [
    arm.armId,
    arm.pinning["network.jinn.binary-judgment.instrument"],
  ]));
  const judgeModels = [...new Set(run.arms.map((arm) => arm.pinning.model.id))];
  if (judgeModels.length !== 1) {
    throw new Error(`the panel is only comparable if every arm shares one judge model; found ${judgeModels.join(", ")}`);
  }
  const harnesses = [...new Set(run.arms.map((arm) => `${arm.pinning.harness.id}@${arm.pinning.harness.version}`))];
  if (harnesses.length !== 1) throw new Error(`arms disagree on the judge harness: ${harnesses.join(", ")}`);
  const [harnessId, harnessVersion] = harnesses[0].split("@");

  assertAccountingContract({
    items: perCandidateClass.reduce((total, entry) => total + entry.items, 0),
    itemsPerCandidateClass: new Set(perCandidateClass.map((entry) => entry.items)).size === 1
      ? perCandidateClass[0].items
      : -1,
    candidateClasses: configuration.candidateClasses.length,
    strata: configuration.strata.length,
    arms: armIds.length,
    expectedCells: disclosures.completeness.expected,
    judgedCells: disclosures.completeness.judged,
    lostCells: disclosures.completeness.expected - disclosures.completeness.judged,
    parserNeutralCalls,
    excludedItems: results.excluded.count,
    excludedArms: excludedByArm.length,
    conflictedCells: results.conflicted.count,
  });

  return {
    schema: PRESENTATION_SCHEMA,
    slug: PUBLIC_SLUG,
    title: PUBLIC_TITLE,
    summary: SUMMARY,
    sealedAt: runState.reportedAt,
    subject: {
      judgeModel: judgeModels[0],
      harness: { id: harnessId, version: harnessVersion },
      benchmark: {
        name: benchmark.name,
        description: benchmark.description,
        sha256: run.benchmark.digest.sha256,
      },
      arms: armIds.map((armId) => ({
        id: armId,
        label: ARM_LABELS[armId] ?? armId,
        instrumentSha256: armInstruments.get(armId),
      })),
    },
    question: {
      designUrl: DESIGN_URL,
      postedOn: "2026-08-18",
      preRegistered: PRE_REGISTERED,
    },
    execution: {
      judgePrompts: {
        count: armIds.length,
        provenance:
          "Used as posted by their publishers and community contributors, with nothing authored or"
          + " tuned here. Each arm is pinned to its own sealed instrument digest.",
      },
      modelSnapshot: {
        id: judgeModels[0],
        temperature: "0",
        profile: report.method.parameters.judgeModelProfile,
      },
      replicates: run.replicates,
      reduction: configuration.reduction,
      abstainPolicy: {
        parserInvalid: configuration.parserInvalidPolicy,
        description:
          "Unparseable output records a neutral inconclusive result rather than a rejection, and an"
          + " item whose three repeats produce no majority is a visible exclusion rather than a drop.",
      },
      intervals: "95 percent Wilson, with every rate carrying its count and its denominator",
      truthAdmission: configuration.truthAdmission,
      venue: run.venue.kind,
    },
    result: {
      primary: "agreement-with-human-labels",
      perArm,
      spread: {
        lowestArmId: lowest.armId,
        highestArmId: highest.armId,
        pointsBetween: pointsBetween(highest.agreement.estimate, lowest.agreement.estimate),
      },
      interpretation: INTERPRETATION,
      methodStatement: METHOD_STATEMENT,
    },
    population: {
      items: perCandidateClass.reduce((total, entry) => total + entry.items, 0),
      perCandidateClass,
      perStratum,
      labels:
        "Published and evidence-checked, but model-proposed and sample-checked rather than fully"
        + " hand-labelled. The sample agreement rate, the evidence pointers, and the exclusions are"
        + " published so that is inspectable rather than infallible.",
    },
    accounting: {
      cells: {
        expected: disclosures.completeness.expected,
        judged: disclosures.completeness.judged,
        lost: disclosures.completeness.expected - disclosures.completeness.judged,
      },
      parserNeutral: {
        calls: parserNeutralCalls,
        denominator: disclosures.completeness.expected,
        policy: configuration.parserInvalidPolicy,
        note:
          "The unparseable output traces to the instrument rather than to a parser gap: the"
          + " faithfully reproduced prompt asks for an explanation and a JSON label, and the sealed"
          + " grammar accepts a fenced label but refuses surrounding prose.",
      },
      excludedItems: { count: results.excluded.count, byArm: excludedByArm },
      // The sealed Report carries the floor as a decimal STRING; older material carried a JSON
      // number. Normalized to one fixed precision either way rather than trusting the encoding.
      completenessFloor: Number(disclosures.completeness.floor).toFixed(4),
      runOutcome: disclosures.completeness.runOutcome,
    },
    manipulationCheck: {
      replicateInstability: { unstableItems, gradedItems },
      conflictedCells: results.conflicted.count,
      companionChecks: [
        {
          name: "consistency gate",
          finding:
            "Twelve set-relation probes, half subset and half superset, including the four cases that"
            + " opened the community thread. Three of five judges grade the same set operation"
            + " inconsistently, and the two that pass do so by accepting every variant.",
          provenBy: "consistency-gate",
        },
        {
          name: "corrupt-key positive control",
          finding:
            "Twenty questions whose official answers the audit found to be wrong, each paired with an"
            + " answer that is actually true, graded under the broken key and again under the"
            + " corrected one. Every judge scored 20 of 20 under the corrected key, so the"
            + " disagreement lives entirely in the broken-key condition.",
          provenBy: "corrupt-key-check",
        },
      ],
    },
    limitations: LIMITATIONS,
    selfRunDisclosure: SELF_RUN_DISCLOSURE,
    verification: {
      bundleFormat: BUNDLE_FORMAT,
      checks: BUNDLE_CHECKS,
      command: VERIFY_COMMAND,
      compatibleCommand: VERIFY_COMPATIBLE_COMMAND,
      readerAvailability: "available",
      reportSha256: runState.reportSha256,
      reportEnvelopeSha256: runState.reportEnvelopeSha256,
    },
    provenance: {
      runSha256: runState.runSha256,
      benchmarkSha256: run.benchmark.digest.sha256,
      matrixSha256: runState.matrixSha256,
      reportSha256: runState.reportSha256,
      reportEnvelopeSha256: runState.reportEnvelopeSha256,
      anchors: (runState.anchors ?? []).map((anchor) => ({
        subject: anchor.subject,
        provider: anchor.provider,
        recordSha256: anchor.recordSha256,
      })),
      siblingAnalyses: (runState.additionalReports ?? []).map((entry) => ({
        method: entry.method,
        version: entry.version,
        reportSha256: entry.reportSha256,
      })),
      companionBundles: COMPANION_BUNDLES,
    },
  };
}

/**
 * The drift guard. Every published sentence that states a shape is checked against what the sealed
 * record actually says, and a mismatch prints both sides rather than shipping prose the table does
 * not back.
 */
function assertAccountingContract(derived) {
  const drifted = Object.entries(ACCOUNTING_CONTRACT)
    .filter(([key, expected]) => derived[key] !== expected)
    .map(([key, expected]) => `${key}: sealed ${derived[key]}, presentation asserts ${expected}`);
  if (drifted.length !== 0) {
    throw new Error(
      "the sealed LoCoMo judge-report accounting no longer matches the published presentation"
      + ` contract:\n  ${drifted.join("\n  ")}`,
    );
  }
}

function argument(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1 || args[index + 1] === undefined) {
    throw new Error(
      "usage: locomo-export-presentation.mjs --workspace <dir> --draft <draftId> --output <file>",
    );
  }
  return args[index + 1];
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const output = resolve(argument(args, "output"));
    if (existsSync(output)) throw new Error(`refusing to overwrite existing output file: ${output}`);
    const presentation = buildLocomoPresentation({
      workspaceDir: resolve(argument(args, "workspace")),
      draftId: argument(args, "draft"),
    });
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(presentation, null, 2)}\n`);
    console.log(`wrote ${presentation.schema} for "${presentation.slug}" to ${output}`);
    console.log(`presents report ${presentation.provenance.reportSha256}`);
    console.log(`${presentation.result.perArm.length} arms, ${presentation.population.items} items, `
      + `${presentation.accounting.cells.judged} of ${presentation.accounting.cells.expected} cells`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
