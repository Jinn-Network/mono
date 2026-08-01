// SPDX-License-Identifier: Apache-2.0

import type { RuntimeConfig } from "./config.js";
import type { HealthCheck } from "./health.js";
import type { RuntimeLogger } from "./logger.js";

/** Everything a capability is handed. Nothing is reached for; everything is given. */
export interface CapabilityContext {
  readonly config: RuntimeConfig;
  readonly log: RuntimeLogger;
}

/**
 * One unit of product behavior. Capture, the corpus mirror, retrieval, relevance, and the
 * MCP server each arrive as one of these; the runtime itself holds no product logic.
 *
 * A capability owns what it opens; there is no shared handle registry.
 *
 * **Do not hold the local evidence archive open across the process lifetime.**
 * `openLocalEvidenceRuntime` takes an *exclusive* SQLite lock on the runtime root
 * (`packages/evidence/local-runtime/src/lock.ts:37,46` — `locking_mode = EXCLUSIVE` plus
 * `BEGIN EXCLUSIVE`, three retries at 10/25/50 ms, then `ROOT_IN_USE`). Sessions are
 * short-lived and a session may hold two runtime instances (host-spawned for tools,
 * adapter-spawned for hooks), so a capability that opened the archive in `start` would
 * starve its sibling for the whole session. Open the archive per operation and close it.
 * `start` is for cheap, contention-free setup; long-lived exclusive resources belong to
 * the operation that needs them.
 */
export interface RuntimeCapability {
  readonly name: string;
  start?(context: CapabilityContext): Promise<void>;
  stop?(): Promise<void>;
  healthChecks?(): Promise<readonly HealthCheck[]>;
}
