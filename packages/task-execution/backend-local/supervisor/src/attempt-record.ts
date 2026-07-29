// SPDX-License-Identifier: Apache-2.0

import type { AttemptUri } from "@jinn-network/task-execution-backend";
import type { JournalEvent } from "./journal-types.js";

/**
 * A structural echo of the `launchers` package's `InterruptionBehavior` (design §6.3/§10.3).
 * Supervisor never imports `launchers` (Finding (e)), so this is declared locally; the assembly
 * hands a `LaunchPlan.interruptionBehavior` value across and TypeScript's structural typing
 * accepts it without a cross-package import.
 */
export const INTERRUPTION_BEHAVIORS = ["repeatable", "recoverable", "nonrepeatable"] as const;
export type InterruptionBehavior = (typeof INTERRUPTION_BEHAVIORS)[number];

/** One collected output artifact (design §6.3 outputs manifest). Structurally compatible with the `workspace` package's `OutputArtifact` — supervisor never imports `workspace`'s type (Finding (e)); the assembly hands harvest results across, and TypeScript's structural typing accepts them. */
export interface AttemptOutputArtifact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: `sha256:${string}` | string;
  readonly mediaType?: string;
}

/** The harvest input `foldAttemptRecord` optionally folds in (design §6.3) — structurally compatible with the `workspace` package's `HarvestResult`, never imported directly. */
export interface AttemptHarvestInput {
  readonly manifest: readonly AttemptOutputArtifact[];
  readonly omissions: readonly string[];
  readonly integrityViolations: readonly { readonly path: string; readonly reason: string }[];
}

/** The blame verdict on a `failed` (or otherwise blameable) terminal (design §6.3/§8.1). */
export interface BlameVerdict {
  readonly blame: "task" | "infrastructure";
  readonly reasonCode: string;
  readonly message?: string;
  readonly matchedRule?: Readonly<Record<string, unknown>>;
}

export const RECOVERY_ADVICE_VALUES = ["retry-safe", "resume-with-session", "do-not-retry"] as const;
/** A deliberate three-value reduction of the Evaluation Runner design's five-value enum (design §6.3): `retry-step`/`operator-action-required` are application-policy distinctions above this backend. */
export type RecoveryAdvice = (typeof RECOVERY_ADVICE_VALUES)[number];

export interface AttemptRecordOutcome {
  readonly exitCode: number | null;
  readonly termSignal: string | null;
  readonly envelope?: Readonly<Record<string, unknown>>;
  readonly blame?: BlameVerdict;
  readonly recoveryAdvice?: RecoveryAdvice;
  readonly interruptionBehavior?: InterruptionBehavior;
}

export interface AttemptPhaseTimestamps {
  readonly created?: string;
  readonly prepareStarted?: string;
  readonly execStarted?: string;
  readonly execFinished?: string;
  readonly harvested?: string;
  readonly recorded?: string;
}

export interface AttemptExecutorIdentity {
  readonly harnessName?: string;
  readonly harnessVersion?: string;
  readonly capabilityStrings?: readonly string[];
  readonly harnessSessionId?: string;
  readonly shimFingerprint?: { readonly pid: number; readonly startTime: number };
  readonly workspacePath?: string;
  readonly launchPlanDigest?: `sha256:${string}`;
}

export interface AttemptResourceUsage {
  readonly elapsedMsByPhase?: Readonly<Record<string, number>>;
  readonly peakMemoryBytes?: number;
}

/**
 * The durable per-attempt document (design §6.3, frozen interface §14 item 4), folded from the
 * journal plus an optional harvest result. Synthesizes Batch `attempts[]`, Nomad events, TES
 * logs, and Slurm accounting into one field set.
 */
export interface AttemptRecord {
  // identity and lineage
  readonly attemptUri: AttemptUri | string;
  readonly nonce?: string;
  readonly taskDigest?: `sha256:${string}`;
  readonly submissionUri?: string;
  readonly attemptNumber?: number;
  readonly supersededBy?: string;
  readonly priorAttempt?: string;

  readonly phaseTimestamps: AttemptPhaseTimestamps;

  readonly phase:
    | "engaged" | "spawn-intended" | "running" | "harvesting" | "recording" | "terminal";
  readonly terminal: boolean;
  readonly terminalState?: string;
  readonly contradictory: boolean;
  readonly outcome?: AttemptRecordOutcome;

  readonly outputsManifest: readonly AttemptOutputArtifact[];
  readonly omissions: readonly string[];
  readonly integrityViolations: readonly { readonly path: string; readonly reason: string }[];

  readonly executor: AttemptExecutorIdentity;
  readonly resourceUsage?: AttemptResourceUsage;

  /** The raw intact journal events this record was folded from — kept for reconciliation and inspection. */
  readonly events: readonly JournalEvent[];
}

function latestDetail(events: readonly JournalEvent[], type: JournalEvent["type"]): JournalEvent | undefined {
  let found: JournalEvent | undefined;
  for (const event of events) if (event.type === type) found = event;
  return found;
}

function phaseTimestampsFrom(events: readonly JournalEvent[]): AttemptPhaseTimestamps {
  return {
    created: latestDetail(events, "attempt-engaged")?.time,
    prepareStarted: latestDetail(events, "spawn-intended")?.time,
    execStarted: latestDetail(events, "spawned")?.time,
    execFinished: latestDetail(events, "exec-finished")?.time,
    harvested: latestDetail(events, "harvested")?.time,
    recorded: latestDetail(events, "delivery-recorded")?.time,
  };
}

/** The authoritative (first-by-seq, non-`rejectedAtAppend`) terminal in an intact event list, and whether a contradictory second terminal was also recorded (design §6.2/§6.4). */
function resolveAuthoritativeTerminal(
  events: readonly JournalEvent[],
): { terminal: JournalEvent | undefined; contradictory: boolean } {
  const accepted = events.filter((event) => event.type === "attempt-terminal" && event.rejectedAtAppend !== true);
  const rejected = events.some((event) => event.type === "attempt-terminal" && event.rejectedAtAppend === true);
  const first = accepted[0];
  const terminal = first?.details["state"] === "lost" && accepted[1] !== undefined
    ? accepted[1]
    : first;
  const allowedAcceptedCount = first?.details["state"] === "lost" ? 2 : 1;
  return {
    terminal,
    contradictory: rejected || accepted.length > allowedAcceptedCount,
  };
}

function derivePhase(events: readonly JournalEvent[]): AttemptRecord["phase"] {
  const { terminal } = resolveAuthoritativeTerminal(events);
  if (terminal !== undefined) return "terminal";
  if (latestDetail(events, "harvest-started") !== undefined || latestDetail(events, "exec-finished") !== undefined) {
    return latestDetail(events, "harvested") !== undefined ? "recording" : "harvesting";
  }
  if (latestDetail(events, "spawned") !== undefined || latestDetail(events, "attempt-started") !== undefined) {
    return "running";
  }
  if (latestDetail(events, "spawn-intended") !== undefined) return "spawn-intended";
  return "engaged";
}

/**
 * Folds a journal's intact events (plus an optional harvest result) into the durable per-attempt
 * document (design §6.3). A pure function of `(events, harvest)` — no I/O.
 */
export function foldAttemptRecord(
  events: readonly JournalEvent[],
  harvest?: AttemptHarvestInput,
): AttemptRecord {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const { terminal, contradictory } = resolveAuthoritativeTerminal(ordered);
  const spawned = latestDetail(ordered, "spawned");
  const spawnIntended = latestDetail(ordered, "spawn-intended");
  const engaged = latestDetail(ordered, "attempt-engaged");

  const terminalDetails = terminal?.details as
    | { state?: string; blame?: "task" | "infrastructure"; reasonCode?: string; detail?: string; matchedRule?: Record<string, unknown>; recoveryAdvice?: RecoveryAdvice; exitCode?: number | null; termSignal?: string | null; envelope?: Record<string, unknown> }
    | undefined;

  return {
    attemptUri: (engaged?.details["attempt"] as string | undefined) ?? ordered[0]?.attemptId ?? "",
    nonce: (spawned?.details["nonce"] as string | undefined) ?? (spawnIntended?.details["nonce"] as string | undefined),
    taskDigest: engaged?.details["taskDigest"] as `sha256:${string}` | undefined,
    submissionUri: engaged?.details["submission"] as string | undefined,
    attemptNumber: engaged?.details["attemptNumber"] as number | undefined,
    supersededBy: engaged?.details["supersededBy"] as string | undefined,
    priorAttempt: engaged?.details["priorAttempt"] as string | undefined,
    phaseTimestamps: phaseTimestampsFrom(ordered),
    phase: derivePhase(ordered),
    terminal: terminal !== undefined,
    terminalState: terminalDetails?.state,
    contradictory,
    outcome: terminal === undefined ? undefined : {
      exitCode: terminalDetails?.exitCode ?? null,
      termSignal: terminalDetails?.termSignal ?? null,
      envelope: terminalDetails?.envelope,
      blame: terminalDetails?.blame === undefined ? undefined : {
        blame: terminalDetails.blame,
        reasonCode: terminalDetails.reasonCode ?? "unspecified",
        message: terminalDetails.detail,
        matchedRule: terminalDetails.matchedRule,
      },
      recoveryAdvice: terminalDetails?.recoveryAdvice,
    },
    outputsManifest: harvest?.manifest ?? [],
    omissions: harvest?.omissions ?? [],
    integrityViolations: harvest?.integrityViolations ?? [],
    executor: {
      shimFingerprint: spawned === undefined ? undefined : {
        pid: spawned.details["pid"] as number,
        startTime: spawned.details["startTime"] as number,
      },
      launchPlanDigest: spawnIntended?.details["launchPlanDigest"] as `sha256:${string}` | undefined,
    },
    events: ordered,
  };
}
