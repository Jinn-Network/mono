// SPDX-License-Identifier: Apache-2.0

import type { AttemptRecord } from "./attempt-record.js";

export type ReconciliationClassification =
  | "matching" | "matching-late" | "absent-never-executed" | "absent" | "orphaned"
  | "stale-foreign" | "harvesting-resume" | "recording-resume" | "contradictory" | "corrected";

export interface AttemptReality {
  readonly processAlive?: boolean;
  readonly shimAlive?: boolean;
  readonly outcomePresent?: boolean;
  readonly nonceMatches?: boolean;
  readonly deliveryCheckpointPresent?: boolean;
  readonly shimFingerprintVerifiedSurvivorsAlive?: boolean;
  readonly pids?: readonly number[];
}

export interface ReconciliationResult {
  readonly classification: ReconciliationClassification;
  readonly action: string;
  readonly terminalState?: "rejected" | "lost";
  readonly blame?: "infrastructure";
  readonly killedPids?: readonly number[];
}

/** Pure recovery classifier. It reports actions for the caller to perform; it never respawns. */
export function reconcileAttempt(record: AttemptRecord, reality: AttemptReality): ReconciliationResult {
  if (record.terminal) {
    if (record.terminalState === "lost" && reality.outcomePresent) return { classification: "corrected", action: "accept-corrective-terminal" };
    if (record.contradictory || reality.shimFingerprintVerifiedSurvivorsAlive) return { classification: "contradictory", action: "terminal-record-wins-kill-survivors", killedPids: reality.pids ?? [] };
    return { classification: "matching", action: "terminal-record-wins" };
  }
  if (record.phase === "engaged") return { classification: "absent-never-executed", action: "rejected", terminalState: "rejected" };
  if (record.phase === "harvesting") return { classification: "harvesting-resume", action: "re-run-harvest-idempotently" };
  if (record.phase === "recording" && reality.deliveryCheckpointPresent) return { classification: "recording-resume", action: "re-write-delivery-from-checkpoint" };
  if (reality.outcomePresent && reality.nonceMatches === false) return { classification: "stale-foreign", action: "ignore-outcome-file" };
  if (reality.outcomePresent && reality.nonceMatches !== false && !reality.processAlive) return { classification: "matching-late", action: "ingest-outcome-append-terminal" };
  if (reality.processAlive && !reality.shimAlive) return { classification: "orphaned", action: "kill-ladder-then-lost", terminalState: "lost", blame: "infrastructure", killedPids: reality.pids ?? [] };
  if (reality.shimAlive) return { classification: "matching", action: "resume-supervision" };
  return { classification: "absent", action: "lost", terminalState: "lost", blame: "infrastructure" };
}
