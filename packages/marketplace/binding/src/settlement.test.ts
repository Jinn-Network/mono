import {
  sealDelivery,
  sha256Hex,
  type DeliveryRecord,
} from "@jinn-network/task-execution-protocol";
import { describe, expect, test, vi } from "vitest";
import { BASE_SEPOLIA_TODAY, type MarketplaceChainConfig } from "./index.js";
import {
  mapRaceLoss,
  settleDelivery,
  type SettlementAttempt,
  type SettlementGradeVerification,
  type SettlementPorts,
} from "./settlement.js";
import { keccakEvidenceHash } from "./venue/digest.js";

const REQUEST_ID = `0x${"a".repeat(64)}` as const;
const OTHER_REQUEST_ID = `0x${"b".repeat(64)}` as const;
const DISPATCH_DIGEST = `sha256:${"c".repeat(64)}` as const;
const EVALUATION_DIGEST = `sha256:${"d".repeat(64)}` as const;
const ATTEMPT_URI = "urn:uuid:11111111-1111-4111-8111-111111111111";
const EXECUTION_URI = "urn:uuid:22222222-2222-4222-8222-222222222222";
const ZERO_HASH = `0x${"0".repeat(64)}` as const;

const REVISED_CONFIG: MarketplaceChainConfig = {
  ...BASE_SEPOLIA_TODAY,
  generation: "revised",
  taskCoordinator: "0x1111111111111111111111111111111111111111",
  jinnRouter: "0x2222222222222222222222222222222222222222",
};

function makeDelivery(input: {
  readonly executionIds?: readonly string[];
  readonly evidenceRecords?: readonly {
    readonly family: "execution-evidence";
    readonly digest: `sha256:${string}`;
  }[];
} = {}): Uint8Array {
  return sealDelivery({
    protocol: "https://jinn.network/profiles/task-execution/1.0",
    attempt: ATTEMPT_URI,
    task: `sha256:${"1".repeat(64)}`,
    outputs: [],
    outcome: "fulfilled",
    executionIds: input.executionIds ?? [EXECUTION_URI],
    evidenceRecords: input.evidenceRecords ?? [
      {
        family: "execution-evidence",
        digest: `sha256:${"2".repeat(64)}`,
      },
    ],
    createdAt: "2026-07-29T00:00:00Z",
  });
}

const SEALED_DELIVERY = makeDelivery();
const DELIVERY_SHA256 = `sha256:${sha256Hex(SEALED_DELIVERY)}` as const;
const DELIVERY_KECCAK = keccakEvidenceHash(SEALED_DELIVERY);

const ATTEMPT: SettlementAttempt = {
  requestId: REQUEST_ID,
  expectedDispatchContextDigest: DISPATCH_DIGEST,
  taskEvaluationDigest: EVALUATION_DIGEST,
};

const VERIFIED: SettlementGradeVerification = {
  executorBinding: { status: "verified" },
  dispatchBinding: { status: "verified" },
  evaluationSpecification: { status: "verified" },
};

function todayFacts(overrides: Partial<{
  requestId: `0x${string}`;
  sha256CidDigest: `sha256:${string}`;
  keccakEvidenceHash: `0x${string}`;
}> = {}) {
  return {
    generation: "today" as const,
    requestId: overrides.requestId ?? REQUEST_ID,
    sha256CidDigest: overrides.sha256CidDigest ?? DELIVERY_SHA256,
    keccakEvidenceHash: overrides.keccakEvidenceHash ?? DELIVERY_KECCAK,
  };
}

function revisedFacts(overrides: Partial<{
  requestId: `0x${string}`;
  sha256Digest: `sha256:${string}`;
}> = {}) {
  return {
    generation: "revised" as const,
    requestId: overrides.requestId ?? REQUEST_ID,
    sha256Digest: overrides.sha256Digest ?? DELIVERY_SHA256,
  };
}

function makePorts(input: {
  readonly verification?: SettlementGradeVerification;
  readonly facts?: ReturnType<typeof todayFacts> | ReturnType<typeof revisedFacts>;
  readonly chainStatus?:
    | "settled"
    | "already-settled"
    | "rejected"
    | "delivered-unsettled";
} = {}): SettlementPorts & {
  readonly pinned: Uint8Array[];
} {
  const pinned: Uint8Array[] = [];
  return {
    pinned,
    pin: vi.fn(async (bytes: Uint8Array) => {
      pinned.push(bytes);
    }),
    verifySettlementGrade: vi.fn(async () => input.verification ?? VERIFIED),
    readDeliveryFacts: vi.fn(async () => input.facts ?? todayFacts()),
    claimSolutionDelivery: vi.fn(async () => ({
      status: input.chainStatus ?? "settled",
    })),
  };
}

describe("settleDelivery settlement-grade gate", () => {
  test("today mode verifies exact bytes and chain correspondence before pinning and claiming", async () => {
    const ports = makePorts();

    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual({ settled: true, state: "delivered" });

    expect(ports.verifySettlementGrade).toHaveBeenCalledOnce();
    const [verificationInput] = vi.mocked(ports.verifySettlementGrade).mock.calls[0]!;
    expect(verificationInput.attempt).toBe(ATTEMPT);
    expect(verificationInput.deliveryBytes).toBe(SEALED_DELIVERY);
    expect(verificationInput.config).toBe(BASE_SEPOLIA_TODAY);
    expect((verificationInput.delivery as DeliveryRecord).attempt).toBe(ATTEMPT_URI);
    expect(ports.pinned).toEqual([SEALED_DELIVERY]);
    expect(ports.claimSolutionDelivery).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      solutionDigest: DELIVERY_KECCAK,
    });
  });

  test("revised mode requires only its sha256 anchor and sends that digest through the generation seam", async () => {
    const ports = makePorts({ facts: revisedFacts() });

    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, REVISED_CONFIG, ports),
    ).resolves.toEqual({ settled: true, state: "delivered" });

    expect(ports.claimSolutionDelivery).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      solutionDigest: `0x${DELIVERY_SHA256.slice("sha256:".length)}`,
    });
  });

  test("rejects schema-valid noncanonical Delivery JSON before verifier, chain reads, pin, or claim", async () => {
    const noncanonical = new TextEncoder().encode(
      JSON.stringify(JSON.parse(new TextDecoder().decode(SEALED_DELIVERY)), null, 2),
    );
    const ports = makePorts();

    await expect(
      settleDelivery(ATTEMPT, noncanonical, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual({
      settled: false,
      state: "rejected",
      kind: "noncanonical-delivery",
      detail: "Delivery bytes do not equal protocol canonical sealed bytes",
    });
    expect(ports.verifySettlementGrade).not.toHaveBeenCalled();
    expect(ports.readDeliveryFacts).not.toHaveBeenCalled();
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "executionIds",
      sealed: makeDelivery({ executionIds: [] }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "missing-execution-ids",
        detail: "marketplace Delivery requires at least one executionId",
      },
    },
    {
      label: "evidenceRecords",
      sealed: makeDelivery({ evidenceRecords: [] }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "missing-evidence-records",
        detail: "marketplace Delivery requires at least one evidenceRecord",
      },
    },
  ])("rejects missing mandatory $label with zero write side effects", async ({
    sealed,
    expected,
  }) => {
    const ports = makePorts();
    await expect(
      settleDelivery(ATTEMPT, sealed, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual(expected);
    expect(ports.verifySettlementGrade).not.toHaveBeenCalled();
    expect(ports.readDeliveryFacts).not.toHaveBeenCalled();
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test.each([
    {
      label: "an absent executor signature check",
      verification: {
        ...VERIFIED,
        executorBinding: {
          status: "missing" as const,
          detail: "Delivery omitted executor DSSE binding evidence",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "executor-signature-invalid",
        detail: "Delivery omitted executor DSSE binding evidence",
      },
    },
    {
      label: "an invalid executor signature",
      verification: {
        ...VERIFIED,
        executorBinding: {
          status: "invalid" as const,
          detail: "executor DSSE signature did not verify",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "executor-signature-invalid",
        detail: "executor DSSE signature did not verify",
      },
    },
    {
      label: "an absent dispatch-binding check",
      verification: {
        ...VERIFIED,
        dispatchBinding: {
          status: "missing" as const,
          detail: "no execution-verification named dispatch-binding",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "dispatch-binding-failed",
        detail: "no execution-verification named dispatch-binding",
      },
    },
    {
      label: "a failed dispatch-binding check",
      verification: {
        ...VERIFIED,
        dispatchBinding: {
          status: "failed" as const,
          detail: "captured dispatch digest disagrees",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "dispatch-binding-failed",
        detail: "captured dispatch digest disagrees",
      },
    },
    {
      label: "an absent applicable evaluation-specification check",
      verification: {
        ...VERIFIED,
        evaluationSpecification: {
          status: "missing" as const,
          detail: "execution evidence omitted evaluationSpecification",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "evaluation-specification-mismatch",
        detail: "execution evidence omitted evaluationSpecification",
      },
    },
    {
      label: "a failed evaluation-specification equality check",
      verification: {
        ...VERIFIED,
        evaluationSpecification: {
          status: "failed" as const,
          detail: "execution evidence names another evaluation specification",
        },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "evaluation-specification-mismatch",
        detail: "execution evidence names another evaluation specification",
      },
    },
    {
      label: "a falsely not-applicable evaluation check",
      verification: {
        ...VERIFIED,
        evaluationSpecification: { status: "not-applicable" as const },
      },
      expected: {
        settled: false,
        state: "rejected",
        kind: "evaluation-specification-mismatch",
        detail: "Task requires evaluationSpecification digest equality",
      },
    },
  ])("rejects $label before pin or claim", async ({ verification, expected }) => {
    const ports = makePorts({ verification });
    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual(expected);
    expect(ports.readDeliveryFacts).not.toHaveBeenCalled();
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test("allows an explicitly not-applicable evaluation check only when the Task has no evaluation digest", async () => {
    const attemptWithoutEvaluation: SettlementAttempt = {
      requestId: REQUEST_ID,
      expectedDispatchContextDigest: DISPATCH_DIGEST,
    };
    const ports = makePorts({
      verification: {
        ...VERIFIED,
        evaluationSpecification: { status: "not-applicable" },
      },
    });
    await expect(
      settleDelivery(
        attemptWithoutEvaluation,
        SEALED_DELIVERY,
        BASE_SEPOLIA_TODAY,
        ports,
      ),
    ).resolves.toEqual({ settled: true, state: "delivered" });
  });

  test.each([
    {
      label: "an all-zero router evidence hash",
      facts: todayFacts({ keccakEvidenceHash: ZERO_HASH }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "zero-evidence-hash",
        hash: ZERO_HASH,
      },
    },
    {
      label: "a different requestId",
      facts: todayFacts({ requestId: OTHER_REQUEST_ID }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "request-id-mismatch",
        expectedRequestId: REQUEST_ID,
        actualRequestId: OTHER_REQUEST_ID,
      },
    },
    {
      label: "a sha256 digest divergence",
      facts: todayFacts({ sha256CidDigest: `sha256:${"e".repeat(64)}` }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "digest-divergence",
        generation: "today",
        asserted: {
          sha256Digest: DELIVERY_SHA256,
          keccakEvidenceHash: DELIVERY_KECCAK,
        },
        onChain: {
          sha256CidDigest: `sha256:${"e".repeat(64)}`,
          keccak: DELIVERY_KECCAK,
        },
      },
    },
    {
      label: "a keccak digest divergence",
      facts: todayFacts({ keccakEvidenceHash: `0x${"f".repeat(64)}` }),
      expected: {
        settled: false,
        state: "rejected",
        kind: "digest-divergence",
        generation: "today",
        asserted: {
          sha256Digest: DELIVERY_SHA256,
          keccakEvidenceHash: DELIVERY_KECCAK,
        },
        onChain: {
          sha256CidDigest: DELIVERY_SHA256,
          keccak: `0x${"f".repeat(64)}`,
        },
      },
    },
  ])("rejects today-mode chain facts with $label before pin or claim", async ({
    facts,
    expected,
  }) => {
    const ports = makePorts({ facts });
    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual(expected);
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test("rejects a revised-mode sha256 anchor divergence without inventing a today-mode keccak fact", async () => {
    const onChainDigest = `sha256:${"e".repeat(64)}` as const;
    const ports = makePorts({
      facts: revisedFacts({ sha256Digest: onChainDigest }),
    });
    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, REVISED_CONFIG, ports),
    ).resolves.toEqual({
      settled: false,
      state: "rejected",
      kind: "digest-divergence",
      generation: "revised",
      asserted: { sha256Digest: DELIVERY_SHA256 },
      onChain: { sha256Digest: onChainDigest },
    });
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test("rejects chain facts from a different contract generation", async () => {
    const ports = makePorts({ facts: revisedFacts() });
    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual({
      settled: false,
      state: "rejected",
      kind: "chain-facts-generation-mismatch",
      expectedGeneration: "today",
      actualGeneration: "revised",
    });
    expect(ports.pinned).toEqual([]);
    expect(ports.claimSolutionDelivery).not.toHaveBeenCalled();
  });

  test.each([
    {
      status: "settled" as const,
      expected: { settled: true, state: "delivered" },
    },
    {
      status: "already-settled" as const,
      expected: { settled: true, state: "delivered" },
    },
    {
      status: "rejected" as const,
      expected: { settled: false, state: "rejected" },
    },
    {
      status: "delivered-unsettled" as const,
      expected: { settled: false, state: "delivered" },
    },
  ])("preserves first-wins/idempotent/race semantics for $status after all gates pass", async ({
    status,
    expected,
  }) => {
    const ports = makePorts({ chainStatus: status });
    await expect(
      settleDelivery(ATTEMPT, SEALED_DELIVERY, BASE_SEPOLIA_TODAY, ports),
    ).resolves.toEqual(expected);
  });
});

describe("mapRaceLoss", () => {
  test("maps a lost race to the observed non-failure state", () => {
    expect(mapRaceLoss("rejected")).toBe("rejected");
    expect(mapRaceLoss("delivered-unsettled")).toBe("delivered");
  });
});
