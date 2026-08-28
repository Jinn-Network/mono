// SPDX-License-Identifier: Apache-2.0

import type {
  CaptureOrigin,
  FinalizeExecutionInput,
  InputCapture,
  RepositoryStateCapture,
  RuntimeComponentCapture,
  StartExecutionRecordingInput,
} from "@jinn-network/execution-recorder";

import { PluginRuntimeError } from "../errors.js";
import type { ParsedSessionFeed } from "./feed.js";
import {
  BASE_COMMIT_PROPERTY,
  BASE_TREE_PROPERTY,
  BRANCH_PROPERTY,
  CAPTURE_LICENSE,
  CONTROLLED_INPUT_ROLE_PROPERTY,
  MODEL_SERVICE_ENTITY_ID,
  PRODUCER_IRI,
  PRODUCER_NAME,
  REPOSITORY_BASE_STATE_ENTITY_ID,
  REPOSITORY_STATE_ENTITY_ID,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_ID_PROPERTY,
  TARGET_BASE_PROPERTY,
  TRACE_RECORD_IDENTIFIER_PROPERTY,
  controlledInputEntityId,
  executorIri,
} from "./identity.js";

const SUMMARY_LIMIT = 500;
const JSON_MEDIA_TYPE = "application/json";

export interface SessionOutcome {
  readonly outcome: "completed" | "failed" | "abandoned";
  readonly endedAt: string;
}

export interface CaptureAssemblyInput {
  readonly feed: ParsedSessionFeed;
  readonly feedPath: string;
  readonly workspaceDir: string;
  readonly producerVersion: string;
  readonly outcome: SessionOutcome;
  readonly traceDigest: `sha256:${string}`;
}

const encoder = new TextEncoder();

/** Object literal order is the serialization order; every call site fixes it explicitly. */
function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function origin(feed: ParsedSessionFeed): CaptureOrigin {
  // Every fact in the record derives from a feed the host reported and this runtime captured.
  return {
    kind: "executor-reported",
    reporter: executorIri(feed.open.host.name),
    capturedBy: PRODUCER_IRI,
  };
}

export function resolveSessionOutcome(
  feed: ParsedSessionFeed,
  override?: { readonly outcome?: SessionOutcome["outcome"]; readonly endedAt?: string },
): SessionOutcome {
  const outcome = override?.outcome ?? feed.close?.outcome;
  const endedAt = override?.endedAt ?? feed.close?.endedAt;
  if (outcome === undefined || endedAt === undefined) {
    throw new PluginRuntimeError(
      "capture-outcome-unknown",
      "The session feed carries no session-close event and no outcome was supplied.",
    );
  }
  if (!Number.isFinite(Date.parse(endedAt))) {
    throw new PluginRuntimeError("capture-outcome-unknown", `endedAt is not an instant: ${endedAt}`);
  }
  if (Date.parse(endedAt) < Date.parse(feed.open.startedAt)) {
    throw new PluginRuntimeError(
      "capture-outcome-unknown",
      `endedAt ${endedAt} precedes the session start ${feed.open.startedAt}.`,
    );
  }
  return { outcome, endedAt };
}

export function sessionSummary(feed: ParsedSessionFeed): string {
  const declared = feed.close?.summary.trim();
  if (declared !== undefined && declared.length > 0) return declared.slice(0, SUMMARY_LIMIT);
  for (const { event } of feed.lines) {
    if (event.type !== "user-turn") continue;
    const first = event.text.trim().split("\n")[0]?.trim() ?? "";
    if (first.length > 0) return first.slice(0, SUMMARY_LIMIT);
  }
  return "(no summary)";
}

function counts(feed: ParsedSessionFeed) {
  let userTurns = 0;
  let assistantTurns = 0;
  let toolCalls = 0;
  let failedToolCalls = 0;
  for (const { event } of feed.lines) {
    if (event.type === "user-turn") userTurns += 1;
    if (event.type === "assistant-turn") assistantTurns += 1;
    if (event.type === "tool-call") {
      toolCalls += 1;
      if (event.status === "error") failedToolCalls += 1;
    }
  }
  return { userTurns, assistantTurns, toolCalls, failedToolCalls };
}

function environmentBytes(feed: ParsedSessionFeed): Uint8Array {
  return encodeJson({
    host: { name: feed.open.host.name, version: feed.open.host.version },
    model: { provider: feed.open.model.provider, name: feed.open.model.name },
    tools: feed.environment?.tools ?? [],
    skills: feed.environment?.skills ?? [],
  });
}

/**
 * Binds the base repository state as a content-bound input — the first capture gap the
 * `autopilot-issue-1697` fixture records ("the original repository base commit/tree was never
 * captured").
 *
 * A dataset, because the subject is the repository tree rather than one file, and the recorder
 * requires a non-empty member list: the single member carries the Git object names, which are
 * the binding a verifier actually resolves.
 */
function repositoryState(
  feed: ParsedSessionFeed,
  captureOrigin: CaptureOrigin,
): RepositoryStateCapture | undefined {
  const observed = feed.repositoryState;
  if (observed === undefined) return undefined;

  const state = {
    repository: observed.repository,
    baseCommit: observed.baseCommit,
    baseTree: observed.baseTree,
    ...(observed.branch === undefined ? {} : { branch: observed.branch }),
    ...(observed.targetBase === undefined ? {} : { targetBase: observed.targetBase }),
  };

  return {
    artifact: {
      kind: "dataset",
      entityId: REPOSITORY_STATE_ENTITY_ID,
      manifest: {
        bytes: encodeJson(state),
        mediaType: JSON_MEDIA_TYPE,
        name: "repository.json",
      },
      members: [
        {
          kind: "file",
          entityId: REPOSITORY_BASE_STATE_ENTITY_ID,
          source: {
            bytes: encodeJson({ baseCommit: observed.baseCommit, baseTree: observed.baseTree }),
            mediaType: JSON_MEDIA_TYPE,
            name: "base-state.json",
          },
          origin: captureOrigin,
        },
      ],
      origin: captureOrigin,
    },
    identifiers: [
      { propertyId: BASE_COMMIT_PROPERTY, value: observed.baseCommit },
      { propertyId: BASE_TREE_PROPERTY, value: observed.baseTree },
      ...(observed.branch === undefined
        ? []
        : [{ propertyId: BRANCH_PROPERTY, value: observed.branch }]),
      ...(observed.targetBase === undefined
        ? []
        : [{ propertyId: TARGET_BASE_PROPERTY, value: observed.targetBase }]),
    ],
    repository: observed.repository,
  };
}

/**
 * Binds each producer-controlled input's exact bytes — the second capture gap ("producer-
 * controlled workflow, skill, prompt, and effective child configuration bytes are not bound to
 * immutable artifacts"). The recorder digests the bytes; the role identifier says which class
 * of controlled input each one is.
 */
function controlledInputs(
  feed: ParsedSessionFeed,
  captureOrigin: CaptureOrigin,
): readonly InputCapture[] {
  return feed.controlledInputs.map((controlled, index) => ({
    kind: "file",
    entityId: controlledInputEntityId(index, controlled.name),
    source: {
      bytes: controlled.bytes,
      mediaType: controlled.mediaType,
      name: controlled.name,
    },
    identifiers: [{ propertyId: CONTROLLED_INPUT_ROLE_PROPERTY, value: controlled.role }],
    origin: captureOrigin,
  }));
}

/**
 * Records the hosted model as an `opaque` runtime component when the host reports a full
 * service identity — the rest of the second gap ("the opaque hosted model has a service label
 * but no more precise deployment identity"). A producer cannot content-address a hosted
 * service, so the protocol asks for precise provider and deployment identification instead.
 */
function modelServiceComponent(
  feed: ParsedSessionFeed,
  captureOrigin: CaptureOrigin,
): RuntimeComponentCapture | undefined {
  const service = feed.open.model.service;
  if (service === undefined) return undefined;

  return {
    kind: "opaque",
    descriptor: {
      kind: "file",
      entityId: MODEL_SERVICE_ENTITY_ID,
      source: {
        bytes: encodeJson({
          provider: feed.open.model.provider,
          model: feed.open.model.name,
          service,
        }),
        mediaType: JSON_MEDIA_TYPE,
        name: "model-service.json",
      },
      origin: captureOrigin,
    },
    component: {
      entityId: service.iri,
      name: service.name ?? `${feed.open.model.provider} ${feed.open.model.name}`,
      ...(service.version === undefined ? {} : { softwareVersion: service.version }),
      ...(service.providerIri === undefined ? {} : { provider: service.providerIri }),
    },
  };
}

export function buildStartInput(input: CaptureAssemblyInput): StartExecutionRecordingInput {
  const { feed } = input;
  const captureOrigin = origin(feed);
  const environment = environmentBytes(feed);
  const baseState = repositoryState(feed, captureOrigin);
  const modelService = modelServiceComponent(feed, captureOrigin);

  return {
    workspaceDir: input.workspaceDir,
    startedAt: feed.open.startedAt,
    record: {
      name: "Jinn agent session",
      description: "An interactive agent session captured by the Jinn plugin runtime.",
      license: CAPTURE_LICENSE,
      executionName: `Agent session ${feed.sessionId}`,
      executionIdentifiers: [{ propertyId: SESSION_ID_PROPERTY, value: feed.sessionId }],
    },
    task: {
      entityId: "input/session-task.json",
      name: "Session task",
      source: {
        bytes: encodeJson({
          sessionId: feed.sessionId,
          summary: sessionSummary(feed),
          startedAt: feed.open.startedAt,
        }),
        mediaType: JSON_MEDIA_TYPE,
        name: "session-task.json",
      },
      origin: captureOrigin,
    },
    initialInputs: controlledInputs(feed, captureOrigin),
    ...(baseState === undefined ? {} : { repositoryState: baseState }),
    executor: {
      entityId: executorIri(feed.open.host.name),
      kind: "software",
      name: feed.open.host.name,
      softwareVersion: feed.open.host.version,
      origin: captureOrigin,
    },
    runtime: {
      entityId: "runtime/host.json",
      specification: {
        bytes: environment,
        mediaType: JSON_MEDIA_TYPE,
        name: "host.json",
      },
      name: `${feed.open.host.name} session runtime`,
      softwareVersion: feed.open.host.version,
      origin: captureOrigin,
      components: [
        {
          kind: "controlled",
          artifact: {
            kind: "file",
            entityId: "runtime/host-environment.json",
            source: {
              bytes: environment,
              mediaType: JSON_MEDIA_TYPE,
              name: "host-environment.json",
            },
            origin: captureOrigin,
          },
        },
        ...(modelService === undefined ? [] : [modelService]),
      ],
    },
    producer: {
      entityId: PRODUCER_IRI,
      kind: "software",
      name: PRODUCER_NAME,
      softwareVersion: input.producerVersion,
      origin: captureOrigin,
    },
  };
}

export function buildFinalizeInput(input: CaptureAssemblyInput): FinalizeExecutionInput {
  const { feed } = input;
  const captureOrigin = origin(feed);
  const tally = counts(feed);

  return {
    outcome: input.outcome.outcome,
    endedAt: input.outcome.endedAt,
    // Always present, so a completed execution never trips COMPLETED_RESULT_MISSING.
    results: [
      {
        kind: "file",
        entityId: "results/session-summary.json",
        source: {
          bytes: encodeJson({
            outcome: input.outcome.outcome,
            endedAt: input.outcome.endedAt,
            summary: sessionSummary(feed),
            userTurns: tally.userTurns,
            assistantTurns: tally.assistantTurns,
            toolCalls: tally.toolCalls,
            failedToolCalls: tally.failedToolCalls,
            ...(feed.tokens === undefined ? {} : { tokens: feed.tokens }),
          }),
          mediaType: JSON_MEDIA_TYPE,
          name: "session-summary.json",
        },
        origin: captureOrigin,
      },
    ],
    nativeTrace: {
      artifact: {
        kind: "file",
        entityId: "trace/feed.ndjson",
        // By path, never by bytes: bulk material moves on the filesystem (contract 4).
        source: {
          path: input.feedPath,
          mediaType: SESSION_FEED_MEDIA_TYPE,
          name: "feed.ndjson",
        },
        // The forward link to the trace record, sealed inside the execution record.
        identifiers: [
          {
            propertyId: TRACE_RECORD_IDENTIFIER_PROPERTY,
            value: input.traceDigest,
          },
        ],
        origin: captureOrigin,
      },
      format: {
        entityId: SESSION_FEED_FORMAT_IRI,
        name: "Jinn agent session feed",
      },
    },
  };
}
