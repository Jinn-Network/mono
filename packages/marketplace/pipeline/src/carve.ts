// SPDX-License-Identifier: MIT

import type {
  CarveOwner,
  TaskEngineFailedCause,
} from "./types.js";

/**
 * Documentation-as-code disposition of today's TaskEngine states (design §9). The live daemon
 * cutover waits on the migration-mechanics design session — this map is drift-guarded only.
 */
export const TASK_ENGINE_CARVE = {
  DISCOVERED: "pipeline",
  CLAIMED: "pipeline",
  WAITING: "pipeline",
  PRE_SNAPSHOT: "embedded-backend",
  RUNNING: "embedded-backend",
  POST_SNAPSHOT: "embedded-backend",
  PACKAGING: "embedded-backend",
  DELIVERING: "binding",
  COMPLETE: "binding",
  AWAITING_ADOPTION: "application",
  CLAIMING_DELIVERY: "application",
  RACE_LOST: "binding",
} as const satisfies Record<string, CarveOwner>;

/**
 * FAILED is split by cause (design §9): backend-side execution failure vs venue-side failure.
 * This is intentionally not flattened into synthetic TaskEngine states.
 */
export const TASK_ENGINE_FAILED_CARVE = {
  backend: "embedded-backend",
  venue: "binding",
} as const satisfies Record<TaskEngineFailedCause, CarveOwner>;

export type TaskEngineCarveState = keyof typeof TASK_ENGINE_CARVE;

export function carveOwnerForFailed(cause: TaskEngineFailedCause): CarveOwner {
  return TASK_ENGINE_FAILED_CARVE[cause];
}
