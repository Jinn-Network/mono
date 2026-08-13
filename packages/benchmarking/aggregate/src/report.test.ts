import {
  BENCHMARK_PUBLICATION_EXTENSION,
  BENCHMARKING_REPORTS_SCOPE,
  REPORT_MEDIA_TYPE,
  REPORT_V2_RECORD_KIND,
  SIGNED_REPORT_MEDIA_TYPE,
  parseBenchmarkAccounting,
  parseMatrix,
  sealBenchmarkAccounting,
  sealMatrix,
  sealReport,
  sealRun,
  withMatrixPublicationExtension,
} from "@jinn-network/benchmarking-records";
import { sealTask } from "@jinn-network/task-execution-protocol";
import {
  canonicalJsonBytes,
  dssePreAuthEncoding,
  parseExactDsseEnvelope,
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
  produceReportV2,
  verifyReport,
  verifyReportV2,
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

function fixtureSignature(preAuthEncoding: Uint8Array): Uint8Array {
  const digestBytes = new TextEncoder().encode(recordDigest(preAuthEncoding));
  const signature = new Uint8Array(digestBytes.length + 1);
  signature[0] = 0xfb;
  signature.set(digestBytes, 1);
  return signature;
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function verdictBytes(verdict: "pass" | "fail", label: string): Uint8Array {
  const subjectDigest = recordDigest(new TextEncoder().encode(label)).slice("sha256:".length);
  const payload = canonicalJsonBytes({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: `fixture/${label}`, digest: { sha256: subjectDigest } }],
    predicateType: "https://spec.jinn.network/attestations/result-evaluation/v1",
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
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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

interface PublicationFixture extends Fixture {
  readonly accountingBytes: Uint8Array[];
}

function makePublicationFixture(
  options: { preregistered?: boolean; publicRegistration?: "pre-dispatch" | "post-hoc" | "unverifiable" } = {},
): PublicationFixture {
  const fixture = makeFixture({ preregistered: options.preregistered });
  const accountingBytes: Uint8Array[] = [];
  const subjectBytes = fixture.subjectBytes.map((subjectBytes, index) => {
    const matrix = parseMatrix(subjectBytes);
    const accounting = sealBenchmarkAccounting({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { name: "run", digest: { sha256: matrix.run.digest.sha256 } },
      publisher: "urn:uuid:22222222-2222-5222-8222-222222222222",
      publisherAuthority: { kind: "run-owner" },
      procedure: { id: "jinn.benchmarking.accounting", version: "1.0" },
      scope: { streams: [{
        role: "https://spec.jinn.network/roles/benchmark-publisher-dispatches/v1",
        kind: "record-discovery",
        source: { agent: "urn:uuid:22222222-2222-5222-8222-222222222222", name: "benchmarks" },
        through: { sequence: "0000000000000002", entry: `sha256:${"a".repeat(64)}` },
      }] },
      publicRegistration: options.publicRegistration === "pre-dispatch"
        ? {
            status: "pre-dispatch",
            runBoundary: {
              kind: "record-discovery",
              source: { agent: "urn:uuid:22222222-2222-5222-8222-222222222222", name: "benchmarks" },
              position: { sequence: "0000000000000001", entry: `sha256:${"b".repeat(64)}` },
            },
            firstDispatchBoundary: {
              kind: "record-discovery",
              source: { agent: "urn:uuid:22222222-2222-5222-8222-222222222222", name: "benchmarks" },
              position: { sequence: "0000000000000002", entry: `sha256:${"c".repeat(64)}` },
            },
          }
        : options.publicRegistration === "unverifiable"
          ? { status: "unverifiable" }
          : { status: "post-hoc" },
      closeBoundary: matrix.closeBoundary,
      cells: [],
    });
    accountingBytes.push(accounting.bytes);
    return sealMatrix(withMatrixPublicationExtension({
      ...matrix,
      assembly: { procedure: "jinn.benchmarking.assembly", version: "2.0" },
    }, {
      accounting: {
        name: `accounting-${index}`,
        digest: { sha256: accounting.digest.slice("sha256:".length) },
      },
    })).bytes;
  });
  return { ...fixture, subjectBytes, accountingBytes };
}

function rebindAccountingCloseBoundary(
  fixture: PublicationFixture,
  closeBoundary: {
    readonly at: string;
    readonly anchor?: { readonly chain: string; readonly blockNumber: number; readonly blockHash: string };
  },
): PublicationFixture {
  const accountingBytes: Uint8Array[] = [];
  const subjectBytes = fixture.subjectBytes.map((subjectBytes, index) => {
    const matrix = parseMatrix(subjectBytes);
    const accounting = parseBenchmarkAccounting(fixture.accountingBytes[index]!);
    const reboundAccounting = sealBenchmarkAccounting({ ...accounting, closeBoundary });
    accountingBytes.push(reboundAccounting.bytes);
    return sealMatrix(withMatrixPublicationExtension(matrix, {
      accounting: {
        name: `accounting-${index}`,
        digest: { sha256: reboundAccounting.digest.slice("sha256:".length) },
      },
    })).bytes;
  });
  return { ...fixture, subjectBytes, accountingBytes };
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
    const taskBytes = sealTask({
      protocol: "https://spec.jinn.network/profiles/task-execution/v1",
      profile: { digest: { sha256: "a".repeat(64) } }, instructions: sharedTask ? "shared" : `revision-${index}`,
      outputs: [], evaluation: { digest: { sha256: "d".repeat(64) } },
      payload: { provenance: { source: "fixture/shared-repository", timestamp: "2026-07-29T00:00:00Z" } },
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
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
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

const signer: DsseSigner = async ({ preAuthEncoding }) => [
  { keyid: REPORT_KEY, signature: fixtureSignature(preAuthEncoding) },
];

function resolvedBinding(scope: readonly string[], revoked: boolean): ResolvedBinding {
  const revocationPayloadType = "application/vnd.jinn.trust.revocation.v1+json";
  const revocationPayload = canonicalJsonBytes({ fixture: "revocation" });
  const revocationEnvelope = sealDsseEnvelope({
    payloadType: revocationPayloadType,
    payloadBytes: revocationPayload,
    signatures: [{
      keyid: REPORT_KEY,
      signature: fixtureSignature(dssePreAuthEncoding(revocationPayloadType, revocationPayload)),
    }],
  });
  return {
    binding: {
      protocol: "https://spec.jinn.network/trust/key-binding/v1",
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
            protocol: "https://spec.jinn.network/trust/revocation/v1",
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
    dsseVerifier: (bytes) => {
      if (options.badSignature) return { validSignerKeyids: [] };
      try {
        const parsed = parseDsseEnvelope(bytes);
        const expected = fixtureSignature(
          dssePreAuthEncoding(parsed.payloadType, parsed.payloadBytes),
        );
        return {
          validSignerKeyids: parsed.signatures
            .filter((signature) =>
              signature.keyid !== undefined
              && bytesEqual(decodeBase64(signature.sig), expected))
            .map((signature) => signature.keyid as string),
        };
      } catch {
        return { validSignerKeyids: [] };
      }
    },
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

test("verifyReport rejects an impossible civil effective-time context before trust resolution", async () => {
  const fixture = makeFixture();
  const produced = await produce(fixture);
  const result = await verifyReport(
    {
      envelopeBytes: produced.envelope,
      subjects: fixture.subjectBytes,
      effectiveTime: "2026-02-30T00:00:00Z",
    },
    verificationPorts(fixture.ports),
  );
  expect(result).toEqual({
    ok: false,
    check: "report-authenticity",
    detail: "effectiveTime context must be an explicit RFC 3339 verification instant",
  });
});

describe("deriveDisclosures", () => {
  test("is lossless, one-to-one, digest-bound, and subject-ordered", () => {
    const fixture = makeFixture({ subjectCount: 2 });
    const disclosures = deriveDisclosures(fixture.subjectBytes, fixture.ports.resolveRunBytes);
    expect(disclosures.perSubject).toHaveLength(2);
    expect(disclosures.perSubject.map((entry) => entry.subjectSha256)).toEqual(
      fixture.subjectBytes.map((bytes) => recordDigest(bytes).slice("sha256:".length)),
    );
    expect(disclosures.perSubject[1]!.attrition.asymmetryFlags).toEqual([]);
    expect(disclosures.perSubject[0]!.integrityTiers).not.toEqual(
      disclosures.perSubject[1]!.integrityTiers,
    );
  });

  function independenceFixture(options: {
    outcome: "judged" | "expired";
    independence: "disclosed" | "gating";
    checksFailed: readonly string[];
  }): Fixture {
    const registry = createMethodRegistry();
    const verdictMap = new Map<string, Uint8Array>();
    const verdictOne = verdictBytes("pass", "independence");
    verdictMap.set(recordDigest(verdictOne), verdictOne);
    const run = sealRun({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      benchmark: { digest: { sha256: "b".repeat(64) } },
      owner: "urn:uuid:22222222-2222-5222-8222-222222222222",
      arms: [{ armId: "armA", pinning: {} }],
      replicates: 1,
      policy: {
        completenessFloor: "1",
        cellWindow: 60_000,
        replacement: { allowed: false },
        independence: options.independence,
        evaluation: {},
        submissionBaseline: {},
      },
      closeAt: "2026-08-04T00:00:00Z",
    });
    const runMap = new Map<string, Uint8Array>([[run.digest, run.bytes]]);
    const taskDigest = "c".repeat(64);
    const verdictDigest = recordDigest(verdictOne);
    const judgedCell = {
      cellKey: `${taskDigest}/armA/1`,
      taskDigest,
      armId: "armA",
      replicate: 1,
      dispatches: 1,
      accounted: 1,
      submission: `sha256:${"3".repeat(64)}`,
      delivery: `sha256:${"4".repeat(64)}`,
      verdicts: [verdictDigest],
      validVerdicts: [verdictDigest],
      outcome: "judged" as const,
      verification: {
        harness: "match",
        model: "match",
        loadout: "match",
        isolation: "match",
        checksFailed: [...options.checksFailed].sort(),
      },
      integrityTier: "re-derivable" as const,
    };
    const expiredCell = {
      cellKey: `${taskDigest}/armA/1`,
      taskDigest,
      armId: "armA",
      replicate: 1,
      dispatches: 0,
      verdicts: [] as string[],
      validVerdicts: [] as string[],
      outcome: "expired" as const,
      verification: {
        harness: "match",
        model: "match",
        loadout: "match",
        isolation: "match",
        checksFailed: [...options.checksFailed].sort(),
      },
      integrityTier: "re-derivable" as const,
    };
    const cell = options.outcome === "judged" ? judgedCell : expiredCell;
    const matrix = sealMatrix({
      protocol: "https://spec.jinn.network/protocols/benchmarking/v1",
      run: { digest: { sha256: run.digest.slice("sha256:".length) } },
      closeBoundary: { at: "2026-08-04T00:00:00Z" },
      cells: [cell],
      exclusions: [],
      attrition: {
        perArm: {
          armA: {
            expected: 1,
            judged: options.outcome === "judged" ? 1 : 0,
            unjudged: 0,
            unscorable: 0,
            expired: options.outcome === "expired" ? 1 : 0,
            invalidated: 0,
            excluded: 0,
            replacements: 0,
          },
        },
        asymmetryFlags: [],
      },
      completeness: {
        expected: 1,
        judged: options.outcome === "judged" ? 1 : 0,
        floor: "1",
        runOutcome: options.outcome === "judged" ? "complete" : "partial",
      },
      assembly: { procedure: "jinn.benchmarking.assembly", version: "1.0" },
    });
    return {
      subjectBytes: [matrix.bytes],
      ports: {
        registry,
        resolveVerdictBytes: (digest) => verdictMap.get(digest),
        resolveRunBytes: (digest) => runMap.get(digest),
        resolveTaskBytes: () => undefined,
      },
    };
  }

  test.each([
    ["judged disclosed independence violation", { outcome: "judged" as const, independence: "disclosed" as const, expected: 1 }],
    ["expired disclosed independence violation", { outcome: "expired" as const, independence: "disclosed" as const, expected: 0 }],
    ["judged gating independence violation", { outcome: "judged" as const, independence: "gating" as const, expected: 0 }],
    ["expired gating independence violation", { outcome: "expired" as const, independence: "gating" as const, expected: 0 }],
  ])("counts evaluator-independence disclosures only for judged cells under disclosed policy (%s)", (_label, { outcome, independence, expected }) => {
    const fixture = independenceFixture({
      outcome,
      independence,
      checksFailed: ["evaluator-independence"],
    });
    const disclosures = deriveDisclosures(fixture.subjectBytes, fixture.ports.resolveRunBytes);
    expect(disclosures.perSubject[0]).toMatchObject({
      subjectSha256: recordDigest(fixture.subjectBytes[0]!).slice("sha256:".length),
      integrityTiers: { "re-derivable": 1, "attested-only": 0 },
      pinning: {
        harness: { match: 1, mismatch: 0, unverifiable: 0 },
        model: { match: 1, mismatch: 0, unverifiable: 0 },
        loadout: { match: 1, mismatch: 0, unverifiable: 0 },
        isolation: { match: 1, mismatch: 0, unverifiable: 0 },
      },
      independence: expected,
      completeness: {
        expected: 1,
        judged: outcome === "judged" ? 1 : 0,
        floor: "1",
        runOutcome: outcome === "judged" ? "complete" : "partial",
      },
      attrition: {
        perArm: {
          armA: {
            expected: 1,
            judged: outcome === "judged" ? 1 : 0,
            unjudged: 0,
            unscorable: 0,
            expired: outcome === "expired" ? 1 : 0,
            invalidated: 0,
            excluded: 0,
            replacements: 0,
          },
        },
        asymmetryFlags: [],
      },
    });
  });
});

describe("byte-first produceReport / verifyReport", () => {
  test("Report producer envelope exact-parses and refuses an empty producer signature", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    expect(parseExactDsseEnvelope(produced.envelope).payloadBytes).toEqual(produced.bytes);
    const emptySigner: DsseSigner = async () => [{ keyid: REPORT_KEY, signature: new Uint8Array() }];
    await expect(produceReport({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
    }, emptySigner)).rejects.toThrow(/non-empty/);
  });

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
      verificationPorts(fixture.ports),
    );
    expect(result).toMatchObject({ ok: true });
  });

  test.each([
    ["pretty", (envelope: Record<string, unknown>) =>
      `${JSON.stringify(envelope, null, 2)}\n`,
    "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding."],
    ["reordered", (envelope: Record<string, unknown>) => JSON.stringify({
      signatures: envelope["signatures"],
      payloadType: envelope["payloadType"],
      payload: envelope["payload"],
    }),
    "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding."],
    ["trailing", (_envelope: Record<string, unknown>, exact: string) => `${exact} `,
    "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding."],
    ["duplicate", (envelope: Record<string, unknown>) =>
      `{"payload":${JSON.stringify(envelope["payload"])},"payload":${JSON.stringify(envelope["payload"])},"payloadType":${JSON.stringify(envelope["payloadType"])},"signatures":${JSON.stringify(envelope["signatures"])}}`,
    "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding."],
    ["extra", (envelope: Record<string, unknown>) => JSON.stringify({ ...envelope, extra: true }),
    "invalid DSSE envelope: TrustCoreError: DSSE envelope must contain exactly payload, payloadType, and signatures."],
    ["non-producer-base64", (envelope: Record<string, unknown>) => {
      const signatures = envelope["signatures"] as Array<Record<string, unknown>>;
      const signature = signatures[0]!;
      const sig = signature["sig"] as string;
      expect(sig).toContain("+");
      return JSON.stringify({
        ...envelope,
        signatures: [{ ...signature, sig: sig.replace("+", "-") }],
      });
    }, "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding."],
  ] as const)(
    "rejects a byte-distinct %s Report envelope before semantic trust verification",
    async (_name, mutate, detail) => {
      const fixture = makeFixture();
      const produced = await produce(fixture);
      const exact = new TextDecoder().decode(produced.envelope);
      const envelope = JSON.parse(exact) as Record<string, unknown>;
      const variant = new TextEncoder().encode(mutate(envelope, exact));
      let trustCalls = 0;
      const ports = verificationPorts(fixture.ports);
      const result = await verifyReport(
        {
          envelopeBytes: variant,
          subjects: fixture.subjectBytes,
          effectiveTime: EFFECTIVE_TIME,
        },
        {
          ...ports,
          trust: {
            ...ports.trust,
            dsseVerifier: (bytes) => {
              trustCalls += 1;
              return ports.trust.dsseVerifier(bytes);
            },
          },
        },
      );
      expect(result).toEqual({
        ok: false,
        check: "report-envelope",
        detail,
      });
      expect(trustCalls).toBe(0);
    },
  );

  test("exact envelope admission precedes verification-time context validation", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const pretty = new TextEncoder().encode(
      `${JSON.stringify(JSON.parse(new TextDecoder().decode(produced.envelope)), null, 2)}\n`,
    );
    const result = await verifyReport(
      {
        envelopeBytes: pretty,
        subjects: fixture.subjectBytes,
        effectiveTime: "not-a-time",
      },
      verificationPorts(fixture.ports),
    );
    expect(result).toEqual({
      ok: false,
      check: "report-envelope",
      detail: "invalid DSSE envelope: TrustCoreError: DSSE envelope bytes are not the exact producer encoding.",
    });
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
      verificationPorts(fixture.ports, options),
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
      verificationPorts(fixture.ports),
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
      verificationPorts(fixture.ports),
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
      verificationPorts(fixture.ports),
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
      verificationPorts(fixture.ports),
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

  test("noninferiority-iut cross-Benchmark report accepts only its exact shared eligible Task pairing", async () => {
    const fixture = crossVersionPairedFixture(true);
    const produced = await produceReport({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: {
        id: "jinn.benchmarking.method/noninferiority-iut",
        version: "1",
        parameters: { baseline: "armA", candidate: "armB", seed: 1, resamples: 1 },
      },
      verdictRule: "unanimous",
      author: AUTHOR,
    }, signer);
    const perSubject = (produced.record.results as {
      perSubject: Array<{ results: { pairing: { taskDigests: string[] } } }>;
    }).perSubject;
    expect(perSubject).toHaveLength(2);
    expect(perSubject[0]!.results.pairing.taskDigests).toEqual(perSubject[1]!.results.pairing.taskDigests);
    expect(perSubject[0]!.results.pairing.taskDigests).toHaveLength(1);
  });

  test("verification instant is explicit context and invalid input fails before trust resolution", async () => {
    const fixture = makeFixture();
    const produced = await produce(fixture);
    const result = await verifyReport(
      { envelopeBytes: produced.envelope, subjects: fixture.subjectBytes, effectiveTime: "not-time" },
      verificationPorts(fixture.ports),
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

  test("v1 production stays a raw Report payload contract while v2 names payload and record identities", async () => {
    const fixture = makeFixture();
    const legacy = await produce(fixture);
    expect(legacy.record[BENCHMARK_PUBLICATION_EXTENSION]).toBeUndefined();
    expect("reportPayloadSha256" in legacy).toBe(false);

    const publicationFixture = makePublicationFixture({ publicRegistration: "pre-dispatch" });
    const produced = await produceReportV2({
      ...publicationFixture.ports,
      subjects: publicationFixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: publicationFixture.accountingBytes },
    }, signer);

    expect(produced.reportPayloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(produced.reportRecordSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(produced.reportPayloadSha256).toBe(recordDigest(produced.bytes).slice("sha256:".length));
    expect(produced.reportRecordSha256).toBe(recordDigest(produced.envelope).slice("sha256:".length));
    expect(produced.recordKind).toBe(REPORT_V2_RECORD_KIND);
    expect(produced.recordMediaType).toBe(SIGNED_REPORT_MEDIA_TYPE);
  });

  test("v2 verifies the exact envelope, Matrix/accounting publication binding, signature, and method replay", async () => {
    const fixture = makePublicationFixture({ publicRegistration: "pre-dispatch" });
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);

    const result = await verifyReportV2({
      envelopeBytes: produced.envelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      recordKind: produced.recordKind,
      recordMediaType: produced.recordMediaType,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports));
    expect(result).toMatchObject({
      ok: true,
      reportPayloadSha256: produced.reportPayloadSha256,
      reportRecordSha256: produced.reportRecordSha256,
    });
  });

  test("v2 production rejects descriptor-bound accounting whose closeBoundary anchor differs from the Matrix", async () => {
    const fixture = rebindAccountingCloseBoundary(makePublicationFixture(), {
      at: "2026-08-04T00:00:00Z",
      anchor: { chain: "eip155:1", blockNumber: 42, blockHash: `0x${"a".repeat(64)}` },
    });
    let signerCalls = 0;
    await expect(produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, async (request) => {
      signerCalls += 1;
      return signer(request);
    })).rejects.toThrow(/accounting closeBoundary must exactly match the Matrix closeBoundary/);
    expect(signerCalls).toBe(0);
  });

  test("v2 verification rejects a signed Report over descriptor-rebound accounting with a different closeBoundary", async () => {
    const fixture = rebindAccountingCloseBoundary(makePublicationFixture(), {
      at: "2026-08-04T00:00:00Z",
      anchor: { chain: "eip155:1", blockNumber: 42, blockHash: `0x${"b".repeat(64)}` },
    });
    const legacy = await produce(fixture);
    const publicationExtension = {
      publicRegistration: {
        perSubject: fixture.subjectBytes.map((subjectBytes, index) => ({
          subjectSha256: recordDigest(subjectBytes).slice("sha256:".length),
          status: "post-hoc",
          accounting: {
            name: `accounting-${index}`,
            digest: { sha256: recordDigest(fixture.accountingBytes[index]!).slice("sha256:".length) },
          },
          check: { status: "pass" },
        })),
      },
    };
    const forgedPayload = sealReport({
      ...legacy.record,
      [BENCHMARK_PUBLICATION_EXTENSION]: publicationExtension,
    }).bytes;
    const forgedEnvelope = sealDsseEnvelope({
      payloadType: REPORT_MEDIA_TYPE,
      payloadBytes: forgedPayload,
      signatures: [{
        keyid: REPORT_KEY,
        signature: fixtureSignature(dssePreAuthEncoding(REPORT_MEDIA_TYPE, forgedPayload)),
      }],
    });

    const result = await verifyReportV2({
      envelopeBytes: forgedEnvelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      recordKind: REPORT_V2_RECORD_KIND,
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports));
    expect(result).toEqual({
      ok: false,
      check: "publication-disclosure",
      detail: expect.stringContaining("accounting closeBoundary must exactly match the Matrix closeBoundary"),
    });
  });

  test("v2 rejects a tampered publication disclosure even when the tampered payload is correctly signed", async () => {
    const fixture = makePublicationFixture({ publicRegistration: "pre-dispatch" });
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);
    const extension = produced.record[BENCHMARK_PUBLICATION_EXTENSION] as {
      publicRegistration: { perSubject: Array<Record<string, unknown>> };
    };
    const tamperedPayload = sealReport({
      ...produced.record,
      [BENCHMARK_PUBLICATION_EXTENSION]: {
        publicRegistration: {
          perSubject: [{ ...extension.publicRegistration.perSubject[0], status: "post-hoc" }],
        },
      },
    }).bytes;
    const tamperedEnvelope = sealDsseEnvelope({
      payloadType: REPORT_MEDIA_TYPE,
      payloadBytes: tamperedPayload,
      signatures: [{
        keyid: REPORT_KEY,
        signature: fixtureSignature(dssePreAuthEncoding(REPORT_MEDIA_TYPE, tamperedPayload)),
      }],
    });

    const result = await verifyReportV2({
      envelopeBytes: tamperedEnvelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      recordKind: REPORT_V2_RECORD_KIND,
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports));
    expect(result).toMatchObject({ ok: false, check: "publication-disclosure" });
  });

  test.each([
    ["wrong record kind", { recordKind: "https://spec.jinn.network/records/benchmark-report/v1", recordMediaType: SIGNED_REPORT_MEDIA_TYPE }, "recordKind"],
    ["wrong record media type", { recordKind: REPORT_V2_RECORD_KIND, recordMediaType: REPORT_MEDIA_TYPE }, "recordMediaType"],
  ] as const)("v2 rejects %s before report verification", async (_name, metadata, expected) => {
    const fixture = makePublicationFixture();
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);
    const result = await verifyReportV2({
      envelopeBytes: produced.envelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      ...metadata,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports));
    expect(result).toMatchObject({ ok: false, check: "report-record", detail: expect.stringContaining(expected) });
  });

  test("v2 rejects an exact DSSE envelope with a non-Report payload media type", async () => {
    const fixture = makePublicationFixture();
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);
    const wrongMediaEnvelope = sealDsseEnvelope({
      payloadType: "application/json",
      payloadBytes: produced.bytes,
      signatures: [{
        keyid: REPORT_KEY,
        signature: fixtureSignature(dssePreAuthEncoding("application/json", produced.bytes)),
      }],
    });
    const result = await verifyReportV2({
      envelopeBytes: wrongMediaEnvelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      recordKind: REPORT_V2_RECORD_KIND,
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports));
    expect(result).toMatchObject({ ok: false, check: "report-envelope" });
  });

  test("v2 keeps post-hoc public registration independent from analysis preregistration", async () => {
    const fixture = makePublicationFixture({ preregistered: true, publicRegistration: "post-hoc" });
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);
    const extension = produced.record[BENCHMARK_PUBLICATION_EXTENSION] as {
      publicRegistration: { perSubject: Array<{ status: string }> };
    };
    expect(produced.record.preregistered).toBe(true);
    expect(extension.publicRegistration.perSubject[0]!.status).toBe("post-hoc");
    await expect(verifyReportV2({
      envelopeBytes: produced.envelope,
      subjects: fixture.subjectBytes,
      effectiveTime: EFFECTIVE_TIME,
      recordKind: REPORT_V2_RECORD_KIND,
      recordMediaType: SIGNED_REPORT_MEDIA_TYPE,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, verificationPorts(fixture.ports))).resolves.toMatchObject({ ok: true });
    expect(parseBenchmarkAccounting(fixture.accountingBytes[0]!).publicRegistration.status).toBe("post-hoc");
  });

  test("v2 carries an unverifiable public-registration status with its independent check result", async () => {
    const fixture = makePublicationFixture({ publicRegistration: "unverifiable" });
    const produced = await produceReportV2({
      ...fixture.ports,
      subjects: fixture.subjectBytes,
      method: { id: "jinn.benchmarking.method/wilson", version: "1", parameters: {} },
      verdictRule: "unanimous",
      author: AUTHOR,
      publicRegistration: { accountingBytes: fixture.accountingBytes },
    }, signer);
    const extension = produced.record[BENCHMARK_PUBLICATION_EXTENSION] as {
      publicRegistration: { perSubject: Array<{ status: string; check: { status: string } }> };
    };
    expect(extension.publicRegistration.perSubject[0]).toMatchObject({
      status: "unverifiable",
      check: { status: "indeterminate" },
    });
  });

  test("new exact-byte boundaries reject lone surrogates and accept supplementary scalar pairs", async () => {
    const fixture = makeFixture();
    const parsed = parseMatrix(fixture.subjectBytes[0]!);
    expect(() => sealMatrix({ ...parsed, "example.fixture.note": "valid \u{1f680}" })).not.toThrow();
    expect(() => sealMatrix({ ...parsed, "example.fixture.note": "\ud800" })).toThrow();
  });
});
