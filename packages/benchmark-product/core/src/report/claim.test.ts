import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  compareCodeUnitStrings,
  parseMatrix,
  parseReport,
  parseRun,
  sealMatrix,
  sealReport,
  sealRun,
  type BenchmarkRecord,
} from "@jinn-network/benchmarking-records";
import { createMethodRegistry, produceReport, type DsseSigner, type MethodPorts } from "@jinn-network/benchmarking-aggregate";
import { canonicalJsonBytes, recordDigest, sealDsseEnvelope } from "@jinn-network/trust-core";
import type { VenueHonesty } from "../operations/run-results.js";
import { LOCAL_VENUE_LIMITS, unverifiableAxisCounts } from "../operations/run-results.js";
import { assertClaimConsistency } from "../verification/claim-consistency.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import {
  BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
  BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
  BINARY_QUALIFICATION_VERIFICATION_COMMAND,
  buildClaimPackage,
  type BuildClaimPackageInput,
  CLAIM_PACKAGE_SCHEMA_ID,
  ClaimPackageSchema,
} from "./claim.js";

const MATCH_ALL = { harness: "match", model: "match", loadout: "match", isolation: "match", checksFailed: [] } as const;
const AUTHOR = "urn:uuid:33333333-3333-5333-8333-333333333333";
const REPORT_KEY = "did:key:zReportFixture";

/** Matches the fixture Run's own sealed policy below (BP-21): the claim's assurance block must
 * state primitives the sealed Run actually carries, or `buildClaimPackage` throws. */
const FIXTURE_ASSURANCE = {
  preset: "direct-check",
  resolved: {
    independence: "disclosed",
    minVerdicts: 1,
    distinctEvaluator: false,
    verdictRule: "sole",
  },
} as const;

function verdictEnvelope(verdict: "pass" | "fail", label: string): Uint8Array {
  const subjectDigest = sha256Hex(new TextEncoder().encode(label));
  const payload = canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `fixture/${label}`, digest: { sha256: subjectDigest } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-08-01T00:00:00Z",
      evaluator: { id: "urn:jinn:test:evaluator" },
      taskSubject: "execution/task/task.json",
      resultSubjects: ["execution/result/result.json"],
      verdict,
    },
  });
  return sealDsseEnvelope({
    payloadBytes: payload,
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "did:key:zVerdict", signature: Uint8Array.of(1) }],
  });
}

interface Fixture {
  readonly matrix: ReturnType<typeof sealMatrix>;
  readonly run: ReturnType<typeof sealRun>;
  readonly produced: Awaited<ReturnType<typeof produceReport>>;
}

/** One arm, three cells: a decisive pass, a conflicted cell (two disagreeing valid verdicts under
 * verdictRule "sole"), and a never-dispatched (expired) cell -- so completeness is genuinely
 * INCOMPLETE (judged 2 < expected 3) with nonzero attrition, and the wilson results carry a
 * nonzero `conflicted` block. Mirrors `@jinn-network/benchmarking-aggregate`'s own
 * `report.test.ts` fixture style. */
async function buildFixture(): Promise<Fixture> {
  const registry = createMethodRegistry();
  const passVerdict = verdictEnvelope("pass", "cell1-pass");
  const conflictA = verdictEnvelope("pass", "cell2-a");
  const conflictB = verdictEnvelope("fail", "cell2-b");
  const verdictMap = new Map<string, Uint8Array>([
    [recordDigest(passVerdict), passVerdict],
    [recordDigest(conflictA), conflictA],
    [recordDigest(conflictB), conflictB],
  ]);

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "b".repeat(64) } },
    owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
    arms: [{ armId: "armA", pinning: {} }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 60_000,
      replacement: { allowed: false },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [{
      method: BENCHMARKING_METHOD_IDS.wilson,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: { verdictRule: "sole" },
    }],
    closeAt: "2026-08-04T00:00:00Z",
  });

  const task1 = "1".repeat(64);
  const task2 = "2".repeat(64);
  const task3 = "3".repeat(64);
  const conflictedDigests = [recordDigest(conflictA), recordDigest(conflictB)].sort(compareCodeUnitStrings);

  const matrix = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [
      {
        cellKey: `${task1}/armA/1`,
        taskDigest: task1,
        armId: "armA",
        replicate: 1,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${"3".repeat(64)}`,
        delivery: `sha256:${"4".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)],
        validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged",
        verification: MATCH_ALL,
        integrityTier: "re-derivable",
      },
      {
        cellKey: `${task2}/armA/1`,
        taskDigest: task2,
        armId: "armA",
        replicate: 1,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${"5".repeat(64)}`,
        delivery: `sha256:${"6".repeat(64)}`,
        verdicts: conflictedDigests,
        validVerdicts: conflictedDigests,
        outcome: "judged",
        verification: MATCH_ALL,
        integrityTier: "attested-only",
      },
      {
        cellKey: `${task3}/armA/1`,
        taskDigest: task3,
        armId: "armA",
        replicate: 1,
        dispatches: 0,
        verdicts: [],
        validVerdicts: [],
        outcome: "expired",
        verification: MATCH_ALL,
        integrityTier: "attested-only",
      },
    ],
    exclusions: [],
    attrition: {
      perArm: {
        armA: {
          expected: 3,
          judged: 2,
          unjudged: 0,
          unscorable: 0,
          expired: 1,
          invalidated: 0,
          excluded: 0,
          replacements: 0,
        },
      },
      asymmetryFlags: [],
    },
    completeness: { expected: 3, judged: 2, floor: "1", runOutcome: "partial" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });

  const ports: MethodPorts = {
    registry,
    resolveVerdictBytes: (digest) => verdictMap.get(digest),
    resolveRunBytes: (digest) => (digest === run.digest ? run.bytes : undefined),
    resolveTaskBytes: () => undefined,
  };
  const signer: DsseSigner = async ({ preAuthEncoding }) => [
    { keyid: REPORT_KEY, signature: Uint8Array.of(...new TextEncoder().encode(sha256Hex(preAuthEncoding)).slice(0, 4)) },
  ];
  const produced = await produceReport({
    ...ports,
    subjects: [matrix.bytes],
    method: { id: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: {} },
    verdictRule: "sole",
    author: AUTHOR,
    limitations: ["This is a local, self-run venue."],
  }, signer);

  return { matrix, run, produced };
}

function venueHonestyFor(matrixRecord: ReturnType<typeof parseMatrix>): VenueHonesty {
  return {
    venue: "self-run",
    preRegistration: "structural-and-append-order-only",
    limits: LOCAL_VENUE_LIMITS,
    unverifiableAxisCounts: unverifiableAxisCounts(matrixRecord.cells),
  };
}

describe("buildClaimPackage", () => {
  it("round-trips through the ClaimPackageSchema for a real built claim", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    expect(claim.claimSchema).toBe(CLAIM_PACKAGE_SCHEMA_ID);
    const parsed = ClaimPackageSchema.parse(claim);
    expect(ClaimPackageSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it("carries the conflicted cellKeys/count and the incomplete matrix's attrition -- nothing dropped", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    expect(claim.conflicted.count).toBe(1);
    expect(claim.conflicted.cellKeys).toEqual([`${"2".repeat(64)}/armA/1`]);

    // Incomplete: judged (2) < expected (3), carried whole from the matrix record.
    expect(claim.completeness).toEqual({ expected: 3, judged: 2, floor: "1", runOutcome: "partial" });
    expect(claim.attrition).toEqual({
      perArm: {
        armA: {
          expected: 3, judged: 2, unjudged: 0, unscorable: 0,
          expired: 1, invalidated: 0, excluded: 0, replacements: 0,
        },
      },
      asymmetryFlags: [],
    });

    // Disclosures verbatim plus the convenience summaries -- nothing silently dropped.
    expect(claim.disclosures.perSubject).toHaveLength(1);
    expect(claim.disclosures.integrityTierCounts).toEqual({ "re-derivable": 1, "attested-only": 2 });
    expect(claim.disclosures.pinningUnverifiableCounts).toEqual({ harness: 0, model: 0, loadout: 0, isolation: 0 });
    expect(claim.limitations).toEqual(["This is a local, self-run venue."]);
  });

  it("headline numbers are identical to the report's own wilson per-arm results (extracted, not recomputed)", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    const rawResults = produced.record.results as unknown as {
      readonly perSubject: readonly { readonly results: { readonly arms: Record<string, unknown> } }[];
    };
    expect(claim.headline).toEqual(rawResults.perSubject[0]!.results.arms);
    expect(claim.results).toEqual(produced.record.results);
    expect(claim.method).toEqual({ ...produced.record.method, preregistered: produced.record.preregistered ?? false });
  });

  it("carries the scope, records, and verification blocks", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);
    const runSha256 = run.digest.slice("sha256:".length);
    const matrixSha256 = matrix.digest.slice("sha256:".length);
    const reportSha256 = sha256Hex(produced.bytes);
    const reportEnvelopeSha256 = sha256Hex(produced.envelope);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256,
      matrixRecord,
      matrixSha256,
      reportRecord: produced.record,
      reportSha256,
      reportEnvelopeSha256,
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    expect(claim.scope).toEqual({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      taskCount: 3,
      arms: [{ armId: "armA", pinning: {} }],
      replicates: 1,
      venue: "self-run",
    });
    expect(claim.records).toEqual({
      benchmarkSha256: "b".repeat(64),
      runSha256,
      matrixSha256,
      reportSha256,
      reportEnvelopeSha256,
    });
    expect(claim.verification.command).toBe("npx @colophon-claims/verify@0.1.0 <bundle-dir>");
    expect(claim.verification.compatibleCommand).toBe("npx @colophon-claims/verify@0.1 <bundle-dir>");
    expect(claim.verification.checks).toEqual([
      "manifest",
      "evidence-closure",
      "trust",
      "matrix-rederivation",
      "report-verification",
      "claim-consistency",
    ]);
    expect(claim.verification.trustRoot.length).toBeGreaterThan(0);
  });

  it("carries the assurance block — preset, resolved primitives, and the agent-distinctness disclosure — and the schema requires it", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    // The preset name is product policy; the claim states BOTH the preset and the primitives.
    expect(claim.assurance.preset).toBe("direct-check");
    expect(claim.assurance.resolved).toEqual(FIXTURE_ASSURANCE.resolved);
    expect(claim.assurance.disclosure).toContain("agent-distinctness");
    expect(claim.assurance.disclosure).toContain("party-independence");

    // The block is REQUIRED — a claim without it does not satisfy the schema.
    expect(ClaimPackageSchema.safeParse({ ...claim, assurance: undefined }).success).toBe(false);
  });

  it("throws when the stated assurance primitives disagree with what the sealed Run carries", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);
    const base = {
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
    } as const;

    // The fixture Run's policy carries minVerdicts 1 / independence "disclosed"; a claim stating
    // otherwise would name primitives the sealed Run does not carry.
    expect(() =>
      buildClaimPackage({
        ...base,
        assurance: { ...FIXTURE_ASSURANCE, resolved: { ...FIXTURE_ASSURANCE.resolved, minVerdicts: 2 } },
      }),
    ).toThrow(/sealed Run/);
    expect(() =>
      buildClaimPackage({
        ...base,
        assurance: { ...FIXTURE_ASSURANCE, resolved: { ...FIXTURE_ASSURANCE.resolved, independence: "gating" } },
      }),
    ).toThrow(/sealed Run/);
    expect(() =>
      buildClaimPackage({
        ...base,
        assurance: { ...FIXTURE_ASSURANCE, resolved: { ...FIXTURE_ASSURANCE.resolved, distinctEvaluator: true } },
      }),
    ).toThrow(/sealed Run/);
    // verdictRule lives in the sealed Run's analysisPlan parameters (BP-13 F2), not its policy —
    // the fixture Run pre-registered "sole", so a claim stating "majority" must throw too.
    expect(() =>
      buildClaimPackage({
        ...base,
        assurance: { ...FIXTURE_ASSURANCE, resolved: { ...FIXTURE_ASSURANCE.resolved, verdictRule: "majority" } },
      }),
    ).toThrow(/sealed Run/);
  });
});

/** P4b Task 4 (`docs/superpowers/plans/demo-report-1/2026-08-12-P4b-implementation-plan.md`): a
 * golden byte-equality guard that lands BEFORE any commit touches `claim.ts`, so later tasks that
 * teach this builder to dispatch on method cannot silently drift wilson's own output. Built from
 * the exact same deterministic fixture every other test in this file already uses. */
function readGolden(name: string): string {
  return readFileSync(new URL(`../bundle/__fixtures__/wilson-golden/${name}`, import.meta.url), "utf8");
}

async function wilsonGoldenInput(): Promise<BuildClaimPackageInput> {
  const { matrix, run, produced } = await buildFixture();
  const matrixRecord = parseMatrix(matrix.bytes);
  const runRecord = parseRun(run.bytes);
  return {
    draftId: "wilson-golden",
    benchmarkSha256: "b".repeat(64),
    runRecord,
    runSha256: run.digest.slice("sha256:".length),
    matrixRecord,
    matrixSha256: matrix.digest.slice("sha256:".length),
    reportRecord: produced.record,
    reportSha256: sha256Hex(produced.bytes),
    reportEnvelopeSha256: sha256Hex(produced.envelope),
    venueHonesty: venueHonestyFor(matrixRecord),
    verificationCommandVerb: "verify",
    assurance: FIXTURE_ASSURANCE,
  };
}

describe("Task 4 golden guard: wilson claim package byte-equality", () => {
  it("wilson claim package serializes byte-identically to the committed golden", async () => {
    const claim = buildClaimPackage(await wilsonGoldenInput());
    // Exactly what writeClaimPackage does in production (claim.ts:338-341): schema-validate, then
    // canonical JSON bytes -- compact, sorted keys, no trailing newline. A guard that serialized
    // differently from production would not be guarding production.
    const serialized = new TextDecoder().decode(canonicalJsonBytes(ClaimPackageSchema.parse(claim)));
    expect(serialized).toBe(readGolden("claim-package.json"));
  });
});

/**
 * P4b Task 5: a paired-delta@1 Report built DIRECTLY via `sealReport`, not through
 * `produceReport`/the method registry -- this keeps the unit test isolated from the report-
 * production path (`operations/report.ts`'s method-selection wiring, landed in Task 3) so a claim-
 * package regression here can never be masked or caused by a change on that separate path. This
 * mirrors the real `pairedDeltaMethod.compute()` output shape (`benchmarking/aggregate/src/
 * registry.ts`) verbatim, wrapped in the standard `{perSubject: [{subjectSha256, results}]}`
 * envelope used by every method.
 *
 * The two sealed `analysisPlan` entries deliberately carry DIFFERENT `verdictRule` values
 * ("sole" for wilson, "majority" for paired-delta) -- in real compiled data the two entries agree
 * (`run/compile.ts`'s buildAnalysisPlan), so a regression from "select the plan entry matching
 * the produced Report's method" back to "always read analysisPlan[0]" would otherwise pass this
 * fixture silently. Disagreeing values make the regression fail loudly via the assurance
 * cross-check instead.
 */
interface PairedFixture {
  readonly matrixRecord: ReturnType<typeof parseMatrix>;
  readonly runRecord: ReturnType<typeof parseRun>;
  readonly reportRecord: ReturnType<typeof parseReport>;
  readonly matrixSha256: string;
  readonly runSha256: string;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
}

const PAIRED_FIXTURE_ASSURANCE = {
  preset: "direct-check",
  resolved: {
    independence: "disclosed",
    minVerdicts: 1,
    distinctEvaluator: false,
    verdictRule: "majority",
  },
} as const;

/** The exact shape `comparisonProjection` (claim.ts) must extract from `pairedResults` below,
 * verbatim -- used by the "carries comparison" assertion. */
const EXPECTED_COMPARISON = {
  pairs: 2,
  delta: "0.0000",
  interval: null,
  reasons: ["fewer than minN=5 paired tasks (got 2)"],
  pairing: { taskDigests: ["1".repeat(64), "2".repeat(64)] },
  clustering: { basis: "task-provenance-source", clusters: 1 },
  excluded: { count: 0, cellKeys: [] },
  conflicted: { count: 0, cellKeys: [] },
  bootstrap: {
    procedure: "xorshift32-v1", seed: 123456789, resamples: 1000,
    basis: "task-provenance-source-family", count: 1, unit: "source-cluster", draws: 0,
    clusters: [{ key: ["source", "fixture-repo"], members: ["1".repeat(64), "2".repeat(64)] }],
  },
};

function buildPairedFixture(): PairedFixture {
  const passVerdict = verdictEnvelope("pass", "paired-a1");
  const failVerdict = verdictEnvelope("fail", "paired-b2");

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "b".repeat(64) } },
    owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
    // Distinct pinning is required (§7.1): arms with byte-identical pinning are refused at seal.
    arms: [{ armId: "armA", pinning: { label: "armA" } }, { armId: "armB", pinning: { label: "armB" } }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 60_000,
      replacement: { allowed: false },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
      {
        method: BENCHMARKING_METHOD_IDS.pairedDelta, version: BENCHMARKING_METHOD_VERSION,
        parameters: {
          verdictRule: "majority", baseline: "armA", candidate: "armB",
          seed: 123456789, resamples: 1000, alpha: "0.05",
        },
      },
    ],
    closeAt: "2026-08-04T00:00:00Z",
  });

  const task1 = "1".repeat(64);
  const task2 = "2".repeat(64);

  const perArmComplete = {
    expected: 2, judged: 2, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
  };

  const matrix = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-04T00:00:00Z" },
    cells: [
      {
        cellKey: `${task1}/armA/1`, taskDigest: task1, armId: "armA", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"3".repeat(64)}`, delivery: `sha256:${"4".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task1}/armB/1`, taskDigest: task1, armId: "armB", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"5".repeat(64)}`, delivery: `sha256:${"6".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task2}/armA/1`, taskDigest: task2, armId: "armA", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"7".repeat(64)}`, delivery: `sha256:${"8".repeat(64)}`,
        verdicts: [recordDigest(failVerdict)], validVerdicts: [recordDigest(failVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task2}/armB/1`, taskDigest: task2, armId: "armB", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"9".repeat(64)}`, delivery: `sha256:${"a".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
    ],
    exclusions: [],
    attrition: { perArm: { armA: perArmComplete, armB: perArmComplete }, asymmetryFlags: [] },
    completeness: { expected: 4, judged: 4, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });

  const matrixDigestHex = matrix.digest.slice("sha256:".length);

  // Mirrors pairedDeltaMethod.compute()'s return shape (registry.ts) verbatim -- see
  // EXPECTED_COMPARISON above for what buildClaimPackage must extract from it.
  const pairedResults = {
    verdictRule: "majority",
    baseline: "armA",
    candidate: "armB",
    ...EXPECTED_COMPARISON,
  };

  const disclosurePerSubject = {
    subjectSha256: matrixDigestHex,
    integrityTiers: { "re-derivable": 4, "attested-only": 0 },
    pinning: {
      harness: { match: 4, mismatch: 0, unverifiable: 0 },
      model: { match: 4, mismatch: 0, unverifiable: 0 },
      loadout: { match: 4, mismatch: 0, unverifiable: 0 },
      isolation: { match: 4, mismatch: 0, unverifiable: 0 },
    },
    independence: 0,
    completeness: { expected: 4, judged: 4, floor: "1", runOutcome: "complete" as const },
    attrition: { perArm: { armA: perArmComplete, armB: perArmComplete }, asymmetryFlags: [] },
  };

  const reportSealed = sealReport({
    protocol: BENCHMARKING_PROTOCOL,
    subjects: [{ digest: { sha256: matrixDigestHex } }],
    method: {
      id: BENCHMARKING_METHOD_IDS.pairedDelta,
      version: BENCHMARKING_METHOD_VERSION,
      parameters: {
        verdictRule: "majority", baseline: "armA", candidate: "armB",
        seed: 123456789, resamples: 1000, alpha: "0.05",
      },
    },
    preregistered: true,
    results: { perSubject: [{ subjectSha256: matrixDigestHex, results: pairedResults }] },
    disclosures: { perSubject: [disclosurePerSubject] },
    limitations: ["This is a local, self-run venue."],
    author: AUTHOR,
  });

  return {
    matrixRecord: parseMatrix(matrix.bytes),
    runRecord: parseRun(run.bytes),
    reportRecord: parseReport(reportSealed.bytes),
    matrixSha256: matrixDigestHex,
    runSha256: run.digest.slice("sha256:".length),
    reportSha256: sha256Hex(reportSealed.bytes),
    // No real DSSE envelope is built for this direct-sealed fixture; buildClaimPackage treats
    // this as an opaque identity string, never dereferencing or re-verifying it.
    reportEnvelopeSha256: "e".repeat(64),
  };
}

describe("buildClaimPackage — paired-delta@1 comparison shape (P4b Task 5)", () => {
  it("retains the frozen paired-delta claim byte digest", () => {
    const fixture = buildPairedFixture();
    const claim = buildClaimPackage({
      draftId: "paired-1",
      benchmarkSha256: "b".repeat(64),
      runRecord: fixture.runRecord,
      runSha256: fixture.runSha256,
      matrixRecord: fixture.matrixRecord,
      matrixSha256: fixture.matrixSha256,
      reportRecord: fixture.reportRecord,
      reportSha256: fixture.reportSha256,
      reportEnvelopeSha256: fixture.reportEnvelopeSha256,
      venueHonesty: venueHonestyFor(fixture.matrixRecord),
      verificationCommandVerb: "verify",
      assurance: PAIRED_FIXTURE_ASSURANCE,
    });
    expect(sha256Hex(canonicalJsonBytes(ClaimPackageSchema.parse(claim))))
      .toBe("882918f92a1ff4ccb059bef78d04c126d1abf971be8c96b72ad87a40eb0d3ea8");
  });

  it("builds a claim carrying `comparison`, not `headline`, extracted verbatim from the paired Report", () => {
    const fixture = buildPairedFixture();
    const claim = buildClaimPackage({
      draftId: "paired-1",
      benchmarkSha256: "b".repeat(64),
      runRecord: fixture.runRecord,
      runSha256: fixture.runSha256,
      matrixRecord: fixture.matrixRecord,
      matrixSha256: fixture.matrixSha256,
      reportRecord: fixture.reportRecord,
      reportSha256: fixture.reportSha256,
      reportEnvelopeSha256: fixture.reportEnvelopeSha256,
      venueHonesty: venueHonestyFor(fixture.matrixRecord),
      verificationCommandVerb: "verify",
      assurance: PAIRED_FIXTURE_ASSURANCE,
    });

    expect(claim.comparison).toEqual(EXPECTED_COMPARISON);
    expect(claim.headline).toBeUndefined();
    // The top-level conflicted field (always required, regardless of method) mirrors the
    // paired-delta method's own conflicted count -- same source, never invented.
    expect(claim.conflicted).toEqual(EXPECTED_COMPARISON.conflicted);
    expect(claim.method).toEqual({
      id: "jinn.benchmarking.method/paired-delta", version: "1",
      parameters: fixture.reportRecord.method.parameters, preregistered: true,
    });

    // The claim must still satisfy its own schema (comparison present is sufficient).
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });

  it("throws when the stated verdictRule matches wilson's plan entry rather than the produced paired-delta entry (proves entry SELECTION, not analysisPlan[0])", () => {
    const fixture = buildPairedFixture();
    expect(() =>
      buildClaimPackage({
        draftId: "paired-1",
        benchmarkSha256: "b".repeat(64),
        runRecord: fixture.runRecord,
        runSha256: fixture.runSha256,
        matrixRecord: fixture.matrixRecord,
        matrixSha256: fixture.matrixSha256,
        reportRecord: fixture.reportRecord,
        reportSha256: fixture.reportSha256,
        reportEnvelopeSha256: fixture.reportEnvelopeSha256,
        venueHonesty: venueHonestyFor(fixture.matrixRecord),
        verificationCommandVerb: "verify",
        // "sole" matches analysisPlan[0] (wilson) but not the produced paired-delta entry
        // ("majority") -- if the code selected by index rather than by method id, this call
        // would NOT throw, silently accepting the wrong entry.
        assurance: { ...PAIRED_FIXTURE_ASSURANCE, resolved: { ...PAIRED_FIXTURE_ASSURANCE.resolved, verdictRule: "sole" } },
      }),
    ).toThrow(/sealed Run/);
  });
});

describe("buildClaimPackage — schema requires headline or comparison", () => {
  it("refuses a claim carrying neither headline nor comparison", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);
    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256: run.digest.slice("sha256:".length),
      matrixRecord,
      matrixSha256: matrix.digest.slice("sha256:".length),
      reportRecord: produced.record,
      reportSha256: sha256Hex(produced.bytes),
      reportEnvelopeSha256: sha256Hex(produced.envelope),
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    const { headline: _headline, ...withoutHeadline } = claim;
    expect(ClaimPackageSchema.safeParse(withoutHeadline).success).toBe(false);
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });
});

describe("assertClaimConsistency (P4b Task 5): round-trips both shapes", () => {
  it("round-trips a wilson claim built by buildClaimPackage", async () => {
    const { matrix, run, produced } = await buildFixture();
    const matrixRecord = parseMatrix(matrix.bytes);
    const runRecord = parseRun(run.bytes);
    const runSha256 = run.digest.slice("sha256:".length);
    const matrixSha256 = matrix.digest.slice("sha256:".length);
    const reportSha256 = sha256Hex(produced.bytes);
    const reportEnvelopeSha256 = sha256Hex(produced.envelope);

    const claim = buildClaimPackage({
      draftId: "draft-1",
      benchmarkSha256: "b".repeat(64),
      runRecord,
      runSha256,
      matrixRecord,
      matrixSha256,
      reportRecord: produced.record,
      reportSha256,
      reportEnvelopeSha256,
      venueHonesty: venueHonestyFor(matrixRecord),
      verificationCommandVerb: "verify",
      assurance: FIXTURE_ASSURANCE,
    });

    expect(() =>
      assertClaimConsistency({
        claim,
        identities: { benchmarkSha256: "b".repeat(64), runSha256, matrixSha256, reportSha256, reportEnvelopeSha256 },
        // Unused by assertClaimConsistency (never dereferenced in its body) -- see claim-consistency.ts.
        benchmarkRecord: {} as unknown as BenchmarkRecord,
        runRecord,
        matrixRecord,
        reportRecord: produced.record,
        draftId: "draft-1",
        assurancePreset: FIXTURE_ASSURANCE.preset,
      }),
    ).not.toThrow();
  });

  it("round-trips a paired-delta claim carrying comparison", () => {
    const fixture = buildPairedFixture();
    const claim = buildClaimPackage({
      draftId: "paired-1",
      benchmarkSha256: "b".repeat(64),
      runRecord: fixture.runRecord,
      runSha256: fixture.runSha256,
      matrixRecord: fixture.matrixRecord,
      matrixSha256: fixture.matrixSha256,
      reportRecord: fixture.reportRecord,
      reportSha256: fixture.reportSha256,
      reportEnvelopeSha256: fixture.reportEnvelopeSha256,
      venueHonesty: venueHonestyFor(fixture.matrixRecord),
      verificationCommandVerb: "verify",
      assurance: PAIRED_FIXTURE_ASSURANCE,
    });

    expect(() =>
      assertClaimConsistency({
        claim,
        identities: {
          benchmarkSha256: "b".repeat(64), runSha256: fixture.runSha256, matrixSha256: fixture.matrixSha256,
          reportSha256: fixture.reportSha256, reportEnvelopeSha256: fixture.reportEnvelopeSha256,
        },
        benchmarkRecord: {} as unknown as BenchmarkRecord,
        runRecord: fixture.runRecord,
        matrixRecord: fixture.matrixRecord,
        reportRecord: fixture.reportRecord,
        draftId: "paired-1",
        assurancePreset: PAIRED_FIXTURE_ASSURANCE.preset,
      }),
    ).not.toThrow();
  });
});

function binaryZeroRate() {
  return { numerator: 0, denominator: 0, estimate: null, wilsonInterval: null, withheldReason: "zero-denominator" };
}

function binaryZeroProjection() {
  return {
    item: { expected: 0, complete: 0, excluded: 0, unstable: 0 },
    call: { expected: 0, evaluated: 0, parseInvalid: 0 },
    confusion: { correctAccepted: 0, correctRejected: 0, wrongAccepted: 0, wrongRejected: 0 },
    agreement: binaryZeroRate(), falseAccept: binaryZeroRate(), falseReject: binaryZeroRate(),
    instability: binaryZeroRate(), parserInvalid: binaryZeroRate(),
  };
}

function binaryQualificationFixture() {
  return {
    configuration: {
      verdictRule: "sole", k: 1, reduction: "strict-majority", measurementProfile: "binary-instrument@1",
      candidateClasses: ["factuality"], strata: ["core", "stress"], parserInvalidPolicy: "reject",
      truthAdmission: "two-human-unanimous", intervalAlpha: "0.05",
    },
    arms: Object.fromEntries(["arm-a", "arm-b", "arm-c", "arm-d"].map((armId, index) => [armId, {
      instrumentSha256: `sha256:${String(index + 1).repeat(64)}`,
      ...binaryZeroProjection(),
      byCandidateClass: { factuality: binaryZeroProjection() },
      byStratum: { core: binaryZeroProjection(), stress: binaryZeroProjection() },
    }])),
    itemDecisions: [],
    excluded: { count: 0, items: [] },
    conflicted: { count: 0, cellKeys: [] },
  };
}

describe("claim-package/2 exact binary qualification gate", () => {
  it("round-trips an exact F6 projection and rejects drift, conclusions, and another method version", async () => {
    const base = buildClaimPackage(await wilsonGoldenInput());
    const qualification = binaryQualificationFixture();
    const claim = {
      ...base,
      claimSchema: BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
      method: { ...base.method, id: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION },
      results: { perSubject: [{ subjectSha256: base.records.matrixSha256, results: qualification }] },
      headline: undefined,
      comparison: undefined,
      qualification,
      conflicted: qualification.conflicted,
      verification: {
        ...base.verification,
        command: BINARY_QUALIFICATION_VERIFICATION_COMMAND,
        compatibleCommand: BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
      },
    };
    delete claim.headline;
    delete claim.comparison;
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);

    const topLevelConclusion = structuredClone(claim) as any;
    topLevelConclusion.ranking = ["arm-a"];
    expect(ClaimPackageSchema.safeParse(topLevelConclusion).success).toBe(false);

    const nestedConclusion = structuredClone(claim) as any;
    nestedConclusion.scope.arms[0].winner = true;
    expect(ClaimPackageSchema.safeParse(nestedConclusion).success).toBe(false);

    const ranked = structuredClone(claim) as any;
    ranked.qualification.ranking = ["arm-a"];
    ranked.results.perSubject[0].results.ranking = ["arm-a"];
    expect(ClaimPackageSchema.safeParse(ranked).success).toBe(false);

    const drifted = structuredClone(claim) as any;
    drifted.qualification.configuration.intervalAlpha = "0.01";
    expect(ClaimPackageSchema.safeParse(drifted).success).toBe(false);

    const futureVersion = structuredClone(claim) as any;
    futureVersion.method.version = "2";
    expect(ClaimPackageSchema.safeParse(futureVersion).success).toBe(false);

    const reorderedChecks = structuredClone(claim) as any;
    reorderedChecks.verification.checks.reverse();
    expect(ClaimPackageSchema.safeParse(reorderedChecks).success).toBe(false);
  });

  it("preserves the frozen claim-package/1 grammar that accepts both legacy projections", async () => {
    const legacy = buildClaimPackage(await wilsonGoldenInput());
    expect(ClaimPackageSchema.safeParse({ ...legacy, comparison: EXPECTED_COMPARISON }).success).toBe(true);
    const parsed = ClaimPackageSchema.parse({ ...legacy, qualification: { formerly: "an unknown v1 field" } });
    expect("qualification" in parsed).toBe(false);
  });
});

// --- packet #2837: pairwise-disagreement@1 and paired-majority-delta@1 claim projections ---

interface JudgeFamilyFixture {
  readonly matrixRecord: ReturnType<typeof parseMatrix>;
  readonly runRecord: ReturnType<typeof parseRun>;
  readonly reportRecord: ReturnType<typeof parseReport>;
  readonly matrixSha256: string;
  readonly runSha256: string;
  readonly reportSha256: string;
  readonly reportEnvelopeSha256: string;
}

const JUDGE_FAMILY_ASSURANCE = {
  preset: "direct-check",
  resolved: {
    independence: "disclosed",
    minVerdicts: 1,
    distinctEvaluator: false,
    verdictRule: "sole",
  },
} as const;

/** Sibling of `buildPairedFixture`, generalized to any judge-family method (packet #2837): the
 * same two-arm/two-task Run+Matrix shape, with the analysisPlan's non-wilson entry and the sealed
 * Report's method/parameters/results/limitations supplied by the caller. */
function buildJudgeFamilyFixture(input: {
  readonly method: string;
  readonly parameters: Record<string, unknown>;
  readonly results: unknown;
  readonly limitations?: readonly string[];
}): JudgeFamilyFixture {
  const passVerdict = verdictEnvelope("pass", "judge-a1");
  const failVerdict = verdictEnvelope("fail", "judge-b2");

  const run = sealRun({
    protocol: BENCHMARKING_PROTOCOL,
    benchmark: { digest: { sha256: "c".repeat(64) } },
    owner: "urn:uuid:44444444-4444-5444-8444-444444444444",
    arms: [{ armId: "armA", pinning: { label: "armA" } }, { armId: "armB", pinning: { label: "armB" } }],
    replicates: 1,
    policy: {
      completenessFloor: "1",
      cellWindow: 60_000,
      replacement: { allowed: false },
      independence: "disclosed",
      evaluation: { minVerdicts: 1, distinctEvaluator: false },
      submissionBaseline: {},
    },
    analysisPlan: [
      { method: BENCHMARKING_METHOD_IDS.wilson, version: BENCHMARKING_METHOD_VERSION, parameters: { verdictRule: "sole" } },
      { method: input.method, version: BENCHMARKING_METHOD_VERSION, parameters: input.parameters },
    ],
    closeAt: "2026-08-20T00:00:00Z",
  });

  const task1 = "1".repeat(64);
  const task2 = "2".repeat(64);
  const perArmComplete = {
    expected: 2, judged: 2, unjudged: 0, unscorable: 0, expired: 0, invalidated: 0, excluded: 0, replacements: 0,
  };

  const matrix = sealMatrix({
    protocol: BENCHMARKING_PROTOCOL,
    run: { digest: { sha256: run.digest.slice("sha256:".length) } },
    closeBoundary: { at: "2026-08-20T00:00:00Z" },
    cells: [
      {
        cellKey: `${task1}/armA/1`, taskDigest: task1, armId: "armA", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"3".repeat(64)}`, delivery: `sha256:${"4".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task1}/armB/1`, taskDigest: task1, armId: "armB", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"5".repeat(64)}`, delivery: `sha256:${"6".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task2}/armA/1`, taskDigest: task2, armId: "armA", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"7".repeat(64)}`, delivery: `sha256:${"8".repeat(64)}`,
        verdicts: [recordDigest(failVerdict)], validVerdicts: [recordDigest(failVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
      {
        cellKey: `${task2}/armB/1`, taskDigest: task2, armId: "armB", replicate: 1,
        dispatches: 1, accounted: 1,
        submission: `sha256:${"9".repeat(64)}`, delivery: `sha256:${"a".repeat(64)}`,
        verdicts: [recordDigest(passVerdict)], validVerdicts: [recordDigest(passVerdict)],
        outcome: "judged", verification: MATCH_ALL, integrityTier: "re-derivable",
      },
    ],
    exclusions: [],
    attrition: { perArm: { armA: perArmComplete, armB: perArmComplete }, asymmetryFlags: [] },
    completeness: { expected: 4, judged: 4, floor: "1", runOutcome: "complete" },
    assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
  });

  const matrixDigestHex = matrix.digest.slice("sha256:".length);

  const disclosurePerSubject = {
    subjectSha256: matrixDigestHex,
    integrityTiers: { "re-derivable": 4, "attested-only": 0 },
    pinning: {
      harness: { match: 4, mismatch: 0, unverifiable: 0 },
      model: { match: 4, mismatch: 0, unverifiable: 0 },
      loadout: { match: 4, mismatch: 0, unverifiable: 0 },
      isolation: { match: 4, mismatch: 0, unverifiable: 0 },
    },
    independence: 0,
    completeness: { expected: 4, judged: 4, floor: "1", runOutcome: "complete" as const },
    attrition: { perArm: { armA: perArmComplete, armB: perArmComplete }, asymmetryFlags: [] },
  };

  const reportSealed = sealReport({
    protocol: BENCHMARKING_PROTOCOL,
    subjects: [{ digest: { sha256: matrixDigestHex } }],
    method: { id: input.method, version: BENCHMARKING_METHOD_VERSION, parameters: input.parameters },
    preregistered: true,
    results: { perSubject: [{ subjectSha256: matrixDigestHex, results: input.results }] },
    disclosures: { perSubject: [disclosurePerSubject] },
    limitations: input.limitations ?? ["This is a local, self-run venue."],
    author: AUTHOR,
  });

  return {
    matrixRecord: parseMatrix(matrix.bytes),
    runRecord: parseRun(run.bytes),
    reportRecord: parseReport(reportSealed.bytes),
    matrixSha256: matrixDigestHex,
    runSha256: run.digest.slice("sha256:".length),
    reportSha256: sha256Hex(reportSealed.bytes),
    reportEnvelopeSha256: "e".repeat(64),
  };
}

function buildJudgeFamilyClaim(fixture: JudgeFamilyFixture, extra: Partial<BuildClaimPackageInput> = {}) {
  return buildClaimPackage({
    draftId: "judge-1",
    benchmarkSha256: "c".repeat(64),
    runRecord: fixture.runRecord,
    runSha256: fixture.runSha256,
    matrixRecord: fixture.matrixRecord,
    matrixSha256: fixture.matrixSha256,
    reportRecord: fixture.reportRecord,
    reportSha256: fixture.reportSha256,
    reportEnvelopeSha256: fixture.reportEnvelopeSha256,
    venueHonesty: venueHonestyFor(fixture.matrixRecord),
    verificationCommandVerb: "verify",
    assurance: JUDGE_FAMILY_ASSURANCE,
    ...extra,
  });
}

const PAIRWISE_DISAGREEMENT_PARAMETERS = {
  verdictRule: "sole",
  k: 3,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  candidateClasses: ["zeta"],
  strata: ["core"],
  parserInvalidPolicy: "reject",
  truthAdmission: "operator-only",
  intervalAlpha: "0.05",
};

const EXPECTED_PAIRWISE_DISAGREEMENT = {
  pairs: [
    {
      armA: "armA",
      armB: "armB",
      n: 2,
      disagreements: 1,
      rate: "0.5000",
      interval: { lower: "0.0655", upper: "0.9345", alpha: "0.05" },
      byCandidateClass: [
        { candidateClass: "zeta", n: 1, disagreements: 0, rate: "0.0000", interval: { lower: "0.0000", upper: "0.7935", alpha: "0.05" } },
      ],
      byStratum: [
        { stratum: "core", n: 1, disagreements: 0, rate: "0.0000", interval: { lower: "0.0000", upper: "0.7935", alpha: "0.05" } },
      ],
      exclusions: [],
    },
  ],
  conflicted: { count: 0, cellKeys: [] },
};

describe("buildClaimPackage — pairwise-disagreement@1 panel shape (packet #2837)", () => {
  it("builds a claim carrying `pairwiseDisagreement`, not `headline`/`comparison`/`qualification`, extracted verbatim from the Report", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
      parameters: PAIRWISE_DISAGREEMENT_PARAMETERS,
      results: EXPECTED_PAIRWISE_DISAGREEMENT,
    });
    const claim = buildJudgeFamilyClaim(fixture);

    expect(claim.pairwiseDisagreement).toEqual(EXPECTED_PAIRWISE_DISAGREEMENT);
    expect(claim.headline).toBeUndefined();
    expect(claim.comparison).toBeUndefined();
    expect(claim.qualification).toBeUndefined();
    expect(claim.pairedMajorityDelta).toBeUndefined();
    // The top-level conflicted field (always required, regardless of method) mirrors the method's
    // own conflicted count — same source, never invented.
    expect(claim.conflicted).toEqual(EXPECTED_PAIRWISE_DISAGREEMENT.conflicted);
    expect(claim.method).toEqual({
      id: BENCHMARKING_METHOD_IDS.pairwiseDisagreement, version: "1",
      parameters: PAIRWISE_DISAGREEMENT_PARAMETERS, preregistered: true,
    });
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });

  it("throws when the Report results do not carry pairwise-disagreement@1's pairs/conflicted shape", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
      parameters: PAIRWISE_DISAGREEMENT_PARAMETERS,
      results: { pairs: EXPECTED_PAIRWISE_DISAGREEMENT.pairs }, // conflicted missing
    });
    expect(() => buildJudgeFamilyClaim(fixture)).toThrow(/pairwise-disagreement@1's pairs\/conflicted shape/);
  });
});

const PAIRED_MAJORITY_DELTA_PARAMETERS = {
  verdictRule: "sole",
  k: 3,
  reduction: "strict-majority",
  measurementProfile: "binary-instrument@1",
  candidateClasses: ["zeta"],
  strata: ["core"],
  parserInvalidPolicy: "reject",
  truthAdmission: "operator-only",
  baseline: "armA",
  candidate: "armB",
  seed: 20_260_819,
  resamples: 20_000,
  alpha: "0.05",
};

const EXPECTED_PAIRED_MAJORITY_DELTA = {
  baseline: "armA",
  candidate: "armB",
  n: 2,
  delta: "0.5000",
  interval: null,
  reasons: ["fewer than minN=5 paired tasks (got 2)", "fewer than two source clusters (got 1)"],
  clusters: { count: 1, manifest: [{ key: ["source", "fixture-source"], members: [task1(), task2()] }] },
  byCandidateClass: [
    {
      candidateClass: "zeta", n: 1, delta: "0.0000", interval: null,
      reasons: ["fewer than minN=5 paired tasks (got 1)", "fewer than two source clusters (got 1)"],
    },
  ],
  byStratum: [
    {
      stratum: "core", n: 1, delta: "0.0000", interval: null,
      reasons: ["fewer than minN=5 paired tasks (got 1)", "fewer than two source clusters (got 1)"],
    },
  ],
  exclusions: [],
  conflicted: { count: 0, cellKeys: [] },
};

function task1(): string { return "1".repeat(64); }
function task2(): string { return "2".repeat(64); }

describe("buildClaimPackage — paired-majority-delta@1 evidence-contrast shape (packet #2837)", () => {
  it("builds a claim carrying `pairedMajorityDelta`, not `headline`/`comparison`/`qualification`, extracted verbatim from the Report", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
      parameters: PAIRED_MAJORITY_DELTA_PARAMETERS,
      results: EXPECTED_PAIRED_MAJORITY_DELTA,
    });
    const claim = buildJudgeFamilyClaim(fixture);

    expect(claim.pairedMajorityDelta).toEqual(EXPECTED_PAIRED_MAJORITY_DELTA);
    expect(claim.pairedMajorityDelta?.baseline).toBe("armA");
    expect(claim.pairedMajorityDelta?.candidate).toBe("armB");
    expect(claim.headline).toBeUndefined();
    expect(claim.comparison).toBeUndefined();
    expect(claim.qualification).toBeUndefined();
    expect(claim.pairwiseDisagreement).toBeUndefined();
    expect(claim.conflicted).toEqual(EXPECTED_PAIRED_MAJORITY_DELTA.conflicted);
    expect(claim.method).toEqual({
      id: BENCHMARKING_METHOD_IDS.pairedMajorityDelta, version: "1",
      parameters: PAIRED_MAJORITY_DELTA_PARAMETERS, preregistered: true,
    });
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);
  });

  it("throws when the Report results do not carry paired-majority-delta@1's baseline/candidate/delta shape", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
      parameters: PAIRED_MAJORITY_DELTA_PARAMETERS,
      results: EXPECTED_PAIRED_MAJORITY_DELTA,
    });
    // `sealReport` validates the RECORD schema, not this method's own results shape, so a
    // malformed method-results object cannot be sealed directly (`results` fails schema
    // validation before it ever reaches the projection). Mutating the already-sealed, already-
    // parsed record in place isolates the check to exactly what `pairedMajorityDeltaProjection`
    // itself is responsible for.
    const mutated = structuredClone(fixture.reportRecord) as any;
    delete mutated.results.perSubject[0].results.baseline;
    expect(() => buildJudgeFamilyClaim({ ...fixture, reportRecord: mutated })).toThrow(
      /paired-majority-delta@1's baseline\/candidate\/delta shape/,
    );
  });

  it("refuses a binary-instrument qualification claim that also carries pairwiseDisagreement/pairedMajorityDelta (exactBinaryClaimControls admits the keys, the schema-level refine still refuses by name)", async () => {
    const base = buildClaimPackage(await wilsonGoldenInput());
    const qualification = binaryQualificationFixture();
    const claim = {
      ...base,
      claimSchema: BINARY_QUALIFICATION_CLAIM_PACKAGE_SCHEMA_ID,
      method: { ...base.method, id: BENCHMARKING_METHOD_IDS.binaryInstrument, version: BENCHMARKING_METHOD_VERSION },
      results: { perSubject: [{ subjectSha256: base.records.matrixSha256, results: qualification }] },
      headline: undefined,
      comparison: undefined,
      qualification,
      conflicted: qualification.conflicted,
      verification: {
        ...base.verification,
        command: BINARY_QUALIFICATION_VERIFICATION_COMMAND,
        compatibleCommand: BINARY_QUALIFICATION_COMPATIBLE_VERIFICATION_COMMAND,
      },
    };
    delete claim.headline;
    delete claim.comparison;
    // A well-formed binary claim (no leak) validates -- proves the fixture itself is right before
    // asserting the leak case below.
    expect(ClaimPackageSchema.safeParse(claim).success).toBe(true);

    // exactBinaryClaimControls admits `pairwiseDisagreement` (packet #2837) so this reaches the
    // schema-level refine and is refused BY NAME, not collapsed into the generic control-shape
    // failure -- proving admitting the key in the allowlist did not also widen what a binary claim
    // may legally carry.
    const leaked = { ...claim, pairwiseDisagreement: EXPECTED_PAIRWISE_DISAGREEMENT };
    const leakedResult = ClaimPackageSchema.safeParse(leaked);
    expect(leakedResult.success).toBe(false);
    expect(
      leakedResult.success ? undefined : leakedResult.error.issues.some((issue) => issue.path.join(".") === "qualification"),
    ).toBe(true);
  });
});

// packet #2837: the limitations decision (PAIRED_ESTIMATE_LIMITATION carries to
// paired-majority-delta@1, no extra line for the withheld-interval case) asserted at the
// `assertClaimConsistency` cold-rebuild layer -- see `operations/report.ts`'s matching
// method-conditional and `verification/claim-consistency.ts`'s matching `pairedEstimateLimitation`.
describe("assertClaimConsistency — paired-majority-delta@1 carries PAIRED_ESTIMATE_LIMITATION (packet #2837)", () => {
  const PAIRED_ESTIMATE_LIMITATION =
    "This method estimates an effect; it does not gate one — no verdict, threshold, or selection was registered.";
  // A non-empty `additionalLimitations` is what forces the isolation/additionalLimitations gate
  // open in `assertClaimConsistency` -- mirrors how `operations/verify.ts`'s real caller supplies
  // suite/inspect facts through the same input, and is the only way to exercise the
  // exact-disclosure rebuild this test is about without depending on isolation posture.
  const FORCING_ADDITIONAL_LIMITATIONS = ["forcing fact so the limitations gate opens"];

  it("does not throw when the sealed Report's limitations exactly match venue + additional + PAIRED_ESTIMATE_LIMITATION", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
      parameters: PAIRED_MAJORITY_DELTA_PARAMETERS,
      results: EXPECTED_PAIRED_MAJORITY_DELTA,
      limitations: [...LOCAL_VENUE_LIMITS, ...FORCING_ADDITIONAL_LIMITATIONS, PAIRED_ESTIMATE_LIMITATION],
    });
    const claim = buildJudgeFamilyClaim(fixture);

    expect(() =>
      assertClaimConsistency({
        claim,
        identities: {
          benchmarkSha256: "c".repeat(64), runSha256: fixture.runSha256, matrixSha256: fixture.matrixSha256,
          reportSha256: fixture.reportSha256, reportEnvelopeSha256: fixture.reportEnvelopeSha256,
        },
        benchmarkRecord: {} as unknown as BenchmarkRecord,
        runRecord: fixture.runRecord,
        matrixRecord: fixture.matrixRecord,
        reportRecord: fixture.reportRecord,
        draftId: "judge-1",
        assurancePreset: JUDGE_FAMILY_ASSURANCE.preset,
        additionalLimitations: FORCING_ADDITIONAL_LIMITATIONS,
      }),
    ).not.toThrow();
  });

  it("throws when the sealed Report's limitations omit PAIRED_ESTIMATE_LIMITATION for a paired-majority-delta@1 Report", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairedMajorityDelta,
      parameters: PAIRED_MAJORITY_DELTA_PARAMETERS,
      results: EXPECTED_PAIRED_MAJORITY_DELTA,
      // Omits PAIRED_ESTIMATE_LIMITATION -- proves the cold rebuild actually requires it rather
      // than passing vacuously.
      limitations: [...LOCAL_VENUE_LIMITS, ...FORCING_ADDITIONAL_LIMITATIONS],
    });
    const claim = buildJudgeFamilyClaim(fixture);

    expect(() =>
      assertClaimConsistency({
        claim,
        identities: {
          benchmarkSha256: "c".repeat(64), runSha256: fixture.runSha256, matrixSha256: fixture.matrixSha256,
          reportSha256: fixture.reportSha256, reportEnvelopeSha256: fixture.reportEnvelopeSha256,
        },
        benchmarkRecord: {} as unknown as BenchmarkRecord,
        runRecord: fixture.runRecord,
        matrixRecord: fixture.matrixRecord,
        reportRecord: fixture.reportRecord,
        draftId: "judge-1",
        assurancePreset: JUDGE_FAMILY_ASSURANCE.preset,
        additionalLimitations: FORCING_ADDITIONAL_LIMITATIONS,
      }),
    ).toThrow(/Report limitations are not the exact disclosure/);
  });

  it("does NOT require an extra limitation line for pairwise-disagreement@1 (no PAIRED_ESTIMATE_LIMITATION, no withheld-interval disclosure)", () => {
    const fixture = buildJudgeFamilyFixture({
      method: BENCHMARKING_METHOD_IDS.pairwiseDisagreement,
      parameters: PAIRWISE_DISAGREEMENT_PARAMETERS,
      results: EXPECTED_PAIRWISE_DISAGREEMENT,
      limitations: [...LOCAL_VENUE_LIMITS, ...FORCING_ADDITIONAL_LIMITATIONS],
    });
    const claim = buildJudgeFamilyClaim(fixture);

    expect(() =>
      assertClaimConsistency({
        claim,
        identities: {
          benchmarkSha256: "c".repeat(64), runSha256: fixture.runSha256, matrixSha256: fixture.matrixSha256,
          reportSha256: fixture.reportSha256, reportEnvelopeSha256: fixture.reportEnvelopeSha256,
        },
        benchmarkRecord: {} as unknown as BenchmarkRecord,
        runRecord: fixture.runRecord,
        matrixRecord: fixture.matrixRecord,
        reportRecord: fixture.reportRecord,
        draftId: "judge-1",
        assurancePreset: JUDGE_FAMILY_ASSURANCE.preset,
        additionalLimitations: FORCING_ADDITIONAL_LIMITATIONS,
      }),
    ).not.toThrow();
  });
});
