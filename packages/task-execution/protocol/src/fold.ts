import { compareCodeUnitStrings } from "./order.js";
import type { ProtocolObservation } from "./schemas/observation.js";
import type { AttemptState, FailureBlame } from "./states.js";

/** Pure projection over an Attempt's observation log (§9/§10.4/§22). */
export interface DerivedAttemptState {
  state: AttemptState;
  terminal: boolean;
  contradictory: boolean;
  cancelRequested: boolean;
  blame?: FailureBlame;
  executor?: string;
  effectiveDeadline?: string;
  executionIds: readonly string[];
  deliveries: readonly { digest: `sha256:${string}` }[];
}

/**
 * The §9/§22 Attempt projection, materialized at `observe()`'s surface (backend, Task 2.x;
 * program §7.16). Defined here so the frozen §22 name is a real export; its reference fields
 * (`task`/`submission`/`annotations`) are supplied at materialization time by the consumer that
 * holds the Submission + dispatch context — the pure log fold below does not carry them.
 */
export interface AttemptDescriptor {
  attempt: `urn:uuid:${string}`;
  task: `sha256:${string}`;
  submission: `urn:uuid:${string}`;
  annotations?: Readonly<Record<string, unknown>>;
  derived: DerivedAttemptState;
}

export interface FoldObservationsOptions {
  /** The clock reading to derive provisional `expired` against (§10.4 rule 5). */
  now?: string;
  /** The Attempt's effective absolute deadline, from the engaging Submission. */
  effectiveDeadline?: string;
}

type TerminalObservation = Extract<
  ProtocolObservation,
  { type: "network.jinn.task-execution.attempt-terminal.v1" }
>;

function isTerminal(observation: ProtocolObservation): observation is TerminalObservation {
  return observation.type === "network.jinn.task-execution.attempt-terminal.v1";
}

/**
 * Two observations from one producer share a (`source`, `id`) pair but disagree on what the fold
 * reads. §10.1 makes the pair unique per producer, so this is not the duplicate §10.4 rule 2 drops,
 * and keeping either one would let array position pick the Attempt's state. The fold refuses, in
 * either order, as `@jinn-network/policy-outcomes` and `@jinn-network/task-curation` do for their
 * own dedupe keys. `category` is §13's `protocol-violation`, the same plain shape
 * `InvalidDocumentError` carries.
 */
export class ConflictingObservationError extends Error {
  readonly category = "protocol-violation" as const;
  constructor(readonly source: string, readonly id: string) {
    super(`observations share source "${source}" and id "${id}" but disagree (§10.1, §10.4 rule 2)`);
    this.name = "ConflictingObservationError";
  }
}

/**
 * Canonical text of a payload: key order is not content, and neither is an explicit `undefined`.
 * Iterative, because `annotations` has no depth bound and a recursive walk would overflow the stack
 * on a record a checker of untrusted sets has to report, not die on.
 */
function canonicalText(root: unknown): string {
  type Step = { readonly text: string } | { readonly value: unknown };
  const parts: string[] = [];
  const pending: Step[] = [{ value: root }];
  while (pending.length > 0) {
    const step = pending.pop()!;
    if ("text" in step) {
      parts.push(step.text);
    } else if (Array.isArray(step.value)) {
      const items = step.value as readonly unknown[];
      pending.push({ text: "]" });
      for (let index = items.length - 1; index >= 0; index -= 1) {
        pending.push({ value: items[index] });
        if (index > 0) pending.push({ text: "," });
      }
      pending.push({ text: "[" });
    } else if (typeof step.value === "object" && step.value !== null) {
      const record = step.value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareCodeUnitStrings);
      pending.push({ text: "}" });
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]!;
        pending.push({ value: record[key] });
        pending.push({ text: `${index > 0 ? "," : ""}${JSON.stringify(key)}:` });
      }
      pending.push({ text: "{" });
    } else {
      parts.push(String(JSON.stringify(step.value)));
    }
  }
  return parts.join("");
}

/** One observation with what the fold compares it by. Two with the same `dedupeKey` and `reads`
 * are the same observation to this fold: nothing else about them can change its result. */
interface FoldEntry {
  readonly observation: ProtocolObservation;
  readonly dedupeKey: string;
  readonly reads: string;
}

function toFoldEntry(observation: ProtocolObservation): FoldEntry {
  return {
    observation,
    // A raw byte (not an escape) was used as the delimiter here pre-fix -- invisible in a
    // normal read, and (like the fake backend's idempotency scope key, see
    // testing/src/fake-backend.ts) it made this file register as binary to git, hiding this
    // function's diffs from review. Named and escaped explicitly now; same delimiter role
    // (source/id are unconstrained strings, so an undelimited or ambiguous join could
    // collide two distinct pairs into one dedupe key), same U+001F convention this tree
    // already uses in `deriveAttemptUri` and the fake backend's idempotency scope.
    dedupeKey: `${observation.source}\u001f${observation.id}`,
    reads: `${observation.type}\u001f${canonicalText(observation.data)}`,
  };
}

function compareFoldEntries(a: FoldEntry, b: FoldEntry): number {
  return compareCodeUnitStrings(a.observation.sequence, b.observation.sequence)
    || compareCodeUnitStrings(a.dedupeKey, b.dedupeKey)
    || compareCodeUnitStrings(a.reads, b.reads);
}

/**
 * §10.4 rules 2 and 3: `sequence` order with exact replays dropped. The tiebreaks after `sequence`
 * mean no array position decides anything, and they make every replay adjacent. An entry whose
 * key survives twice therefore disagrees with its twin (see `refuseConflicts`).
 */
function inFoldOrder(observations: readonly ProtocolObservation[]): FoldEntry[] {
  return observations
    .map(toFoldEntry)
    .sort(compareFoldEntries)
    .filter((entry, index, entries) => index === 0 || compareFoldEntries(entries[index - 1]!, entry) !== 0);
}

/**
 * Only the fold's own input can refuse it. §10.4 folds the authoritative source's observations, so
 * a producer outside that source contradicting itself is excluded like everything else it says,
 * and cannot take an Attempt's state away from the source that owns it.
 */
function refuseConflicts(entries: readonly FoldEntry[], authoritativeSource: string | undefined): void {
  const seen = new Set<string>();
  for (const { observation, dedupeKey } of entries) {
    if (authoritativeSource !== undefined && observation.source !== authoritativeSource) continue;
    if (seen.has(dedupeKey)) throw new ConflictingObservationError(observation.source, observation.id);
    seen.add(dedupeKey);
  }
}

/**
 * Resolves the authoritative terminal from the sequence-ordered list of `attempt-terminal`
 * observations (§10.4 rules 4 and 6). A single terminal is authoritative outright. Multiple
 * terminals resolve by walking in order: while the currently accepted terminal is the
 * quasi-terminal `lost`, a later terminal supersedes it without contradiction (rule 6); any
 * other terminal-to-terminal transition is contradictory, and the derived state is the first
 * terminal in sequence order (rule 4).
 */
function resolveTerminal(
  terminals: readonly TerminalObservation[],
): { accepted: TerminalObservation; contradictory: boolean } | undefined {
  if (terminals.length === 0) return undefined;
  let accepted = terminals[0]!;
  let contradictory = false;
  for (let i = 1; i < terminals.length; i++) {
    if (!contradictory && accepted.data.state === "lost") {
      accepted = terminals[i]!; // rule 6: quasi-terminal supersession, no contradiction
    } else {
      contradictory = true;
      accepted = terminals[0]!; // rule 4: contradictory falls back to the first-in-sequence terminal
    }
  }
  return { accepted, contradictory };
}

type EngagedObservation = Extract<
  ProtocolObservation,
  { type: "network.jinn.task-execution.attempt-engaged.v1" }
>;

/**
 * §10.1/§10.4: `attempt-engaged` pins the authoritative observation-producer source (its
 * `data.source` field) for the rest of the Attempt's log. If multiple `attempt-engaged`
 * observations from different sources appear (a race, or a forgery), the first one in sequence
 * order wins as the engagement — every other observation, including a later `attempt-engaged`
 * from a different source, is non-authoritative.
 */
function findAuthoritativeSource(ordered: readonly ProtocolObservation[]): string | undefined {
  for (const observation of ordered) {
    if (observation.type === "network.jinn.task-execution.attempt-engaged.v1") {
      return (observation as EngagedObservation).data.source;
    }
  }
  return undefined;
}

/**
 * Implements §10.4 exactly. Without `opts`, this is a pure log fold — no provisional `expired`.
 *
 * SELF-FILTER (§10.1/§10.4): the caller MAY hand this function a multi-source log (e.g. every
 * observation recorded for an Attempt, not pre-filtered). Once the first `attempt-engaged` in
 * sequence order pins the authoritative source, every observation whose envelope `source` does
 * not match it — including a forged or merely corroborating observation from a different
 * producer — is excluded from the fold entirely: it neither updates derived state nor
 * participates in terminal resolution (so it can never raise a false `contradictory`).
 *
 * @throws {ConflictingObservationError} when the authoritative source's log holds two observations
 * sharing a (`source`, `id`) pair that disagree. The result never depends on array order.
 */
export function foldObservations(
  observations: readonly ProtocolObservation[],
  opts?: FoldObservationsOptions,
): DerivedAttemptState {
  const entries = inFoldOrder(observations);
  const ordered = entries.map(({ observation }) => observation);
  const authoritativeSource = findAuthoritativeSource(ordered);
  refuseConflicts(entries, authoritativeSource);

  let running = false;
  let cancelRequested = false;
  let executor: string | undefined;
  let effectiveDeadline: string | undefined;
  const executionIds: string[] = [];
  const deliveries: { digest: `sha256:${string}` }[] = [];
  const terminals: TerminalObservation[] = [];

  for (const observation of ordered) {
    if (authoritativeSource !== undefined && observation.source !== authoritativeSource) continue;
    switch (observation.type) {
      case "network.jinn.task-execution.attempt-engaged.v1": {
        if (observation.data.executor !== undefined) executor = observation.data.executor;
        effectiveDeadline = observation.data.effectiveDeadline;
        break;
      }
      case "network.jinn.task-execution.attempt-started.v1": {
        running = true;
        if (observation.data.executor !== undefined) executor = observation.data.executor;
        break;
      }
      case "network.jinn.task-execution.cancel-requested.v1": {
        cancelRequested = true;
        break;
      }
      case "network.jinn.task-execution.execution-observed.v1": {
        executionIds.push(observation.data.executionId);
        break;
      }
      case "network.jinn.task-execution.delivery-recorded.v1": {
        // The Sha256Digest zod schema enforces the `sha256:<hex>` shape at runtime; regex-based
        // zod schemas infer as `string`, so the narrower template type is asserted here.
        deliveries.push({ digest: observation.data.digest as `sha256:${string}` });
        break;
      }
      default:
        break;
    }
    if (isTerminal(observation)) terminals.push(observation);
  }

  const resolved = resolveTerminal(terminals);
  if (resolved !== undefined) {
    return {
      state: resolved.accepted.data.state,
      terminal: true,
      contradictory: resolved.contradictory,
      cancelRequested,
      blame: resolved.accepted.data.blame,
      executor,
      effectiveDeadline,
      executionIds,
      deliveries,
    };
  }

  // No authoritative terminal in the log. Provisional `expired` derives only when the caller
  // supplies both a clock reading and the effective deadline (program §7.16 / §10.4 rule 5).
  if (
    opts?.now !== undefined
    && opts.effectiveDeadline !== undefined
    && new Date(opts.now).getTime() > new Date(opts.effectiveDeadline).getTime()
  ) {
    return {
      state: "expired",
      terminal: true,
      contradictory: false,
      cancelRequested,
      executor,
      effectiveDeadline,
      executionIds,
      deliveries,
    };
  }

  return {
    state: running ? "running" : "pending",
    terminal: false,
    contradictory: false,
    cancelRequested,
    executor,
    effectiveDeadline,
    executionIds,
    deliveries,
  };
}
