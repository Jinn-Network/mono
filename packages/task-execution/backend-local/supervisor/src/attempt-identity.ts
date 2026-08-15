// SPDX-License-Identifier: Apache-2.0

import type { AttemptUri } from "@jinn-network/task-execution-backend";

/**
 * Custody-owned Attempt identity (design §14 item 1; backend plan §15/Finding (e)). Homed in
 * `supervisor` — never in `workspace` or `launchers` — because process custody (the shim
 * fingerprint, the journal's per-attempt `seq`, the nonce that guards terminal uniqueness) is
 * exactly what the Attempt Supervisor owns (design §6). `attemptUri` is minted by the assembly
 * at `submit` (or adopted from a two-party `TwoPartyEngagement`, TEP Addendum 2026-07-28-b) and
 * threaded down into the supervisor/launcher surfaces from there — this package never mints one
 * itself.
 */
export interface AttemptIdentity {
  /** The minted (or adopted) Attempt URI (§9.2). */
  readonly attemptUri: AttemptUri;
  /** The per-attempt nonce the shim fingerprints and the journal enforces terminal-uniqueness against (§6.1/§6.2). */
  readonly nonce: string;
  /** 1-based ordinal among the Attempts a Submission has engaged (§6.3 identity/lineage). */
  readonly attemptNumber: number;
}

/**
 * The minimal structural shape the shim spawns (§6.1 step 4). The assembly reduces a resolved
 * `LaunchPlan` (the `launchers` package's type) to this shape before handing it to the
 * supervisor, so the supervisor never imports the `launchers` package's types (backend plan
 * Finding (e)) — it takes primitive `argv`/`env`/`cwd`, nothing more.
 */
export interface SpawnRequest {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}
