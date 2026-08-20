import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJsonBytes,
  tupleDigest,
  type ExecutionPolicyTuple,
  type JsonValue,
} from "@jinn-network/policy-identity";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_PROTOCOL,
  cellKey,
  sealMatrix,
  sealReport,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { describe, expect, it } from "vitest";
import { archiveLayout, defaultArchiveRoot, readAdoptionLog } from "../archive/store.js";
import { prepareLocalCampaignAdoption } from "./live-adoption.js";
import { sealLocalLoadoutDirectory } from "./loadout-archive.js";
import {
  prepareSweRebenchJourney,
  type SweRebenchJourneyPorts,
} from "./swe-rebench-journey.js";

function row(index: number) {
  return {
    instance_id: `owner-${index}__repo-${index}-${100 + index}`,
    repo: `owner-${index}/repo-${index}`,
    base_commit: String(index + 1).padStart(40, "a").slice(0, 40),
    problem_statement: `Repair public issue ${index}`,
    created_at: `2026-02-${String(index + 1).padStart(2, "0")} 01:02:03`,
    image_name: `registry.example/rebench-${index}:latest`,
    test_patch: `diff --git a/test_${index}.py b/test_${index}.py`,
    patch: "NEVER INCLUDED",
    FAIL_TO_PASS: [`test_${index}.py::test_fix`],
    PASS_TO_PASS: [`test_${index}.py::test_existing`],
    install_config: {
      install: [],
      test_cmd: [`python -m pytest test_${index}.py`],
      log_parser: "parse_log_pytest",
    },
  };
}

const ports: SweRebenchJourneyPorts = {
  fetchRows: async () => Array.from({ length: 6 }, (_, index) => row(index)),
  resolveImage: async (image) => {
    const ordinal = Number(/rebench-(\d+)/u.exec(image)?.[1] ?? "0");
    const digest = `sha256:${ordinal.toString(16).padStart(64, "0")}`;
    return { source: image, reference: image.replace(/:latest$/u, `@${digest}`), digest };
  },
  resolveHarness: async (id) => ({
    id,
    executable: "/opt/jinn/bin/codex",
    digest: `sha256:${"f".repeat(64)}`,
    version: "codex-cli 1.2.3",
  }),
};

function loadout(root: string, name: "current" | "candidate") {
  const directory = join(root, name);
  mkdirSync(join(directory, name === "current" ? "notes" : "skills"), { recursive: true });
  writeFileSync(
    join(directory, name === "current" ? "notes/policy.md" : "skills/policy.md"),
    `${name} policy\n`,
  );
  return { directory, sealed: sealLocalLoadoutDirectory(directory) };
}

function candidateTuple(current: ExecutionPolicyTuple, digest: string): ExecutionPolicyTuple {
  return {
    ...current,
    loadout: { ...(current.loadout as Record<string, string>), digest },
  };
}

function writeRecommendationEvidence(input: {
  readonly preparedRoot: string;
  readonly currentTupleDigest: string;
  readonly candidateTupleDigest: string;
  readonly methods: readonly {
    readonly id: string;
    readonly version: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  }[];
  readonly proven?: boolean;
}): void {
  const runRoot = join(input.preparedRoot, "run");
  const reportsRoot = join(runRoot, "reports");
  mkdirSync(reportsRoot, { recursive: true, mode: 0o700 });
  const task = "a".repeat(64);
  const author = "urn:uuid:10000000-0000-5000-8000-000000000001";
  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "b".repeat(64) } },
    owner: author,
    arms: [
      { armId: "current", pinning: { loadout: { op: "eq", value: input.currentTupleDigest } } },
      { armId: "challenger", pinning: { loadout: { op: "eq", value: input.candidateTupleDigest } } },
    ],
    replicates: 1,
    policy: {
      completenessFloor: "1", cellWindow: 1,
      replacement: { allowed: false }, independence: "disclosed",
      evaluation: { minVerdicts: 1 }, submissionBaseline: {},
    },
    analysisPlan: input.methods.map((method) => ({
      method: method.id, version: method.version, parameters: method.parameters,
    })),
    closeAt: "2026-08-11T10:00:00Z",
  });
  const verification = {
    harness: "match" as const, model: "match" as const, loadout: "match" as const,
    isolation: "match" as const, checksFailed: [],
  };
  const counts = {
    expected: 1, judged: 1, unjudged: 0, unscorable: 0, expired: 0,
    invalidated: 0, excluded: 0, replacements: 0,
  };
  const matrix = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-11T10:00:00Z" },
    cells: ["challenger", "current"].map((armId) => ({
      cellKey: cellKey(task, armId, 1), taskDigest: task, armId, replicate: 1,
      dispatches: 1, accounted: 1,
      submission: `sha256:${armId === "current" ? "d".repeat(64) : "e".repeat(64)}`,
      delivery: `sha256:${armId === "current" ? "f".repeat(64) : "9".repeat(64)}`,
      verdicts: [`sha256:${"c".repeat(64)}`], validVerdicts: [`sha256:${"c".repeat(64)}`],
      outcome: "judged" as const, verification, integrityTier: "re-derivable" as const,
    })),
    exclusions: [],
    attrition: { perArm: { current: counts, challenger: counts }, asymmetryFlags: [] },
    completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "fixture", version: "1" },
  });
  const disclosure = {
    subjectSha256: matrix.digest.slice("sha256:".length),
    integrityTiers: { "re-derivable": 2, "attested-only": 0 },
    pinning: Object.fromEntries(["harness", "model", "loadout", "isolation"].map((axis) =>
      [axis, { match: 2, mismatch: 0, unverifiable: 0 }])),
    independence: 2,
    completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
    attrition: { perArm: { current: counts, challenger: counts }, asymmetryFlags: [] },
  };
  for (const method of input.methods) {
    const proofProbability = input.proven === false ? "0.5" : "0.03125";
    const results = method.id === BENCHMARKING_METHOD_IDS.pairedMcnemar
      ? { improved: 6, regressed: 0, "pValue": proofProbability }
      : method.id === BENCHMARKING_METHOD_IDS.provenanceClusterSign
        ? { favorable: 6, unfavorable: 0, nonTied: 6, "pValue": proofProbability }
        : { arms: {} };
    const report = sealReport({
      protocol: BENCHMARKING_PROTOCOL,
      subjects: [{ digest: { sha256: matrix.digest.slice("sha256:".length) } }],
      method,
      preregistered: true,
      results: { perSubject: [{ subjectSha256: matrix.digest.slice("sha256:".length), results }] },
      disclosures: { perSubject: [disclosure] },
      author,
    });
    writeFileSync(join(reportsRoot, `${report.digest.slice("sha256:".length)}.json`), report.bytes, { mode: 0o600 });
  }
  writeFileSync(join(runRoot, "promotion-run.json"), run.bytes, { mode: 0o600 });
  writeFileSync(join(runRoot, "matrix.json"), matrix.bytes, { mode: 0o600 });
  // Deliberately untrusted. Adoption must recompute from the exact evidence above.
  writeFileSync(join(runRoot, "recommendation.json"), "{}", { mode: 0o600 });
}

async function fixture(proven = true) {
  const root = mkdtempSync(join(tmpdir(), "jinn-local-adoption-"));
  const current = loadout(root, "current");
  const candidate = loadout(root, "candidate");
  const prepared = await prepareSweRebenchJourney({
    stateRoot: join(root, "state"),
    currentLoadout: current.sealed,
    candidateLoadout: candidate.sealed,
    routeName: "swe-rebench-v2",
    affectedRoutes: ["swe-rebench-v2", "swe-rebench-nightly"],
    harness: "codex",
    model: "gpt-test",
    isolationPolicy: "unrestricted",
    now: () => new Date("2026-08-11T09:00:00Z"),
    ports,
  });
  const paths = prepared.persist();
  const challenger = candidateTuple(prepared.snapshot.snapshot.seed.tuple, candidate.sealed.treeDigest);
  writeRecommendationEvidence({
    preparedRoot: paths.root,
    currentTupleDigest: prepared.snapshot.snapshot.seed.digest,
    candidateTupleDigest: tupleDigest(challenger),
    methods: prepared.campaign.campaign.objective.methods,
    proven,
  });
  return { root, current, candidate, prepared, paths, challenger };
}

function common(data: Awaited<ReturnType<typeof fixture>>) {
  return {
    preparedRoot: data.paths.root,
    currentLoadoutPath: data.current.directory,
    approvedRoutes: ["swe-rebench-v2", "swe-rebench-nightly"],
    approvedTupleDigest: tupleDigest(data.challenger),
    approvedPayloadClasses: ["skill" as const],
    adoptedAt: "2026-08-11T11:00:00Z",
  };
}

describe("recommendation-bound standalone adoption", () => {
  it("recomputes proof and writes one immutable plan plus atomically linked route decisions", async () => {
    const data = await fixture();
    const input = common(data);
    const preview = prepareLocalCampaignAdoption({ ...input, confirmed: false });
    expect(preview.recommendation.status).toBe("proven");
    expect(existsSync(join(data.paths.root, "archive", "adoption.json"))).toBe(false);

    const result = prepareLocalCampaignAdoption({ ...input, confirmed: true });
    if (!("planPath" in result)) throw new Error("confirmed adoption did not produce a plan");
    expect(result.records).toHaveLength(2);
    expect(new Set(result.records.map((record) => record.sharedDecisionId))).toEqual(
      new Set([result.sharedDecisionId]),
    );
    expect(result.records.every((record) => record.recommendationBasis !== undefined)).toBe(true);
    const plan = JSON.parse(readFileSync(result.planPath, "utf8"));
    expect(plan).toMatchObject({
      formatToken: "network.jinn.policy-optimization.local-adoption-plan/1.0",
      effect: "prepared-only-no-daemon-mutation",
      recommendation: { status: "proven", basis: result.recommendation.basis },
      baseline: {
        configRevision: result.configRevision,
        expectedCurrentTupleDigest: result.currentTupleDigest,
        source: "operator-declared-not-live-destination-state",
      },
      preconditions: [{
        kind: "destination-current-tuple-must-equal",
        responsibility: "required-at-apply-time-not-checked-by-optimizer",
      }],
    });
    expect(plan.changes).toHaveLength(2);
    expect(plan.rollbacks).toHaveLength(2);
    const records = readAdoptionLog(archiveLayout(defaultArchiveRoot(data.paths.root))).records;
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.scope.route)).toEqual([
      "swe-rebench-nightly", "swe-rebench-v2",
    ]);
  });

  it("refuses partial or mismatched route consent and payload-class confusion without writing", async () => {
    const data = await fixture();
    const input = common(data);
    expect(() => prepareLocalCampaignAdoption({
      ...input, approvedRoutes: ["swe-rebench-v2"], confirmed: true,
    })).toThrow(/complete operator-declared/u);
    expect(() => prepareLocalCampaignAdoption({
      ...input, approvedRoutes: ["swe-rebench-v2", "other"], confirmed: true,
    })).toThrow(/complete operator-declared/u);
    expect(() => prepareLocalCampaignAdoption({
      ...input, approvedPayloadClasses: ["prompt"], confirmed: true,
    })).toThrow(/payload class/u);
    expect(existsSync(join(data.paths.root, "archive", "adoption.json"))).toBe(false);
  });

  it("refuses baseline, candidate, tuple, and exact Report substitution", async () => {
    const baselineMoved = await fixture();
    writeFileSync(join(baselineMoved.current.directory, "notes/policy.md"), "moved policy\n");
    expect(() => prepareLocalCampaignAdoption({ ...common(baselineMoved), confirmed: true }))
      .toThrow(/baseline loadout moved/u);

    const candidateMoved = await fixture();
    writeFileSync(join(candidateMoved.paths.root, "loadout-candidate.json"), "{}", { mode: 0o600 });
    expect(() => prepareLocalCampaignAdoption({ ...common(candidateMoved), confirmed: true }))
      .toThrow(/prepared loadout archive/u);

    const tupleMoved = await fixture();
    expect(() => prepareLocalCampaignAdoption({
      ...common(tupleMoved), approvedTupleDigest: `sha256:${"0".repeat(64)}`, confirmed: true,
    })).toThrow(/tuple consent/u);

    const reportMoved = await fixture();
    const reports = join(reportMoved.paths.root, "run", "reports");
    const name = readdirSync(reports)[0]!;
    writeFileSync(join(reports, name), "{}", { mode: 0o600 });
    expect(() => prepareLocalCampaignAdoption({ ...common(reportMoved), confirmed: true }))
      .toThrow(/filename does not bind/u);
  });

  it("refuses missing Reports and any post-campaign MethodRef change", async () => {
    const missingReport = await fixture();
    const reports = join(missingReport.paths.root, "run", "reports");
    unlinkSync(join(reports, readdirSync(reports)[0]!));
    expect(() => prepareLocalCampaignAdoption({ ...common(missingReport), confirmed: true }))
      .toThrow(/advanced override/u);

    const changedMethod = await fixture();
    const campaignPath = join(changedMethod.paths.root, "campaign-inputs.json");
    const campaign = JSON.parse(readFileSync(campaignPath, "utf8")) as {
      objective: { methods: Array<{ version: string }> };
    };
    campaign.objective.methods[0]!.version = "substituted-method-version";
    writeFileSync(campaignPath, canonicalJsonBytes(campaign as unknown as JsonValue), { mode: 0o600 });
    expect(() => prepareLocalCampaignAdoption({ ...common(changedMethod), confirmed: true }))
      .toThrow(/campaign.*binding moved/u);
  });

  it("keeps non-proven evidence labelled and behind the explicit reasoned override", async () => {
    const data = await fixture(false);
    const input = common(data);
    expect(() => prepareLocalCampaignAdoption({ ...input, confirmed: true }))
      .toThrow(/advanced override/u);
    expect(() => prepareLocalCampaignAdoption({
      ...input, confirmed: true, overrideInconclusive: { reason: "" },
    })).toThrow(/non-empty reason/u);
    const result = prepareLocalCampaignAdoption({
      ...input,
      confirmed: true,
      overrideInconclusive: { reason: "operator accepts the documented local uncertainty" },
    });
    if (!("records" in result)) throw new Error("override did not produce records");
    expect(result.recommendation.status).toBe("promising");
    expect(result.records.every((record) => record.recommendationStatus === "promising")).toBe(true);
    expect(result.records.every((record) => record.overrideReason !== undefined)).toBe(true);
  });
});
