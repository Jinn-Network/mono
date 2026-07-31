// SPDX-License-Identifier: Apache-2.0

import type {
  CaptureOrigin,
  FinalizeExecutionInput,
  StartExecutionRecordingInput,
} from "@jinn-network/execution-recorder";

import { PluginRuntimeError } from "../errors.js";
import type { ParsedSessionFeed } from "./feed.js";
import {
  CAPTURE_LICENSE,
  PRODUCER_IRI,
  PRODUCER_NAME,
  SESSION_FEED_FORMAT_IRI,
  SESSION_FEED_MEDIA_TYPE,
  SESSION_ID_PROPERTY,
  TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
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
  readonly trajectoryDigest: `sha256:${string}`;
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

export function buildStartInput(input: CaptureAssemblyInput): StartExecutionRecordingInput {
  const { feed } = input;
  const captureOrigin = origin(feed);
  const environment = environmentBytes(feed);

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
        // The forward link to the trajectory record, sealed inside the execution record.
        identifiers: [
          {
            propertyId: TRAJECTORY_RECORD_IDENTIFIER_PROPERTY,
            value: input.trajectoryDigest,
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
