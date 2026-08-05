// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  EvidenceCatalogReader,
  EvidenceCatalogWriter,
  ExecutionEvidenceProjection,
  ExecutionVerificationProjection,
  ResultEvaluationProjection,
  Sha256Digest,
} from "./types.js";

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

export interface CatalogContractFixtures {
  readonly privateExecution: ExecutionEvidenceProjection;
  readonly publicDerivative: ExecutionEvidenceProjection;
  readonly evaluation: ResultEvaluationProjection;
  readonly verification: ExecutionVerificationProjection;
}

export function createCatalogContractFixtures(): CatalogContractFixtures {
  const executionId = "urn:uuid:11111111-1111-4111-8111-111111111111";
  const task = {
    entityId: "task/task.md",
    digest: digest("a"),
    name: "Fixture task",
    mediaType: "text/markdown",
  } as const;
  const result = {
    entityId: "results/result.patch",
    digest: digest("b"),
    name: "Fixture result",
    mediaType: "text/x-diff",
  } as const;

  const executionProjection = (
    recordDigest: Sha256Digest,
  ): ExecutionEvidenceProjection => ({
    family: "execution-evidence",
    reference: { family: "execution-evidence", digest: recordDigest },
    byteSize: 1024,
    executionId,
    task,
    executorId: "urn:uuid:22222222-2222-4222-8222-222222222222",
    runtime: {
      entityId: "runtime/runtime-specification.json",
      digest: digest("c"),
      name: "Fixture runtime",
      mediaType: "application/json",
    },
    results: [result],
    nativeTrace: {
      entityId: "trace/trace.jsonl",
      digest: digest("d"),
      name: "Fixture trace",
      mediaType: "application/x-ndjson",
    },
    outcome: "completed",
    startedAt: "2026-07-24T10:00:00Z",
    endedAt: "2026-07-24T10:01:00Z",
    publishedAt: "2026-07-24T10:01:01Z",
    declaredEntities: [
      { entityId: executionId, types: ["CreateAction"] },
      { entityId: task.entityId, types: ["CreativeWork", "File", "prov:Plan"] },
    ],
    declaredRelationships: [
      {
        sourceEntityId: executionId,
        predicate: "object",
        targetEntityId: task.entityId,
      },
    ],
  });

  const privateExecution = executionProjection(digest("1"));
  const publicDerivative = {
    ...executionProjection(digest("2")),
    declaredRelationships: [
      ...privateExecution.declaredRelationships,
      {
        sourceEntityId: "./",
        predicate: "prov:wasDerivedFrom",
        targetEntityId: privateExecution.reference.digest,
      },
    ],
  } satisfies ExecutionEvidenceProjection;

  const evaluation: ResultEvaluationProjection = {
    family: "result-evaluation",
    reference: { family: "result-evaluation", digest: digest("3") },
    byteSize: 512,
    taskSubject: {
      name: task.entityId,
      digest: task.digest,
      uri: "https://example.invalid/task/fixture",
    },
    resultSubjects: [
      {
        name: result.entityId,
        digest: result.digest,
        uri: "https://example.invalid/result/fixture",
      },
    ],
    evaluatorId: "urn:uuid:33333333-3333-4333-8333-333333333333",
    verdict: "pass",
    evaluatedAt: "2026-07-24T10:02:00Z",
    supersedes: [],
    disputes: [],
    declaredEntities: [
      {
        entityId: "urn:uuid:33333333-3333-4333-8333-333333333333",
        types: ["Agent"],
      },
    ],
    declaredRelationships: [],
  };

  const verification: ExecutionVerificationProjection = {
    family: "execution-verification",
    reference: { family: "execution-verification", digest: digest("4") },
    byteSize: 512,
    subjectRecord: {
      family: "execution-evidence",
      digest: privateExecution.reference.digest,
    },
    executionId,
    verifierId: "urn:uuid:44444444-4444-4444-8444-444444444444",
    verdict: "verified",
    verifiedAt: "2026-07-24T10:03:00Z",
    supersedes: [],
    disputes: [],
    declaredEntities: [
      { entityId: executionId, types: ["CreateAction"] },
      {
        entityId: "urn:uuid:44444444-4444-4444-8444-444444444444",
        types: ["Agent"],
      },
    ],
    declaredRelationships: [],
  };

  return {
    privateExecution,
    publicDerivative,
    evaluation,
    verification,
  };
}

export interface EvidenceCatalogContractContext {
  readonly reader: EvidenceCatalogReader;
  readonly writer: EvidenceCatalogWriter;
  readonly cleanup?: () => Promise<void> | void;
}

export type EvidenceCatalogContractFactory = (
  name: string,
) =>
  | Promise<EvidenceCatalogContractContext>
  | EvidenceCatalogContractContext;

async function putAvailable(
  context: EvidenceCatalogContractContext,
  projection:
    | ExecutionEvidenceProjection
    | ResultEvaluationProjection
    | ExecutionVerificationProjection,
  suffix: string,
): Promise<void> {
  await context.writer.putRecordProjection(projection);
  await context.writer.observeRecordLocation(projection.reference, {
    sourceId: "contract-source",
    announcementId: `available-${suffix}`,
    repositoryId: "contract-repository",
  });
}

export function describeEvidenceCatalogContract(
  createContext: EvidenceCatalogContractFactory,
): void {
  describe("EvidenceCatalog contract", () => {
    let context: EvidenceCatalogContractContext | undefined;
    let fixtures: CatalogContractFixtures;

    beforeEach(async (testContext) => {
      context = await createContext(testContext.task.name);
      fixtures = createCatalogContractFixtures();
    });

    afterEach(async () => {
      await context?.cleanup?.();
      context = undefined;
    });

    test("round-trips all three projection families by exact reference", async () => {
      for (const projection of [
        fixtures.privateExecution,
        fixtures.evaluation,
        fixtures.verification,
      ]) {
        expect(await context!.writer.putRecordProjection(projection)).toMatchObject({
          reference: projection.reference,
          status: "created",
        });
        expect(await context!.reader.getRecord(projection.reference)).toEqual(
          projection,
        );
      }
    });

    test("keeps two records sharing an Execution IRI distinct", async () => {
      await putAvailable(context!, fixtures.privateExecution, "private");
      await putAvailable(context!, fixtures.publicDerivative, "public");
      const page = await context!.reader.findExecutions({
        executionId: fixtures.privateExecution.executionId,
      });
      expect(page.items.map(({ reference }) => reference)).toEqual([
        fixtures.privateExecution.reference,
        fixtures.publicDerivative.reference,
      ]);
    });

    test("filters every typed family and entity occurrences exactly", async () => {
      await putAvailable(context!, fixtures.privateExecution, "execution");
      await putAvailable(context!, fixtures.evaluation, "evaluation");
      await putAvailable(context!, fixtures.verification, "verification");

      expect(
        (
          await context!.reader.findExecutions({
            taskDigest: fixtures.privateExecution.task.digest,
            resultDigest: fixtures.privateExecution.results[0]!.digest,
            executorId: fixtures.privateExecution.executorId,
          })
        ).items,
      ).toHaveLength(1);
      expect(
        (
          await context!.reader.findEvaluations({
            evaluatorId: fixtures.evaluation.evaluatorId,
            verdict: "pass",
          })
        ).items,
      ).toEqual([fixtures.evaluation]);
      expect(
        (
          await context!.reader.findVerifications({
            subjectRecordDigest: fixtures.privateExecution.reference.digest,
            verifierId: fixtures.verification.verifierId,
          })
        ).items,
      ).toEqual([fixtures.verification]);
      expect(
        (
          await context!.reader.findRecordsForEntity(
            fixtures.privateExecution.executionId,
          )
        ).items.map(({ family }) => family),
      ).toEqual(["execution-evidence", "execution-verification"]);
    });

    test("implements every Execution filter and exclusive time boundary", async () => {
      await putAvailable(context!, fixtures.privateExecution, "execution");
      const matching: Parameters<EvidenceCatalogReader["findExecutions"]>[0] = {
        executionId: fixtures.privateExecution.executionId,
        taskId: fixtures.privateExecution.task.entityId,
        taskDigest: fixtures.privateExecution.task.digest,
        resultId: fixtures.privateExecution.results[0]!.entityId,
        resultDigest: fixtures.privateExecution.results[0]!.digest,
        executorId: fixtures.privateExecution.executorId,
        outcome: fixtures.privateExecution.outcome,
        startedAfter: "2026-07-24T09:59:59Z",
        startedBefore: "2026-07-24T10:00:01Z",
      };
      expect((await context!.reader.findExecutions(matching)).items).toEqual([
        fixtures.privateExecution,
      ]);
      for (const query of [
        { executionId: "urn:uuid:00000000-0000-4000-8000-000000000000" },
        { taskId: "other-task" },
        { taskDigest: digest("9") },
        { resultId: "other-result" },
        { resultDigest: digest("8") },
        { executorId: "urn:uuid:00000000-0000-4000-8000-000000000001" },
        { outcome: "failed" as const },
        { startedAfter: fixtures.privateExecution.startedAt },
        { startedAfter: "2026-07-24T12:00:00+02:00" },
        { startedBefore: fixtures.privateExecution.startedAt },
      ]) {
        expect((await context!.reader.findExecutions(query)).items).toEqual([]);
      }
    });

    test("implements every Evaluation filter and exclusive time boundary", async () => {
      await putAvailable(context!, fixtures.evaluation, "evaluation");
      expect(
        (
          await context!.reader.findEvaluations({
            taskDigest: fixtures.evaluation.taskSubject.digest,
            resultDigest: fixtures.evaluation.resultSubjects[0].digest,
            evaluatorId: fixtures.evaluation.evaluatorId,
            verdict: fixtures.evaluation.verdict,
            evaluatedAfter: "2026-07-24T10:01:59Z",
            evaluatedBefore: "2026-07-24T10:02:01Z",
          })
        ).items,
      ).toEqual([fixtures.evaluation]);
      for (const query of [
        { taskDigest: digest("9") },
        { resultDigest: digest("8") },
        { evaluatorId: "urn:uuid:00000000-0000-4000-8000-000000000002" },
        { verdict: "fail" as const },
        { evaluatedAfter: fixtures.evaluation.evaluatedAt },
        { evaluatedBefore: fixtures.evaluation.evaluatedAt },
      ]) {
        expect((await context!.reader.findEvaluations(query)).items).toEqual([]);
      }
    });

    test("implements every Verification filter and exclusive time boundary", async () => {
      await putAvailable(context!, fixtures.verification, "verification");
      expect(
        (
          await context!.reader.findVerifications({
            executionId: fixtures.verification.executionId,
            subjectRecordDigest: fixtures.verification.subjectRecord.digest,
            verifierId: fixtures.verification.verifierId,
            verdict: fixtures.verification.verdict,
            verifiedAfter: "2026-07-24T10:02:59Z",
            verifiedBefore: "2026-07-24T10:03:01Z",
          })
        ).items,
      ).toEqual([fixtures.verification]);
      for (const query of [
        { executionId: "urn:uuid:00000000-0000-4000-8000-000000000003" },
        { subjectRecordDigest: digest("9") },
        { verifierId: "urn:uuid:00000000-0000-4000-8000-000000000004" },
        { verdict: "rejected" as const },
        { verifiedAfter: fixtures.verification.verifiedAt },
        { verifiedBefore: fixtures.verification.verifiedAt },
      ]) {
        expect((await context!.reader.findVerifications(query)).items).toEqual(
          [],
        );
      }
    });

    test("applies the entity-family filter", async () => {
      await putAvailable(context!, fixtures.privateExecution, "execution");
      await putAvailable(context!, fixtures.verification, "verification");
      expect(
        (
          await context!.reader.findRecordsForEntity(
            fixtures.privateExecution.executionId,
            { family: "execution-verification" },
          )
        ).items,
      ).toEqual([fixtures.verification]);
    });

    test("hides unavailable records by default but exact lookup retains them", async () => {
      await context!.writer.putRecordProjection(fixtures.privateExecution);
      expect((await context!.reader.findExecutions({})).items).toEqual([]);
      expect(
        (
          await context!.reader.findExecutions({ availability: "any" })
        ).items,
      ).toEqual([fixtures.privateExecution]);
      expect(
        await context!.reader.getRecord(fixtures.privateExecution.reference),
      ).toEqual(fixtures.privateExecution);
    });

    test("paginates deterministically without duplicate records", async () => {
      await putAvailable(context!, fixtures.privateExecution, "private");
      await putAvailable(context!, fixtures.publicDerivative, "public");
      const first = await context!.reader.findExecutions({ limit: 1 });
      const second = await context!.reader.findExecutions({
        limit: 1,
        cursor: first.nextCursor,
      });
      expect([
        ...first.items.map(({ reference }) => reference.digest),
        ...second.items.map(({ reference }) => reference.digest),
      ]).toEqual([
        fixtures.privateExecution.reference.digest,
        fixtures.publicDerivative.reference.digest,
      ]);
      await expect(
        context!.reader.findExecutions({
          limit: 1,
          cursor: first.nextCursor,
          executorId: "urn:changed",
        }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
      await expect(
        context!.reader.findExecutions({ cursor: "not-a-cursor" }),
      ).rejects.toMatchObject({ code: "INVALID_QUERY" });
    });

    test("replays, conflicts, and withdraws source events safely", async () => {
      await context!.writer.putRecordProjection(fixtures.privateExecution);
      const observation = {
        sourceId: "source-a",
        announcementId: "available-1",
        repositoryId: "repository-a",
      } as const;
      expect(
        await context!.writer.observeRecordLocation(
          fixtures.privateExecution.reference,
          observation,
        ),
      ).toEqual({ status: "created" });
      expect(
        await context!.writer.observeRecordLocation(
          fixtures.privateExecution.reference,
          observation,
        ),
      ).toEqual({ status: "existing" });
      await expect(
        context!.writer.observeRecordLocation(
          fixtures.privateExecution.reference,
          { ...observation, repositoryId: "repository-b" },
        ),
      ).rejects.toMatchObject({ code: "LOCATION_CONFLICT" });

      const withdrawal = {
        sourceId: "source-a",
        announcementId: "withdrawn-1",
        retractsAnnouncementId: observation.announcementId,
      } as const;
      expect(
        await context!.writer.withdrawRecordLocationObservation(withdrawal),
      ).toEqual({ status: "withdrawn" });
      expect(
        await context!.writer.withdrawRecordLocationObservation(withdrawal),
      ).toEqual({ status: "existing" });
      await expect(
        context!.writer.withdrawRecordLocationObservation({
          ...withdrawal,
          retractsAnnouncementId: "different",
        }),
      ).rejects.toMatchObject({ code: "LOCATION_CONFLICT" });
      expect(
        await context!.writer.withdrawRecordLocationObservation({
          sourceId: "source-a",
          announcementId: "withdrawn-missing",
          retractsAnnouncementId: "missing",
        }),
      ).toEqual({ status: "absent" });
      expect(await context!.reader.getRecordLocations(fixtures.privateExecution.reference))
        .toEqual([]);
    });

    test("isolates withdrawals by source and preserves independently supported locations", async () => {
      await context!.writer.putRecordProjection(fixtures.privateExecution);
      await context!.writer.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: "source-a",
          announcementId: "available-a",
          repositoryId: "shared-repository",
        },
      );
      await context!.writer.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: "source-b",
          announcementId: "available-b",
          repositoryId: "shared-repository",
        },
      );

      await expect(
        context!.writer.withdrawRecordLocationObservation({
          sourceId: "source-a",
          announcementId: "wrong-source-withdrawal",
          retractsAnnouncementId: "available-b",
        }),
      ).rejects.toMatchObject({ code: "LOCATION_CONFLICT" });

      await expect(
        context!.writer.withdrawRecordLocationObservation({
          sourceId: "source-a",
          announcementId: "withdrawal-a",
          retractsAnnouncementId: "available-a",
        }),
      ).resolves.toEqual({ status: "withdrawn" });
      expect(
        await context!.reader.getRecordLocations(
          fixtures.privateExecution.reference,
        ),
      ).toEqual([{ repositoryId: "shared-repository" }]);
    });

    test("de-duplicates active local and canonical published locations", async () => {
      await context!.writer.putRecordProjection(fixtures.privateExecution);
      for (const [sourceId, announcementId] of [
        ["source-a", "local-a"],
        ["source-b", "local-b"],
      ]) {
        await context!.writer.observeRecordLocation(
          fixtures.privateExecution.reference,
          { sourceId, announcementId, repositoryId: "local" },
        );
      }
      await context!.writer.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: "source-a",
          announcementId: "published-a",
          repositoryId: "remote-a",
          publishedLocation: {
            bindingProfile: "https://example.invalid/oci",
            locator: { repository: "jinn/evidence", digest: "sha256:fixture" },
          },
        },
      );
      await context!.writer.observeRecordLocation(
        fixtures.privateExecution.reference,
        {
          sourceId: "source-b",
          announcementId: "published-b",
          repositoryId: "remote-b",
          publishedLocation: {
            bindingProfile: "https://example.invalid/oci",
            locator: { digest: "sha256:fixture", repository: "jinn/evidence" },
          },
        },
      );
      expect(
        await context!.reader.getRecordLocations(
          fixtures.privateExecution.reference,
        ),
      ).toHaveLength(2);
    });

    test("makes equal puts idempotent and rejects unequal replay", async () => {
      expect(
        await context!.writer.putRecordProjection(fixtures.privateExecution),
      ).toMatchObject({ status: "created" });
      expect(
        await context!.writer.putRecordProjection(fixtures.privateExecution),
      ).toMatchObject({ status: "existing" });
      await expect(
        context!.writer.putRecordProjection({
          ...fixtures.privateExecution,
          byteSize: fixtures.privateExecution.byteSize + 1,
        }),
      ).rejects.toMatchObject({ code: "PROJECTION_CONFLICT" });
    });

    test("does not expose mutable stored projections", async () => {
      await context!.writer.putRecordProjection(fixtures.privateExecution);
      const returned = await context!.reader.getRecord(
        fixtures.privateExecution.reference,
      );
      (returned as { executionId: string }).executionId = "urn:changed";
      expect(
        await context!.reader.getRecord(fixtures.privateExecution.reference),
      ).toEqual(fixtures.privateExecution);
    });

    test("honors already-aborted operations", async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        context!.reader.getRecord(fixtures.privateExecution.reference, {
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "OPERATION_ABORTED" });
    });
  });
}

export { InMemoryEvidenceCatalog } from "./in-memory.js";
