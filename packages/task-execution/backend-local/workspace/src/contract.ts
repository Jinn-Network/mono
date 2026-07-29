// SPDX-License-Identifier: Apache-2.0

import type { TaskSpecification } from "@jinn-network/task-execution-protocol";
import type { TaskView } from "./task-view.js";

/**
 * The workspace kind a `ProvisionerContract` materializes for a given `TaskView` (design §7.2):
 * a plain scratch directory by default, or a detached git worktree checked out at an exact OID
 * for repository/session profiles. Provisioner IMPLEMENTATIONS are selected by profile
 * (`selectProvisioner`, Milestone B, Task B1) — this type only names the two v1 kinds.
 */
export const WORKSPACE_KINDS = ["dir", "worktree"] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/**
 * The per-attempt directory contract (design §7.1, frozen interface §14 item 7). Concrete paths
 * are never promised to the executor — only env-var indirection (`JINN_ATTEMPT_*`) is — but the
 * supervisor/launcher/assembly need the real paths to provision, plan, and harvest, so this type
 * carries them.
 */
export interface WorkspacePaths {
  /** `<attemptsRoot>/<attemptId>/` */
  readonly root: string;
  /** Read-only after provisioning: sealed Task bytes verbatim, dispatch-context artifact, resolved inputs. */
  readonly input: string;
  /** Executor cwd and scratch — the only directory the executor may assume writable. */
  readonly work: string;
  /** The delivery contract: only files here are collected at harvest. */
  readonly out: string;
  /** stdout/stderr/harness NDJSON — backend-written, outside the executor's write surface. */
  readonly logs: string;
  /** Per-attempt harness session home (CLAUDE_CONFIG_DIR / CODEX_HOME). */
  readonly harnessState: string;
  /** 0700; injected credentials; never collected or listed; wiped at terminal. */
  readonly secrets: string;
  /** TMPDIR; wiped at terminal. */
  readonly tmp: string;
  /** Backend-owned, read-only to the executor: shim.json, heartbeat, outcome.json, journal, attempt record. */
  readonly meta: string;
}

/**
 * The workspace-owned structural subset of a resolved `LaunchPlan` that `executionEnv` accepts
 * (design §7/plan Finding (e)) — deliberately NOT the launchers package's `LaunchPlan` type, so
 * `workspace` stays free of the `launchers` package (no workspace↔launchers cycle). The assembly
 * adapts the resolved `LaunchPlan` to this shape before calling `executionEnv`.
 */
export interface LaunchEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/**
 * The minimal local `capabilityGrant` resolution (design §7.2, backend plan Finding (d)): a
 * declared grant is an opaque descriptor retained only in the backend's admission path. The
 * backend-owned secret-forward resolver redeems it after durable spawn intent; workspace setup
 * never writes grant handles or values under `secrets/`.
 */
export interface CapabilityGrant {
  /** The grant's declared key (matches a `secrets/` reference the launcher's `LaunchPlan.env` forwards). */
  readonly key: string;
  /** An opaque, grant-specific descriptor; concrete shape is the capability-grant issuer's (out of scope here). */
  readonly descriptor: unknown;
}

/** One declared Task output slot (`TaskSpecification.outputs[number]`) — imported structurally so a protocol schema change never silently drifts this package's harvest signature. */
export type DeclaredOutputSlot = TaskSpecification["outputs"][number];

/** One collected `out/` artifact (design §6.3/§7.4 outputs manifest entry). */
export interface OutputArtifact {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: `sha256:${string}` | string;
  readonly mediaType?: string;
}

/** A symlink-escape or input-mutation integrity violation recorded on the attempt record (design §7.3/§7.4). */
export interface IntegrityViolation {
  readonly path: string;
  readonly reason: string;
}

/**
 * `harvest`'s result (design §7.4). A missing declared output is a recorded omission, never a
 * failure — the outcome verdict comes from the exit record and result envelope, never from
 * output presence.
 */
export interface HarvestResult {
  readonly manifest: readonly OutputArtifact[];
  readonly omissions: readonly string[];
  readonly integrityViolations: readonly IntegrityViolation[];
}

/**
 * The Workspace Provisioner contract (design §7, frozen interface §14 item 7). A provisioner
 * implementation never spawns and never interprets outcomes (design §5 never-touches column).
 */
export interface ProvisionerContract {
  /** Selects the workspace kind for a Task view — plain dir by default, worktree for repository/session profiles (§7.2). */
  workspaceKind(view: TaskView): WorkspaceKind;
  /** The setup phase (§7.2): resolves inputs by digest with re-hash-on-fetch and materializes the workspace kind. It may inspect declared grants for policy, but never writes handles or values to `secrets/`. */
  setup(view: TaskView, paths: WorkspacePaths, grants: readonly CapabilityGrant[]): Promise<void>;
  /** The execution-phase environment (§7.2 boundary): only the launcher's allowlisted env crosses from setup into the harness. */
  executionEnv(launch: LaunchEnv): Record<string, string>;
  /** The symlink-guarded, verified-empty harvest (§7.4). Always run — after success, failure, cancellation, and expiry. */
  harvest(paths: WorkspacePaths, declaredOutputs: readonly DeclaredOutputSlot[]): Promise<HarvestResult>;
}
