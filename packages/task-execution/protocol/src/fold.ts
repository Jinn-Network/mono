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

function dedupe(observations: readonly ProtocolObservation[]): ProtocolObservation[] {
  const seen = new Set<string>();
  const result: ProtocolObservation[] = [];
  for (const observation of observations) {
    // A raw byte (not an escape) was used as the delimiter here pre-fix -- invisible in a
    // normal read, and (like the fake backend's idempotency scope key, see
    // testing/src/fake-backend.ts) it made this file register as binary to git, hiding this
    // function's diffs from review. Named and escaped explicitly now; same delimiter role
    // (source/id are unconstrained strings, so an undelimited or ambiguous join could
    // collide two distinct pairs into one dedupe key), same U+001F convention this tree
    // already uses in `deriveAttemptUri` and the fake backend's idempotency scope.
    const key = `${observation.source}\u001f${observation.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(observation);
  }
  return result;
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
 */
export function foldObservations(
  observations: readonly ProtocolObservation[],
  opts?: FoldObservationsOptions,
): DerivedAttemptState {
  const ordered = dedupe(observations)
    .slice()
    .sort((a, b) => (a.sequence < b.sequence ? -1 : a.sequence > b.sequence ? 1 : 0));
  const authoritativeSource = findAuthoritativeSource(ordered);

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
