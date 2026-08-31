import { createHash } from "node:crypto";
import {
  cellIdempotencyKey,
  documentDigest,
  expectedCellSet,
  orderCellsByTask,
  submissionExtensionBlock,
  type BenchmarkRecord,
  type RunRecord,
} from "@jinn-network/benchmarking-records";
import { sealSubmission } from "@jinn-network/task-execution-protocol";
import type {
  BenchmarkExecutionBackend,
  BenchmarkObservationSnapshot,
} from "./backend-port.js";
import { assertCellCorrespondence, CellCorrespondenceError } from "./checks.js";

export type CellStatusKind =
  | "dispatch"
  | "claimed"
  | "delivered"
  | "judged"
  | "cancelled"
  | "error";

/** §7.4 replaceable terminal reasons — typed, never parsed from prose. */
export type ReplaceableReason = "expired" | "unscorable" | "exclusion-hit";

export interface CellStatusEvent {
  cellKey: string;
  armId: string;
  replicate: number;
  dispatch: number;
  kind: CellStatusKind;
  attempt?: string;
  submission?: `urn:uuid:${string}`;
  submissionDigest?: `sha256:${string}`;
  detail?: string;
  /** True when this terminal is replaceable under §7.4. */
  replaceable?: boolean;
  /** Typed replaceable reason when `replaceable` is true. */
  replaceableReason?: ReplaceableReason;
  /** Cancellation marker for assembly (`completeness.runOutcome: "cancelled"`). */
  cancelledRun?: boolean;
}

/** Injected clock — launch never owns timer policy beyond reading `now()`. */
export type Clock = {
  now(): Date;
};

/**
 * Injected wait/poll port for backends that do not advertise `watch`.
 * The host owns sleep/backoff; this package only awaits the port.
 */
export type AttemptWaitPort = {
  waitUntilTerminal(input: {
    backend: BenchmarkExecutionBackend;
    attempt: string;
    signal?: AbortSignal;
    closeAt: string;
  }): Promise<BenchmarkObservationSnapshot>;
};

/** Crash-safe resume: exact previously accepted Submission bytes for a dispatch. */
export type AcceptedSubmissionPort = {
  acceptedSubmissionBytes(
    runDigest: string,
    cellKey: string,
    dispatch: number,
  ): Uint8Array | undefined | Promise<Uint8Array | undefined>;
};

/**
 * Host-owned publication capture for one Jinn-managed dispatch. The runner never retains these
 * values: callers persist the exact sealed Submission and accepted observation snapshot in their
 * own durable accounting workspace.
 */
export type LaunchCapturePort = {
  /** Awaited before every backend submit, including replacements and resumed dispatches. */
  captureSubmission(input: {
    runDigest: `sha256:${string}`;
    cellKey: string;
    armId: string;
    replicate: number;
    dispatch: number;
    /** A defensive byte copy whose content is the exact sealed Submission. */
    bytes: Uint8Array;
  }): void | Promise<void>;
  /** Awaited after the backend has accepted and exposed its ObservationSnapshot. */
  captureObservation(input: {
    runDigest: `sha256:${string}`;
    cellKey: string;
    armId: string;
    replicate: number;
    dispatch: number;
    submission: `urn:uuid:${string}`;
    submissionDigest: `sha256:${string}`;
    snapshot: BenchmarkObservationSnapshot;
  }): void | Promise<void>;
};

/** Host-visible typed terminal facts beyond Attempt derived state (§7.4). */
export type HostTerminalFacts = {
  exclusionHit?: boolean;
  unscorable?: boolean;
};

/** Classify a terminal observation into status + §7.4 replaceability. */
export type TerminalClassifier = (input: {
  snapshot: BenchmarkObservationSnapshot;
  cellKey: string;
  armId: string;
  hostFacts?: HostTerminalFacts;
}) => {
  kind: CellStatusKind;
  replaceable: boolean;
  replaceableReason?: ReplaceableReason;
  detail?: string;
  judged?: boolean;
};

export interface LaunchOptions {
  runDigest: `sha256:${string}`;
  taskBytesFor(taskDigestHex: string): Uint8Array | Promise<Uint8Array>;
  signal?: AbortSignal;
  /**
   * Explicit owner early-close (distinct from natural `closeAt`). When true, assembly receives
   * `cancelledRun` after in-flight drain.
   */
  earlyClose?: boolean;
  /**
   * Injected clock for deadline = min(nowMs + cellWindowMs, closeAt) and for the
   * `pastClose` dispatch gate. REQUIRED: a Run's close boundary is evaluated against
   * a caller-supplied instant only. There is deliberately no wall-clock fallback —
   * an implicit one made every unpinned call site a dormant time bomb that detonated
   * when a fixture's absolute `closeAt` passed.
   */
  clock: Clock;
  mintSubmissionUri?: (idempotencyKey: string) => `urn:uuid:${string}`;
  requirementsOverride?: Record<string, unknown>;
  /** Opaque requester grants sealed into each newly-created Submission. Values are handles only;
   * the backend's resolver owns redemption and never returns them to this package. */
  capabilityGrants?: Readonly<Record<string, unknown>>;
  /** Fallback when `capabilities().watch` is false / `backend.watch` absent. */
  waitForTerminal?: AttemptWaitPort;
  /** Exact accepted Submission bytes for resume (no package journal). */
  acceptedSubmissions?: AcceptedSubmissionPort;
  /** Optional host-owned exact-byte / observation capture for publication accounting. */
  capture?: LaunchCapturePort;
  /** Optional §7.4 classifier (defaults to `defaultClassifyTerminal`). */
  classifyTerminal?: TerminalClassifier;
  /**
   * Task digests (hex, no `sha256:` prefix) giving the order tasks are dispatched in — the
   * beacon-derived execution order of a run bound by `beacon-binding/1` (issue #2976). Omission
   * keeps `expectedCellSet`'s `cellKey` order, which is what every unbound run uses. Reordering
   * never changes which cells run: a task this list does not name still runs, after the named
   * ones.
   */
  dispatchTaskOrder?: readonly string[];
  /** Optional host-visible exclusion/unscorable facts per Attempt. */
  hostTerminalFacts?(input: {
    cellKey: string;
    armId: string;
    attempt: string;
    snapshot: BenchmarkObservationSnapshot;
  }): HostTerminalFacts | undefined | Promise<HostTerminalFacts | undefined>;
  /**
   * Maximum number of distinct benchmark cells whose solve attempts may be active together.
   * Per-cell dispatches and replacements remain sequential. Omission preserves the historical
   * one-cell-at-a-time behavior.
   */
  maxConcurrentCells?: number;
}

/** Product-facing safety bound for one host-owned launch generation. */
export const MAX_CONCURRENT_CELLS = 32;

function resolvedMaxConcurrentCells(opts: LaunchOptions): number {
  const value = opts.maxConcurrentCells ?? 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONCURRENT_CELLS) {
    throw new Error(`maxConcurrentCells must be an integer between 1 and ${MAX_CONCURRENT_CELLS}`);
  }
  return value;
}

function mergePinningMaps(
  pinning: Record<string, unknown>,
  baseline: Record<string, unknown>,
): Record<string, unknown> {
  return { ...baseline, ...pinning };
}

function deterministicSubmissionUri(idempotencyKey: string): `urn:uuid:${string}` {
  const hex = createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return `urn:uuid:${uuid}`;
}

/**
 * Wall-clock `Clock` for a host that genuinely wants real time.
 *
 * Passing this is a decision the call site makes and a reviewer can see in the diff.
 * That is the whole point: the previous implicit fallback made the same choice
 * invisibly, at every site that simply forgot to pass a clock.
 */
export const systemClock: Clock = { now: () => new Date() };

/**
 * Deadline = min(nowMs + cellWindowMs, closeAt), calendar-strict RFC3339 Z.
 * Canonical `Run.policy.cellWindow` is a duration in milliseconds.
 */
export function computeCellDeadline(
  now: Date,
  cellWindowMs: number,
  closeAt: string,
): string {
  const windowEndMs = now.getTime() + cellWindowMs;
  const closeMs = Date.parse(closeAt);
  const deadlineMs = Number.isFinite(closeMs) ? Math.min(windowEndMs, closeMs) : windowEndMs;
  return new Date(deadlineMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * §7.4 default: only expired, unscorable, and exclusion-hit are replaceable.
 * judged / unjudged / invalidated / delivered / cancelled / submit-rejection are not.
 */
export function defaultClassifyTerminal(input: {
  snapshot: BenchmarkObservationSnapshot;
  hostFacts?: HostTerminalFacts;
}): ReturnType<TerminalClassifier> {
  if (input.hostFacts?.exclusionHit === true) {
    return {
      kind: "error",
      replaceable: true,
      replaceableReason: "exclusion-hit",
      detail: "exclusion-hit",
    };
  }
  if (input.hostFacts?.unscorable === true) {
    return {
      kind: "error",
      replaceable: true,
      replaceableReason: "unscorable",
      detail: "unscorable",
    };
  }
  const state = input.snapshot.descriptor.derived.state;
  if (state === "expired") {
    return {
      kind: "error",
      replaceable: true,
      replaceableReason: "expired",
      detail: "expired",
    };
  }
  if (state === "delivered") {
    return { kind: "delivered", replaceable: false };
  }
  if (state === "cancelled") {
    return { kind: "cancelled", replaceable: false, detail: "cancelled" };
  }
  if (state === "failed" || state === "rejected" || state === "lost") {
    return { kind: "error", replaceable: false, detail: state };
  }
  return { kind: "error", replaceable: false, detail: state };
}

async function waitForAttemptTerminal(
  backend: BenchmarkExecutionBackend,
  attempt: string,
  opts: LaunchOptions,
  closeAt: string,
): Promise<BenchmarkObservationSnapshot> {
  const capabilities = await backend.capabilities();
  if (capabilities.watch && backend.watch !== undefined) {
    let latest = await backend.observe(attempt as never);
    if (latest.descriptor.derived.terminal) return latest;
    for await (const _observation of backend.watch(attempt as never, latest.cursor)) {
      void _observation;
      if (opts.signal?.aborted || opts.earlyClose === true) break;
      latest = await backend.observe(attempt as never);
      if (latest.descriptor.derived.terminal) return latest;
      if (Date.parse(closeAt) <= opts.clock.now().getTime()) {
        return latest;
      }
    }
    return latest;
  }
  if (opts.waitForTerminal === undefined) {
    throw new Error(
      "launchAndWatch: backend does not advertise watch; inject waitForTerminal (no owned timer policy)",
    );
  }
  return opts.waitForTerminal.waitUntilTerminal({
    backend,
    attempt,
    signal: opts.signal,
    closeAt,
  });
}

type Coord = { cellKey: string; taskDigest: string; armId: string; replicate: number };

async function sealNewSubmission(input: {
  run: RunRecord;
  runDigest: `sha256:${string}`;
  coord: Coord;
  dispatch: number;
  opts: LaunchOptions;
  requirements: Record<string, unknown>;
}): Promise<{ bytes: Uint8Array; digest: `sha256:${string}`; uri: `urn:uuid:${string}` }> {
  const { run, runDigest, coord, dispatch, opts, requirements } = input;
  const idempotencyKey = cellIdempotencyKey(runDigest, coord.cellKey, dispatch);
  const submissionUri =
    opts.mintSubmissionUri?.(idempotencyKey) ?? deterministicSubmissionUri(idempotencyKey);
  const deadline = computeCellDeadline(
    opts.clock.now(),
    run.policy.cellWindow,
    run.closeAt,
  );
  const submissionDocument = {
    protocol: "https://spec.jinn.network/profiles/task-execution/v1",
    submission: submissionUri,
    task: { digest: { sha256: coord.taskDigest } },
    requester: run.owner,
    nonce: `${coord.cellKey}:${dispatch}`,
    idempotencyKey,
    deadline,
    // Publication profile v1: one sealed Submission authorizes one actual Attempt. Planned
    // replicates and replacements are distinct visible cell dispatches.
    attempts: { maxTotal: 1, maxConcurrent: 1 },
    requirements,
    ...(opts.capabilityGrants === undefined ? {} : { capabilityGrants: opts.capabilityGrants }),
    annotations: submissionExtensionBlock(runDigest, coord.cellKey, coord.armId),
  };
  const bytes = sealSubmission(submissionDocument);
  return { bytes, digest: documentDigest(bytes), uri: submissionUri };
}

async function dispatchAndWatchCell(input: {
  run: RunRecord;
  runDigest: `sha256:${string}`;
  backend: BenchmarkExecutionBackend;
  coord: Coord;
  dispatch: number;
  opts: LaunchOptions;
  inFlight: Set<string>;
}): Promise<CellStatusEvent[]> {
  const { run, runDigest, backend, coord, dispatch, opts, inFlight } = input;
  const arm = run.arms.find((candidate) => candidate.armId === coord.armId);
  if (arm === undefined) throw new Error(`unknown armId ${coord.armId}`);

  const expectedRequirements = mergePinningMaps(
    arm.pinning as Record<string, unknown>,
    run.policy.submissionBaseline as Record<string, unknown>,
  );
  const actualRequirements = opts.requirementsOverride ?? expectedRequirements;
  assertCellCorrespondence(expectedRequirements, actualRequirements);

  const taskBytes = await opts.taskBytesFor(coord.taskDigest);
  const taskDigest = documentDigest(taskBytes);
  if (taskDigest !== `sha256:${coord.taskDigest}`) {
    throw new Error(
      `task bytes for ${coord.taskDigest} digest to ${taskDigest}, expected sha256:${coord.taskDigest}`,
    );
  }

  const prior = await opts.acceptedSubmissions?.acceptedSubmissionBytes(
    runDigest,
    coord.cellKey,
    dispatch,
  );
  const sealed = prior !== undefined
    ? {
      bytes: prior,
      digest: documentDigest(prior),
      uri: (JSON.parse(new TextDecoder().decode(prior)) as { submission: `urn:uuid:${string}` }).submission,
    }
    : await sealNewSubmission({
      run,
      runDigest,
      coord,
      dispatch,
      opts,
      requirements: actualRequirements,
    });

  await opts.capture?.captureSubmission({
    runDigest,
    cellKey: coord.cellKey,
    armId: coord.armId,
    replicate: coord.replicate,
    dispatch,
    bytes: new Uint8Array(sealed.bytes),
  });
  const ack = await backend.submit(taskBytes, sealed.bytes);
  if (!ack.accepted) {
    // Submit rejection is NOT a §7.4 replacement trigger.
    return [{
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      dispatch,
      kind: "error",
      detail: ack.error.detail ?? ack.error.category,
      replaceable: false,
    }];
  }

  const snapshot = await backend.observe(ack.submission);
  const attempt = snapshot.descriptor.attempt;
  if (typeof attempt !== "string" || attempt.length === 0) {
    throw new Error("observe(ack.submission) did not materialize descriptor.attempt");
  }
  await opts.capture?.captureObservation({
    runDigest,
    cellKey: coord.cellKey,
    armId: coord.armId,
    replicate: coord.replicate,
    dispatch,
    submission: ack.submission,
    submissionDigest: ack.digest,
    snapshot,
  });
  inFlight.add(attempt);

  const events: CellStatusEvent[] = [{
    cellKey: coord.cellKey,
    armId: coord.armId,
    replicate: coord.replicate,
    dispatch,
    kind: "dispatch",
    attempt,
    submission: ack.submission,
    submissionDigest: ack.digest,
  }];

  if (!snapshot.descriptor.derived.terminal) {
    events.push({
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      dispatch,
      kind: "claimed",
      attempt,
      submission: ack.submission,
      submissionDigest: ack.digest,
    });
  }

  const terminalSnap = snapshot.descriptor.derived.terminal
    ? snapshot
    : await waitForAttemptTerminal(backend, attempt, opts, run.closeAt);

  const hostFacts = await opts.hostTerminalFacts?.({
    cellKey: coord.cellKey,
    armId: coord.armId,
    attempt,
    snapshot: terminalSnap,
  });

  const classified = (opts.classifyTerminal ?? defaultClassifyTerminal)({
    snapshot: terminalSnap,
    cellKey: coord.cellKey,
    armId: coord.armId,
    ...(hostFacts === undefined ? {} : { hostFacts }),
  });

  events.push({
    cellKey: coord.cellKey,
    armId: coord.armId,
    replicate: coord.replicate,
    dispatch,
    kind: classified.kind,
    attempt,
    submission: ack.submission,
    submissionDigest: ack.digest,
    ...(classified.detail === undefined ? {} : { detail: classified.detail }),
    replaceable: classified.replaceable,
    ...(classified.replaceableReason === undefined
      ? {}
      : { replaceableReason: classified.replaceableReason }),
  });

  if (classified.judged === true && classified.kind !== "judged") {
    events.push({
      cellKey: coord.cellKey,
      armId: coord.armId,
      replicate: coord.replicate,
      dispatch,
      kind: "judged",
      attempt,
      submission: ack.submission,
      submissionDigest: ack.digest,
      replaceable: false,
    });
  }

  inFlight.delete(attempt);
  return events;
}

function maxDispatches(run: RunRecord): number {
  if (!run.policy.replacement.allowed) return 1;
  return (run.policy.replacement.maxPerCell ?? 1) + 1;
}

function pastClose(run: RunRecord, opts: LaunchOptions): boolean {
  return Date.parse(run.closeAt) <= opts.clock.now().getTime();
}

function ownerCancelled(opts: LaunchOptions): boolean {
  return opts.signal?.aborted === true || opts.earlyClose === true;
}

/**
 * Dispatch each expected cell via 2-arg `submit`, watch to a terminal boundary, and apply §7.4
 * replacement only for expired / unscorable / exclusion-hit terminals.
 *
 * Natural `closeAt` stops further dispatch/replacement without marking the run cancelled.
 * Only signal abort or explicit `earlyClose` sets `cancelledRun` for assembly.
 */
export async function* launchAndWatch(
  bench: BenchmarkRecord,
  run: RunRecord,
  backend: BenchmarkExecutionBackend,
  opts: LaunchOptions,
): AsyncGenerator<CellStatusEvent> {
  const cells = orderCellsByTask(expectedCellSet(bench, run), opts.dispatchTaskOrder);
  const maxPerCell = maxDispatches(run);
  const maxConcurrentCells = resolvedMaxConcurrentCells(opts);
  const inFlight = new Set<string>();
  let runCancelled = false;

  const drainInFlight = async function* (): AsyncGenerator<CellStatusEvent> {
    if (backend.cancel !== undefined) {
      for (const attempt of [...inFlight]) {
        try {
          await backend.cancel(attempt as never, "run-cancelled");
        } catch {
          // best-effort cancel; still drain via watch/wait
        }
      }
    }
    for (const attempt of [...inFlight]) {
      try {
        const snap = await waitForAttemptTerminal(backend, attempt, opts, run.closeAt);
        yield {
          cellKey: "drain",
          armId: "",
          replicate: 0,
          dispatch: 0,
          kind: snap.descriptor.derived.state === "cancelled" ? "cancelled" : "error",
          attempt,
          detail: `drain:${snap.descriptor.derived.state}`,
          cancelledRun: true,
        };
      } catch {
        yield {
          cellKey: "drain",
          armId: "",
          replicate: 0,
          dispatch: 0,
          kind: "cancelled",
          attempt,
          detail: "drain-to-boundary",
          cancelledRun: true,
        };
      }
      inFlight.delete(attempt);
    }
  };

  const runCell = async (coord: Coord): Promise<CellStatusEvent[]> => {
    const emitted: CellStatusEvent[] = [];
    let dispatch = 1;
    let lastReplaceable = false;
    do {
      if (ownerCancelled(opts)) {
        break;
      }
      if (pastClose(run, opts)) break;

      const events = await dispatchAndWatchCell({
        run,
        runDigest: opts.runDigest,
        backend,
        coord,
        dispatch,
        opts,
        inFlight,
      });
      emitted.push(...events);
      const terminal = events[events.length - 1]!;
      lastReplaceable = terminal.replaceable === true;
      if (!lastReplaceable) break;
      if (!run.policy.replacement.allowed) break;
      if (dispatch >= maxPerCell) break;
      if (pastClose(run, opts)) break;
      if (ownerCancelled(opts)) break;
      dispatch += 1;
    } while (lastReplaceable);
    return emitted;
  };

  type CompletedCell =
    | { readonly index: number; readonly events: CellStatusEvent[] }
    | { readonly index: number; readonly error: unknown };
  const active = new Map<number, Promise<CompletedCell>>();
  let nextCell = 0;
  let fatal = false;
  let fatalError: unknown;

  const admit = (): void => {
    while (
      active.size < maxConcurrentCells
      && nextCell < cells.length
      && !ownerCancelled(opts)
      && !pastClose(run, opts)
    ) {
      const index = nextCell;
      nextCell += 1;
      const coord = cells[index]!;
      active.set(index, runCell(coord).then(
        (events): CompletedCell => ({ index, events }),
        (error): CompletedCell => ({ index, error }),
      ));
    }
  };

  admit();
  while (active.size > 0) {
    const completed = await Promise.race(active.values());
    active.delete(completed.index);
    if ("error" in completed) {
      // A driver failure stops admission, but it is not run cancellation. Let already-admitted
      // peers reach their own durable terminal boundaries and emit those events before failing the
      // generation; cancelling them here would turn healthy cells into non-resumable terminals.
      if (!fatal) fatalError = completed.error;
      fatal = true;
    } else {
      for (const event of completed.events) yield event;
    }
    if (ownerCancelled(opts)) runCancelled = true;
    if (!runCancelled && !fatal) admit();
  }

  if (fatal) throw fatalError;

  if (ownerCancelled(opts)) runCancelled = true;

  if (runCancelled) {
    for await (const event of drainInFlight()) yield event;
    yield {
      cellKey: "*",
      armId: "*",
      replicate: 0,
      dispatch: 0,
      kind: "cancelled",
      detail: opts.signal?.aborted ? "signal-aborted" : "early-close",
      cancelledRun: true,
    };
  }
}

/**
 * Re-enter outstanding cells using backend durability + exact accepted Submission bytes when
 * the host supplies them. No package-local run journal.
 */
export async function* resumeRun(
  bench: BenchmarkRecord,
  run: RunRecord,
  backend: BenchmarkExecutionBackend,
  opts: LaunchOptions & {
    outstanding: readonly {
      cellKey: string;
      armId: string;
      replicate: number;
      taskDigest: string;
      dispatch: number;
    }[];
  },
): AsyncGenerator<CellStatusEvent> {
  void bench;
  const maxConcurrentCells = resolvedMaxConcurrentCells(opts);
  const inFlight = new Set<string>();
  if (ownerCancelled(opts)) {
    for (const cell of opts.outstanding) {
      yield {
        cellKey: cell.cellKey,
        armId: cell.armId,
        replicate: cell.replicate,
        dispatch: cell.dispatch,
        kind: "cancelled",
        detail: "drain-to-boundary",
        cancelledRun: true,
      };
    }
    return;
  }
  const runOutstanding = async (cell: (typeof opts.outstanding)[number]): Promise<CellStatusEvent[]> => {
    if (ownerCancelled(opts)) {
      return [{
        cellKey: cell.cellKey,
        armId: cell.armId,
        replicate: cell.replicate,
        dispatch: cell.dispatch,
        kind: "cancelled",
        detail: "drain-to-boundary",
        cancelledRun: true,
      }];
    }
    if (pastClose(run, opts)) {
      // Natural close on resume: do not re-dispatch; leave accounting to assembly.
      return [];
    }
    return dispatchAndWatchCell({
      run,
      runDigest: opts.runDigest,
      backend,
      coord: cell,
      dispatch: cell.dispatch,
      opts,
      inFlight,
    });
  };

  type CompletedOutstanding =
    | { readonly index: number; readonly events: CellStatusEvent[] }
    | { readonly index: number; readonly error: unknown };
  const active = new Map<number, Promise<CompletedOutstanding>>();
  let nextCell = 0;
  let fatal = false;
  let fatalError: unknown;
  const admit = (): void => {
    while (
      active.size < maxConcurrentCells
      && nextCell < opts.outstanding.length
      && !ownerCancelled(opts)
      && !pastClose(run, opts)
    ) {
      const index = nextCell;
      nextCell += 1;
      const cell = opts.outstanding[index]!;
      active.set(index, runOutstanding(cell).then(
        (events): CompletedOutstanding => ({ index, events }),
        (error): CompletedOutstanding => ({ index, error }),
      ));
    }
  };

  admit();
  while (active.size > 0) {
    const completed = await Promise.race(active.values());
    active.delete(completed.index);
    if ("error" in completed) {
      if (!fatal) fatalError = completed.error;
      fatal = true;
    } else {
      for (const event of completed.events) yield event;
    }
    if (!fatal) admit();
  }
  if (fatal) throw fatalError;
  if (ownerCancelled(opts)) {
    for (const cell of opts.outstanding.slice(nextCell)) {
      yield {
        cellKey: cell.cellKey,
        armId: cell.armId,
        replicate: cell.replicate,
        dispatch: cell.dispatch,
        kind: "cancelled",
        detail: "drain-to-boundary",
        cancelledRun: true,
      };
    }
  }
}

export { CellCorrespondenceError };
