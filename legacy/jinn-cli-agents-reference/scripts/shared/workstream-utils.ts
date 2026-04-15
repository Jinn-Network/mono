/**
 * Shared utilities for workstream inspection - Re-export from jinn-node
 *
 * This module re-exports workstream utilities from jinn-node for backwards compatibility.
 * The actual implementation is in jinn-node/src/shared/workstream-utils.ts
 */

export {
  // Types
  type ErrorSummary,
  type GitOperationSummary,
  type DispatchInfo,
  type DispatchType,
  type TokenMetrics,
  type InvariantMetrics,
  type TimingMetrics,
  type AggregatedTimingMetrics,
  type AggregatedToolMetrics,
  type FailedToolCall,
  type WorkerTelemetryLog,
  type WorkerTelemetryEvent,
  type ToolMetrics,
  // Functions
  fetchIpfsContent,
  fetchWorkerTelemetryArtifact,
  extractErrorsFromTelemetry,
  extractGitOpsFromTelemetry,
  extractTimingMetrics,
  extractTokenMetrics,
  extractInvariantMetrics,
  extractFailedToolCalls,
  extractToolMetricsFromTelemetry,
  detectDispatchType,
  parseDispatchMessage,
  normalizeErrorPattern,
  aggregateErrorsByPattern,
  aggregateTimingMetrics,
  aggregateToolMetrics,
  computeDepth,
} from 'jinn-node/shared/workstream-utils.js';
