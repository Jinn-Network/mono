/**
 * Product-owned cancellation composition around the platform backend contract.
 *
 * The platform run generator deliberately owns dispatch, watch, classification, replacement,
 * and drain semantics. This decorator does not reproduce any of them. It only bridges the
 * product's durable per-run cancellation marker to the backend's existing `cancel(attempt)`
 * port while an attempt is observably nonterminal. The generator receives an AbortSignal only
 * after every tracked attempt has reached a terminal snapshot, so it stops before the next cell
 * without taking its `earlyClose` escape from a watch loop and losing an in-flight attempt.
 */

import { basename } from "node:path";
import { watch, type FSWatcher } from "node:fs";
import type { AttemptUri, ObservationSnapshot, SubmissionUri } from "@jinn-network/task-execution-backend";
import { cancelRequested } from "./cancel-marker.js";
import type { ProxiedBackend } from "./drive.js";
import { runCancelMarkerPath, runsDir } from "../workspace/layout.js";

export interface CancellationAwareBackendDeps {
  readonly workspaceDir: string;
  readonly draftId: string;
  /** Test/diagnostic observation only; never part of orchestration and never allowed to fail it. */
  readonly onAttemptNonterminal?: (attempt: string) => void;
}

export interface CancellationAwareBackend {
  readonly backend: ProxiedBackend;
  readonly signal: AbortSignal;
  /** Safe platform early-close view: durable marker AND no tracked nonterminal attempt. */
  readonly earlyClose: boolean;
  close(): Promise<void>;
}

function attemptFrom(snapshot: ObservationSnapshot): AttemptUri | undefined {
  const attempt = snapshot.descriptor.attempt;
  return typeof attempt === "string" && attempt.startsWith("urn:uuid:")
    ? attempt as AttemptUri
    : undefined;
}

export function createCancellationAwareBackend(
  backend: ProxiedBackend,
  deps: CancellationAwareBackendDeps,
): CancellationAwareBackend {
  const controller = new AbortController();
  const active = new Set<AttemptUri>();
  const pendingSubmissions = new Set<SubmissionUri>();
  const cancelSent = new Set<AttemptUri>();
  const announced = new Set<AttemptUri>();
  let pendingSubmitCount = 0;
  let drainingGeneration = false;
  let closed = false;
  let failure: unknown;
  let work = Promise.resolve();

  const checkMarker = async (): Promise<void> => {
    if (!cancelRequested(deps.workspaceDir, deps.draftId)) return;
    const workPending = pendingSubmitCount > 0 || pendingSubmissions.size > 0 || active.size > 0;
    if (workPending) drainingGeneration = true;
    if (!workPending && drainingGeneration) {
      controller.abort("run-cancelled-after-terminal-drain");
      return;
    }
    if (active.size === 0) return;
    if (backend.cancel === undefined) {
      throw new Error("local venue does not expose the backend cancellation port");
    }
    for (const attempt of active) {
      if (cancelSent.has(attempt)) continue;
      cancelSent.add(attempt);
      try {
        await backend.cancel(attempt, "run-cancelled");
      } catch (cause) {
        cancelSent.delete(attempt);
        throw cause;
      }
    }
  };

  const enqueueMarkerCheck = (): Promise<void> => {
    const step = work.then(checkMarker);
    work = step.catch((cause) => {
      failure ??= cause;
    });
    return step;
  };

  const markerName = basename(runCancelMarkerPath(deps.workspaceDir, deps.draftId));
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(runsDir(deps.workspaceDir), { persistent: false }, (_event, filename) => {
      if (closed || filename === null || filename.toString() !== markerName) return;
      void enqueueMarkerCheck().catch(() => {
        // Stored in `failure`; the foreground observe/close boundary surfaces it.
      });
    });
  } catch {
    // The bounded durable-marker poll below is the correctness path when watching is unavailable.
  }
  // `fs.watch` is a latency optimization, not a correctness dependency: notifications can be
  // coalesced or lost. This bounded-period host poll re-reads the durable marker while the run
  // call is alive, and `close` always tears it down.
  const poll = setInterval(() => {
    if (closed) return;
    void enqueueMarkerCheck().catch(() => {
      // Stored in `failure`; the foreground observe/close boundary surfaces it.
    });
  }, 25);
  poll.unref();

  const observe = async (ref: SubmissionUri | AttemptUri): Promise<ObservationSnapshot> => {
    if (failure !== undefined) throw failure;
    const materializing = pendingSubmissions.has(ref as SubmissionUri);
    let snapshot: ObservationSnapshot;
    try {
      snapshot = await backend.observe(ref);
    } catch (cause) {
      if (materializing) {
        pendingSubmissions.delete(ref as SubmissionUri);
        await enqueueMarkerCheck();
      }
      throw cause;
    }
    const attempt = attemptFrom(snapshot);
    if (attempt === undefined) {
      if (materializing) {
        pendingSubmissions.delete(ref as SubmissionUri);
        await enqueueMarkerCheck();
      }
      return snapshot;
    }

    if (snapshot.descriptor.derived.terminal) {
      active.delete(attempt);
      if (materializing) pendingSubmissions.delete(ref as SubmissionUri);
      await enqueueMarkerCheck();
    } else {
      active.add(attempt);
      // Add the materialized attempt before removing its accepted-submission placeholder: there
      // is never an observable zero-work gap in which the signal could abort.
      if (materializing) pendingSubmissions.delete(ref as SubmissionUri);
      if (!announced.has(attempt)) {
        announced.add(attempt);
        try {
          deps.onAttemptNonterminal?.(attempt);
        } catch {
          // Diagnostic/test hook only — cancellation and run accounting remain authoritative.
        }
      }
      // The hook may have synchronously started `run.cancel`, publishing the marker before its
      // first venue-probe await. Check immediately instead of waiting for a filesystem event.
      await enqueueMarkerCheck();
    }
    if (failure !== undefined) throw failure;
    return snapshot;
  };

  const decorated: ProxiedBackend = {
    capabilities: () => backend.capabilities(),
    async submit(taskBytes, submissionBytes, engagement) {
      pendingSubmitCount += 1;
      let ack: Awaited<ReturnType<ProxiedBackend["submit"]>>;
      try {
        ack = await backend.submit(taskBytes, submissionBytes, engagement);
      } catch (cause) {
        pendingSubmitCount -= 1;
        await enqueueMarkerCheck();
        throw cause;
      }
      pendingSubmitCount -= 1;
      if (ack.accepted) pendingSubmissions.add(ack.submission);
      await enqueueMarkerCheck();
      return ack;
    },
    observe,
    watch: backend.watch === undefined
      ? undefined
      : async function* (ref, cursor) {
        for await (const observation of backend.watch!(ref, cursor)) yield observation;
      },
    cancel: backend.cancel === undefined ? undefined : (attempt, reason) => backend.cancel!(attempt, reason),
    recover: (ref) => backend.recover(ref),
    deliveries: (attempt) => backend.deliveries(attempt),
    fetchDelivery: (ref) => backend.fetchDelivery(ref),
    fetchArtifact: backend.fetchArtifact === undefined ? undefined : (descriptor) => backend.fetchArtifact!(descriptor),
    drain: () => backend.drain(),
  };

  // Handles a marker that predates watcher creation (normally only a crash-recovery edge; the
  // public resume guard refuses it before venue boot).
  void enqueueMarkerCheck().catch(() => {
    // Stored in `failure`; foreground use surfaces it.
  });

  return {
    backend: decorated,
    signal: controller.signal,
    get earlyClose() {
      return pendingSubmitCount === 0
        && pendingSubmissions.size === 0
        && active.size === 0
        && cancelRequested(deps.workspaceDir, deps.draftId);
    },
    async close() {
      if (closed) return;
      closed = true;
      watcher?.close();
      clearInterval(poll);
      await work;
      if (failure !== undefined) throw failure;
    },
  };
}
