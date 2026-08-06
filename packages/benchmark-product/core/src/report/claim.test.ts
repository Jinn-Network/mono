import { describe, expect, it } from "vitest";
import {
  BENCHMARKING_METHOD_IDS,
  BENCHMARKING_METHOD_VERSION,
  BENCHMARKING_PROTOCOL,
  compareCodeUnitStrings,
  parseMatrix,
  parseRun,
  sealMatrix,
  sealRun,
} from "@jinn-network/benchmarking-records";
import { createMethodRegistry, produceReport, type DsseSigner, type MethodPorts } from "@jinn-network/benchmarking-aggregate";
import { canonicalJsonBytes, recordDigest, sealDsseEnvelope } from "@jinn-network/trust-core";
import type { VenueHonesty } from "../operations/run-results.js";
import { LOCAL_VENUE_LIMITS, unverifiableAxisCounts } from "../operations/run-results.js";
import { sha256Hex } from "../workspace/sealed-store.js";
import { buildClaimPackage, CLAIM_PACKAGE_SCHEMA_ID, ClaimPackageSchema } from "./claim.js";

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
    expect(claim.verification.command).toContain("draft-1");
    expect(claim.verification.command).toContain("verify");
    expect(claim.verification.checks.length).toBeGreaterThan(0);
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
