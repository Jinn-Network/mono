// SPDX-License-Identifier: Apache-2.0

import type { ProtocolObservation } from "@jinn-network/task-execution-protocol";
import { formatSequence } from "@jinn-network/task-execution-protocol";
import type { JournalEvent } from "@jinn-network/task-execution-supervisor";

export type ProjectableJournalEvent =
  | JournalEvent
  | (Omit<JournalEvent, "type"> & { readonly type: "execution-observed" });

function stringDetail(
  details: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = details[key];
  return typeof value === "string" ? value : undefined;
}

function sourceByAttempt(
  events: readonly ProjectableJournalEvent[],
): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "attempt-engaged") continue;
    const source = stringDetail(event.details, "source");
    if (source !== undefined && !result.has(event.attemptId)) {
      result.set(event.attemptId, source);
    }
  }
  return result;
}

function taskByAttempt(
  events: readonly ProjectableJournalEvent[],
): ReadonlyMap<string, `sha256:${string}`> {
  const result = new Map<string, `sha256:${string}`>();
  for (const event of events) {
    if (event.type !== "attempt-engaged") continue;
    const task = stringDetail(event.details, "taskDigest");
    if (task?.startsWith("sha256:") === true && !result.has(event.attemptId)) {
      result.set(event.attemptId, task as `sha256:${string}`);
    }
  }
  return result;
}

/**
 * Pure journal → TEP CloudEvents projection. Observation identity is a pure function of the
 * authoritative source, Attempt URI, and durable journal sequence, so a rebuild emits the same
 * `(source,id)` pairs byte-for-byte.
 */
export function projectObservations(
  events: readonly ProjectableJournalEvent[],
  options: { readonly defaultSource?: string } = {},
): ProtocolObservation[] {
  const sources = sourceByAttempt(events);
  const tasks = taskByAttempt(events);
  const projected: ProtocolObservation[] = [];

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.rejectedAtAppend === true) continue;
    const source =
      sources.get(event.attemptId)
      ?? stringDetail(event.details, "source")
      ?? options.defaultSource;
    if (source === undefined) {
      throw new TypeError(
        `journal event ${event.attemptId}/${event.seq} has no authoritative source`,
      );
    }
    const taskdigest = tasks.get(event.attemptId);
    const base = {
      specversion: "1.0" as const,
      id: `${source}/${event.attemptId}/${event.seq}`,
      source,
      subject: event.attemptId,
      time: event.time,
      datacontenttype: "application/json" as const,
      sequence: formatSequence(BigInt(event.seq)),
      ...(taskdigest === undefined ? {} : { taskdigest }),
    };

    switch (event.type) {
      case "attempt-engaged":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.attempt-engaged.v1",
          data: {
            attempt: event.details["attempt"],
            task: event.details["taskDigest"],
            submission: event.details["submission"],
            ...(event.details["executor"] === undefined
              ? {}
              : { executor: event.details["executor"] }),
            effectiveDeadline: event.details["effectiveDeadline"],
            source,
            dispatchContext: event.details["dispatchContext"],
            ...(event.details["annotations"] === undefined
              ? {}
              : { annotations: event.details["annotations"] }),
          },
        } as ProtocolObservation);
        break;
      case "attempt-started":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.attempt-started.v1",
          data: {
            startedAt: stringDetail(event.details, "startedAt") ?? event.time,
            ...(event.details["executor"] === undefined
              ? {}
              : { executor: event.details["executor"] }),
          },
        } as ProtocolObservation);
        break;
      case "progress":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.progress.v1",
          data: {
            ...(event.displayMessage === undefined
              && event.details["message"] === undefined
              ? {}
              : {
                  message:
                    event.displayMessage
                    ?? String(event.details["message"]),
                }),
            ...(typeof event.details["fraction"] === "number"
              ? { fraction: event.details["fraction"] }
              : {}),
          },
        });
        break;
      case "cancel-requested":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.cancel-requested.v1",
          data: {
            reason: stringDetail(event.details, "reason") ?? "cancel requested",
            requestedBy:
              stringDetail(event.details, "requestedBy") ?? "backend caller",
          },
        });
        break;
      case "cancel-acknowledged":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.cancel-acknowledged.v1",
          data: {
            acknowledgedBy:
              stringDetail(event.details, "acknowledgedBy") ?? source,
          },
        });
        break;
      case "execution-observed":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.execution-observed.v1",
          data: {
            executionId: event.details["executionId"],
            ...(event.details["evidenceRecord"] === undefined
              ? {}
              : { evidenceRecord: event.details["evidenceRecord"] }),
          },
        } as ProtocolObservation);
        break;
      case "delivery-recorded":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.delivery-recorded.v1",
          data: {
            digest: event.details["digest"],
            ...(event.details["locators"] === undefined
              ? {}
              : { locators: event.details["locators"] }),
          },
        } as ProtocolObservation);
        break;
      case "attempt-terminal":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.attempt-terminal.v1",
          data: {
            state: event.details["state"],
            ...(event.details["blame"] === undefined
              ? {}
              : { blame: event.details["blame"] }),
            ...(event.details["category"] === undefined
              ? {}
              : { category: event.details["category"] }),
            ...(event.details["detail"] === undefined
              ? {}
              : { detail: event.details["detail"] }),
            ...(Array.isArray(event.details["residualPids"])
              ? { residualPids: event.details["residualPids"] }
              : {}),
          },
        } as ProtocolObservation);
        break;
      case "spawn-intended":
      case "spawned":
      case "exec-finished":
      case "harvest-started":
      case "harvested":
      case "delivery-checkpointed":
      case "reconciliation":
        projected.push({
          ...base,
          type: "network.jinn.task-execution.progress.v1",
          data: { message: event.displayMessage ?? event.type },
        });
        break;
      default:
        break;
    }
  }

  return projected;
}
