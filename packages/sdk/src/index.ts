// @jinn-network/sdk
//
// Minimal generic SDK root. Use role-oriented subpaths for execution,
// SolverNet, plugin, and first-party SolverNet helpers.

export type {
  Address,
  Hex,
  IntentWindow,
  Task,
  OutputArtifact,
  RationaleEntry,
  Solution,
  TrajectoryCollector,
  TrajectorySpanInput,
  ReadyStatus,
  EnableArgDef,
  IntentEnableMetadata,
  EnableResult,
} from './types.js';
export { REQUIRES_LIVE_DAEMON_READINESS, SkippableError } from './types.js';
