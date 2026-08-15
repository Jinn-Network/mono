// SPDX-License-Identifier: MIT

import {
  ADMISSION_RECEIPT_ANNOTATION_URI,
  ADMISSION_RECEIPT_TRUST_SCOPE,
  VerdictCode,
  type VerdictObservationGate,
  type VerdictObservationGateInput,
  type VerdictObservationGatePorts,
} from "@jinn-network/marketplace-binding";
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
  sealDsseEnvelope,
  type ResolvedBinding,
} from "@jinn-network/trust-core";
import {
  buildRevocationFixture,
  buildResolvedBindingFixture,
  createFakeResolvers,
  resolvedRevocation,
  testAgentIri,
  testDidKey,
} from "@jinn-network/trust-testing";
import { describe, expect, test } from "vitest";

const ADMISSION_KEY = testDidKey("marketplace-admission-key");
const VERDICT_KEY = testDidKey("marketplace-verdict-key");
const SETTLEMENT_KEY = testDidKey("marketplace-settlement-key");
const SOLVER_KEY = testDidKey("marketplace-solver-key");
const REQUESTER_KEY = testDidKey("marketplace-requester-key");
const REQUESTER_REVOCATION_KEY = testDidKey(
  "marketplace-requester-revocation-key",
);
const UNAUTHORIZED_REVOCATION_KEY = testDidKey(
  "marketplace-unauthorized-revocation-key",
);
const ADMISSION_AGENT = testAgentIri("marketplace-admission");
const EVALUATOR_AGENT = testAgentIri("marketplace-evaluator");
const SOLVER_AGENT = testAgentIri("marketplace-solver");
const REQUESTER_AGENT = testAgentIri("marketplace-requester");
const OTHER_AGENT = testAgentIri("marketplace-other");
const REQUESTER_SAFE = "0x1111111111111111111111111111111111111111";
const EVALUATOR_SAFE = "0x2222222222222222222222222222222222222222";
const EVALUATED_AT = "2026-07-29T10:00:00Z";
const CLAIM_BLOCK_TIME = "2026-07-29T10:00:05Z";
const OIDC_VOUCHER = {
  kind: "oidc-machine",
  subject: "repo:jinn-network/mono:ref:refs/heads/main",
} as const;

const evaluationSpec: EvaluationSpec = {
  protocol: EVALUATION_SPEC_FORMAT_URI,
  semanticsVersion: "4",
  family: "deterministic-process",
  grader: { uri: "https://spec.jinn.network/graders/marketplace-conformance" },
  familyBlock: {
    image: { uri: "https://spec.jinn.network/images/marketplace-conformance" },
    platform: "linux/amd64",
    workspace: { root: "/workspace" },
    testMaterial: [],
    parser: {
      id: "jinn.parser.marketplace-conformance",
      version: "1.0.0",
      digest: `sha256:${"9".repeat(64)}`,
    },
    transitions: { failToPass: [], passToPass: [] },
    timeout: 60,
  },
  measurements: [{ name: "passed", type: "boolean", required: true }],
  verdictRule: {
    threshold: { measurement: "passed", op: "eq", value: true },
  },
  unscorable: [],
  evidenceConventions: { requiredRefs: [] },
};

export type NamedCheckSubject = (
  input: VerdictObservationGateInput,
  ports: VerdictObservationGatePorts,
) => Promise<VerdictObservationGate>;

export interface NamedCheckTrustFixture {
  readonly admission: ResolvedBinding;
  readonly requester: ResolvedBinding;
  readonly verdict: ResolvedBinding;
  readonly settlement: ResolvedBinding;
  readonly solver: ResolvedBinding;
}

export interface NamedCheckFixture {
  readonly input: VerdictObservationGateInput;
  readonly ports: VerdictObservationGatePorts;
  readonly statement: Record<string, unknown>;
  readonly trust: NamedCheckTrustFixture;
}

export interface BuildNamedCheckFixtureOptions {
  /** Registers the settlement leg under another Agent IRI to model a failed trust join. */
  readonly settlementAgent?: string;
  readonly requesterRevocation?: {
    readonly effectiveTime: string;
    readonly authorized: boolean;
  };
}

function signedEnvelope(payloadBytes: Uint8Array, keyid: string): Uint8Array {
  return sealDsseEnvelope({
    payloadBytes,
    payloadType: "application/vnd.in-toto+json",
    signatures: [{
      signature: new Uint8Array([1, 2, 3]),
      keyid,
    }],
  });
}

function makeStatement(): Record<string, unknown> {
  const sealedSpec = sealEvaluationSpec(evaluationSpec);
  const statement: ResultEvaluationStatement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [],
    predicateType: RESULT_EVALUATION_PREDICATE_TYPE,
    predicate: {
      evaluatedAt: EVALUATED_AT,
      evaluator: { id: EVALUATOR_AGENT },
      evaluationSpecification: {
        name: "evaluation-spec.json",
        digest: { sha256: sealedSpec.digest.slice("sha256:".length) },
      },
      taskSubject: "",
      resultSubjects: [],
      verdict: "pass",
      measurements: [{ name: "passed", value: true }],
    },
  };
  return statement as unknown as Record<string, unknown>;
}

async function registerBinding(
  fakes: ReturnType<typeof createFakeResolvers>,
  input: {
    readonly key: string;
    readonly agent: string;
    readonly scope: readonly string[];
  },
): Promise<ResolvedBinding> {
  const fixture = await buildResolvedBindingFixture({
    agent: input.agent,
    workingKeyDidKey: input.key,
    ceremonyType: "oidc-machine",
    voucher: OIDC_VOUCHER,
    relationship: "controls",
    scope: input.scope,
  });
  fakes.registerBinding({
    key: input.key,
    agent: input.agent,
    resolved: fixture.resolved,
    validFrom: fixture.binding.validFrom,
  });
  return fixture.resolved;
}

export async function buildNamedCheckFixture(
  options: BuildNamedCheckFixtureOptions = {},
): Promise<NamedCheckFixture> {
  const sealedSpec = sealEvaluationSpec(evaluationSpec);
  const taskBytes = sealTask({
    protocol: TASK_EXECUTION_PROTOCOL_URI,
    profile: {
      uri: "https://spec.jinn.network/task-profiles/repository-work/1.0",
      digest: { sha256: "6".repeat(64) },
    },
    instructions: "Solve the marketplace conformance fixture.",
    outputs: [{
      name: "result.txt",
      mediaType: "text/plain",
      required: true,
    }],
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
  const resultBytes = new TextEncoder().encode("marketplace conformance result\n");
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
      {
        name: task.name,
        digest: { sha256: task.digest.slice("sha256:".length) },
      },
      {
        name: "evaluation-spec.json",
        digest: { sha256: sealedSpec.digest.slice("sha256:".length) },
      },
    ],
    predicateType: "https://spec.jinn.network/attestations/admission-receipt/v1",
    predicate: { issuer: ADMISSION_AGENT },
  };
  const receiptEnvelopeBytes = signedEnvelope(
    canonicalJsonBytes(admissionStatement),
    ADMISSION_KEY,
  );
  const receiptDescriptor = {
    name: "admission-receipt",
    digest: {
      sha256: documentDigest(receiptEnvelopeBytes).slice("sha256:".length),
    },
    uri: "ipfs://bafy-marketplace-admission-conformance",
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
    idempotencyKey: "marketplace-subject-conformance",
    nonce: "marketplace-subject-nonce",
    deadline: "2026-07-30T00:00:00Z",
    annotations: {
      [ADMISSION_RECEIPT_ANNOTATION_URI]: receiptDescriptor,
    },
  });
  const derivedEvaluationTask = deriveEvaluationTask({
    subjectTask: task,
    subjectDelivery: delivery,
    subjectResults: [result],
    evaluationSpecDigest: sealedSpec.digest,
    admissionReceipt: receiptDescriptor,
  });

  const statement = makeStatement();
  statement.subject = [
    {
      name: task.name,
      digest: { sha256: task.digest.slice("sha256:".length) },
    },
    {
      name: result.name,
      digest: { sha256: result.digest.slice("sha256:".length) },
    },
  ];
  const predicate = statement.predicate as Record<string, unknown>;
  predicate.taskSubject = task.name;
  predicate.resultSubjects = [result.name];

  const fakes = createFakeResolvers();
  const settlementAgent = options.settlementAgent ?? EVALUATOR_AGENT;
  let requester = await registerBinding(fakes, {
    key: REQUESTER_KEY,
    agent: REQUESTER_AGENT,
    scope: ["authorizations"],
  });
  if (options.requesterRevocation !== undefined) {
    const revokedBy = options.requesterRevocation.authorized
      ? REQUESTER_REVOCATION_KEY
      : UNAUTHORIZED_REVOCATION_KEY;
    if (options.requesterRevocation.authorized) {
      await registerBinding(fakes, {
        key: revokedBy,
        agent: REQUESTER_AGENT,
        scope: ["bindings"],
      });
    }
    const revocation = await buildRevocationFixture({
      target: requester.bindingDigest,
      revokedBy,
      effectiveFrom: options.requesterRevocation.effectiveTime,
    });
    requester = {
      ...requester,
      revocations: [
        resolvedRevocation(
          revocation,
          options.requesterRevocation.effectiveTime,
        ),
      ],
    };
    fakes.registerBinding({
      key: REQUESTER_KEY,
      agent: REQUESTER_AGENT,
      resolved: requester,
      validFrom: requester.binding.validFrom,
    });
  }
  const trust = {
    admission: await registerBinding(fakes, {
      key: ADMISSION_KEY,
      agent: ADMISSION_AGENT,
      scope: [ADMISSION_RECEIPT_TRUST_SCOPE],
    }),
    requester,
    verdict: await registerBinding(fakes, {
      key: VERDICT_KEY,
      agent: EVALUATOR_AGENT,
      scope: ["verdicts"],
    }),
    settlement: await registerBinding(fakes, {
      key: SETTLEMENT_KEY,
      agent: settlementAgent,
      scope: ["settlements"],
    }),
    solver: await registerBinding(fakes, {
      key: SOLVER_KEY,
      agent: SOLVER_AGENT,
      scope: ["deliveries"],
    }),
  };

  const input: VerdictObservationGateInput = {
    settlement: {
      subjectTask: task,
      subjectDelivery: delivery,
      subjectResults: [result],
      subjectSubmissionBytes,
      evaluationSpecBytes: sealedSpec.bytes,
      evaluationTaskBytes: derivedEvaluationTask.bytes,
    },
    admissionReceipt: {
      envelopeBytes: receiptEnvelopeBytes,
      signerKey: ADMISSION_KEY,
      effectiveTime: "2026-07-29T09:00:00Z",
    },
    verdict: {
      envelopeBytes: signedEnvelope(canonicalJsonBytes(statement), VERDICT_KEY),
      signerKey: VERDICT_KEY,
      settlementDeclarationKey: SETTLEMENT_KEY,
      claimBlockTime: CLAIM_BLOCK_TIME,
      onChainVerdictCode: VerdictCode.Pass,
      solver: {
        address: REQUESTER_SAFE,
        claimedAgent: SOLVER_AGENT,
        declarationKey: SOLVER_KEY,
        effectiveTime: "2026-07-29T09:50:00Z",
      },
      evaluatorAddress: EVALUATOR_SAFE,
    },
    requesterAuthentication: {
      envelopeBytes: sealDsseEnvelope({
        payloadBytes: subjectSubmissionBytes,
        payloadType: "application/vnd.jinn.task-execution.submission.v1+json",
        signatures: [{
          signature: new Uint8Array([1, 2, 3]),
          keyid: REQUESTER_KEY,
        }],
      }),
      signerKey: REQUESTER_KEY,
      sealingTime: "2026-07-29T08:00:00Z",
    },
  };
  const ports: VerdictObservationGatePorts = {
    bindingResolver: fakes.bindingResolver,
    witnessVerifier: fakes.witnessVerifier,
    dsseVerifier: fakes.dsseVerifier,
    admissionAgentPolicy: {
      accepted: [ADMISSION_AGENT],
      requiredStrength: "strong",
    },
    evaluatorPolicy: {
      accepted: [EVALUATOR_AGENT],
      requiredStrength: "strong",
    },
  };
  return { input, ports, statement, trust };
}

export function withNamedCheckStatement(
  fixture: NamedCheckFixture,
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

export function describeNamedChecks(subject: NamedCheckSubject): void {
  describe("marketplace named-check and evaluation conformance (§6.4, §13)", () => {
    test("accepts the exact pair-derived evaluation leg against sealed trust fixtures", async () => {
      const fixture = await buildNamedCheckFixture();
      expect(fixture.trust.admission.envelopeBytes.length).toBeGreaterThan(0);
      expect(fixture.trust.admission.binding.scope).toContain(
        ADMISSION_RECEIPT_TRUST_SCOPE,
      );
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: true,
        failures: [],
      });
    });

    test("refuses an evaluation Task mutated after pair derivation", async () => {
      const fixture = await buildNamedCheckFixture();
      const input = {
        ...fixture.input,
        settlement: {
          ...fixture.input.settlement,
          evaluationTaskBytes: new TextEncoder().encode("{}"),
        },
      };
      await expect(subject(input, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "derivation-byte-equality",
          detail: expect.any(String),
        }],
      });
    });

    test("refuses missing and mismatched verdict mappings without an Invalid default", async () => {
      const fixture = await buildNamedCheckFixture();
      const missing = withNamedCheckStatement(fixture, (statement) => {
        delete (statement.predicate as Record<string, unknown>).verdict;
      });
      await expect(subject(missing, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "verdict-correspondence",
          detail: expect.any(String),
        }],
      });

      const mismatched = {
        ...fixture.input,
        verdict: {
          ...fixture.input.verdict,
          onChainVerdictCode: VerdictCode.Fail,
        },
      };
      await expect(subject(mismatched, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "verdict-correspondence",
          detail: expect.any(String),
        }],
      });
    });

    test("allows requester self-claim on solve while keeping evaluator distinct", async () => {
      const fixture = await buildNamedCheckFixture();
      const input = {
        ...fixture.input,
        verdict: {
          ...fixture.input.verdict,
          solver: {
            ...fixture.input.verdict.solver,
            address: REQUESTER_SAFE,
          },
          evaluatorAddress: EVALUATOR_SAFE,
        },
      };
      await expect(subject(input, fixture.ports)).resolves.toEqual({
        decisionGrade: true,
        failures: [],
      });
    });

    test("refuses evaluator equals solver", async () => {
      const fixture = await buildNamedCheckFixture();
      const input = {
        ...fixture.input,
        verdict: {
          ...fixture.input.verdict,
          evaluatorAddress: fixture.input.verdict.solver.address.toUpperCase(),
        },
      };
      await expect(subject(input, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "evaluator-distinctness",
          detail: expect.any(String),
        }],
      });
    });

    test("refuses a settlement binding registered under another Agent IRI", async () => {
      const fixture = await buildNamedCheckFixture({
        settlementAgent: OTHER_AGENT,
      });
      expect(fixture.trust.settlement.binding.agent).toBe(OTHER_AGENT);
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "settlement-join",
          detail: expect.any(String),
        }],
      });
    });

    test("refuses a requester binding revoked before Submission sealing", async () => {
      const fixture = await buildNamedCheckFixture({
        requesterRevocation: {
          effectiveTime: "2026-07-29T07:00:00Z",
          authorized: true,
        },
      });
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "requester-authentication",
          detail: expect.stringContaining("revoked effective"),
        }],
      });
    });

    test("refuses a requester binding revoked exactly at Submission sealing", async () => {
      const sealingTime = "2026-07-29T08:00:00Z";
      const fixture = await buildNamedCheckFixture({
        requesterRevocation: {
          effectiveTime: sealingTime,
          authorized: true,
        },
      });
      expect(fixture.input.requesterAuthentication.sealingTime).toBe(
        sealingTime,
      );
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: false,
        failures: [{
          check: "requester-authentication",
          detail: expect.stringContaining(`revoked effective "${sealingTime}"`),
        }],
      });
    });

    test("accepts a requester binding revoked after Submission sealing", async () => {
      const fixture = await buildNamedCheckFixture({
        requesterRevocation: {
          effectiveTime: "2026-07-29T09:00:00Z",
          authorized: true,
        },
      });
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: true,
        failures: [],
      });
    });

    test("ignores a requester revocation from an unauthorized key", async () => {
      const fixture = await buildNamedCheckFixture({
        requesterRevocation: {
          effectiveTime: "2026-07-29T07:00:00Z",
          authorized: false,
        },
      });
      await expect(subject(fixture.input, fixture.ports)).resolves.toEqual({
        decisionGrade: true,
        failures: [],
      });
    });
  });
}
