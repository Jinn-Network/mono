import { describe, expect, test, vi } from "vitest";

import type {
  EvidenceRecordReference,
  RetrievalLocationHint,
} from "./contracts.js";
import { queryEvidence } from "./query.js";
import {
  createQueryReferenceSet,
  queryFixture,
  runQuery,
} from "./test-support.js";

describe("retrieval security boundaries", () => {
  test("candidate location data cannot construct or bypass a binding", async () => {
    const { firstValidReference: reference } =
      await createQueryReferenceSet();
    const resolver = vi.fn().mockResolvedValue(null);
    const fixture = await queryFixture({
      pages: [[{
        reference,
        locationHints: [{
          sourceId: "attacker",
          repositoryId: "not-registered",
          publishedLocation: {
            bindingProfile: "https",
            locator: {
              url: "https://attacker.invalid/private?credential=secret",
            },
          },
        }],
      }]],
    });
    await queryEvidence(
      {
        ...fixture.dependencies,
        locator: {
          locate: vi.fn(async (
            _reference: EvidenceRecordReference,
            hints: readonly RetrievalLocationHint[],
          ) =>
            hints.map((hint) => ({
              observationId: `hint:${hint.repositoryId}`,
              sourceId: hint.sourceId,
              status: "available" as const,
              repositoryId: hint.repositoryId,
              publishedLocation: hint.publishedLocation,
            })),
          ),
        },
        repositoryResolver: { resolve: resolver },
        locationPolicy: {
          select: (_reference, observations) =>
            observations
              .filter(({ repositoryId }) => repositoryId === "registered")
              .map((observation) => ({
                repositoryId: "registered",
                observation,
              })),
        },
      },
      {
        candidateSource: fixture.source,
        sourceQuery: { kind: "attack" },
        resultLimit: 1,
        candidateBudget: 1,
      },
    );
    expect(resolver).not.toHaveBeenCalledWith(
      "https://attacker.invalid/private?credential=secret",
      expect.anything(),
    );
    expect(resolver).not.toHaveBeenCalledWith("not-registered", expect.anything());
  });

  test("provider issue text is bounded and never rendered as trusted content", async () => {
    const fixture = await queryFixture({
      pages: [[]],
      diagnostics: {
        issues: [{
          code: "REMOTE_WARNING",
          message: "secret ".repeat(10_000),
        }],
      },
    });
    const outcome = await runQuery(
      fixture,
      { resultLimit: 1, candidateBudget: 1 },
    );
    expect(JSON.stringify(outcome.diagnostics).length).toBeLessThan(32_000);
    expect(outcome.diagnostics?.providerIssues).toEqual([{
      code: "REMOTE_WARNING",
      message: "Candidate source reported a classified issue.",
    }]);
  });

  test("only the explicitly supplied candidateSource receives the query", async () => {
    const fixture = await queryFixture({
      pages: [[(await createQueryReferenceSet()).firstValidReference]],
    });
    await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(fixture.find).toHaveBeenCalledTimes(1);
  });

  test("provider data remains available in result provenance without appearing in telemetry or safe failure messages", async () => {
    const fixture = await queryFixture({
      pages: [[{
        reference: (await createQueryReferenceSet()).firstValidReference,
        providerData: { snippet: "private snippet content" },
      }]],
    });
    const outcome = await runQuery(fixture, { resultLimit: 1, candidateBudget: 1 });
    expect(outcome.results[0]?.discoveryProvenance[0]?.providerData).toEqual({
      snippet: "private snippet content",
    });
    expect(JSON.stringify(outcome.diagnostics)).not.toContain("private snippet content");
  });
});
