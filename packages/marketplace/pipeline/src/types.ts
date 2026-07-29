// SPDX-License-Identifier: MIT

import type { BackendCapabilities } from "@jinn-network/task-execution-backend";

/**
 * Pipeline-local discovery facts card shape (design §7). Intentionally minimal and
 * structural — no import from record-discovery packages.
 */
export interface SubmissionFacts {
  readonly taskId: bigint;
  readonly taskDigest: `sha256:${string}`;
  readonly submission: `urn:uuid:${string}`;
  readonly nonce: string;
  /** Task profile URI from the facts card — checked against backend capabilities before claim. */
  readonly profileUri: string;
  /** Declared requirements from the facts card — validated against capabilities.runPinning and preflight. */
  readonly requirements: Readonly<Record<string, unknown>>;
  /** Whether the operator's predicate considers this Submission runnable. */
  readonly runnable: boolean;
  readonly intendedSpendWei: bigint;
  readonly intendedAiUnits: number;
  readonly workKind: string;
  readonly runPinning?: {
    readonly harness?: string;
    readonly model?: string;
    readonly loadout?: string;
    readonly effortFloor?: number;
    readonly isolationPolicy?: string;
  };
  /** Migration-honesty annotation for manifest-digest matching until daemon cutover (§7). */
  readonly legacyManifestDigest?: string;
}

export type ClaimPredicate =
  | null
  | ((
      facts: SubmissionFacts,
      capabilities: BackendCapabilities,
      caps: OperatorCaps,
    ) => boolean);

/** The claim-nothing-when-unconfigured safety default (design §7). */
export const CLAIM_NOTHING: ClaimPredicate = null;

export interface OperatorCaps {
  readonly spendCapWei: bigint;
  readonly aiUnitCap: number;
}

export interface ExecutionWiringEntry {
  readonly workKind: string;
  readonly harness: string;
  readonly model: string;
  readonly plugins: readonly string[];
  readonly credentialRef: string;
  /** Effective backend isolation resolved for this wiring entry. */
  readonly isolationPolicy: string;
  readonly legacyManifestDigest?: string;
}

export type CarveOwner = "pipeline" | "embedded-backend" | "binding" | "application";

export type TaskEngineFailedCause = "backend" | "venue";
