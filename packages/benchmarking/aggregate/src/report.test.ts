import {
  BENCHMARKING_REPORTS_SCOPE,
  REPORT_MEDIA_TYPE,
  parseMatrix,
  sealMatrix,
  sealReport,
  sealRun,
} from "@jinn-network/benchmarking-records";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseDsseEnvelope,
  recordDigest,
  sealDsseEnvelope,
  type DsseSigner,
  type ResolvedBinding,
  type VerifyEnvelopeBindingDeps,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { createMethodRegistry } from "./registry.js";
import {
  deriveDisclosures,
  produceReport,
  verifyReport,
  type MethodPorts,
  type VerifyReportPorts,
} from "./report.js";

const AUTHOR = "urn:uuid:11111111-1111-5111-8111-111111111111";
const OTHER_AUTHOR = "urn:uuid:99999999-9999-5999-8999-999999999999";
const REPORT_KEY = "did:key:zReportFixture";
const EFFECTIVE_TIME = "2026-07-29T12:00:00Z";
const MATCH_ALL = {
  harness: "match",
  model: "match",
  loadout: "match",
  isolation: "match",
  checksFailed: [],
};

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function verdictBytes(verdict: "pass" | "fail", label: string): Uint8Array {
  const subjectDigest = recordDigest(new TextEncoder().encode(label)).slice("sha256:".length);
  const payload = canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `fixture/${label}`, digest: { sha256: subjectDigest } }],
    predicateType: "https://jinn.network/attestations/result-evaluation/v1",
    predicate: {
      evaluatedAt: "2026-07-29T00:00:00Z",
      evaluator: { id: "urn:uuid:77777777-7777-5777-8777-777777777777" },
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
  readonly subjectBytes: Uint8Array[];
  readonly ports: MethodPorts;
}

function makeFixture(options: { preregistered?: boolean; subjectCount?: number } = {}): Fixture {
  const registry = createMethodRegistry();
  const verdictMap = new Map<string, Uint8Array>();
  const verdictOne = verdictBytes("pass", "1");
  const verdictTwo = verdictBytes("fail", "2");
  verdictMap.set(recordDigest(verdictOne), verdictOne);
  verdictMap.set(recordDigest(verdictTwo), verdictTwo);
  const runMap = new Map<string, Uint8Array>();
  const subjectBytes: Uint8Array[] = [];
  const count = options.subjectCount ?? 1;

  for (let index = 0; index < count; index += 1) {
    const analysisPlan = options.preregistered === false
      ? []
      : [{
          method: "jinn.benchmarking.method/wilson",
          version: "1",
          parameters: { verdictRule: "unanimous" },
        }];
    const run = sealRun({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      benchmark: { digest: { sha256: "b".repeat(64) } },
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      arms: [{ armId: "armA", pinning: {} }],
      replicates: 1,
      policy: {
        completenessFloor: "1",
        cellWindow: 60_000,
        replacement: { allowed: false },
        independence: "disclosed",
        evaluation: {},
        submissionBaseline: {},
      },
      analysisPlan,
      closeAt: "2026-08-04T00:00:00Z",
    });
    runMap.set(run.digest, run.bytes);
    const taskDigest = `${index + 1}`.padStart(64, "c");
    const verdictDigest = index % 2 === 0 ? recordDigest(verdictOne) : recordDigest(verdictTwo);
    const cellKey = `${taskDigest}/armA/1`;
    const matrix = sealMatrix({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      run: { digest: { sha256: run.digest.slice("sha256:".length) } },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells: [{
        cellKey,
        taskDigest,
        armId: "armA",
        replicate: 1,
        dispatches: 1,
        accounted: 1,
        submission: `sha256:${"3".repeat(64)}`,
        delivery: `sha256:${"4".repeat(64)}`,
        verdicts: [verdictDigest],
        validVerdicts: [verdictDigest],
        outcome: "judged",
        verification: MATCH_ALL,
        integrityTier: index === 0 ? "re-derivable" : "attested-only",
      }],
      exclusions: [],
      attrition: {
        perArm: {
          armA: {
            expected: 1,
            judged: 1,
            unjudged: 0,
            unscorable: 0,
            expired: 0,
            invalidated: 0,
            excluded: 0,
            replacements: 0,
          },
        },
        asymmetryFlags: [],
      },
      completeness: { expected: 1, judged: 1, floor: "1", runOutcome: "complete" },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
    });
    subjectBytes.push(matrix.bytes);
  }

  return {
    subjectBytes,
    ports: {
      registry,
      resolveVerdictBytes: (digest) => verdictMap.get(digest),
      resolveRunBytes: (digest) => runMap.get(digest),
      resolveTaskBytes: () => undefined,
    },
  };
}

function crossVersionPairedFixture(sharedTask: boolean): Fixture {
  const registry = createMethodRegistry();
  const verdictMap = new Map<string, Uint8Array>();
  const runMap = new Map<string, Uint8Array>();
  const taskMap = new Map<string, Uint8Array>();
  const subjectBytes: Uint8Array[] = [];
  const methodParameters = {
    baseline: "armA",
    candidate: "armB",
    verdictRule: "unanimous",
  };

  for (let index = 0; index < 2; index += 1) {
    const taskBytes = canonicalJsonBytes({
      payload: {
        provenance: {
          source: "fixture/shared-repository",
          timestamp: "2026-07-29T00:00:00Z",
          ...(sharedTask ? {} : { revision: index }),
        },
      },
    });
    const taskDigest = recordDigest(taskBytes);
    taskMap.set(taskDigest, taskBytes);
    const baselineVerdict = verdictBytes("fail", `cross-${index}-baseline`);
    const candidateVerdict = verdictBytes("pass", `cross-${index}-candidate`);
    const baselineVerdictDigest = recordDigest(baselineVerdict);
    const candidateVerdictDigest = recordDigest(candidateVerdict);
    verdictMap.set(baselineVerdictDigest, baselineVerdict);
    verdictMap.set(candidateVerdictDigest, candidateVerdict);
    const run = sealRun({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      benchmark: { digest: { sha256: (index === 0 ? "b" : "c").repeat(64) } },
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      arms: [
        { armId: "armA", pinning: { "fixture/arm": "armA" } },
        { armId: "armB", pinning: { "fixture/arm": "armB" } },
      ],
      replicates: 1,
      policy: {
        completenessFloor: "1",
        cellWindow: 60_000,
        replacement: { allowed: false },
        independence: "disclosed",
        evaluation: {},
        submissionBaseline: {},
      },
      analysisPlan: [{
        method: "jinn.benchmarking.method/paired-mcnemar",
        version: "1",
        parameters: methodParameters,
      }],
      closeAt: "2026-08-04T00:00:00Z",
    });
    runMap.set(run.digest, run.bytes);
    const taskHex = taskDigest.slice("sha256:".length);
    const matrix = sealMatrix({
      protocol: "https://jinn.network/protocols/benchmarking/1.0",
      run: { digest: { sha256: run.digest.slice("sha256:".length) } },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells: [
        {
          cellKey: `${taskHex}/armA/1`,
          taskDigest: taskHex,
          armId: "armA",
          replicate: 1,
          dispatches: 1,
          accounted: 1,
          submission: `sha256:${"5".repeat(64)}`,
          delivery: `sha256:${"6".repeat(64)}`,
          verdicts: [baselineVerdictDigest],
          validVerdicts: [baselineVerdictDigest],
          outcome: "judged",
          verification: MATCH_ALL,
          integrityTier: "re-derivable",
        },
        {
          cellKey: `${taskHex}/armB/1`,
          taskDigest: taskHex,
          armId: "armB",
          replicate: 1,
          dispatches: 1,
          accounted: 1,
          submission: `sha256:${"7".repeat(64)}`,
          delivery: `sha256:${"8".repeat(64)}`,
          verdicts: [candidateVerdictDigest],
          validVerdicts: [candidateVerdictDigest],
          outcome: "judged",
          verification: MATCH_ALL,
          integrityTier: "re-derivable",
        },
      ],
      exclusions: [],
      attrition: {
        perArm: {
          armA: {
            expected: 1,
            judged: 1,
            unjudged: 0,
            unscorable: 0,
            expired: 0,
            invalidated: 0,
            excluded: 0,
            replacements: 0,
          },
          armB: {
            expected: 1,
            judged: 1,
            unjudged: 0,
            unscorable: 0,
            expired: 0,
            invalidated: 0,
            excluded: 0,
            replacements: 0,
          },
        },
        asymmetryFlags: [],
      },
      completeness: { expected: 2, judged: 2, floor: "1", runOutcome: "complete" },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
    });
    subjectBytes.push(matrix.bytes);
  }
  return {
    subjectBytes,
    ports: {
      registry,
      resolveVerdictBytes: (digest) => verdictMap.get(digest),
      resolveRunBytes: (digest) => runMap.get(digest),
      resolveTaskBytes: (digest) => taskMap.get(digest),
    },
  };
}

const signer: DsseSigner = async () => [
  { keyid: REPORT_KEY, signature: Uint8Array.of(7, 8, 9) },
];

function resolvedBinding(scope: readonly string[], revoked: boolean): ResolvedBinding {
  const revocationEnvelope = Uint8Array.of(9, 9, 9);
  return {
    binding: {
      protocol: "https://jinn.network/trust/key-binding/v1",
      agent: AUTHOR,
      key: {
        publicKey: "fixture",
        keyid: REPORT_KEY,
        algorithm: "fixture",
        didKey: REPORT_KEY,
      },
      voucher: { kind: "agentId", caip19: "eip155:1/erc721:0x0000000000000000000000000000000000000000/1" },
      relationship: "controls",
      scope: [...scope],
      validFrom: "2026-07-01T00:00:00Z",
      ceremony: { type: "agentId", digest: `sha256:${"d".repeat(64)}` },
      strength: "strong",
      anchors: [],
    },
    envelopeBytes: Uint8Array.of(1),
    bindingDigest: `sha256:${"e".repeat(64)}`,
    effectiveStart: "2026-07-01T00:00:00Z",
    isGenesis: true,
    revocations: revoked
      ? [{
          revocation: {
            protocol: "https://jinn.network/trust/revocation/v1",
            target: `sha256:${"e".repeat(64)}`,
            revokedBy: REPORT_KEY,
            anchors: [],
            effectiveFrom: "2026-07-20T00:00:00Z",
          },
          envelopeBytes: revocationEnvelope,
          effectiveTime: "2026-07-20T00:00:00Z",
        }]
      : [],
  } as ResolvedBinding;
}

function verificationPorts(
  methodPorts: MethodPorts,
  expectedEnvelope: Uint8Array,
  options: {
    author?: string;
    scope?: readonly string[];
    revoked?: boolean;
    badSignature?: boolean;
  } = {},
): VerifyReportPorts {
  const binding = resolvedBinding(
    options.scope ?? [BENCHMARKING_REPORTS_SCOPE, "bindings"],
    options.revoked ?? false,
  );
  const trust: VerifyEnvelopeBindingDeps = {
    dsseVerifier: (bytes) => ({
      validSignerKeyids: options.badSignature
        ? []
        : bytesEqual(bytes, expectedEnvelope) || bytesEqual(bytes, Uint8Array.of(9, 9, 9))
          ? [REPORT_KEY]
          : [],
    }),
    bindingResolver: {
      async resolveBinding(query) {
        if (query.agent !== (options.author ?? AUTHOR) || query.key !== REPORT_KEY) return null;
        return binding;
      },
    },
    witnessVerifier: {
      async verify1271Witness() {
        return { verified: true };
      },
    },
  };
  return { ...methodPorts, trust };
}

async function produce(fixture: Fixture) {
  return produceReport(
    {
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: {
        id: "jinn.benchmarking.method/wilson",
        version: "1",
        parameters: {},
      },
      verdictRule: "unanimous",
      author: AUTHOR,
    },
    signer,
  );
}

describe("deriveDisclosures", () => {
  test("is lossless, one-to-one, digest-bound, and subject-ordered", () => {
    const fixture = makeFixture({ subjectCount: 2 });
    const disclosures = deriveDisclosures(fixture.subjectBytes);
    expect(disclosures.perSubject).toHaveLength(2);
    expect(disclosures.perSubject.map((entry) => entry.subjectSha256)).toEqual(
      fixture.subjectBytes.map((bytes) => recordDigest(bytes).slice("sha256:".length)),
    );
    expect(disclosures.perSubject[1]!.attrition.asymmetryFlags).toEqual([]);
    expect(disclosures.perSubject[0]!.integrityTiers).not.toEqual(
      disclosures.perSubject[1]!.integrityTiers,
    );
  });
});

describe("byte-first produceReport / verifyReport", () => {
  test("positive exact-byte path verifies signature, author, scope, time, subjects, and replay", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    expect(produced.record.preregistered).toBe(true);
    const result = await verifyReport(
      {
        envelopeBytes: produced.envelope,
        subjects: fixture.subjectBytes,
        effectiveTime: EFFECTIVE_TIME,
      },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: true });
  });

  test.each([
    ["wrong author", { author: OTHER_AUTHOR }, "report-authenticity"],
    ["wrong scope", { scope: ["bindings"] }, "report-authenticity"],
    ["revoked", { revoked: true }, "report-authenticity"],
    ["bad signature", { badSignature: true }, "report-authenticity"],
  ] as const)("%s fails closed", async (_name, options, check) => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const result = await verifyReport(
      {
        envelopeBytes: produced.envelope,
        subjects: fixture.subjectBytes,
        effectiveTime: EFFECTIVE_TIME,
      },
      verificationPorts(fixture.ports, produced.envelope, options),
    );
    expect(result).toMatchObject({ ok: false, check });
  });

  test("payload substitution fails the exact-envelope signature check", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const parsed = parseDsseEnvelope(produced.envelope);
    const substitutedPayload = sealReport({
      ...produced.record,
      author: OTHER_AUTHOR,
    }).bytes;
    const substituted = sealDsseEnvelope({
      payloadType: REPORT_MEDIA_TYPE,
      payloadBytes: substitutedPayload,
      signatures: [{ keyid: REPORT_KEY, signature: Uint8Array.of(7, 8, 9) }],
    });
    expect(parsed.payloadBytes).not.toEqual(substitutedPayload);
    const result = await verifyReport(
      { envelopeBytes: substituted, subjects: fixture.subjectBytes, effectiveTime: EFFECTIVE_TIME },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: false, check: "report-authenticity" });
  });

  test("noncanonical subject bytes fail even when they parse to the same Matrix", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const noncanonical = new TextEncoder().encode(
      ` ${new TextDecoder().decode(fixture.subjectBytes[0]!)}`,
    );
    const result = await verifyReport(
      { envelopeBytes: produced.envelope, subjects: [noncanonical], effectiveTime: EFFECTIVE_TIME },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: false, check: "report-recompute" });
  });

  test("subject order is exact and cannot be swapped", async () => {
    const fixture = makeFixture({ subjectCount: 2 });
    const produced = await produce(fixture);
    const result = await verifyReport(
      {
        envelopeBytes: produced.envelope,
        subjects: [...fixture.subjectBytes].reverse(),
        effectiveTime: EFFECTIVE_TIME,
      },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: false, check: "report-recompute" });
  });

  test("preregistered is producer-derived false when exact Run tuple is absent", async () => {
    const fixture = makeFixture({ preregistered: false });
    const produced = await produce(fixture);
    expect(produced.record.preregistered).toBe(false);
  });

  test("unresolved Run/Benchmark identity fails comparability explicitly", async () => {
    const fixture = makeFixture();
    await expect(produceReport(
      {
        ...fixture.ports,
        resolveRunBytes: () => undefined,
        subjects: fixture.subjectBytes,
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        author: AUTHOR,
      },
      signer,
    )).rejects.toThrow(/run-record-unavailable/);
  });

  test("version-robust cross-Benchmark reports prove and replay the exact shared Task pairing", async () => {
    const fixture = crossVersionPairedFixture(true);
    const produced = await produceReport(
      {
        ...fixture.ports,
        subjects: fixture.subjectBytes,
        method: {
          id: "jinn.benchmarking.method/paired-mcnemar",
          version: "1",
          parameters: { baseline: "armA", candidate: "armB" },
        },
        verdictRule: "unanimous",
        author: AUTHOR,
      },
      signer,
    );
    const perSubject = (produced.record.results as {
      perSubject: Array<{ subjectSha256: string; results: { pairing: { taskDigests: string[] } } }>;
    }).perSubject;
    expect(perSubject).toHaveLength(2);
    expect(perSubject[0]!.results.pairing.taskDigests).toHaveLength(1);
    expect(perSubject[1]!.results.pairing.taskDigests)
      .toEqual(perSubject[0]!.results.pairing.taskDigests);
    const result = await verifyReport(
      {
        envelopeBytes: produced.envelope,
        subjects: fixture.subjectBytes,
        effectiveTime: EFFECTIVE_TIME,
      },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: true });
  });

  test("version-robust cross-Benchmark production refuses an empty/non-shared pairing", async () => {
    const fixture = crossVersionPairedFixture(false);
    await expect(produceReport(
      {
        ...fixture.ports,
        subjects: fixture.subjectBytes,
        method: {
          id: "jinn.benchmarking.method/paired-mcnemar",
          version: "1",
          parameters: { baseline: "armA", candidate: "armB" },
        },
        verdictRule: "unanimous",
        author: AUTHOR,
      },
      signer,
    )).rejects.toThrow(/identical Task-digest pairing/);
  });

  test("verification instant is explicit context and invalid input fails before trust resolution", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const result = await verifyReport(
      { envelopeBytes: produced.envelope, subjects: fixture.subjectBytes, effectiveTime: "not-time" },
      verificationPorts(fixture.ports, produced.envelope),
    );
    expect(result).toMatchObject({ ok: false, check: "report-authenticity" });
  });

  test("Report envelope payload is the exact canonical record bytes signed through DSSE PAE", async () => {
    const fixture = makeFixture();
    let signedPae: Uint8Array | undefined;
    const captureSigner: DsseSigner = async (request) => {
      signedPae = request.preAuthEncoding;
      return [{ keyid: REPORT_KEY, signature: Uint8Array.of(1) }];
    };
    const produced = await produceReport(
      {
        ...fixture.ports,
        subjects: fixture.subjectBytes,
        method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
        verdictRule: "unanimous",
        author: AUTHOR,
      },
      captureSigner,
    );
    expect(parseDsseEnvelope(produced.envelope).payloadBytes).toEqual(produced.bytes);
    expect(signedPae).toEqual(dssePreAuthEncoding(REPORT_MEDIA_TYPE, produced.bytes));
  });

  test("new exact-byte boundaries reject lone surrogates and accept supplementary scalar pairs", async () => {
    const fixture = makeFixture();
    const parsed = parseMatrix(fixture.subjectBytes[0]!);
    expect(() => sealMatrix({ ...parsed, "example.fixture.note": "valid \u{1f680}" })).not.toThrow();
    expect(() => sealMatrix({ ...parsed, "example.fixture.note": "\ud800" })).toThrow();
  });
});
