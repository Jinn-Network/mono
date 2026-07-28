import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";
import { describe, expect, test } from "vitest";

import { EvidenceRetrievalError } from "./errors.js";
import { createOperationContext, resolveHardLimits } from "./operation.js";
import { hydrateArtifacts } from "./artifacts.js";
import {
  artifactFixture,
  available,
  repositoryReturning,
  resolverFrom,
} from "./test-support.js";

describe("hydrateArtifacts", () => {
  test("does not read artifact bytes without a hydration request", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: undefined,
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    expect(fixture.repositories.flatMap((repository) =>
      repository.getArtifact.mock.calls,
    )).toHaveLength(0);
    expect(result.results.every(({ status }) => status === "not-requested"))
      .toBe(true);
  });

  test("hydrates only matching selectors and verifies exact bytes", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({
        requirement: "required",
        status: "verified",
        bytes: fixture.resultBytes,
      }),
    );
    expect(result.completeness).toBe("complete");
  });

  test("verified bytes are a defensive copy, not the repository's buffer", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    const verified = result.results.find(({ status }) => status === "verified");
    expect(verified?.bytes).not.toBe(fixture.resultBytes);
    expect(verified?.bytes).toEqual(fixture.resultBytes);
  });

  test("reports unavailable when every allowed repository returns null", async () => {
    const fixture = await artifactFixture();
    const empty = repositoryReturning(fixture.record.canonicalBytes);
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: empty },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: resolverFrom({ memory: empty }),
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "unavailable" }),
    );
    expect(result.completeness).toBe("complete");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("reports access-denied when every allowed copy denies access", async () => {
    const fixture = await artifactFixture();
    const denying = repositoryReturning(fixture.record.canonicalBytes);
    denying.getArtifact.mockImplementation(async () => {
      throw new EvidenceRepositoryError("ACCESS_DENIED", "adapter detail");
    });
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: denying },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: resolverFrom({ memory: denying }),
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "access-denied" }),
    );
    expect(result.completeness).toBe("artifact-incomplete");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "REQUIRED_ARTIFACT_UNAVAILABLE" }),
    );
  });

  test("reports integrity-mismatch when returned bytes have a different digest", async () => {
    const fixture = await artifactFixture();
    const wrongBytes = new TextEncoder().encode("not the right patch");
    const mismatched = repositoryReturning(fixture.record.canonicalBytes);
    mismatched.getArtifact.mockImplementation(async () =>
      Uint8Array.from(wrongBytes),
    );
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: mismatched },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: resolverFrom({ memory: mismatched }),
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "integrity-mismatch" }),
    );
    expect(result.completeness).toBe("artifact-incomplete");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "ARTIFACT_INTEGRITY_MISMATCH" }),
    );
  });

  test("reports too-large when the repository capability is below the artifact size", async () => {
    const fixture = await artifactFixture();
    const constrained = repositoryReturning(fixture.record.canonicalBytes, {});
    constrained.getArtifact.mockImplementation(async () =>
      Uint8Array.from(fixture.resultBytes),
    );
    (constrained as { capabilities: { maxObjectBytes?: number } }).capabilities = {
      maxObjectBytes: 1,
    };
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: constrained },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: resolverFrom({ memory: constrained }),
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "too-large" }),
    );
  });

  test("reports too-large when the shared artifact-byte budget is exhausted", async () => {
    const fixture = await artifactFixture();
    const context = createOperationContext(
      resolveHardLimits({ maxTotalArtifactBytes: 1 }),
    );
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: fixture.resolver,
      context,
    });
    context.dispose();
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "too-large" }),
    );
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "BYTE_BUDGET_EXCEEDED" }),
    );
  });

  test("reports timed-out when the operation deadline aborts the read", async () => {
    const fixture = await artifactFixture();
    const context = createOperationContext(resolveHardLimits({ timeoutMs: 5 }));
    const slow = repositoryReturning(fixture.record.canonicalBytes);
    slow.getArtifact.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new EvidenceRepositoryError(
        "OPERATION_ABORTED",
        "the repository operation was aborted",
      );
    });
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: slow },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: resolverFrom({ memory: slow }),
      context,
    });
    context.dispose();
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: "timed-out" }),
    );
  });

  test("returns not-requested for a declared artifact that matches no selection", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    const unrelated = result.results.filter(
      (entry) => entry.declaration.entityId !== "results/slug-normalization.patch",
    );
    expect(unrelated.length).toBeGreaterThan(0);
    expect(unrelated.every(({ status }) => status === "not-requested")).toBe(true);
  });

  test("matching two selectors to the same declaration produces one read", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [
          {
            selector: { kind: "role", role: "result" },
            requirement: "optional",
          },
          {
            selector: { kind: "entity-id", entityId: "results/slug-normalization.patch" },
            requirement: "optional",
          },
        ],
      },
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    expect(fixture.record.repository.getArtifact).toHaveBeenCalledOnce();
    expect(result.results.filter(
      (entry) => entry.declaration.entityId === "results/slug-normalization.patch",
    )).toHaveLength(1);
  });

  test("required wins when required and optional selectors match the same declaration", async () => {
    const fixture = await artifactFixture();
    const result = await hydrateArtifacts({
      record: fixture.record,
      request: {
        selections: [
          {
            selector: { kind: "entity-id", entityId: "results/slug-normalization.patch" },
            requirement: "optional",
          },
          {
            selector: { kind: "role", role: "result" },
            requirement: "required",
          },
        ],
      },
      repositoryResolver: fixture.resolver,
      context: fixture.context,
    });
    expect(result.results).toContainEqual(
      expect.objectContaining({
        declaration: expect.objectContaining({
          entityId: "results/slug-normalization.patch",
        }),
        requirement: "required",
      }),
    );
  });

  test("optional failure yields a warning but stays complete", async () => {
    const fixture = await artifactFixture();
    const empty = repositoryReturning(fixture.record.canonicalBytes);
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: empty },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "optional",
        }],
      },
      repositoryResolver: resolverFrom({ memory: empty }),
      context: fixture.context,
    });
    expect(result.completeness).toBe("complete");
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.failures).toHaveLength(0);
  });

  test("required failure yields artifact-incomplete plus REQUIRED_ARTIFACT_UNAVAILABLE", async () => {
    const fixture = await artifactFixture();
    const empty = repositoryReturning(fixture.record.canonicalBytes);
    const result = await hydrateArtifacts({
      record: { ...fixture.record, repository: empty },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: resolverFrom({ memory: empty }),
      context: fixture.context,
    });
    expect(result.completeness).toBe("artifact-incomplete");
    expect(result.failures).toContainEqual(
      expect.objectContaining({ code: "REQUIRED_ARTIFACT_UNAVAILABLE" }),
    );
  });

  test("rejects selecting more declarations than maxArtifactCount", async () => {
    const fixture = await artifactFixture();
    const context = createOperationContext(
      resolveHardLimits({ maxArtifactCount: 1 }),
    );
    await expect(
      hydrateArtifacts({
        record: fixture.record,
        request: {
          selections: [
            {
              selector: { kind: "role", role: "result" },
              requirement: "optional",
            },
            {
              selector: { kind: "role", role: "hasPart" },
              requirement: "optional",
            },
          ],
        },
        repositoryResolver: fixture.resolver,
        context,
      }),
    ).rejects.toThrow(EvidenceRetrievalError);
    context.dispose();
  });

  test("artifact failure never changes the containing record's Protocol conformance", async () => {
    const fixture = await artifactFixture();
    const empty = repositoryReturning(fixture.record.canonicalBytes);
    await hydrateArtifacts({
      record: { ...fixture.record, repository: empty },
      request: {
        selections: [{
          selector: { kind: "role", role: "result" },
          requirement: "required",
        }],
      },
      repositoryResolver: resolverFrom({ memory: empty }),
      context: fixture.context,
    });
    expect(fixture.record.validatedRecord.family).toBe("execution-evidence");
  });
});
