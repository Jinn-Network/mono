import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";

import { CandidateAccumulator, referenceKey } from "./candidates.js";
import type {
  CandidateSourceIdentity,
  CandidateSourceIssue,
  CandidateSourceReport,
  EvidenceLocationPolicy,
  EvidenceRecordLocator,
  EvidenceRetrievalFailure,
  QueryEvidenceInput,
  QueryEvidenceOutcome,
  RetrievalDiagnostics,
  RetrievalHardLimits,
  RetrievalOperationOptions,
  RetrievalWarning,
  ValidatedEvidenceAcceptance,
  ValidatedEvidenceResult,
} from "./contracts.js";
import { EvidenceRetrievalError, createEvidenceRetrievalFailure } from "./errors.js";
import { hydrateArtifacts } from "./artifacts.js";
import {
  assertBoundedJson,
  createOperationContext,
  mapBounded,
  validateQueryBounds,
  type OperationContext,
} from "./operation.js";
import { resolveValidatedRecord } from "./resolution.js";
import { createQuerySnapshotReceipt } from "./saved-query.js";

export interface QueryDependencies {
  readonly locator: EvidenceRecordLocator;
  readonly locationPolicy: EvidenceLocationPolicy;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly hardLimits: RetrievalHardLimits;
}

interface CandidateResolution<ProviderData> {
  readonly result?: ValidatedEvidenceResult<ProviderData>;
  readonly failures: readonly EvidenceRetrievalFailure[];
  readonly warnings: readonly RetrievalWarning[];
}

const LOGICAL_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;

function assertLogicalComponent(value: string, name: string): void {
  if (!LOGICAL_COMPONENT.test(value)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `${name} must use a bounded logical component.`,
    );
  }
}

function sameIdentity(
  left: CandidateSourceIdentity,
  right: CandidateSourceIdentity,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function validateInitialContinuation(
  identity: CandidateSourceIdentity,
  cursor: QueryEvidenceInput<unknown>["cursor"],
  checkpoint: QueryEvidenceInput<unknown>["checkpoint"],
  limits: RetrievalHardLimits,
): void {
  if (cursor !== undefined) {
    if (!sameIdentity(cursor.source, identity)) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "cursor source identity does not match the configured candidate source.",
      );
    }
    assertBoundedJson(cursor.value, limits.maxCursorBytes, "cursor");
  }
  if (checkpoint !== undefined) {
    if (!sameIdentity(checkpoint.source, identity)) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "checkpoint source identity does not match the configured candidate source.",
      );
    }
    assertBoundedJson(checkpoint.value, limits.maxCursorBytes, "checkpoint");
  }
}

function validateLiveAcceptanceIdentity(
  acceptance: ValidatedEvidenceAcceptance | undefined,
): void {
  if (acceptance === undefined) return;
  assertLogicalComponent(acceptance.id, "acceptance.id");
  assertLogicalComponent(acceptance.version, "acceptance.version");
}

function validateSavedInvocation(
  input: QueryEvidenceInput<unknown>,
): void {
  const saved = input.savedQuery;
  if (saved === undefined) return;
  if (!sameIdentity(saved.candidateSourceSet, input.candidateSource.identity)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "savedQuery.candidateSourceSet does not match the live candidateSource.",
    );
  }
  if (
    saved.resultLimit !== input.resultLimit
    || saved.candidateBudget !== input.candidateBudget
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "savedQuery limits do not match the live invocation.",
    );
  }
  const savedAcceptance = saved.acceptancePolicy;
  const liveAcceptance = input.acceptance;
  if (
    (savedAcceptance === undefined) !== (liveAcceptance === undefined)
    || (
      savedAcceptance !== undefined
      && liveAcceptance !== undefined
      && (
        savedAcceptance.id !== liveAcceptance.id
        || savedAcceptance.version !== liveAcceptance.version
      )
    )
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "savedQuery acceptance identity does not match the live invocation.",
    );
  }
}

function classifySourceError(
  error: unknown,
  identity: CandidateSourceIdentity,
  context: OperationContext,
): EvidenceRetrievalFailure {
  if (context.timedOut()) {
    return createEvidenceRetrievalFailure({
      code: "TIMED_OUT",
      stage: "source",
      message: "The candidate source exceeded the operation deadline.",
      source: identity,
      retryable: true,
    });
  }
  if (context.signal.aborted) {
    return createEvidenceRetrievalFailure({
      code: "OPERATION_ABORTED",
      stage: "source",
      message: "The candidate source call was aborted by the caller.",
      source: identity,
      retryable: false,
    });
  }
  if (error instanceof EvidenceRetrievalError) {
    return createEvidenceRetrievalFailure({
      code: "PROVIDER_CONTRACT_VIOLATION",
      stage: "source",
      message: "The candidate source violated the provider contract.",
      source: identity,
      retryable: false,
    });
  }
  return createEvidenceRetrievalFailure({
    code: "SOURCE_FAILED",
    stage: "source",
    message: "The candidate source failed to return a page.",
    source: identity,
    retryable: true,
  });
}

function normalizeSourceReports(
  reports: readonly CandidateSourceReport[],
  limits: RetrievalHardLimits,
): readonly CandidateSourceReport[] {
  return reports.map((report) => {
    assertLogicalComponent(report.source.id, "sourceReports[].source.id");
    assertLogicalComponent(
      report.source.version,
      "sourceReports[].source.version",
    );
    if (!Number.isSafeInteger(report.candidatesReturned) || report.candidatesReturned < 0) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "sourceReports[].candidatesReturned must be a non-negative safe integer.",
      );
    }
    if (
      report.checkpoint !== undefined
      && !sameIdentity(report.checkpoint.source, report.source)
    ) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "sourceReports[].checkpoint source identity must match the report's source.",
      );
    }
    if (report.checkpoint !== undefined) {
      assertBoundedJson(
        report.checkpoint.value,
        limits.maxCursorBytes,
        "sourceReports[].checkpoint",
      );
    }
    return {
      source: report.source,
      status: report.status,
      candidatesReturned: report.candidatesReturned,
      ...(report.checkpoint === undefined ? {} : { checkpoint: report.checkpoint }),
      ...(report.failure === undefined
        ? {}
        : {
            failure: createEvidenceRetrievalFailure({
              code: report.failure.code,
              stage: report.failure.stage,
              message: "Candidate source reported a classified failure.",
              source: report.source,
              retryable: report.failure.retryable ?? false,
            }),
          }),
    };
  });
}

function mergeSourceReports(
  existing: readonly CandidateSourceReport[],
  incoming: readonly CandidateSourceReport[],
): readonly CandidateSourceReport[] {
  const byKey = new Map<string, CandidateSourceReport>();
  for (const report of existing) {
    byKey.set(`${report.source.id}@${report.source.version}`, report);
  }
  for (const report of incoming) {
    const key = `${report.source.id}@${report.source.version}`;
    const previous = byKey.get(key);
    if (!previous) {
      byKey.set(key, report);
      continue;
    }
    const status =
      previous.status === report.status
        ? report.status
        : "partial";
    byKey.set(key, {
      source: report.source,
      status,
      candidatesReturned: previous.candidatesReturned + report.candidatesReturned,
      ...(report.checkpoint === undefined
        ? (previous.checkpoint === undefined ? {} : { checkpoint: previous.checkpoint })
        : { checkpoint: report.checkpoint }),
      ...(report.failure === undefined
        ? (previous.failure === undefined ? {} : { failure: previous.failure })
        : { failure: report.failure }),
    });
  }
  return [...byKey.values()];
}

function buildDiagnostics(
  mode: "summary" | "detailed" | undefined,
  accumulator: CandidateAccumulator<unknown>,
  failures: readonly EvidenceRetrievalFailure[],
  providerIssues: readonly CandidateSourceIssue[],
  maxDiagnostics: number,
): RetrievalDiagnostics | undefined {
  if (mode === undefined) return undefined;
  const boundedFailures = failures.slice(0, maxDiagnostics).map((failure) =>
    mode === "detailed"
      ? failure
      : {
          code: failure.code,
          stage: failure.stage,
          message: failure.message,
          retryable: failure.retryable,
          ...(failure.reference === undefined ? {} : { reference: failure.reference }),
          ...(failure.source === undefined ? {} : { source: failure.source }),
        },
  );
  return {
    examinedCandidates: accumulator.examined,
    uniqueReferences: accumulator.groups.length,
    failures: boundedFailures,
    providerIssues: providerIssues.slice(0, maxDiagnostics),
  };
}

async function resolveCandidateGroup<Query, ProviderData>(
  dependencies: QueryDependencies,
  input: QueryEvidenceInput<Query, ProviderData>,
  group: {
    readonly reference: Parameters<typeof resolveValidatedRecord>[0]["reference"];
    readonly observations: ValidatedEvidenceResult<ProviderData>["discoveryProvenance"];
    readonly locationHints: Parameters<typeof resolveValidatedRecord>[0]["hints"];
  },
  context: OperationContext,
): Promise<CandidateResolution<ProviderData>> {
  const resolved = await resolveValidatedRecord({
    reference: group.reference,
    hints: group.locationHints,
    locator: dependencies.locator,
    locationPolicy: dependencies.locationPolicy,
    repositoryResolver: dependencies.repositoryResolver,
    context,
  });
  if (!resolved.ok) {
    return {
      failures: [...resolved.failures],
      warnings: [],
    };
  }

  if (input.acceptance) {
    let decision;
    try {
      decision = await input.acceptance.evaluate(resolved.record.validatedRecord);
    } catch {
      return {
        failures: [createEvidenceRetrievalFailure({
          code: "ACCEPTANCE_REJECTED",
          stage: "acceptance",
          message: `Acceptance policy ${input.acceptance.id}@${input.acceptance.version} threw while evaluating validated evidence.`,
          reference: group.reference,
        })],
        warnings: resolved.record.warnings,
      };
    }
    if (decision.status === "rejected") {
      return {
        failures: [createEvidenceRetrievalFailure({
          code: "ACCEPTANCE_REJECTED",
          stage: "acceptance",
          message: `Validated evidence was rejected by ${input.acceptance.id}@${input.acceptance.version}.`,
          reference: group.reference,
        })],
        warnings: resolved.record.warnings,
      };
    }
  }

  const hydration = await hydrateArtifacts({
    record: resolved.record,
    request: input.artifacts,
    repositoryResolver: dependencies.repositoryResolver,
    context,
  });
  return {
    result: {
      reference: group.reference,
      canonicalBytes: resolved.record.canonicalBytes,
      validatedRecord: resolved.record.validatedRecord,
      discoveryProvenance: group.observations,
      availability: resolved.record.availability,
      selectedLocation: resolved.record.selectedLocation,
      artifacts: hydration.results,
      completeness: hydration.completeness,
      warnings: [...resolved.record.warnings, ...hydration.warnings],
    },
    failures: [...resolved.record.failures, ...hydration.failures],
    warnings: hydration.warnings,
  };
}

export async function queryEvidence<Query, ProviderData>(
  dependencies: QueryDependencies,
  input: QueryEvidenceInput<Query, ProviderData>,
  operationOptions?: RetrievalOperationOptions,
): Promise<QueryEvidenceOutcome<ProviderData>> {
  validateQueryBounds(
    input.resultLimit,
    input.candidateBudget,
    dependencies.hardLimits,
  );
  validateInitialContinuation(
    input.candidateSource.identity,
    input.cursor,
    input.checkpoint,
    dependencies.hardLimits,
  );
  validateLiveAcceptanceIdentity(input.acceptance);
  validateSavedInvocation(input as QueryEvidenceInput<unknown>);

  const context = createOperationContext(
    dependencies.hardLimits,
    operationOptions,
  );
  const accumulator = new CandidateAccumulator<ProviderData>(
    input.candidateSource.identity,
    dependencies.hardLimits,
  );
  const results: ValidatedEvidenceResult<ProviderData>[] = [];
  const resultByKey = new Map<string, ValidatedEvidenceResult<ProviderData>>();
  const attempted = new Set<string>();
  const failures: EvidenceRetrievalFailure[] = [];
  let providerIssues: CandidateSourceIssue[] = [];
  let cursor = input.cursor;
  let sourceReports: readonly CandidateSourceReport[] = [];

  try {
    while (
      results.length < input.resultLimit
      && accumulator.examined < input.candidateBudget
    ) {
      const maximumCandidates = Math.min(
        input.candidateBudget - accumulator.examined,
        dependencies.hardLimits.maxCandidatePageSize,
      );
      let page;
      try {
        page = await input.candidateSource.find(input.sourceQuery, {
          signal: context.signal,
          timeoutMs: context.remainingMs(),
          maximumCandidates,
          ...(cursor === undefined ? {} : { cursor }),
          ...(input.checkpoint === undefined
            ? {}
            : { checkpoint: input.checkpoint }),
        });
        accumulator.append(page, maximumCandidates);
      } catch (error) {
        const sourceFailure = classifySourceError(
          error,
          input.candidateSource.identity,
          context,
        );
        failures.push(sourceFailure);
        sourceReports = mergeSourceReports(sourceReports, [{
          source: input.candidateSource.identity,
          status: "failed",
          candidatesReturned: 0,
          failure: sourceFailure,
        }]);
        break;
      }

      sourceReports = mergeSourceReports(
        sourceReports,
        normalizeSourceReports(
          page.sourceReports ?? [{
            source: page.source,
            status: "complete",
            candidatesReturned: page.candidates.length,
            ...(page.checkpoint === undefined
              ? {}
              : { checkpoint: page.checkpoint }),
          }],
          dependencies.hardLimits,
        ),
      );
      providerIssues = accumulator.providerIssues.slice(
        0,
        dependencies.hardLimits.maxDiagnostics,
      );

      for (const group of accumulator.groups) {
        const key = referenceKey(group.reference);
        const existing = resultByKey.get(key);
        if (existing) {
          const updated = {
            ...existing,
            discoveryProvenance: group.observations,
          };
          results[results.indexOf(existing)] = updated;
          resultByKey.set(key, updated);
        }
      }
      const pending = accumulator.groups.filter((group) => {
        const key = referenceKey(group.reference);
        if (attempted.has(key) || resultByKey.has(key)) return false;
        attempted.add(key);
        return true;
      });
      for (
        let offset = 0;
        offset < pending.length && results.length < input.resultLimit;
        offset += dependencies.hardLimits.maxRecordConcurrency
      ) {
        const batch = pending.slice(
          offset,
          offset + dependencies.hardLimits.maxRecordConcurrency,
        );
        const resolvedBatch = await mapBounded(
          batch,
          dependencies.hardLimits.maxRecordConcurrency,
          (group) => resolveCandidateGroup(
            dependencies,
            input,
            group,
            context,
          ),
        );
        for (const resolved of resolvedBatch) {
          failures.push(...resolved.failures);
          if (!resolved.result || results.length >= input.resultLimit) continue;
          results.push(resolved.result);
          resultByKey.set(
            referenceKey(resolved.result.reference),
            resolved.result,
          );
        }
      }

      const newCursor = accumulator.nextCursor;
      if (
        newCursor !== undefined
        && cursor !== undefined
        && newCursor.source.id === cursor.source.id
        && newCursor.source.version === cursor.source.version
        && JSON.stringify(newCursor.value) === JSON.stringify(cursor.value)
      ) {
        throw new EvidenceRetrievalError(
          "INVALID_INPUT",
          "Candidate source returned the same continuation cursor twice.",
        );
      }
      cursor = newCursor;
      if (!cursor || page.candidates.length === 0) break;
    }

    if (
      results.length < input.resultLimit
      && accumulator.examined >= input.candidateBudget
      && cursor
    ) {
      failures.push(createEvidenceRetrievalFailure({
        code: "CANDIDATE_BUDGET_EXCEEDED",
        stage: "candidate",
        message: "Candidate budget was exhausted before the result limit was filled.",
      }));
    }

    const allSourcesFailed =
      sourceReports.length > 0
      && sourceReports.every(({ status }) => status === "failed");
    const status = allSourcesFailed && results.length === 0
      ? "failed"
      : failures.length > 0
        || sourceReports.some(({ status: reportStatus }) => reportStatus !== "complete")
        ? "partial"
        : "complete";
    const diagnostics = buildDiagnostics(
      input.diagnostics,
      accumulator,
      failures,
      providerIssues,
      dependencies.hardLimits.maxDiagnostics,
    );
    return {
      status,
      results,
      sourceReports,
      ...(cursor === undefined ? {} : { nextCursor: cursor }),
      ...(input.savedQuery === undefined
        ? {}
        : {
            snapshotReceipt: createQuerySnapshotReceipt(
              input.savedQuery,
              sourceReports,
              new Date().toISOString(),
            ),
          }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    };
  } finally {
    context.dispose();
  }
}
