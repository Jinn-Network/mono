import {
  EVALUATION_SPEC_FORMAT_URI,
  RESULT_EVALUATION_PREDICATE_TYPE,
  canonicalJsonBytes,
  deriveEvaluationTask,
  sealEvaluationSpec,
  type EvaluationSpec,
  type ResultEvaluationStatement,
} from "@jinn-network/task-execution-profiles";
import {
  TASK_EXECUTION_PROTOCOL_URI,
  documentDigest,
  sealDelivery,
  sealSubmission,
  sealTask,
} from "@jinn-network/task-execution-protocol";
import {
  TRUST_KEY_BINDING_FORMAT,
  TRUST_REVOCATION_FORMAT,
  TRUST_REVOCATION_MEDIA_TYPE,
  parseDsseEnvelope,
  sealDsseEnvelope,
  type BindingResolver,
  type DsseChainVerifier,
  type ResolvedBinding,
  type ResolvedRevocation,
  type WitnessVerifier,
} from "@jinn-network/trust-core";
import { describe, expect, test } from "vitest";
import { ADMISSION_RECEIPT_ANNOTATION_URI } from "./evaluation-derive.js";
import {
  ADMISSION_RECEIPT_TRUST_SCOPE,
  decisionGradeVerdictCode,
  gateVerdictObservation,
  type VerdictObservationGateInput,
  type VerdictObservationGatePorts,
} from "./named-checks.js";
import { VerdictCode } from "./venue/verdict-code.js";

const ADMISSION_KEY = "did:key:z6MkAdmissionReceipt1111111111111111111111";
const VERDICT_KEY = "did:key:z6MkVerdictSigner111111111111111111111111";
const SETTLEMENT_KEY = "did:key:z6MkSettlementSafe11111111111111111111111";
const SOLVER_KEY = "did:key:z6MkSolverSafe111111111111111111111111111";
const REQUESTER_KEY = "did:key:z6MkRequesterSigner1111111111111111111111";
const ADMISSION_AGENT = "https://spec.jinn.network/agents/admission-fixture";
const EVALUATOR_AGENT = "https://spec.jinn.network/agents/evaluator-fixture";
const SOLVER_AGENT = "https://spec.jinn.network/agents/solver-fixture";
const REQUESTER_AGENT = "https://spec.jinn.network/agents/requester-fixture";
const SOLVER_ADDRESS = "0x1111111111111111111111111111111111111111";
const EVALUATOR_ADDRESS = "0x2222222222222222222222222222222222222222";
const REQUESTER_VOUCHER =
  "did:pkh:eip155:1:0x0000000000000000000000000000000000000000";
const UNAUTHORIZED_REVOKER =
  "did:pkh:eip155:1:0x3333333333333333333333333333333333333333";
const EVALUATED_AT = "2026-07-29T10:00:00Z";
const CLAIM_BLOCK_TIME = "2026-07-29T10:00:05Z";

const spec: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { uri: "https://spec.jinn.network/graders/fixture" },
  familyBlock: {
    image: { uri: "https://spec.jinn.network/images/fixture" },
    platform: "linux/amd64",
    workspace: { root: "/workspace" },
    testMaterial: [],
    parser: {
      id: "jinn.parser.fixture",
      version: "1.0.0",
      digest: `sha256:${"9".repeat(64)}`,
    },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 60,
  },
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: { threshold: { measurement: "passed", op: "eq", value: true } },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
};

function signedEnvelope(payloadBytes: Uint8Array, keyid: string): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid }],
  });
}

function resolvedBinding(
  key: string,
  agent: string,
  scope: string[],
  relationship: "controls" | "signs-for" = "controls",
  revocations: readonly ResolvedRevocation[] = [],
): ResolvedBinding {
  return {
    envelopeBytes: new TextEncoder().encode("fixture-binding"),
    bindingDigest: `sha256:${"8".repeat(64)}`,
    effectiveStart: "2026-01-01T00:00:00Z",
    isGenesis: true,
    revocations,
    binding: {
      protocol: TRUST_KEY_BINDING_FORMAT,
      agent,
      key: { publicKey: key, keyid: key, algorithm: "ed25519", didKey: key },
      voucher: {
        kind: "account",
        did: REQUESTER_VOUCHER,
        contractAccount: false,
      },
      relationship,
      scope,
      validFrom: "2026-01-01T00:00:00Z",
      ceremony: { type: "oidc-machine", digest: `sha256:${"7".repeat(64)}` },
      strength: "strong",
      anchors: [],
    },
  };
}

function revocationEntry(
  revokedBy: string,
  effectiveTime: string,
): ResolvedRevocation {
  const revocation = {
    protocol: TRUST_REVOCATION_FORMAT,
    target: `sha256:${"8".repeat(64)}` as const,
    revokedBy,
    effectiveFrom: effectiveTime,
    anchors: [],
  };
  return {
    revocation,
    envelopeBytes: sealDsseEnvelope({
      payloadBytes: canonicalJsonBytes(revocation),
      payloadType: TRUST_REVOCATION_MEDIA_TYPE,
      signatures: [{
        signature: new Uint8Array([1, 2, 3]),
        keyid: revokedBy,
      }],
    }),
    effectiveTime,
  };
}

function makePorts(
  omittedKey?: string,
  solverAgent: string = SOLVER_AGENT,
  requesterRevocations: readonly ResolvedRevocation[] = [],
): VerdictObservationGatePorts {
  const entries = [
    { key: ADMISSION_KEY, agent: ADMISSION_AGENT, binding: resolvedBinding(ADMISSION_KEY, ADMISSION_AGENT, [ADMISSION_RECEIPT_TRUST_SCOPE]) },
    { key: VERDICT_KEY, agent: EVALUATOR_AGENT, binding: resolvedBinding(VERDICT_KEY, EVALUATOR_AGENT, ["verdicts"]) },
    { key: SETTLEMENT_KEY, agent: EVALUATOR_AGENT, binding: resolvedBinding(SETTLEMENT_KEY, EVALUATOR_AGENT, ["settlements"]) },
    { key: SOLVER_KEY, agent: solverAgent, binding: resolvedBinding(SOLVER_KEY, solverAgent, ["deliveries"]) },
    {
      key: REQUESTER_KEY,
      agent: REQUESTER_AGENT,
      binding: resolvedBinding(
        REQUESTER_KEY,
        REQUESTER_AGENT,
        ["authorizations"],
        "controls",
        requesterRevocations,
      ),
    },
  ].filter((entry) => entry.key !== omittedKey);
  const bindingResolver: BindingResolver = {
    async resolveBinding(query, atTime) {
      if (atTime < "2026-01-01T00:00:00Z") return null;
      return entries.find((entry) => entry.key === query.key && entry.agent === query.agent)?.binding ?? null;
    },
  };
  const dsseVerifier: DsseChainVerifier = (bytes) => ({
    validSignerKeyids: parseDsseEnvelope(bytes).signatures
      .map((signature) => signature.keyid)
      .filter((keyid): keyid is string => keyid !== undefined),
  });
  const witnessVerifier: WitnessVerifier = {
    async verify1271Witness() {
      return { verified: true };
    },
  };
  return {
    bindingResolver,
    dsseVerifier,
    witnessVerifier,
    admissionAgentPolicy: {
      accepted: [ADMISSION_AGENT],
      requiredStrength: "strong",
    },
    evaluatorPolicy: {
      accepted: [EVALUATOR_AGENT],
      requiredStrength: "strong",
    },
  };
}

function makeStatement(
  input: {
    verdict?: "pass" | "fail" | "inconclusive";
    evaluatedAt?: string;
    evaluator?: string;
    measurements?: { name: string; value: string | number | boolean | null }[];
  } = {},
): Record<string, unknown> {
  const sealedSpec = sealEvaluationSpec(spec);
  const statement: ResultEvaluationStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: input.evaluatedAt ?? EVALUATED_AT,
      evaluator: { id: input.evaluator ?? EVALUATOR_AGENT },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: sealedSpec.digest.slice("sha256:".length) },
      },
      taskSubject: "",
      resultSubjects: [],
      verdict: input.verdict ?? "pass",
      measurements: input.measurements ?? [{ name: "passed", value: true }],
    },
  };
  return statement as unknown as Record<string, unknown>;
}

function makeFixture(
  options: { readonly respellReceipt?: (bytes: Uint8Array) => Uint8Array } = {},
): {
  input: VerdictObservationGateInput;
  statement: Record<string, unknown>;
} {
  const sealedSpec = sealEvaluationSpec(spec);
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "6".repeat(64) },
    },
    instructions: "Solve the fixture.",
    outputs: [{ name: "result.txt", mediaType: "text/plain", required: true }],
    evaluation: {
      name: "evaluation-spec.json",
      digest: { sha256: sealedSpec.digest.slice("sha256:".length) },
    },
  });
  const task = {
    name: "task.json",
    digest: documentDigest(taskBytes),
    bytes: taskBytes,
  };
  const resultBytes = new TextEncoder().encode("fixture result\n");
  const result = {
    name: "result.txt",
    digest: documentDigest(resultBytes),
    bytes: resultBytes,
  };
  const deliveryBytes = sealDelivery({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    attempt: "urn:uuid:40000000-0000-4000-8000-000000000004",
    task: task.digest,
    outputs: [{
      name: result.name,
      digest: { sha256: result.digest.slice("sha256:".length) },
    }],
    outcome: "fulfilled",
    createdAt: "2026-07-29T09:55:00Z",
  });
  const delivery = {
    name: "delivery.json",
    digest: documentDigest(deliveryBytes),
    bytes: deliveryBytes,
  };

  const admissionStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [
      { name: task.name, digest: { sha256: task.digest.slice("sha256:".length) } },
      { name: "evaluation-spec.json", digest: { sha256: sealedSpec.digest.slice("sha256:".length) } },
    ],
    predicateType: "https://spec.jinn.network/attestations/admission-receipt/v1",
    predicate: { issuer: ADMISSION_AGENT },
  };
  const canonicalReceiptEnvelopeBytes = signedEnvelope(
    canonicalJsonBytes(admissionStatement),
    ADMISSION_KEY,
  );
  // Producer drift is SELF-CONSISTENT: the descriptor below binds whatever bytes come out of
  // here, so a re-spelled receipt still satisfies the carried-digest check and still carries a
  // valid signature. The encoding gate is then the only check that can catch it -- which is
  // precisely the defect-#34 shape, and why a digest-only test would prove nothing here.
  const receiptEnvelopeBytes =
    options.respellReceipt?.(canonicalReceiptEnvelopeBytes) ?? canonicalReceiptEnvelopeBytes;
  const receiptDescriptor = {
    name: "admission-receipt",
    digest: { sha256: documentDigest(receiptEnvelopeBytes).slice("sha256:".length) },
    uri: "ipfs://bafy-admission-fixture",
    mediaType: "application/vnd.in-toto+json",
  };
  const subjectSubmissionBytes = sealSubmission({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    submission: "urn:uuid:50000000-0000-4000-8000-000000000005",
    task: {
      name: task.name,
      digest: { sha256: task.digest.slice("sha256:".length) },
    },
    requester: REQUESTER_AGENT,
    idempotencyKey: "subject-fixture",
    nonce: "subject-nonce",
    deadline: "2026-07-30T00:00:00Z",
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: receiptDescriptor,
    },
  });
  const evaluationTask = deriveEvaluationTask({
    subjectTask: task,
    subjectDelivery: delivery,
    subjectResults: [result],
    evaluationSpecDigest: sealedSpec.digest,
    admissionReceipt: receiptDescriptor,
  });

  const statement = makeStatement();
  statement.subject = [
    { name: task.name, digest: { sha256: task.digest.slice("sha256:".length) } },
    { name: result.name, digest: { sha256: result.digest.slice("sha256:".length) } },
  ];
  const predicate = statement.predicate as Record<string, unknown>;
  predicate.taskSubject = task.name;
  predicate.resultSubjects = [result.name];
  const verdictEnvelopeBytes = signedEnvelope(canonicalJsonBytes(statement), VERDICT_KEY);

  return {
    statement,
    input: {
      settlement: {
        subjectTask: task,
        subjectDelivery: delivery,
        subjectResults: [result],
        subjectSubmissionBytes,
        evaluationSpecBytes: sealedSpec.bytes,
        evaluationTaskBytes: evaluationTask.bytes,
      },
      admissionReceipt: {
        envelopeBytes: receiptEnvelopeBytes,
        signerKey: ADMISSION_KEY,
        effectiveTime: "2026-07-29T09:00:00Z",
      },
      verdict: {
        envelopeBytes: verdictEnvelopeBytes,
        signerKey: VERDICT_KEY,
        settlementDeclarationKey: SETTLEMENT_KEY,
        claimBlockTime: CLAIM_BLOCK_TIME,
        onChainVerdictCode: VerdictCode.Pass,
        solver: {
          address: SOLVER_ADDRESS,
          claimedAgent: SOLVER_AGENT,
          declarationKey: SOLVER_KEY,
          effectiveTime: "2026-07-29T09:50:00Z",
        },
        evaluatorAddress: EVALUATOR_ADDRESS,
      },
      requesterAuthentication: {
        envelopeBytes: sealDsseEnvelope({
          payloadBytes: subjectSubmissionBytes,
          payloadType: "application/vnd.jinn.task-execution.submission.v1+json",
          signatures: [{ signature: new Uint8Array([1, 2, 3]), keyid: REQUESTER_KEY }],
        }),
        signerKey: REQUESTER_KEY,
        sealingTime: "2026-07-29T08:00:00Z",
      },
    },
  };
}

function withStatement(
  fixture: ReturnType<typeof makeFixture>,
  mutate: (statement: Record<string, unknown>) => void,
): VerdictObservationGateInput {
  const statement = structuredClone(fixture.statement);
  mutate(statement);
  return {
    ...fixture.input,
    verdict: {
      ...fixture.input.verdict,
      envelopeBytes: signedEnvelope(canonicalJsonBytes(statement), VERDICT_KEY),
    },
  };
}

/**
 * Re-spells an envelope in the exact defect-#34 encoding: structurally identical, emitted by
 * plain `JSON.stringify` in `payloadType, payload, signatures` insertion order instead of the
 * sole producer's code-unit-sorted compact JCS bytes. Signatures stay valid; only the envelope's
 * own byte encoding differs.
 */
function nonCanonicalSpelling(envelopeBytes: Uint8Array): Uint8Array {
  const envelope = JSON.parse(new TextDecoder().decode(envelopeBytes)) as {
    payloadType: string;
    payload: string;
    signatures: unknown[];
  };
  return new TextEncoder().encode(JSON.stringify({
    payloadType: envelope.payloadType,
    payload: envelope.payload,
    signatures: envelope.signatures,
  }));
}

describe("gateVerdictObservation (§6.4, §7.5a/§7.5b)", () => {
  test("maps only the conforming Result Evaluation vocabulary with no Invalid default (§7.41)", () => {
    expect(decisionGradeVerdictCode("pass")).toBe(VerdictCode.Pass);
    expect(decisionGradeVerdictCode("fail")).toBe(VerdictCode.Fail);
    expect(decisionGradeVerdictCode("inconclusive")).toBe(VerdictCode.Unresolved);
    expect(() => decisionGradeVerdictCode("invalid")).toThrow(/conforming Result Evaluation/);
    expect(() => decisionGradeVerdictCode(undefined)).toThrow(/conforming Result Evaluation/);
  });

  test("accepts a fully pair-fixed, authenticated, consistent verdict as decision-grade", async () => {
    const fixture = makeFixture();
    await expect(gateVerdictObservation(fixture.input, makePorts())).resolves.toEqual({
      decisionGrade: true,
      failures: [],
    });
  });

  test("fails exact derivation when the actual evaluation Task is not the settlement-authorized pair", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      settlement: {
        ...fixture.input.settlement,
        evaluationTaskBytes: new TextEncoder().encode("{}"),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "derivation-byte-equality", detail: expect.any(String) }],
    });
  });

  test("fails an admission receipt whose exact envelope digest is not the carried descriptor", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      admissionReceipt: {
        ...fixture.input.admissionReceipt,
        envelopeBytes: signedEnvelope(
          canonicalJsonBytes({ different: "receipt" }),
          ADMISSION_KEY,
        ),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "admission-receipt", detail: expect.any(String) }],
    });
  });

  // The last loose read on this gate (residual named in the previous PR). Unlike the two above,
  // this one is not a `parseDsseEnvelope` swap -- it parsed via a Zod envelope SHAPE, which
  // accepts any JSON spelling. The receipt here is fully self-consistent: carried digest matches,
  // signature valid, only the encoding differs, so nothing but an encoding gate can refuse it.
  test("refuses a self-consistent admission receipt that is not the exact producer encoding", async () => {
    const fixture = makeFixture({ respellReceipt: nonCanonicalSpelling });
    expect(await gateVerdictObservation(fixture.input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{
        check: "admission-receipt",
        detail: expect.stringContaining("exact producer encoding") as unknown as string,
      }],
    });
  });

  test("fails an admission receipt whose signer has no admission-agent binding", async () => {
    const fixture = makeFixture();
    expect(await gateVerdictObservation(fixture.input, makePorts(ADMISSION_KEY))).toEqual({
      decisionGrade: false,
      failures: [{ check: "admission-receipt", detail: expect.any(String) }],
    });
  });

  // Defect-#34 class. This gate's structural verdict parse was loose, so its ONLY encoding
  // guarantee came from whichever `dsseVerifier` the composition happened to inject -- a gate
  // that owns a fail-closed decision must not depend on a port for that. `makePorts`'s verifier
  // is deliberately loose (it accepts any structurally-parseable envelope), so before this check
  // the gate granted full decision-grade to bytes the real strict verifier refuses.
  test("refuses a validly-signed verdict envelope that is not the exact producer encoding", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        envelopeBytes: nonCanonicalSpelling(fixture.input.verdict.envelopeBytes),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-envelope", detail: expect.any(String) }],
    });
  });

  test("fails a delivered verdict that disagrees with the declared rule", async () => {
    const fixture = makeFixture();
    const inconsistent = withStatement(fixture, (statement) => {
      (statement.predicate as Record<string, unknown>).verdict = "fail";
    });
    const input = {
      ...inconsistent,
      verdict: {
        ...inconsistent.verdict,
        onChainVerdictCode: VerdictCode.Fail,
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-consistency", detail: expect.any(String) }],
    });
  });

  test("rejects evaluator == solver while not treating solve self-claims as this check", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        evaluatorAddress: SOLVER_ADDRESS.toUpperCase(),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "evaluator-distinctness", detail: expect.any(String) }],
    });
  });

  test("rejects distinct addresses that resolve to the same Agent IRI", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        solver: {
          ...fixture.input.verdict.solver,
          claimedAgent: EVALUATOR_AGENT,
        },
      },
    };
    expect(await gateVerdictObservation(
      input,
      makePorts(undefined, EVALUATOR_AGENT),
    )).toEqual({
      decisionGrade: false,
      failures: [{ check: "evaluator-distinctness", detail: expect.any(String) }],
    });
  });

  test("accepts distinct addresses bound to distinct Agent IRIs", async () => {
    const fixture = makeFixture();
    await expect(gateVerdictObservation(fixture.input, makePorts())).resolves.toEqual({
      decisionGrade: true,
      failures: [],
    });
  });

  test("fails closed for an invented, unbound solver Agent IRI", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        solver: {
          ...fixture.input.verdict.solver,
          claimedAgent: "https://spec.jinn.network/agents/invented-solver",
        },
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "evaluator-distinctness", detail: expect.any(String) }],
    });
  });

  test("fails closed when the settlement declaration does not join to the evaluator", async () => {
    const fixture = makeFixture();
    expect(await gateVerdictObservation(fixture.input, makePorts(SETTLEMENT_KEY))).toEqual({
      decisionGrade: false,
      failures: [{ check: "settlement-join", detail: expect.any(String) }],
    });
  });

  test("fails closed when the verdict signer has no evaluator binding", async () => {
    const fixture = makeFixture();
    expect(await gateVerdictObservation(fixture.input, makePorts(VERDICT_KEY))).toEqual({
      decisionGrade: false,
      failures: [{ check: "settlement-join", detail: expect.any(String) }],
    });
  });

  test("fails requester authentication when the signed Submission key is not bound", async () => {
    const fixture = makeFixture();
    expect(await gateVerdictObservation(fixture.input, makePorts(REQUESTER_KEY))).toEqual({
      decisionGrade: false,
      failures: [{ check: "requester-authentication", detail: expect.any(String) }],
    });
  });

  test("rejects a requester binding revoked before the Submission sealing time", async () => {
    const fixture = makeFixture();
    const ports = makePorts(
      undefined,
      SOLVER_AGENT,
      [revocationEntry(REQUESTER_VOUCHER, "2026-07-29T07:00:00Z")],
    );

    expect(await gateVerdictObservation(fixture.input, ports)).toEqual({
      decisionGrade: false,
      failures: [{
        check: "requester-authentication",
        detail: expect.stringContaining("revoked effective"),
      }],
    });
  });

  test("rejects a requester binding revoked exactly at the Submission sealing time", async () => {
    const fixture = makeFixture();
    const sealingTime = fixture.input.requesterAuthentication.sealingTime;
    const ports = makePorts(
      undefined,
      SOLVER_AGENT,
      [revocationEntry(REQUESTER_VOUCHER, sealingTime)],
    );

    expect(await gateVerdictObservation(fixture.input, ports)).toEqual({
      decisionGrade: false,
      failures: [{
        check: "requester-authentication",
        detail: expect.stringContaining(`revoked effective "${sealingTime}"`),
      }],
    });
  });

  test("accepts a requester binding revoked after the Submission sealing time", async () => {
    const fixture = makeFixture();
    const ports = makePorts(
      undefined,
      SOLVER_AGENT,
      [revocationEntry(REQUESTER_VOUCHER, "2026-07-29T09:00:00Z")],
    );

    await expect(gateVerdictObservation(fixture.input, ports)).resolves.toEqual({
      decisionGrade: true,
      failures: [],
    });
  });

  test("ignores a requester revocation issued by an unauthorized revoker", async () => {
    const fixture = makeFixture();
    const ports = makePorts(
      undefined,
      SOLVER_AGENT,
      [revocationEntry(UNAUTHORIZED_REVOKER, "2026-07-29T07:00:00Z")],
    );

    await expect(gateVerdictObservation(fixture.input, ports)).resolves.toEqual({
      decisionGrade: true,
      failures: [],
    });
  });

  test("fails requester authentication when the DSSE payload type is not Submission", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      requesterAuthentication: {
        ...fixture.input.requesterAuthentication,
        envelopeBytes: signedEnvelope(
          fixture.input.settlement.subjectSubmissionBytes,
          REQUESTER_KEY,
        ),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "requester-authentication", detail: expect.any(String) }],
    });
  });

  // Same encoding floor as the verdict envelope above -- the requester Submission envelope is
  // sealed by the sole canonical producer (`native-requester`'s `sealDsseEnvelope`), so an
  // alternate spelling is never legitimate here either.
  test("refuses a validly-signed requester envelope that is not the exact producer encoding", async () => {
    const fixture = makeFixture();
    const input = {
      ...fixture.input,
      requesterAuthentication: {
        ...fixture.input.requesterAuthentication,
        envelopeBytes: nonCanonicalSpelling(fixture.input.requesterAuthentication.envelopeBytes),
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "requester-authentication", detail: expect.any(String) }],
    });
  });

  test("refuses a future-dated verdict relative to the canonical claim block", async () => {
    const fixture = makeFixture();
    const input = withStatement(fixture, (statement) => {
      (statement.predicate as Record<string, unknown>).evaluatedAt =
        "2026-07-29T10:00:06Z";
    });
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-effective-time", detail: expect.any(String) }],
    });
  });

  test("refuses a verdict future-dated by a sub-millisecond fraction", async () => {
    const fixture = makeFixture();
    const future = withStatement(fixture, (statement) => {
      (statement.predicate as Record<string, unknown>).evaluatedAt =
        "2026-07-29T10:00:00.0002Z";
    });
    const input = {
      ...future,
      verdict: {
        ...future.verdict,
        claimBlockTime: "2026-07-29T10:00:00.0001Z",
      },
    };
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-effective-time", detail: expect.any(String) }],
    });
  });

  test("accepts equal instants written with different offsets and fractional precision", async () => {
    const fixture = makeFixture();
    const equal = withStatement(fixture, (statement) => {
      (statement.predicate as Record<string, unknown>).evaluatedAt =
        "2026-07-29T10:00:00.1Z";
    });
    const input = {
      ...equal,
      verdict: {
        ...equal.verdict,
        claimBlockTime: "2026-07-29T11:00:00.1000+01:00",
      },
    };
    await expect(gateVerdictObservation(input, makePorts())).resolves.toEqual({
      decisionGrade: true,
      failures: [],
    });
  });

  test("refuses a Statement with no verdict rather than defaulting to Invalid", async () => {
    const fixture = makeFixture();
    const input = withStatement(fixture, (statement) => {
      delete (statement.predicate as Record<string, unknown>).verdict;
    });
    expect(await gateVerdictObservation(input, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-correspondence", detail: expect.any(String) }],
    });
  });

  test("refuses on-chain code disagreement, including Invalid with no conforming wire counterpart", async () => {
    const fixture = makeFixture();
    const mismatched = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        onChainVerdictCode: VerdictCode.Fail,
      },
    };
    expect(await gateVerdictObservation(mismatched, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-correspondence", detail: expect.any(String) }],
    });

    const invalid = {
      ...fixture.input,
      verdict: {
        ...fixture.input.verdict,
        onChainVerdictCode: VerdictCode.Invalid,
      },
    };
    expect(await gateVerdictObservation(invalid, makePorts())).toEqual({
      decisionGrade: false,
      failures: [{ check: "verdict-correspondence", detail: expect.any(String) }],
    });
  });

  test.each([
    {
      name: "admission receipt verification",
      throwingKey: ADMISSION_KEY,
      expectedCheck: "admission-receipt",
    },
    {
      name: "requester authentication",
      throwingKey: REQUESTER_KEY,
      expectedCheck: "requester-authentication",
    },
    {
      name: "solver declaration resolution",
      throwingKey: SOLVER_KEY,
      expectedCheck: "evaluator-distinctness",
    },
    {
      name: "verdict envelope binding",
      throwingKey: VERDICT_KEY,
      expectedCheck: "settlement-join",
    },
    {
      name: "settlement declaration join",
      throwingKey: SETTLEMENT_KEY,
      expectedCheck: "settlement-join",
    },
  ])("turns a thrown $name dependency into a named refusal", async ({
    throwingKey,
    expectedCheck,
  }) => {
    const fixture = makeFixture();
    const base = makePorts();
    const ports: VerdictObservationGatePorts = {
      ...base,
      bindingResolver: {
        async resolveBinding(query, atTime) {
          if (query.key === throwingKey) {
            throw new Error(`fixture resolver failure for ${throwingKey}`);
          }
          return base.bindingResolver.resolveBinding(query, atTime);
        },
      },
    };

    await expect(gateVerdictObservation(fixture.input, ports)).resolves.toEqual({
      decisionGrade: false,
      failures: [{
        check: expectedCheck,
        detail: expect.stringContaining(`fixture resolver failure for ${throwingKey}`),
      }],
    });
  });
});
