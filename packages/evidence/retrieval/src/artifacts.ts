import {
  checkArtifactIntegrity,
  recordDigest,
} from "@jinn-network/evidence-protocol";
import { EvidenceRepositoryError } from "@jinn-network/evidence-repository";
import type { EvidenceRepositoryResolver } from "@jinn-network/evidence-discovery";

import type {
  ArtifactHydrationRequest,
  ArtifactRetrievalResult,
  ArtifactRetrievalStatus,
  DeclaredArtifact,
  EvidenceRetrievalFailure,
  RetrievalWarning,
  Sha256Digest,
} from "./contracts.js";
import { collectDeclaredArtifacts } from "./declared-artifacts.js";
import { EvidenceRetrievalError, createEvidenceRetrievalFailure } from "./errors.js";
import type { OperationContext } from "./operation.js";
import type { ResolvedValidatedRecord } from "./resolution.js";

export interface HydrateArtifactsInput {
  readonly record: ResolvedValidatedRecord;
  readonly request?: ArtifactHydrationRequest;
  readonly repositoryResolver: EvidenceRepositoryResolver;
  readonly context: OperationContext;
}

export interface ArtifactHydrationOutcome {
  readonly results: readonly ArtifactRetrievalResult[];
  readonly completeness: "complete" | "artifact-incomplete";
  readonly warnings: readonly RetrievalWarning[];
  readonly failures: readonly EvidenceRetrievalFailure[];
}

function declarationKey(declaration: DeclaredArtifact): string {
  return `${declaration.entityId} ${declaration.reference.digest}`;
}

function matchesSelector(
  declaration: DeclaredArtifact,
  selector: ArtifactHydrationRequest["selections"][number]["selector"],
): boolean {
  if (selector.kind === "entity-id") return declaration.entityId === selector.entityId;
  if (selector.kind === "digest") {
    return declaration.reference.digest === selector.digest;
  }
  return declaration.roles.includes(selector.role);
}

function classifyArtifactRepositoryError(
  error: unknown,
  context: OperationContext,
): ArtifactRetrievalStatus {
  if (error instanceof EvidenceRepositoryError) {
    switch (error.code) {
      case "ACCESS_DENIED":
        return "access-denied";
      case "CONTENT_TOO_LARGE":
        return "too-large";
      case "OPERATION_ABORTED":
        return context.timedOut() ? "timed-out" : "unavailable";
      case "CONTENT_CORRUPT":
        return "integrity-mismatch";
      default:
        return "unavailable";
    }
  }
  return "unavailable";
}

export async function hydrateArtifacts(
  input: HydrateArtifactsInput,
): Promise<ArtifactHydrationOutcome> {
  const { record, request, repositoryResolver, context } = input;
  const declarations = collectDeclaredArtifacts(record.validatedRecord);

  if (!request) {
    return {
      results: declarations.map((declaration) => ({
        declaration,
        status: "not-requested",
      })),
      completeness: "complete",
      warnings: [],
      failures: [],
    };
  }

  const requirementByKey = new Map<string, "required" | "optional">();
  for (const selection of request.selections) {
    for (const declaration of declarations) {
      if (!matchesSelector(declaration, selection.selector)) continue;
      const key = declarationKey(declaration);
      const existing = requirementByKey.get(key);
      requirementByKey.set(
        key,
        existing === "required" || selection.requirement === "required"
          ? "required"
          : "optional",
      );
    }
  }

  if (requirementByKey.size > context.maxArtifactCount) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Artifact hydration selects more than the ${context.maxArtifactCount}-artifact operation limit.`,
    );
  }

  const primaryRepositoryId = record.selectedLocation.repositoryId;
  const repositoryAttempts: {
    readonly repositoryId: string;
    readonly repository?: typeof record.repository;
  }[] = [];
  const seenRepositoryIds = new Set<string>();
  if (primaryRepositoryId !== undefined) {
    repositoryAttempts.push({
      repositoryId: primaryRepositoryId,
      repository: record.repository,
    });
    seenRepositoryIds.add(primaryRepositoryId);
  }
  for (const attempt of record.allowedLocationAttempts) {
    if (seenRepositoryIds.has(attempt.repositoryId)) continue;
    seenRepositoryIds.add(attempt.repositoryId);
    repositoryAttempts.push({ repositoryId: attempt.repositoryId });
  }

  const results: ArtifactRetrievalResult[] = [];
  const warnings: RetrievalWarning[] = [];
  const failures: EvidenceRetrievalFailure[] = [];
  let completeness: "complete" | "artifact-incomplete" = "complete";

  for (const declaration of declarations) {
    const key = declarationKey(declaration);
    const requirement = requirementByKey.get(key);
    if (!requirement) {
      results.push({ declaration, status: "not-requested" });
      continue;
    }

    let status: ArtifactRetrievalStatus = "unavailable";
    let bytes: Uint8Array | undefined;
    let actualDigest: Sha256Digest | undefined;
    let byteBudgetExceeded = false;

    for (const attempt of repositoryAttempts) {
      if (context.signal.aborted) {
        status = context.timedOut() ? "timed-out" : "unavailable";
        break;
      }
      try {
        const repository = attempt.repository
          ?? await repositoryResolver.resolve(attempt.repositoryId, {
            signal: context.signal,
          });
        if (!repository) continue;
        const fetched = await repository.getArtifact(declaration.reference, {
          signal: context.signal,
        });
        if (!fetched) continue;
        const effectiveMaximum = Math.min(
          context.maxArtifactBytes,
          repository.capabilities.maxObjectBytes ?? context.maxArtifactBytes,
        );
        if (fetched.byteLength > effectiveMaximum) {
          status = "too-large";
          continue;
        }
        if (!context.consumeArtifactBytes(fetched.byteLength)) {
          status = "too-large";
          byteBudgetExceeded = true;
          break;
        }
        let verified: boolean;
        let digest: Sha256Digest;
        if (record.validatedRecord.family === "execution-evidence") {
          const report = checkArtifactIntegrity(
            record.validatedRecord.value,
            new Map([[declaration.entityId, fetched]]),
          );
          const entry = report.artifacts.find(
            (candidate) => candidate.entityId === declaration.entityId,
          );
          verified = entry?.status === "verified";
          digest = entry?.actualDigest ?? recordDigest(fetched);
        } else {
          digest = recordDigest(fetched);
          verified = digest === declaration.reference.digest;
        }
        actualDigest = digest;
        if (!verified) {
          status = "integrity-mismatch";
          continue;
        }
        status = "verified";
        bytes = Uint8Array.from(fetched);
        break;
      } catch (error) {
        status = classifyArtifactRepositoryError(error, context);
        if (status === "timed-out") break;
      }
    }

    const result: ArtifactRetrievalResult = {
      declaration,
      requirement,
      status,
      ...(bytes ? { bytes } : {}),
      ...(actualDigest ? { actualDigest } : {}),
    };
    results.push(result);

    if (status !== "verified") {
      if (requirement === "required") {
        completeness = "artifact-incomplete";
        failures.push(
          createEvidenceRetrievalFailure({
            code: status === "integrity-mismatch"
              ? "ARTIFACT_INTEGRITY_MISMATCH"
              : "REQUIRED_ARTIFACT_UNAVAILABLE",
            stage: "artifact",
            message: status === "integrity-mismatch"
              ? "A required artifact's bytes did not match its declared digest."
              : "A required artifact could not be verified from any allowed location.",
            reference: record.reference,
            retryable: status === "unavailable" || status === "timed-out",
          }),
        );
      } else {
        warnings.push({
          code: status.toUpperCase().replaceAll("-", "_"),
          message: "An optional artifact could not be verified from any allowed location.",
        });
      }
      if (byteBudgetExceeded) {
        failures.push(
          createEvidenceRetrievalFailure({
            code: "BYTE_BUDGET_EXCEEDED",
            stage: "artifact",
            message: "The operation artifact-byte budget was exhausted.",
            reference: record.reference,
          }),
        );
      }
    }
  }

  return { results, completeness, warnings, failures };
}
