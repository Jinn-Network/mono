import { parseEvidenceRecordReference } from "@jinn-network/evidence-repository";

import {
  assertCandidateSourceIdentity,
  referenceKey,
} from "./candidates.js";
import type {
  CandidateCheckpoint,
  CandidateCursor,
  CandidatePage,
  CandidateSource,
  CandidateSourceIdentity,
  CandidateSourceOperationOptions,
  CandidateSourceReport,
  CreateFederatedCandidateSourceOptions,
  FederatedCandidateContribution,
  FederatedCandidateGroup,
  FederatedProviderData,
  JsonValue,
  RetrievalLocationHint,
} from "./contracts.js";
import { EvidenceRetrievalError } from "./errors.js";
import { assertBoundedJson, mapBounded } from "./operation.js";

function sameIdentity(
  left: CandidateSourceIdentity,
  right: CandidateSourceIdentity,
): boolean {
  return left.id === right.id && left.version === right.version;
}

function assertUniqueSourceIdentities(
  identities: readonly CandidateSourceIdentity[],
): void {
  const seen = new Set<string>();
  for (const identity of identities) {
    assertCandidateSourceIdentity(identity);
    const key = `${identity.id}@${identity.version}`;
    if (seen.has(key)) {
      throw new EvidenceRetrievalError(
        "HOST_MISCONFIGURED",
        `Federated candidate source configures duplicate child identity ${key}.`,
      );
    }
    seen.add(key);
  }
}

function deduplicatedLocationHints(
  contributions: readonly FederatedCandidateContribution<unknown>[],
): readonly RetrievalLocationHint[] {
  const seen = new Set<string>();
  const hints: RetrievalLocationHint[] = [];
  for (const contribution of contributions) {
    for (const hint of contribution.locationHints) {
      const key = `${hint.sourceId} ${hint.repositoryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hints.push(hint);
    }
  }
  return hints;
}

interface CompositeCursorChild {
  readonly sourceId: string;
  readonly sourceVersion: string;
  readonly value: JsonValue;
}

interface CompositeCursorEnvelope {
  readonly federated: true;
  readonly identityId: string;
  readonly identityVersion: string;
  readonly children: readonly CompositeCursorChild[];
}

function isCompositeCursorEnvelope(
  value: unknown,
): value is CompositeCursorEnvelope {
  return (
    typeof value === "object"
    && value !== null
    && (value as { readonly federated?: unknown }).federated === true
    && typeof (value as { readonly identityId?: unknown }).identityId === "string"
    && typeof (value as { readonly identityVersion?: unknown }).identityVersion === "string"
    && Array.isArray((value as { readonly children?: unknown }).children)
  );
}

function decodeChildContinuation<Envelope extends CandidateCursor | CandidateCheckpoint>(
  composite: Envelope | undefined,
  identity: CandidateSourceIdentity,
  childIdentities: readonly CandidateSourceIdentity[],
  kind: "cursor" | "checkpoint",
): ReadonlyMap<string, JsonValue> {
  const byChild = new Map<string, JsonValue>();
  if (composite === undefined) return byChild;
  if (!sameIdentity(composite.source, identity)) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Federated ${kind} source identity does not match the configured composite source.`,
    );
  }
  const value = composite.value;
  if (
    !isCompositeCursorEnvelope(value)
    || value.identityId !== identity.id
    || value.identityVersion !== identity.version
  ) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      `Federated ${kind} value is not a package-owned composite envelope.`,
    );
  }
  const known = new Set(
    childIdentities.map((child) => `${child.id}@${child.version}`),
  );
  for (const child of value.children) {
    const key = `${child.sourceId}@${child.sourceVersion}`;
    if (!known.has(key)) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        `Federated ${kind} references an unconfigured child source ${key}.`,
      );
    }
    byChild.set(key, child.value);
  }
  return byChild;
}

export function createFederatedCandidateSource<
  Query,
  ChildData = unknown,
  CombinedData = unknown,
>(
  options: CreateFederatedCandidateSourceOptions<
    Query,
    ChildData,
    CombinedData
  >,
): CandidateSource<
  Query,
  FederatedProviderData<ChildData, CombinedData>
> {
  if (options.sources.length === 0) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "A federated candidate source requires at least one configured child.",
    );
  }
  const maximumConcurrency = options.maximumConcurrency ?? 4;
  if (
    !Number.isSafeInteger(maximumConcurrency)
    || maximumConcurrency <= 0
    || maximumConcurrency > 32
  ) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federation concurrency must be an integer from 1 through 32.",
    );
  }
  assertCandidateSourceIdentity(options.identity);
  assertUniqueSourceIdentities(options.sources.map(({ identity }) => identity));
  const identity = Object.freeze({ ...options.identity });
  return Object.freeze({
    identity,
    find: (query: Query, operation: CandidateSourceOperationOptions) => findFederatedPage(
      { ...options, identity, maximumConcurrency },
      query,
      operation,
    ),
  });
}

async function findFederatedPage<Query, ChildData, CombinedData>(
  options: CreateFederatedCandidateSourceOptions<Query, ChildData, CombinedData> & {
    readonly identity: CandidateSourceIdentity;
    readonly maximumConcurrency: number;
  },
  query: Query,
  operation: CandidateSourceOperationOptions,
): Promise<CandidatePage<FederatedProviderData<ChildData, CombinedData>>> {
  const childIdentities = options.sources.map(({ identity }) => identity);

  let allocations: readonly number[];
  try {
    allocations = options.allocate(
      operation.maximumCandidates,
      childIdentities,
      query,
    );
  } catch {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federated allocation callback threw while allocating candidates.",
    );
  }
  if (
    allocations.length !== options.sources.length
    || allocations.some(
      (allocation) => !Number.isSafeInteger(allocation) || allocation <= 0,
    )
  ) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federated allocation callback must allocate one positive integer per configured child.",
    );
  }
  const totalAllocated = allocations.reduce((sum, value) => sum + value, 0);
  if (totalAllocated > operation.maximumCandidates) {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federated allocation callback allocated more than the requested maximum.",
    );
  }
  if (operation.maximumCandidates < options.sources.length) {
    throw new EvidenceRetrievalError(
      "INVALID_INPUT",
      "Federated candidate source requires a maximum at least as large as the configured child count.",
    );
  }

  const cursorByChild = decodeChildContinuation(
    operation.cursor,
    options.identity,
    childIdentities,
    "cursor",
  );
  const checkpointByChild = decodeChildContinuation(
    operation.checkpoint,
    options.identity,
    childIdentities,
    "checkpoint",
  );

  const leaves = await mapBounded(
    options.sources,
    options.maximumConcurrency,
    async (child, index) => {
      const childKey = `${child.identity.id}@${child.identity.version}`;
      const childCursorValue = cursorByChild.get(childKey);
      const childCheckpointValue = checkpointByChild.get(childKey);
      try {
        const page = await child.find(query, {
          signal: operation.signal,
          timeoutMs: operation.timeoutMs,
          maximumCandidates: allocations[index]!,
          ...(childCursorValue === undefined ? {} : {
            cursor: { source: child.identity, value: childCursorValue },
          }),
          ...(childCheckpointValue === undefined ? {} : {
            checkpoint: {
              source: child.identity,
              value: childCheckpointValue,
              replayable: false,
            },
          }),
        });
        return { ok: true as const, child, page };
      } catch {
        return { ok: false as const, child };
      }
    },
  );

  const groups: FederatedCandidateGroup<ChildData>[] = [];
  const groupByKey = new Map<string, FederatedCandidateGroup<ChildData>>();
  const sourceReports: CandidateSourceReport[] = [];
  const nextCursorChildren: {
    readonly sourceId: string;
    readonly sourceVersion: string;
    readonly value: JsonValue;
  }[] = [];
  const checkpointChildren: {
    readonly sourceId: string;
    readonly sourceVersion: string;
    readonly value: JsonValue;
  }[] = [];
  let everyLeafCheckpointReplayable = true;
  let anySuccessfulLeafHasCheckpoint = false;

  for (const leaf of leaves) {
    if (!leaf.ok) {
      sourceReports.push({
        source: leaf.child.identity,
        status: "failed",
        candidatesReturned: 0,
        failure: {
          code: "SOURCE_FAILED",
          stage: "source",
          message: "A configured child candidate source failed.",
          retryable: true,
          source: leaf.child.identity,
        },
      });
      continue;
    }
    const { child, page } = leaf;
    if (!sameIdentity(page.source, child.identity)) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "A configured child candidate source returned a mismatched identity.",
      );
    }
    if (page.candidates.length > allocations[options.sources.indexOf(child)]!) {
      throw new EvidenceRetrievalError(
        "INVALID_INPUT",
        "A configured child candidate source exceeded its allocated maximum.",
      );
    }
    page.candidates.forEach((candidate, ordinal) => {
      const reference = parseEvidenceRecordReference(candidate.reference);
      const locationHints = candidate.locationHints ?? [];
      assertBoundedJson(
        candidate.providerData,
        64 * 1024,
        "federated child provider metadata",
      );
      const contribution: FederatedCandidateContribution<ChildData> = {
        source: child.identity,
        ordinal,
        ...(candidate.providerData === undefined
          ? {}
          : { providerData: candidate.providerData }),
        locationHints,
      };
      const key = referenceKey(reference);
      const group = groupByKey.get(key) ?? {
        reference,
        contributions: [] as FederatedCandidateContribution<ChildData>[],
      };
      (group.contributions as FederatedCandidateContribution<ChildData>[]).push(contribution);
      if (!groupByKey.has(key)) {
        groupByKey.set(key, group);
        groups.push(group);
      }
    });
    sourceReports.push({
      source: child.identity,
      status: "complete",
      candidatesReturned: page.candidates.length,
    });
    if (page.nextCursor !== undefined) {
      nextCursorChildren.push({
        sourceId: child.identity.id,
        sourceVersion: child.identity.version,
        value: page.nextCursor.value,
      });
    }
    if (page.checkpoint !== undefined) {
      anySuccessfulLeafHasCheckpoint = true;
      checkpointChildren.push({
        sourceId: child.identity.id,
        sourceVersion: child.identity.version,
        value: page.checkpoint.value,
      });
      if (!page.checkpoint.replayable) everyLeafCheckpointReplayable = false;
    } else {
      everyLeafCheckpointReplayable = false;
    }
  }

  let ordered;
  try {
    ordered = options.order(groups, query);
  } catch {
    throw new EvidenceRetrievalError(
      "HOST_MISCONFIGURED",
      "Federated ordering callback threw while ordering candidates.",
    );
  }
  const seenOrdered = new Set<string>();
  const candidates = ordered.map((entry) => {
    const key = referenceKey(entry.reference);
    const group = groupByKey.get(key);
    if (!group) {
      throw new EvidenceRetrievalError(
        "HOST_MISCONFIGURED",
        "Federated ordering callback invented a reference outside the observed groups.",
      );
    }
    if (seenOrdered.has(key)) {
      throw new EvidenceRetrievalError(
        "HOST_MISCONFIGURED",
        "Federated ordering callback returned the same reference more than once.",
      );
    }
    seenOrdered.add(key);
    return {
      reference: entry.reference,
      providerData: {
        contributions: group.contributions,
        ...(entry.combinedData === undefined
          ? {}
          : { combinedData: entry.combinedData }),
      },
      locationHints: deduplicatedLocationHints(group.contributions),
    };
  });

  const nextCursor: CandidateCursor | undefined = nextCursorChildren.length === 0
    ? undefined
    : {
        source: options.identity,
        value: {
          federated: true,
          identityId: options.identity.id,
          identityVersion: options.identity.version,
          children: nextCursorChildren,
        },
      };
  const checkpoint: CandidateCheckpoint | undefined = checkpointChildren.length === 0
    ? undefined
    : {
        source: options.identity,
        value: {
          federated: true,
          identityId: options.identity.id,
          identityVersion: options.identity.version,
          children: checkpointChildren,
        },
        replayable: anySuccessfulLeafHasCheckpoint && everyLeafCheckpointReplayable,
      };

  return {
    source: options.identity,
    candidates,
    sourceReports,
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}
