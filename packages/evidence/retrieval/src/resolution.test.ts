import {
  EvidenceRepositoryError,
  createRecordReference,
} from "@jinn-network/evidence-repository";
import { describe, expect, test, vi } from "vitest";

import type { RetrievalLocationAttempt } from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { resolveHardLimits, createOperationContext } from "./operation.js";
import { resolveValidatedRecord } from "./resolution.js";
import {
  arbitraryReference,
  available,
  loadProtocolFixture,
  locatorReturning,
  operationContext,
  policyInObservedOrder,
  repositoryReturning,
  resolverFrom,
  withdrawn,
} from "./test-support.js";

describe("resolveValidatedRecord", () => {
  test("continues from a corrupt copy to a valid allowed copy", async () => {
    const bytes = await loadProtocolFixture("execution-evidence");
    const reference = createRecordReference("execution-evidence", bytes);
    const corrupt = repositoryReturning(new TextEncoder().encode("corrupt"));
    const valid = repositoryReturning(bytes);
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([
        available("catalog", "corrupt"),
        available("catalog", "valid"),
      ]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ corrupt, valid }),
      context: operationContext(),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.selectedLocation.repositoryId).toBe("valid");
      expect(outcome.record.failures).toContainEqual(
        expect.objectContaining({ code: "RECORD_DIGEST_MISMATCH" }),
      );
    }
  });

  test("does not resolve a location rejected by host policy", async () => {
    const resolver = vi.fn();
    const outcome = await resolveValidatedRecord({
      reference: arbitraryReference(),
      hints: [],
      locator: locatorReturning([available("candidate", "remote")]),
      locationPolicy: { select: () => [] },
      repositoryResolver: { resolve: resolver },
      context: operationContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "NO_LOCATION" },
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  test("reports NO_LOCATION when the locator observes nothing", async () => {
    const outcome = await resolveValidatedRecord({
      reference: arbitraryReference(),
      hints: [],
      locator: locatorReturning([]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({}),
      context: operationContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "NO_LOCATION" },
    });
  });

  test("reports WITHDRAWN_OR_UNAVAILABLE when every observation is withdrawn", async () => {
    const outcome = await resolveValidatedRecord({
      reference: arbitraryReference(),
      hints: [],
      locator: locatorReturning([withdrawn("catalog"), withdrawn("mirror")]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({}),
      context: operationContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "WITHDRAWN_OR_UNAVAILABLE" },
    });
  });

  test("classifies an unresolved repository identity and continues", async () => {
    const bytes = await loadProtocolFixture("execution-evidence");
    const reference = createRecordReference("execution-evidence", bytes);
    const valid = repositoryReturning(bytes);
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([
        available("catalog", "missing"),
        available("catalog", "valid"),
      ]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ valid }),
      context: operationContext(),
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.record.failures).toContainEqual(
        expect.objectContaining({ code: "REPOSITORY_UNRESOLVED" }),
      );
    }
  });

  test("classifies a repository returning null bytes as unavailable", async () => {
    const reference = arbitraryReference();
    const empty = repositoryReturning(null);
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([available("catalog", "empty")]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ empty }),
      context: operationContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "WITHDRAWN_OR_UNAVAILABLE" },
    });
  });

  test.each([
    ["ACCESS_DENIED", "ACCESS_DENIED"],
    ["CONTENT_TOO_LARGE", "RECORD_TOO_LARGE"],
  ] as const)(
    "maps repository %s to retrieval failure %s",
    async (repositoryCode, retrievalCode) => {
      const reference = arbitraryReference();
      const throwing = repositoryReturning(null);
      throwing.getRecord.mockImplementation(async () => {
        throw new EvidenceRepositoryError(repositoryCode, "adapter detail");
      });
      const outcome = await resolveValidatedRecord({
        reference,
        hints: [],
        locator: locatorReturning([available("catalog", "throwing")]),
        locationPolicy: policyInObservedOrder(),
        repositoryResolver: resolverFrom({ throwing }),
        context: operationContext(),
      });
      expect(outcome).toMatchObject({
        ok: false,
        failure: { code: retrievalCode },
      });
      if (!outcome.ok) {
        expect(outcome.failure.message).not.toContain("adapter detail");
      }
    },
  );

  test("classifies a repository OPERATION_ABORTED at the deadline as TIMED_OUT", async () => {
    const reference = arbitraryReference();
    const context = createOperationContext(
      resolveHardLimits({ timeoutMs: 5 }),
    );
    const throwing = repositoryReturning(null);
    throwing.getRecord.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new EvidenceRepositoryError(
        "OPERATION_ABORTED",
        "the repository operation was aborted",
      );
    });
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([available("catalog", "throwing")]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ throwing }),
      context,
    });
    context.dispose();
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "TIMED_OUT" },
    });
  });

  test("throws HOST_MISCONFIGURED when the locator exceeds the observation ceiling", async () => {
    const context = createOperationContext(
      resolveHardLimits({ maxLocationObservations: 1 }),
    );
    await expect(
      resolveValidatedRecord({
        reference: arbitraryReference(),
        hints: [],
        locator: locatorReturning([
          available("catalog", "one"),
          available("catalog", "two"),
        ]),
        locationPolicy: policyInObservedOrder(),
        repositoryResolver: resolverFrom({}),
        context,
      }),
    ).rejects.toThrow(EvidenceRetrievalError);
    context.dispose();
  });

  test("throws HOST_MISCONFIGURED when the location policy returns an attempt outside its bounded input", async () => {
    const rogueAttempt: RetrievalLocationAttempt = {
      repositoryId: "not-observed",
      observation: available("catalog", "not-observed"),
    };
    await expect(
      resolveValidatedRecord({
        reference: arbitraryReference(),
        hints: [],
        locator: locatorReturning([available("catalog", "one")]),
        locationPolicy: { select: () => [rogueAttempt] },
        repositoryResolver: resolverFrom({}),
        context: operationContext(),
      }),
    ).rejects.toThrow(EvidenceRetrievalError);
  });

  test("truncates attempts to maxLocationAttempts and never tries the rest", async () => {
    const context = createOperationContext(
      resolveHardLimits({ maxLocationAttempts: 1 }),
    );
    const first = repositoryReturning(null);
    const second = repositoryReturning(null);
    const outcome = await resolveValidatedRecord({
      reference: arbitraryReference(),
      hints: [],
      locator: locatorReturning([
        available("catalog", "first"),
        available("catalog", "second"),
      ]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ first, second }),
      context,
    });
    context.dispose();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failures).toHaveLength(1);
    }
    expect(first.getRecord).toHaveBeenCalledOnce();
    expect(second.getRecord).not.toHaveBeenCalled();
  });

  test("classifies a nonconforming first copy and continues to the next attempt", async () => {
    const nonconformingBytes = new TextEncoder().encode("{}");
    const reference = createRecordReference(
      "execution-evidence",
      nonconformingBytes,
    );
    const first = repositoryReturning(nonconformingBytes);
    const second = repositoryReturning(nonconformingBytes);
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([
        available("catalog", "first"),
        available("catalog", "second"),
      ]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ first, second }),
      context: operationContext(),
    });
    expect(first.getRecord).toHaveBeenCalledOnce();
    expect(second.getRecord).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "PROTOCOL_NONCONFORMING" },
    });
    if (!outcome.ok) {
      expect(outcome.failures).toHaveLength(2);
      expect(outcome.failures.every(
        (failure) => failure.code === "PROTOCOL_NONCONFORMING",
      )).toBe(true);
    }
  });

  test("exhausts every allowed attempt and returns the last classified failure", async () => {
    const reference = arbitraryReference();
    const first = repositoryReturning(null);
    const second = repositoryReturning(null);
    const outcome = await resolveValidatedRecord({
      reference,
      hints: [],
      locator: locatorReturning([
        available("catalog", "first"),
        available("catalog", "second"),
      ]),
      locationPolicy: policyInObservedOrder(),
      repositoryResolver: resolverFrom({ first, second }),
      context: operationContext(),
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "WITHDRAWN_OR_UNAVAILABLE", repositoryId: "second" },
    });
    if (!outcome.ok) {
      expect(outcome.failures).toHaveLength(2);
      expect(outcome.failures.map(({ repositoryId }) => repositoryId))
        .toEqual(["first", "second"]);
    }
  });
});
